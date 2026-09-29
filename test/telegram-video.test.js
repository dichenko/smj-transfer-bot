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

test('MAX receives five separately uploaded images in one message', async () => {
  const root = mkdtempSync(join(tmpdir(), 'max-photos-'));
  const files = Array.from({ length: 5 }, (_, i) => join(root, `photo${i}.jpg`));
  files.forEach((file) => writeFileSync(file, 'image-data'));
  const previousFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    const step = requests.length;
    if (step <= 10 && step % 2 === 1) return new Response(JSON.stringify({ url: 'https://upload.example/image' }));
    if (step <= 10) return new Response(JSON.stringify({ photos: { id: { token: `token${step / 2}` } } }));
    return new Response(JSON.stringify({ message: { body: { mid: 'album-mid' } } }));
  };
  try {
    const result = await new MaxClient('test-token').sendPhotos('123', files, 'five photos');
    assert.equal(result.message.body.mid, 'album-mid');
    assert.equal(requests.length, 11);
    for (const request of requests.filter((_, i) => i < 10 && i % 2 === 1)) {
      assert.equal(request.options.headers.Authorization, 'test-token');
    }
    const message = JSON.parse(requests.at(-1).options.body);
    assert.deepEqual(message.attachments.map((item) => item.payload.token),
      ['token1', 'token2', 'token3', 'token4', 'token5']);
  } finally {
    globalThis.fetch = previousFetch;
    rmSync(root, { recursive: true, force: true });
  }
});
