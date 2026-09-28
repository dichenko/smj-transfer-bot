import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { InputFile } from 'grammy';

const MAX_DOCUMENT_BYTES = 50_000_000;

export async function sendLogs(ctx, { allowedUserIds, logFile, log }) {
  if (ctx.chat?.type !== 'private' || !allowedUserIds.has(String(ctx.from?.id))) return;

  let temporaryDirectory;
  try {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'bridge-logs-'));
    const snapshotPath = join(temporaryDirectory, basename(logFile));
    await copyFile(logFile, snapshotPath);
    const file = await stat(snapshotPath);
    if (!file.isFile() || file.size === 0) {
      await ctx.reply('Журнал пока пуст.');
      return;
    }

    if (file.size <= MAX_DOCUMENT_BYTES) {
      await ctx.replyWithDocument(new InputFile(snapshotPath, basename(snapshotPath)));
      return;
    }

    const archivePath = join(temporaryDirectory, `${basename(logFile)}.gz`);
    await pipeline(createReadStream(snapshotPath), createGzip(), createWriteStream(archivePath));

    if ((await stat(archivePath)).size > MAX_DOCUMENT_BYTES) {
      await ctx.reply('Журнал слишком большой для отправки через Telegram, даже после сжатия. Заберите его с сервера.');
      return;
    }

    await ctx.replyWithDocument(new InputFile(archivePath, basename(archivePath)));
  } catch (error) {
    if (error.code === 'ENOENT') {
      await ctx.reply('Журнал пока не создан.');
      return;
    }
    log('error', 'Failed to send log file', { userId: ctx.from.id, error: error.message });
    await ctx.reply('Не удалось отправить журнал. Попробуйте позже.');
  } finally {
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
