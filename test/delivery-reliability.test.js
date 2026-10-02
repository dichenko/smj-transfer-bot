import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { acceptTelegram, createWorker } from '../src/bridge-runtime.js';
import { MaxClient } from '../src/max-client.js';
import { createDeliveryMonitor, deliveryHealth } from '../src/delivery-monitor.js';
import { localTelegramPhoto } from '../src/telegram-video.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'delivery-reliability-'));
  const path = join(root, 'db.sqlite');
  const store = new Store(path);
  store.migrate();
  store.importLegacy({ telegramSourceChatId: '-1001', maxTargetChatId: '-2001',
    telegramAllowedUserIds: new Set(['101']), maxAllowedUserIds: new Set(['201']) });
  const photoPath = join(root, 'photo.jpg');
  writeFileSync(photoPath, 'image');
  function enqueue(messageId = 1, photo = true) {
    acceptTelegram(store, { update_id: messageId, message: {
      message_id: messageId, chat: { id: -1001, type: 'group' }, from: { id: 101, is_bot: false },
      ...(photo ? { photo: [{ file_id: 'photo', file_size: 5 }], caption: 'caption' } : { text: 'text' })
    } });
  }
  const job = (id = 1) => store.db.prepare('SELECT * FROM deliveries WHERE id=?').get(id);
  const due = () => store.db.exec("UPDATE deliveries SET next_attempt_at='2000-01-01T00:00:00.000Z'");
  return { store, root, path, photoPath, enqueue, job, due,
    close: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('getFile outage retries from durable queue and eventually publishes once', async () => {
  const f = fixture(); let worker; let calls = 0; let sends = 0; const logs = [];
  try {
    f.enqueue();
    worker = createWorker({ store: f.store, mediaRoot: f.root, telegramToken: 'secret-token',
      telegram: { api: { getFile: async () => {
        if (++calls === 1) throw Object.assign(new Error("Network request for 'getFile' failed!"), {
          name: 'HttpError', error: Object.assign(new Error('secret-token fetch failed'), { cause: { code: 'ECONNRESET' } }) });
        return { file_path: f.photoPath };
      } } },
      max: { sendMedia: async (_id, _files, _text, _format, publish) => {
        publish(); sends++; return { message: { body: { mid: 'sent' } } };
      } }, log: (...args) => logs.push(args) });
    await worker.tick();
    assert.equal(f.job().status, 'retrying');
    assert.equal(f.job().stage, 'preparing');
    assert.ok(f.job().next_attempt_at > new Date().toISOString());
    assert.equal(sends, 0);
    assert.equal(logs[0][2].causeCode, 'ECONNRESET');
    assert.ok(!JSON.stringify(logs).includes('secret-token'));
    f.due(); await worker.tick(); await worker.tick();
    assert.equal(f.job().status, 'sent');
    assert.equal(f.job().attempts, 2);
    assert.equal(sends, 1);
  } finally { worker?.stop(); f.close(); }
});

test('exhausted downloads fail, alert once and allow the next post', async () => {
  const f = fixture(); let worker; const alerts = []; let sends = 0;
  try {
    f.enqueue(); f.enqueue(2, false);
    worker = createWorker({ store: f.store, maxAttempts: 3,
      telegram: { api: { getFile: async () => { throw Object.assign(new Error('network failed'), { name: 'HttpError' }); } } },
      max: { sendText: async () => { sends++; return { message: { mid: 'next' } }; } },
      log: () => {}, onFailure: (job) => alerts.push(job) });
    for (let i = 0; i < 3; i++) { f.due(); await worker.tick(); }
    assert.equal(f.job().status, 'failed');
    assert.equal(f.job().attempts, 3);
    assert.equal(alerts.length, 1);
    await worker.tick();
    assert.equal(f.job(2).status, 'sent'); assert.equal(sends, 1);
  } finally { worker?.stop(); f.close(); }
});

test('permanent getFile rejection fails without repeated download attempts', async () => {
  const f = fixture(); let worker;
  try {
    f.enqueue();
    worker = createWorker({ store: f.store, max: {}, log: () => {}, telegram: { api: {
      getFile: async () => { throw Object.assign(new Error('Bad Request: invalid file_id'), { error_code: 400 }); }
    } } });
    await worker.tick();
    assert.equal(f.job().status, 'failed'); assert.equal(f.job().attempts, 1);
  } finally { worker?.stop(); f.close(); }
});

test('ambiguous MAX publication is never repeated and does not freeze later posts', async () => {
  const f = fixture(); let worker; let sends = 0;
  try {
    f.enqueue(); f.enqueue(2, false);
    worker = createWorker({ store: f.store, mediaRoot: f.root, log: () => {},
      telegram: { api: { getFile: async () => ({ file_path: f.photoPath }) } },
      max: {
        sendMedia: async (_id, _files, _text, _format, publish) => { publish(); sends++; throw new TypeError('fetch failed'); },
        sendText: async () => { sends++; return { message: { mid: 'next' } }; }
      } });
    await worker.tick(); assert.equal(f.job().status, 'unknown'); assert.equal(f.job().stage, 'publishing');
    f.due(); await worker.tick(); await worker.tick();
    assert.equal(f.job(2).status, 'sent'); assert.equal(sends, 2);
    assert.equal(f.job().attempts, 1);
  } finally { worker?.stop(); f.close(); }
});

test('publication HTTP 503 is held for review, whereas explicit 429 can retry', async () => {
  for (const code of [503, 429]) {
    const f = fixture(); let worker;
    try {
      f.enqueue(1, false);
      worker = createWorker({ store: f.store, telegram: {}, log: () => {}, max: {
        sendText: async () => { throw Object.assign(new Error(`API ${code}`), { error_code: code }); }
      } });
      await worker.tick(); assert.equal(f.job().status, code === 429 ? 'retrying' : 'unknown');
    } finally { worker?.stop(); f.close(); }
  }
});

test('MAX upload failure remains preparation; callback marks only message POST', async () => {
  const f = fixture(); let worker; const previousFetch = globalThis.fetch;
  try {
    f.enqueue();
    globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
    worker = createWorker({ store: f.store, mediaRoot: f.root, log: () => {},
      telegram: { api: { getFile: async () => ({ file_path: f.photoPath }) } }, max: new MaxClient('token') });
    await worker.tick(); assert.equal(f.job().status, 'retrying'); assert.equal(f.job().stage, 'preparing');
    f.due();
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      if (calls === 1) return new Response(JSON.stringify({ url: 'https://upload.example/photo' }));
      if (calls === 2) return new Response(JSON.stringify({ photos: { id: { token: 'photo-token' } } }));
      assert.equal(f.job().stage, 'publishing'); throw new TypeError('fetch failed');
    };
    await worker.tick(); assert.equal(f.job().status, 'unknown'); assert.equal(calls, 3);
  } finally { worker?.stop(); globalThis.fetch = previousFetch; f.close(); }
});

test('restart retries interrupted preparation and holds interrupted publication', () => {
  const f = fixture();
  try {
    f.enqueue(); f.enqueue(2); f.enqueue(3);
    f.store.startDelivery(1); f.store.startDelivery(2); f.store.setDeliveryStage(2, 'publishing');
    f.store.finishDelivery(3, 'unknown', null, 'Historical incident');
    const previous = f.job(3);
    const interrupted = f.store.recoverInterrupted();
    assert.equal(f.job().status, 'retrying'); assert.equal(f.job(2).status, 'unknown');
    assert.deepEqual(interrupted.map((job) => job.id), [2]);
    assert.deepEqual(f.job(3), previous);
  } finally { f.close(); }
});

test('legacy uploading jobs migrate conservatively and migration is idempotent', () => {
  const f = fixture();
  try {
    f.enqueue();
    f.store.db.exec("UPDATE deliveries SET status='uploading'; ALTER TABLE deliveries DROP COLUMN stage");
    f.store.migrate(); f.store.migrate(); f.store.recoverInterrupted();
    assert.equal(f.job().status, 'unknown'); assert.equal(f.job().stage, 'publishing');
  } finally { f.close(); }
});

test('photo deadline aborts getFile without waiting for the library default', async () => {
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const telegram = { fileTimeouts: { photo: 10 }, api: {
      getFile: async (_file, signal) => new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    } };
    await assert.rejects(localTelegramPhoto(telegram, { file_id: 'photo' }), { name: 'TimeoutError' });
  } finally { clearTimeout(keepAlive); }
});

test('delivery readiness detects pending and unresolved jobs, alerts persist and deduplicate', async () => {
  const f = fixture(); let monitor; const sent = [];
  try {
    f.enqueue();
    f.store.db.exec("UPDATE deliveries SET created_at='2000-01-01T00:00:00.000Z',next_attempt_at='2000-01-01T00:00:00.000Z'");
    assert.equal(deliveryHealth(f.store).stalled.length, 1);
    monitor = createDeliveryMonitor({ store: f.store, adminIds: new Set(['101']), log: () => {},
      telegram: { api: { sendMessage: async (id, text) => sent.push({ id, text }) } } });
    await monitor.tick(); await monitor.tick();
    assert.equal(sent.length, 1);
    assert.ok(!sent[0].text.includes('caption'));
    monitor.stop();
    f.store.finishDelivery(1, 'failed', null, 'download failed');
    monitor = createDeliveryMonitor({ store: f.store, adminIds: new Set(['101']), log: () => {},
      telegram: { api: { sendMessage: async (id, text) => sent.push({ id, text }) } } });
    monitor.alert(f.job()); monitor.alert(f.job());
    await monitor.tick(); await monitor.tick();
    assert.equal(sent.length, 2);
    assert.equal(deliveryHealth(f.store).unresolved.length, 1);
    f.store.finishDelivery(1, 'sent', ['result']);
    assert.equal(deliveryHealth(f.store).ok, true);
  } finally { monitor?.stop(); f.close(); }
});

test('failed alert requests retry in separate queue without changing delivery state', async () => {
  const f = fixture(); let monitor;
  try {
    f.enqueue(); f.store.finishDelivery(1, 'failed');
    monitor = createDeliveryMonitor({ store: f.store, adminIds: new Set(['101']), log: () => {},
      telegram: { api: { sendMessage: async () => { throw new Error('network'); } } } });
    monitor.alert(f.job()); await monitor.tick();
    assert.equal(f.job().status, 'failed');
    const notification = f.store.db.prepare('SELECT * FROM alert_notifications').get();
    assert.equal(notification.status, 'queued'); assert.equal(notification.attempts, 1);
    assert.ok(notification.next_attempt_at > new Date().toISOString());
  } finally { monitor?.stop(); f.close(); }
});
