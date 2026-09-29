import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
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
  return { store, directory, close: () => { store.close(); rmSync(directory, { recursive: true, force: true }); } };
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

test('new channel pair never publishes an unsupported sticker caption as a text post', async () => {
  const { store, close } = fixture();
  try {
    const now = new Date().toISOString();
    store.db.prepare(`INSERT INTO pairs(key,kind,title,telegram_id,max_id,enabled,max_to_telegram,
      telegram_senders,max_senders,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      'news', 'channel', 'News', '-2001', '-3001', 1, 0,
      '{"mode":"all_non_bot","ids":[]}', '{"mode":"all_non_bot","ids":[]}', now, now);
    acceptTelegram(store, { update_id: 5, channel_post: { message_id: 11, chat: { id: -2001, type: 'channel' },
      sticker: { file_id: 'file' }, caption: 'headline' } });
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
    assert.equal(payload.media.length, 5);
    assert.deepEqual(payload.media.map((photo) => photo.file_id),
      ['large0', 'large1', 'large2', 'large3', 'large4']);
    assert.equal(payload.text, 'album caption');
  } finally { close(); }
});

test('a single photo and its caption are sent in the same MAX message', async () => {
  const { store, directory, close } = fixture();
  try {
    const now = new Date().toISOString();
    store.db.prepare(`INSERT INTO pairs(key,kind,title,telegram_id,max_id,enabled,max_to_telegram,
      telegram_senders,max_senders,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      'photo-caption', 'chat', 'Photo', '-2010', '-3010', 1, 0,
      '{"mode":"all_non_bot","ids":[]}', '{"mode":"all_non_bot","ids":[]}', now, now);
    const mediaRoot = join(directory, 'media');
    mkdirSync(mediaRoot);
    const path = join(mediaRoot, 'photo.jpg');
    writeFileSync(path, 'image');
    acceptTelegram(store, { update_id: 200, message: { message_id: 12,
      chat: { id: -2010, type: 'supergroup' }, from: { id: 101, first_name: 'Ada', is_bot: false },
      photo: [{ file_id: 'photo-id', file_size: 5 }], caption: 'Caption text' } });
    let sent;
    const worker = createWorker({ store, mediaRoot,
      telegram: { api: { getFile: async () => ({ file_path: path }) } },
      max: { sendMedia: async (_id, files, text) => {
        sent = { files, text }; return { message: { body: { mid: 'photo-mid' } } };
      } }, log: () => {} });
    await worker.tick(); worker.stop();
    assert.deepEqual(sent.files.map((file) => file.type), ['image']);
    assert.match(sent.text, /Caption text/);
    assert.equal(store.db.prepare("SELECT status FROM deliveries WHERE pair_key='photo-caption'").get().status, 'sent');
  } finally { close(); }
});

test('mixed photo and video album keeps media order in one MAX message', async () => {
  const { store, directory, close } = fixture();
  try {
    const now = new Date().toISOString();
    store.db.prepare(`INSERT INTO pairs(key,kind,title,telegram_id,max_id,enabled,max_to_telegram,
      telegram_senders,max_senders,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      'mixed-album', 'chat', 'Mixed', '-2020', '-3020', 1, 0,
      '{"mode":"all_non_bot","ids":[]}', '{"mode":"all_non_bot","ids":[]}', now, now);
    const mediaRoot = join(directory, 'media');
    mkdirSync(mediaRoot);
    for (const [i, type] of ['photo', 'video', 'photo'].entries()) {
      const fileId = `file${i}`;
      writeFileSync(join(mediaRoot, fileId), 'media');
      acceptTelegram(store, { update_id: 300 + i, message: { message_id: 20 + i,
        chat: { id: -2020, type: 'supergroup' }, from: { id: 101, first_name: 'Ada', is_bot: false },
        media_group_id: 'mixed-group', ...(i === 1 ? { caption: 'Mixed caption' } : {}),
        ...(type === 'photo' ? { photo: [{ file_id: fileId, file_size: 5 }] }
          : { video: { file_id: fileId, file_size: 5, mime_type: 'video/mp4' } }) } });
    }
    store.db.prepare("UPDATE deliveries SET next_attempt_at=? WHERE pair_key='mixed-album'").run(now);
    let sent;
    const worker = createWorker({ store, mediaRoot,
      telegram: { api: { getFile: async (fileId) => ({ file_path: join(mediaRoot, fileId) }) } },
      max: { sendMedia: async (_id, files, text) => {
        sent = { files, text }; return { message: { body: { mid: 'mixed-mid' } } };
      } }, log: () => {} });
    await worker.tick(); worker.stop();
    assert.deepEqual(sent.files.map((file) => file.type), ['image', 'video', 'image']);
    assert.match(sent.text, /Mixed caption/);
    assert.equal(store.db.prepare("SELECT status FROM deliveries WHERE pair_key='mixed-album'").get().status, 'sent');
  } finally { close(); }
});

test('Telegram voice is converted and sent as MAX audio', async () => {
  const { store, directory, close } = fixture();
  try {
    const now = new Date().toISOString();
    store.db.prepare(`INSERT INTO pairs(key,kind,title,telegram_id,max_id,enabled,max_to_telegram,
      telegram_senders,max_senders,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      'voice-test', 'chat', 'Voice', '-2030', '-3030', 1, 0,
      '{"mode":"all_non_bot","ids":[]}', '{"mode":"all_non_bot","ids":[]}', now, now);
    const mediaRoot = join(directory, 'media');
    mkdirSync(mediaRoot);
    const source = join(mediaRoot, 'voice.ogg');
    writeFileSync(source, 'voice');
    acceptTelegram(store, { update_id: 400, message: { message_id: 30,
      chat: { id: -2030, type: 'supergroup' }, from: { id: 101, first_name: 'Ada', is_bot: false },
      voice: { file_id: 'voice-id', file_size: 5, duration: 2, mime_type: 'audio/ogg' } } });
    let sent;
    const worker = createWorker({ store, mediaRoot,
      telegram: { api: { getFile: async () => ({ file_path: source }) } },
      convertVoice: async (path, send) => { assert.equal(path, source); return send('converted.m4a'); },
      max: { sendAudio: async (_id, path, text) => {
        sent = { path, text }; return { message: { body: { mid: 'voice-mid' } } };
      } }, log: () => {} });
    await worker.tick(); worker.stop();
    assert.equal(sent.path, 'converted.m4a');
    assert.match(sent.text, /Голосовое сообщение/);
    assert.equal(store.db.prepare("SELECT status FROM deliveries WHERE pair_key='voice-test'").get().status, 'sent');
  } finally { close(); }
});
