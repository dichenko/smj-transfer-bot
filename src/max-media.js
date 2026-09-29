import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { stat } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { join } from 'node:path';

const TELEGRAM_UPLOAD_LIMIT = 2_000_000_000;
const MEDIA_HOSTS = ['oneme.ru', 'okcdn.ru', 'mycdn.me', 'max.ru'];
const EXTENSIONS = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/x-matroska': 'mkv',
  'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a',
  'audio/ogg': 'ogg', 'audio/wav': 'wav', 'application/pdf': 'pdf'
};

function mediaFilename(header, fallback) {
  let value = null;
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(header ?? '');
  if (encoded) {
    try { value = decodeURIComponent(encoded[1]); } catch { /* Use the plain filename. */ }
  }
  value ??= /filename="?([^";]+)"?/i.exec(header ?? '')?.[1];
  const safe = value?.split(/[\\/]/).at(-1).replace(/[\x00-\x1f<>:"|?*]/g, '_').trim().slice(0, 128);
  return safe || fallback;
}

export function checkedMaxMediaUrl(value) {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.port
      || !MEDIA_HOSTS.some((domain) => host === domain || host.endsWith(`.${domain}`))) {
    throw new Error('MAX media URL is not an allowed HTTPS CDN address');
  }
  return url;
}

async function mediaUrl(max, attachment) {
  if (attachment.payload?.url) return attachment.payload.url;
  if (attachment.type !== 'video' || !attachment.payload?.token) throw new Error('MAX attachment URL is missing');
  const video = await max.request(`/videos/${encodeURIComponent(attachment.payload.token)}`);
  const url = Object.values(video.urls ?? {}).find((value) => typeof value === 'string' && value.startsWith('https://'));
  if (!url) throw new Error('MAX video download URL is unavailable');
  return url;
}

async function fetchMedia(url) {
  for (let redirects = 0; redirects < 5; redirects += 1) {
    const response = await fetch(checkedMaxMediaUrl(url), {
      redirect: 'manual', signal: AbortSignal.timeout(1_800_000)
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw new Error('MAX media redirect has no location');
      url = new URL(location, url).href;
      continue;
    }
    if (!response.ok || !response.body) throw new Error(`MAX media download failed (${response.status})`);
    return response;
  }
  throw new Error('MAX media redirected too many times');
}

async function jpegFrom(path, directory, index) {
  const output = join(directory, `${index}.jpg`);
  await new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error',
      '-i', path, '-frames:v', '1', '-q:v', '2', output], { stdio: 'ignore' });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg image conversion failed (${code})`)));
  });
  return output;
}

export async function downloadMaxMedia(max, attachment, directory, index) {
  const response = await fetchMedia(await mediaUrl(max, attachment));
  const mime = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > TELEGRAM_UPLOAD_LIMIT) throw new Error('MAX media exceeds Telegram upload limit');
  const extension = EXTENSIONS[mime] ?? (attachment.type === 'file' ? 'bin' : 'dat');
  const path = join(directory, `${index}.${extension}`);
  let bytes = 0;
  await pipeline(Readable.fromWeb(response.body), new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      callback(bytes > TELEGRAM_UPLOAD_LIMIT ? new Error('MAX media exceeds Telegram upload limit') : null, chunk);
    }
  }), createWriteStream(path));
  if (bytes === 0) throw new Error('MAX media download is empty');
  const photo = attachment.type === 'image' && !['image/jpeg', 'image/png', 'image/gif'].includes(mime);
  const finalPath = photo ? await jpegFrom(path, directory, index) : path;
  const photoSuitable = attachment.type !== 'image' || mime === 'image/gif'
    || (await stat(finalPath)).size <= 10 * 1024 * 1024;
  return { type: attachment.type, mime, path: finalPath, photoSuitable,
    filename: attachment.type === 'file'
      ? mediaFilename(response.headers.get('content-disposition'), `document-${index}.${extension}`)
      : `${attachment.type}-${index}.${photo ? 'jpg' : extension}` };
}
