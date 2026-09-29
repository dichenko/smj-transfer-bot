import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';

export const TELEGRAM_FILE_ROOT = '/var/lib/telegram-bot-api';
const MAX_VIDEO_LIMIT = 250 * 1024 * 1024;

export async function localTelegramVideo(telegram, video, root = TELEGRAM_FILE_ROOT) {
  if (!video?.file_id) throw new Error('Telegram video file_id is missing');
  if (video.file_size > MAX_VIDEO_LIMIT) throw new Error('Video exceeds MAX 250 MB limit');
  const file = await telegram.api.getFile(video.file_id);
  if (!isAbsolute(file.file_path ?? '')) throw new Error('Telegram Bot API local file path is unavailable');
  const [rootPath, filePath] = await Promise.all([realpath(root), realpath(file.file_path)]);
  const inside = relative(rootPath, filePath);
  if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new Error('Telegram video path is outside the shared volume');
  }
  const details = await stat(filePath);
  if (!details.isFile() || details.size === 0) throw new Error('Telegram video is empty or not a file');
  if (details.size > MAX_VIDEO_LIMIT) throw new Error('Video exceeds MAX 250 MB limit');
  if (video.file_size && details.size !== video.file_size) throw new Error('Telegram video download is incomplete');
  return filePath;
}
