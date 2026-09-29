import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { localTelegramVideo } from '../src/telegram-video.js';
import { MaxClient } from '../src/max-client.js';

test('local Telegram file must be complete and inside shared volume', async () => {
  const root = mkdtempSync(join(tmpdir(), 'telegram-video-'));
  try {
    const inner = join(root, 'bot');
    mkdirSync(inner);
    const file = join(inner, 'video.mp4');
    writeFileSync(file, 'video-data');
    const telegram = { api: { getFile: async () => ({ file_path: file }) } };
    assert.equal(await localTelegramVideo(telegram, { file_id: 'abc', file_size: 10 }, root), file);
    await assert.rejects(localTelegramVideo(telegram, { file_id: 'abc', file_size: 11 }, root), /incomplete/);
    const outside = join(process.cwd(), 'package.json');
    await assert.rejects(localTelegramVideo({ api: { getFile: async () => ({ file_path: outside }) } },
      { file_id: 'abc' }, root), /outside the shared volume/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('MAX video is uploaded then sent with the returned token', async () => {
  const root = mkdtempSync(join(tmpdir(), 'max-video-'));
  const file = join(root, 'video.mp4');
  writeFileSync(file, 'video-data');
  const previousFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    if (requests.length === 1) return new Response(JSON.stringify({ url: 'https://upload.example/upload', token: 'media-token' }));
    if (requests.length === 2) return new Response('<retval>1</retval>');
    return new Response(JSON.stringify({ message: { body: { mid: 'max-message' } } }));
  };
  try {
    const result = await new MaxClient('test-token').sendVideo('123', file, 'caption');
    assert.equal(result.message.body.mid, 'max-message');
    assert.equal(requests.length, 3);
    assert.equal(requests[1].options.body.get('data').name, 'video.mp4');
    const sent = JSON.parse(requests[2].options.body);
    assert.deepEqual(sent.attachments, [{ type: 'video', payload: { token: 'media-token' } }]);
  } finally {
    globalThis.fetch = previousFetch;
    rmSync(root, { recursive: true, force: true });
  }
});
