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

const store = new Store(config.databasePath);
store.migrate();
const imported = store.importLegacy(config);
const max = new MaxClient(config.maxToken);
const telegram = new Bot(config.telegramToken);

function log(level, message, extra) {
  const levels = { debug: 10, info: 20, warn: 30, error: 40 };
  if (levels[level] < (levels[config.logLevel] ?? 20)) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase()} ${message}${extra ? ` ${JSON.stringify(extra)}` : ''}`;
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
  onReceive: (update, rawBody) => acceptMax(store, update, rawBody),
  onUpdate: async (update) => {
    if (!['bot_added', 'bot_admin_permissions_changed', 'chat_title_changed'].includes(update.update_type)) return;
    if (update.chat_id === undefined) return;
    try {
      const chat = await max.getChat(update.chat_id);
      if (!['chat', 'channel'].includes(chat.type)) return;
      const member = await max.request(`/chats/${encodeURIComponent(String(update.chat_id))}/members/me`);
      store.checkedResource('max', chat.type, update.chat_id, chat.title, chat.status, member.permissions ?? [], chat.link);
    } catch (error) { log('warn', 'MAX chat metadata refresh failed', { chatId: update.chat_id, error: error.message }); }
  }
});

// A process can die after POST and before recording its result. Hold those jobs for review.
store.db.prepare("UPDATE deliveries SET status='unknown',error='Interrupted while sending' WHERE status='uploading'").run();
const worker = createWorker({ store, max, telegram, log });
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
