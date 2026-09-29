import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';

export const TELEGRAM_FILE_ROOT = '/var/lib/telegram-bot-api';
const MAX_VIDEO_LIMIT = 250 * 1024 * 1024;
const MAX_PHOTO_LIMIT = 50 * 1024 * 1024;
const MAX_AUDIO_LIMIT = 256 * 1024 * 1024;

async function localTelegramFile(telegram, media, limit, label, root) {
  if (!media?.file_id) throw new Error(`Telegram ${label} file_id is missing`);
  if (media.file_size > limit) throw new Error(`${label} exceeds MAX size limit`);
  const file = await telegram.api.getFile(media.file_id);
  if (!isAbsolute(file.file_path ?? '')) throw new Error('Telegram Bot API local file path is unavailable');
  const [rootPath, filePath] = await Promise.all([realpath(root), realpath(file.file_path)]);
  const inside = relative(rootPath, filePath);
  if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new Error('Telegram video path is outside the shared volume');
  }
  const details = await stat(filePath);
  if (!details.isFile() || details.size === 0) throw new Error(`Telegram ${label} is empty or not a file`);
  if (details.size > limit) throw new Error(`${label} exceeds MAX size limit`);
  if (media.file_size && details.size !== media.file_size) throw new Error(`Telegram ${label} download is incomplete`);
  return filePath;
}

export async function localTelegramVideo(telegram, video, root = TELEGRAM_FILE_ROOT) {
  return localTelegramFile(telegram, video, MAX_VIDEO_LIMIT, 'video', root);
}

export async function localTelegramPhoto(telegram, photo, root = TELEGRAM_FILE_ROOT) {
  if (photo.width > 7680 || photo.height > 7680) throw new Error('Photo exceeds MAX dimension limit');
  return localTelegramFile(telegram, photo, MAX_PHOTO_LIMIT, 'photo', root);
}

export async function localTelegramVoice(telegram, voice, root = TELEGRAM_FILE_ROOT) {
  if (voice.duration > 3600) throw new Error('Voice exceeds MAX 60 minute limit');
  return localTelegramFile(telegram, voice, MAX_AUDIO_LIMIT, 'voice', root);
}
