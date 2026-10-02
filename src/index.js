import { Bot } from 'grammy';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';
import { sendLogs } from './log-command.js';
import { Store } from './store.js';
import { MaxClient } from './max-client.js';
import { acceptTelegram, acceptUnsupportedTelegram, acceptMax, createWorker } from './bridge-runtime.js';
import { TELEGRAM_UPDATE_TYPES } from './update-types.js';
import { startWebhookServer } from './webhook-server.js';
import { issueLoginLink, handleLoginCallback } from './login.js';
import { redactSensitive } from './redact.js';
import { maxRefreshMode, refreshMaxResource, refreshMissingResources } from './resource-metadata.js';
import { createDeliveryMonitor, deliveryHealth } from './delivery-monitor.js';

const store = new Store(config.databasePath);
store.migrate();
const imported = store.importLegacy(config);
const max = new MaxClient(config.maxToken);
const telegram = new Bot(config.telegramToken, config.telegramApiRoot
  ? { client: { apiRoot: config.telegramApiRoot } } : undefined);
const telegramClient = config.telegramApiRoot ? { apiRoot: config.telegramApiRoot } : {};
telegram.fileApi = new Bot(config.telegramToken, { client: { ...telegramClient,
  timeoutSeconds: Math.max(config.telegramPhotoTimeoutSeconds, config.telegramLargeFileTimeoutSeconds) } }).api;
telegram.fileTimeouts = { photo: config.telegramPhotoTimeoutSeconds * 1000,
  large: config.telegramLargeFileTimeoutSeconds * 1000 };
// Independent API calls only; this client never starts a second poller.
const alertTelegram = new Bot(config.telegramToken, { client: { ...telegramClient, timeoutSeconds: 30 } });

function log(level, message, extra) {
  const levels = { debug: 10, info: 20, warn: 30, error: 40 };
  if (levels[level] < (levels[config.logLevel] ?? 20)) return;
  const line = redactSensitive(`${new Date().toISOString()} ${level.toUpperCase()} ${message}${extra ? ` ${JSON.stringify(extra)}` : ''}`,
    config.telegramToken);
  console.log(line);
  try {
    mkdirSync(dirname(config.logFile), { recursive: true });
    appendFileSync(config.logFile, `${line}\n`);
  } catch (error) { console.error('Unable to write log:', error.message); }
}

if (imported) log('info', 'Imported legacy pair', { key: 'main-chat' });

telegram.command('logs', (ctx, next) => {
  if (ctx.chat.type !== 'private') return next();
  return sendLogs(ctx, {
    allowedUserIds: config.telegramAllowedUserIds,
    logFile: config.logFile,
    log
  });
});

telegram.on('message', async (ctx) => {
  if (ctx.chat.type === 'private' && /^\/admin(?:@\w+)?(?:\s|$)/.test(ctx.message.text ?? '')) {
    await issueLoginLink({ store, config, ctx, log });
    return;
  }
  acceptTelegram(store, ctx.update);
});
telegram.on('channel_post', (ctx) => acceptTelegram(store, ctx.update));
telegram.on('my_chat_member', (ctx) => acceptTelegram(store, ctx.update));
telegram.on(['edited_message', 'edited_channel_post', 'message_reaction', 'message_reaction_count'],
  (ctx) => acceptUnsupportedTelegram(store, ctx.update));
telegram.on('callback_query:data', async (ctx) => handleLoginCallback({ store, config, ctx, log }));
telegram.catch((error) => log('error', 'Telegram polling error', { error: error.message }));

await startWebhookServer({
  port: config.appPort,
  secret: config.maxWebhookSecret,
  log,
  getDeliveryHealth: () => deliveryHealth(store, config.deliveryStallSeconds),
  onReceive: (update, rawBody) => acceptMax(store, update, rawBody),
  onUpdate: async (update) => {
    const chatId = update.chat_id ?? update.message?.recipient?.chat_id;
    if (chatId === undefined || chatId === null) return;
    const row = store.db.prepare("SELECT title,bot_status FROM discovered_resources WHERE platform='max' AND resource_id=?")
      .get(String(chatId));
    if (!row) return;
    const mode = maxRefreshMode(row, update.update_type);
    if (!mode) return;
    try {
      await refreshMaxResource(store, max, chatId, mode === 'rights');
    } catch (error) { log('warn', 'MAX chat metadata refresh failed', { chatId, error: error.message }); }
  }
});

let refreshingMetadata = false;
async function refreshMissingMetadata() {
  if (refreshingMetadata) return;
  refreshingMetadata = true;
  try { await refreshMissingResources(store, max, telegram, log); }
  finally { refreshingMetadata = false; }
}
void refreshMissingMetadata().catch((error) => log('warn', 'Resource metadata scan failed', { error: error.message }));
setInterval(() => void refreshMissingMetadata().catch((error) =>
  log('warn', 'Resource metadata scan failed', { error: error.message })), 300_000).unref();

// A process can die after POST and before recording its result. Hold those jobs for review.
const interrupted = store.recoverInterrupted();
const monitor = createDeliveryMonitor({ store, telegram: alertTelegram, adminIds: config.adminTelegramUserIds,
  log, stallSeconds: config.deliveryStallSeconds });
for (const job of interrupted) monitor.alert(job);
const worker = createWorker({ store, max, telegram, log, telegramToken: config.telegramToken,
  maxAttempts: config.deliveryMaxAttempts, onFailure: monitor.alert });
void monitor.tick();
await worker.tick();
await max.subscribeToWebhook({ url: config.maxWebhookUrl, secret: config.maxWebhookSecret });
log('info', 'MAX webhook subscription is active', { url: config.maxWebhookUrl });
try {
  await telegram.api.deleteWebhook({ drop_pending_updates: false });
  log('info', 'Starting Telegram polling');
  await telegram.start({ allowed_updates: TELEGRAM_UPDATE_TYPES });
} catch (error) {
  // grammY network errors can include the bot token in their nested URL.
  log('error', 'Telegram polling stopped', { error: error.message });
  process.exit(1);
}
