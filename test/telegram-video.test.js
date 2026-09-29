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

test('MAX receives an image and video in source order', async () => {
  const root = mkdtempSync(join(tmpdir(), 'max-mixed-'));
  const photo = join(root, 'photo.jpg');
  const video = join(root, 'video.mp4');
  writeFileSync(photo, 'image-data');
  writeFileSync(video, 'video-data');
  const previousFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    if (requests.length === 1) return new Response(JSON.stringify({ url: 'https://upload.example/image' }));
    if (requests.length === 2) return new Response(JSON.stringify({ photos: { id: { token: 'image-token' } } }));
    if (requests.length === 3) return new Response(JSON.stringify({ url: 'https://upload.example/video', token: 'video-token' }));
    if (requests.length === 4) return new Response('<retval>1</retval>');
    return new Response(JSON.stringify({ message: { body: { mid: 'mixed-mid' } } }));
  };
  try {
    await new MaxClient('test-token').sendMedia('123', [
      { type: 'image', path: photo }, { type: 'video', path: video, mimeType: 'video/mp4' }
    ], 'mixed');
    assert.deepEqual(JSON.parse(requests[4].options.body).attachments, [
      { type: 'image', payload: { token: 'image-token' } },
      { type: 'video', payload: { token: 'video-token' } }
    ]);
  } finally {
    globalThis.fetch = previousFetch;
    rmSync(root, { recursive: true, force: true });
  }
});

test('MAX audio upload sends the M4A token as an audio attachment', async () => {
  const root = mkdtempSync(join(tmpdir(), 'max-audio-'));
  const voice = join(root, 'voice.m4a');
  writeFileSync(voice, 'audio-data');
  const previousFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    if (requests.length === 1) return new Response(JSON.stringify({ url: 'https://upload.example/audio', token: 'audio-token' }));
    if (requests.length === 2) return new Response('<retval>1</retval>');
    return new Response(JSON.stringify({ message: { body: { mid: 'audio-mid' } } }));
  };
  try {
    await new MaxClient('test-token').sendAudio('123', voice, 'voice');
    assert.match(requests[0].url, /uploads\?type=audio/);
    assert.equal(requests[1].options.body.get('data').name, 'voice.m4a');
    assert.deepEqual(JSON.parse(requests[2].options.body).attachments,
      [{ type: 'audio', payload: { token: 'audio-token' } }]);
  } finally {
    globalThis.fetch = previousFetch;
    rmSync(root, { recursive: true, force: true });
  }
});

test('MAX file upload obtains its token from the upload response', async () => {
  const root = mkdtempSync(join(tmpdir(), 'max-file-'));
  const file = join(root, 'report.txt');
  writeFileSync(file, 'report');
  const previousFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    if (requests.length === 1) return new Response(JSON.stringify({ url: 'https://upload.example/file' }));
    if (requests.length === 2) return new Response(JSON.stringify({ fileId: 1, token: 'file-token' }));
    return new Response(JSON.stringify({ message: { body: { mid: 'file-mid' } } }));
  };
  try {
    const result = await new MaxClient('test-token').sendFile('123', file, 'document', 'text/plain', 'report.txt');
    assert.equal(result.message.body.mid, 'file-mid');
    assert.equal(requests[1].options.body.get('data').name, 'report.txt');
    assert.deepEqual(JSON.parse(requests[2].options.body).attachments,
      [{ type: 'file', payload: { token: 'file-token' } }]);
  } finally {
    globalThis.fetch = previousFetch;
    rmSync(root, { recursive: true, force: true });
  }
});
