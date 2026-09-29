import { Bot } from 'grammy';
import { config } from '../src/config.js';
import { Store } from '../src/store.js';

const deliveryId = Number(process.argv[2]);
if (!Number.isSafeInteger(deliveryId) || deliveryId < 1) throw new Error('Pass a delivery ID');
if (!config.telegramApiRoot) throw new Error('TELEGRAM_API_ROOT is required');
if (config.adminTelegramUserIds.size !== 1) throw new Error('Exactly one admin Telegram ID is required');

const store = new Store(config.databasePath);
try {
  const job = store.db.prepare('SELECT * FROM deliveries WHERE id=?').get(deliveryId);
  if (!job || job.direction !== 'tg_to_max' || job.media_type !== 'video' || job.status !== 'unsupported') {
    throw new Error('Delivery must be an unsupported Telegram video');
  }
  const payload = JSON.parse(job.payload);
  if (payload.video?.file_id) throw new Error('Delivery already has a video file_id');
  const telegram = new Bot(config.telegramToken, { client: { apiRoot: config.telegramApiRoot } });
  const adminId = [...config.adminTelegramUserIds][0];
  let forwarded;
  try {
    forwarded = await telegram.api.forwardMessage(adminId, job.source_id, Number(job.source_message_id));
    if (!forwarded.video?.file_id) throw new Error('Forwarded message does not contain a video');
    payload.video = {
      file_id: forwarded.video.file_id,
      file_size: forwarded.video.file_size,
      mime_type: forwarded.video.mime_type,
      file_name: forwarded.video.file_name
    };
    const result = store.db.prepare(`UPDATE deliveries SET payload=?,status='queued',attempts=0,
      next_attempt_at=?,error=NULL,updated_at=? WHERE id=? AND status='unsupported'`).run(
      JSON.stringify(payload), new Date().toISOString(), new Date().toISOString(), deliveryId);
    if (result.changes !== 1) throw new Error('Delivery changed before replay');
    console.log(`Queued Telegram video delivery ${deliveryId}; size ${payload.video.file_size} bytes`);
  } finally {
    if (forwarded) {
      try { await telegram.api.deleteMessage(adminId, forwarded.message_id); }
      catch (error) { console.error('Could not remove temporary forwarded message:', error.message); }
    }
  }
} finally { store.close(); }
