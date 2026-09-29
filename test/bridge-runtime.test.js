import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../src/store.js';
import { acceptTelegram, acceptMax, createWorker } from '../src/bridge-runtime.js';
import { parseMaxJson } from '../src/lossless-json.js';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'bridge-db-'));
  const store = new Store(join(directory, 'bridge.sqlite'));
  store.migrate();
  store.importLegacy({ telegramSourceChatId: '-1001', maxTargetChatId: '-9223372036854775807',
    telegramAllowedUserIds: new Set(['101']), maxAllowedUserIds: new Set(['201']) });
  return { store, close: () => { store.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('legacy pair remains locked and preserves exact IDs and sender lists', () => {
  const { store, close } = fixture();
  try {
    const pair = store.pairs()[0];
    assert.equal(pair.locked, 1);
    assert.equal(pair.max_to_telegram, 1);
    assert.equal(pair.max_id, '-9223372036854775807');
    assert.deepEqual(JSON.parse(pair.telegram_senders), { mode: 'allowlist', ids: ['101'] });
    assert.equal(store.importLegacy({ telegramSourceChatId: '-2', maxTargetChatId: '-3',
      telegramAllowedUserIds: new Set(), maxAllowedUserIds: new Set() }), false);
    assert.equal(store.pairs()[0].telegram_id, '-1001');
  } finally { close(); }
});

test('Telegram route and MAX int64 route are exact, deduplicated and deny other senders', () => {
  const { store, close } = fixture();
  try {
    const telegram = (updateId, chatId, userId) => ({ update_id: updateId, message: {
      message_id: 5, chat: { id: chatId, type: 'supergroup', title: 'Main' },
      from: { id: userId, first_name: 'Ada', is_bot: false }, text: 'hello'
    } });
    acceptTelegram(store, telegram(1, -1001, 101));
    acceptTelegram(store, telegram(2, -1001, 101));
    acceptTelegram(store, telegram(3, -1001, 999));
    acceptTelegram(store, telegram(4, -1002, 101));
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM deliveries').get().count, 1);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM discovered_resources WHERE platform='telegram'").get().count, 2);
    assert.equal(store.db.prepare("SELECT configured_pair_key FROM discovered_resources WHERE platform='telegram' AND resource_id='-1001'").get().configured_pair_key, 'main-chat');
    const raw = '{"update_type":"message_created","chat_id":-9223372036854775807,"message":{"recipient":{"chat_id":-9223372036854775807,"chat_type":"chat"},"sender":{"user_id":201,"is_bot":false,"name":"B"},"body":{"mid":"mid1","text":"hello"}}}';
    const update = parseMaxJson(raw);
    assert.equal(update.chat_id, '-9223372036854775807');
    acceptMax(store, update, raw);
    acceptMax(store, update, raw);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM deliveries').get().count, 2);
  } finally { close(); }
});

test('legacy captions remain forwarded but report partial delivery', async () => {
  const { store, close } = fixture();
  const update = { update_id: 1, message: { message_id: 6,
    chat: { id: -1001, type: 'group' }, from: { id: 101, is_bot: false },
    photo: [{ file_id: 'photo1' }], caption: 'caption' } };
  try {
    acceptTelegram(store, update);
    let sent;
    const worker = createWorker({ store, max: { sendText: (_id, text) => { sent = text; return { message: { body: { mid: 'result' } } }; } },
      telegram: {}, log: () => {} });
    await worker.tick(); worker.stop();
    assert.match(sent, /caption/);
    assert.equal(store.db.prepare('SELECT status FROM deliveries').get().status, 'partial');
  } finally { close(); }
});

test('new channel pair never publishes an unsupported media caption as a text post', async () => {
  const { store, close } = fixture();
  try {
    const now = new Date().toISOString();
    store.db.prepare(`INSERT INTO pairs(key,kind,title,telegram_id,max_id,enabled,max_to_telegram,
      telegram_senders,max_senders,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      'news', 'channel', 'News', '-2001', '-3001', 1, 0,
      '{"mode":"all_non_bot","ids":[]}', '{"mode":"all_non_bot","ids":[]}', now, now);
    acceptTelegram(store, { update_id: 5, channel_post: { message_id: 11, chat: { id: -2001, type: 'channel' },
      audio: { file_id: 'file' }, caption: 'headline' } });
    const worker = createWorker({ store, max: { sendText: () => { throw Error('Must not publish caption'); } },
      telegram: {}, log: () => {} });
    await worker.tick(); worker.stop();
    assert.equal(store.db.prepare('SELECT status FROM deliveries WHERE pair_key=?').get('news').status, 'unsupported');
  } finally { close(); }
});

test('five Telegram album photos are collected into one delayed delivery', () => {
  const { store, close } = fixture();
  try {
    const now = new Date().toISOString();
    store.db.prepare(`INSERT INTO pairs(key,kind,title,telegram_id,max_id,enabled,max_to_telegram,
      telegram_senders,max_senders,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      'album-test', 'chat', 'Album test', '-2002', '-3002', 1, 0,
      '{"mode":"all_non_bot","ids":[]}', '{"mode":"all_non_bot","ids":[]}', now, now);
    for (let i = 0; i < 5; i++) {
      const update = { update_id: 50 + i, message: { message_id: 100 + i,
        chat: { id: -2002, type: 'supergroup' },
        from: { id: 101, first_name: 'Ada', is_bot: false }, media_group_id: 'group1',
        photo: [{ file_id: `small${i}` }, { file_id: `large${i}`, file_size: 100 + i }],
        ...(i === 1 ? { caption: 'album caption' } : {}) } };
      acceptTelegram(store, update);
      if (i === 4) acceptTelegram(store, update);
    }
    const jobs = store.db.prepare("SELECT * FROM deliveries WHERE pair_key='album-test'").all();
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].media_type, 'album');
    assert.equal(jobs[0].source_message_id, 'group1');
    assert.ok(jobs[0].next_attempt_at > now);
    const payload = JSON.parse(jobs[0].payload);
    assert.equal(payload.photos.length, 5);
    assert.deepEqual(payload.photos.map((photo) => photo.file_id),
      ['large0', 'large1', 'large2', 'large3', 'large4']);
    assert.equal(payload.text, 'album caption');
  } finally { close(); }
});
