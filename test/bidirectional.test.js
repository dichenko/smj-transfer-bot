import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../src/store.js';
import { acceptMax, acceptTelegram, createWorker } from '../src/bridge-runtime.js';
import { checkedMaxMediaUrl, downloadMaxMedia } from '../src/max-media.js';

function fixture(kind = 'channel') {
  const directory = mkdtempSync(join(tmpdir(), 'bridge-both-'));
  const store = new Store(join(directory, 'bridge.sqlite'));
  store.migrate();
  const now = new Date().toISOString();
  store.db.prepare(`INSERT INTO pairs(key,kind,title,telegram_id,max_id,enabled,max_to_telegram,
    telegram_senders,max_senders,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    'both', kind, 'Both', '-100500', '-900500', 1, 1,
    '{"mode":"all_non_bot","ids":[]}', '{"mode":"all_non_bot","ids":[]}', now, now);
  return { store, directory, close: () => { store.close(); rmSync(directory, { recursive: true, force: true }); } };
}

function maxPost(kind, mid, attachments = [], text = 'Hello') {
  const message = { recipient: { chat_id: '-900500', chat_type: kind },
    body: { mid, text, attachments } };
  if (kind === 'chat') message.sender = { user_id: '55', name: 'Alice', is_bot: false };
  return { update_type: 'message_created', chat_id: '-900500', message };
}

test('MAX channel posts reach Telegram channel without a bot prefix and do not loop', async () => {
  const { store, close } = fixture();
  try {
    const update = maxPost('channel', 'max-1', [], 'Channel post');
    acceptMax(store, update, JSON.stringify(update));
    let sent;
    const worker = createWorker({ store, max: {}, telegram: { api: {
      sendMessage: async (_chat, text) => { sent = text; return { message_id: 42 }; }
    } }, log: () => {} });
    await worker.tick(); worker.stop();
    assert.equal(sent, 'Channel post');
    assert.equal(store.db.prepare('SELECT status FROM deliveries').get().status, 'sent');
    assert.equal(store.wasRelayed('both', 'telegram', 42), true);
    acceptTelegram(store, { update_id: 1, channel_post: {
      message_id: 42, chat: { id: -100500, type: 'channel' }, text: 'Channel post'
    } });
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM deliveries').get().count, 1);
  } finally { close(); }
});

test('MAX markup is escaped and carried into Telegram HTML', async () => {
  const { store, close } = fixture();
  try {
    const update = maxPost('channel', 'max-markup', [], 'Hello <world>');
    update.message.body.markup = [{ type: 'strong', from: 0, length: 5 }];
    acceptMax(store, update, JSON.stringify(update));
    let sent;
    const worker = createWorker({ store, max: {}, telegram: { api: {
      sendMessage: async (_chat, text, options) => { sent = { text, options }; return { message_id: 43 }; }
    } }, log: () => {} });
    await worker.tick(); worker.stop();
    assert.equal(sent.text, '<b>Hello</b> &lt;world&gt;');
    assert.equal(sent.options.parse_mode, 'HTML');
  } finally { close(); }
});

test('MAX-only buttons do not add service text to a channel post', async () => {
  const { store, close } = fixture();
  try {
    const update = maxPost('channel', 'max-button', [{ type: 'inline_keyboard',
      payload: { buttons: [[{ type: 'open_app', text: 'Open' }]] } }], 'Original text');
    acceptMax(store, update, JSON.stringify(update));
    let sent;
    const worker = createWorker({ store, max: {}, telegram: { api: {
      sendMessage: async (_chat, text) => { sent = text; return { message_id: 44 }; }
    } }, log: () => {} });
    await worker.tick(); worker.stop();
    assert.equal(sent, 'Original text');
    assert.equal(store.db.prepare('SELECT status FROM deliveries').get().status, 'partial');
  } finally { close(); }
});

test('MAX photo and video in one post become one Telegram album', async () => {
  const { store, close } = fixture();
  const originalFetch = globalThis.fetch;
  try {
    const attachments = [
      { type: 'image', payload: { url: 'https://i.oneme.ru/photo' } },
      { type: 'video', payload: { url: 'https://maxvd.okcdn.ru/video' } }
    ];
    const update = maxPost('channel', 'max-2', attachments, 'Caption');
    acceptMax(store, update, JSON.stringify(update));
    globalThis.fetch = async (url) => new Response(new Uint8Array([1, 2, 3]), { status: 200,
      headers: { 'content-type': String(url).includes('photo') ? 'image/jpeg' : 'video/mp4' } });
    let group;
    const worker = createWorker({ store, max: {}, telegram: { api: {
      sendMediaGroup: async (_chat, media) => { group = media; return [{ message_id: 10 }, { message_id: 11 }]; }
    } }, log: () => {} });
    await worker.tick(); worker.stop();
    assert.deepEqual(group.map((item) => item.type), ['photo', 'video']);
    assert.equal(group[0].caption, 'Caption');
    assert.equal(store.db.prepare('SELECT status FROM deliveries').get().status, 'sent');
    assert.equal(store.wasRelayed('both', 'telegram', 11), true);
  } finally { globalThis.fetch = originalFetch; close(); }
});

test('MAX chat file and audio are sent as Telegram media with sender attribution', async () => {
  const { store, close } = fixture('chat');
  const originalFetch = globalThis.fetch;
  try {
    const update = maxPost('chat', 'max-3', [
      { type: 'audio', payload: { url: 'https://maxvd.okcdn.ru/audio' } },
      { type: 'file', payload: { url: 'https://maxvd.okcdn.ru/file' } }
    ], 'Track');
    acceptMax(store, update, JSON.stringify(update));
    globalThis.fetch = async (url) => new Response(new Uint8Array([1, 2, 3]), { status: 200,
      headers: { 'content-type': String(url).includes('audio') ? 'audio/mpeg' : 'application/pdf' } });
    const calls = [];
    const worker = createWorker({ store, max: {}, telegram: { api: {
      sendAudio: async (_chat, _file, options) => { calls.push(['audio', options.caption]); return { message_id: 20 }; },
      sendDocument: async () => { calls.push(['file']); return { message_id: 21 }; }
    } }, log: () => {} });
    await worker.tick(); worker.stop();
    assert.deepEqual(calls, [['audio', '[MAX] Alice:\nTrack'], ['file']]);
    assert.equal(store.db.prepare('SELECT status FROM deliveries').get().status, 'partial');
  } finally { globalThis.fetch = originalFetch; close(); }
});

test('Telegram audio and documents upload to MAX in both pair kinds', async () => {
  for (const [kind, type] of [['chat', 'audio'], ['channel', 'document']]) {
    const { store, directory, close } = fixture(kind);
    try {
      const mediaRoot = join(directory, 'media'); mkdirSync(mediaRoot);
      const path = join(mediaRoot, 'source'); writeFileSync(path, '12345');
      const message = { message_id: 5, chat: { id: -100500, type: kind === 'channel' ? 'channel' : 'group' },
        [type]: { file_id: 'media', file_size: 5,
          mime_type: type === 'audio' ? 'audio/mpeg' : 'application/pdf', file_name: `test.${type === 'audio' ? 'mp3' : 'pdf'}` } };
      if (kind === 'chat') message.from = { id: 12, first_name: 'Bob', is_bot: false };
      acceptTelegram(store, { update_id: 5, [kind === 'channel' ? 'channel_post' : 'message']: message });
      let sent;
      const worker = createWorker({ store, mediaRoot,
        telegram: { api: { getFile: async () => ({ file_path: path }) } },
        max: { sendFile: async (...args) => { sent = args; return { message: { body: { mid: 'max-mid' } } }; } },
        log: () => {} });
      await worker.tick(); worker.stop();
      assert.equal(sent[1], path);
      assert.equal(sent[5], type === 'audio' ? 'audio' : 'file');
      assert.equal(store.db.prepare('SELECT status FROM deliveries').get().status, 'sent');
    } finally { close(); }
  }
});

test('MAX media URL must stay on an HTTPS CDN', () => {
  assert.equal(checkedMaxMediaUrl('https://i.oneme.ru/photo').hostname, 'i.oneme.ru');
  assert.throws(() => checkedMaxMediaUrl('http://i.oneme.ru/photo'), /allowed HTTPS/);
  assert.throws(() => checkedMaxMediaUrl('https://oneme.ru.evil.test/photo'), /allowed HTTPS/);
  assert.throws(() => checkedMaxMediaUrl('https://127.0.0.1/private'), /allowed HTTPS/);
});

test('MAX WebP image is converted to a Telegram photo before upload', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'max-webp-'));
  const originalFetch = globalThis.fetch;
  try {
    const source = join(directory, 'source.webp');
    const generated = spawnSync('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=c=red:s=16x16:d=1', '-frames:v', '1', source]);
    assert.equal(generated.status, 0);
    globalThis.fetch = async () => new Response(readFileSync(source), { status: 200,
      headers: { 'content-type': 'image/webp' } });
    const file = await downloadMaxMedia({}, { type: 'image', payload: { url: 'https://i.oneme.ru/test' } }, directory, 0);
    assert.match(file.path, /\.jpg$/);
    assert.equal(file.photoSuitable, true);
    assert.deepEqual([...readFileSync(file.path).subarray(0, 2)], [0xff, 0xd8]);
  } finally { globalThis.fetch = originalFetch; rmSync(directory, { recursive: true, force: true }); }
});
