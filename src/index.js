import { Bot } from 'grammy';
import { config } from './config.js';
import { MaxClient } from './max-client.js';
import { startWebhookServer } from './webhook-server.js';

const max = new MaxClient(config.maxToken);
const telegram = new Bot(config.telegramToken);

function log(level, message, extra = undefined) {
  const levels = { debug: 10, info: 20, warn: 30, error: 40 };
  if (levels[level] < (levels[config.logLevel] ?? 20)) return;
  const suffix = extra === undefined ? '' : ` ${JSON.stringify(extra)}`;
  console.log(`${new Date().toISOString()} ${level.toUpperCase()} ${message}${suffix}`);
}

function authorName(from) {
  if (!from) return 'Unknown sender';
  return [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || 'Unknown sender';
}

function messageText(message) {
  return message.text ?? message.caption ?? null;
}

function messagePreview(message) {
  const text = messageText(message);
  return text === null ? null : Array.from(text).slice(0, 100).join('');
}

function telegramUserDetails(user) {
  return {
    userId: user?.id,
    username: user?.username ?? null,
    firstName: user?.first_name ?? null,
    lastName: user?.last_name ?? null,
    isBot: user?.is_bot ?? false
  };
}

function maxUserDetails(user) {
  return {
    userId: user?.user_id,
    username: user?.username ?? null,
    firstName: user?.first_name ?? null,
    lastName: user?.last_name ?? null,
    isBot: user?.is_bot ?? false,
    lastActivityTime: user?.last_activity_time ?? null
  };
}

function isConfiguredTelegramGroup(chat) {
  return config.telegramSourceChatId !== null
    && ['group', 'supergroup'].includes(chat.type)
    && chat.id === config.telegramSourceChatId;
}

function isConfiguredMaxGroup(message, update) {
  const chatId = message?.recipient?.chat_id ?? update.chat_id;
  return config.maxTargetChatId !== null
    && message?.recipient?.chat_type === 'chat'
    && String(chatId) === String(config.maxTargetChatId);
}

function logMaxDebugUpdate(update) {
  const message = update.message;
  const chatId = message?.recipient?.chat_id ?? update.chat_id ?? null;
  const details = {
    type: update.update_type ?? 'unknown',
    chatId,
    chatType: message?.recipient?.chat_type ?? null,
    messageId: message?.body?.mid ?? null,
    user: message?.sender ? maxUserDetails(message.sender) : null,
    messagePreview: message?.body ? messagePreview(message.body) : null
  };
  log('info', 'MAX debug update', details);

  if (update.update_type === 'bot_added' && chatId !== null) {
    log('warn', 'Set MAX_TARGET_CHAT_ID to this chat ID and restart the service', { chatId });
  }
}

async function relayToMax(message) {
  const text = messageText(message);
  if (!text) {
    log('info', 'Skipped Telegram message without text or caption', { messageId: message.message_id });
    return;
  }

  const outgoing = `**${authorName(message.from)}**\n${text}`;
  await max.sendText(config.maxTargetChatId, outgoing.slice(0, 4000));
  log('info', 'Relayed Telegram message to MAX', { messageId: message.message_id });
}

async function relayToTelegram(message) {
  if (config.telegramSourceChatId === null) return;
  const text = message?.body?.text;
  if (!text) {
    log('info', 'Skipped MAX message without text', { messageId: message?.body?.mid });
    return;
  }

  const sender = message.sender?.name
    ?? [message.sender?.first_name, message.sender?.last_name].filter(Boolean).join(' ')
    ?? 'MAX user';
  await telegram.api.sendMessage(
    config.telegramSourceChatId,
    `[MAX] ${sender}:\n${text}`.slice(0, 4096)
  );
  log('info', 'Relayed MAX message to Telegram', { messageId: message?.body?.mid });
}

telegram.on('message', async (ctx) => {
  if (!isConfiguredTelegramGroup(ctx.chat)) return;

  const sender = telegramUserDetails(ctx.from);
  log('info', 'Telegram group user observed', {
    chatId: ctx.chat.id,
    user: sender,
    messagePreview: messagePreview(ctx.message)
  });

  if (sender.isBot) return;
  if (!config.telegramAllowedUserIds.has(String(sender.userId))) {
    log('info', 'Telegram message ignored: sender is not allowlisted', { chatId: ctx.chat.id, userId: sender.userId });
    return;
  }
  if (config.maxTargetChatId === null) {
    log('warn', 'MAX_TARGET_CHAT_ID is unset; Telegram message not forwarded', { messageId: ctx.message.message_id });
    return;
  }

  try {
    await relayToMax(ctx.message);
  } catch (error) {
    log('error', 'Failed to relay Telegram message', { messageId: ctx.message.message_id, error: error.message });
  }
});

telegram.catch((error) => log('error', 'Telegram polling error', { error: error.message }));

await startWebhookServer({
  port: config.appPort,
  secret: config.maxWebhookSecret,
  log,
  onUpdate: async (update) => {
    if (config.maxDebugLogAllUpdates) {
      logMaxDebugUpdate(update);
      return;
    }
    if (update.update_type === 'message_created') {
      const message = update.message;
      if (!isConfiguredMaxGroup(message, update)) return;

      const sender = maxUserDetails(message.sender);
      log('info', 'MAX group user observed', {
        chatId: message.recipient.chat_id,
        user: sender,
        messagePreview: messagePreview(message.body)
      });

      if (sender.isBot) return;
      if (!config.maxAllowedUserIds.has(String(sender.userId))) {
        log('info', 'MAX message ignored: sender is not allowlisted', {
          chatId: message.recipient.chat_id,
          userId: sender.userId
        });
        return;
      }
      try {
        await relayToTelegram(message);
      } catch (error) {
        log('error', 'Failed to relay MAX message to Telegram', { error: error.message });
      }
    }
  }
});

await max.subscribeToWebhook({ url: config.maxWebhookUrl, secret: config.maxWebhookSecret });
log('info', 'MAX webhook subscription is active', { url: config.maxWebhookUrl });

await telegram.api.deleteWebhook({ drop_pending_updates: false });
log('info', 'Starting Telegram long polling', { sourceChatId: config.telegramSourceChatId });

await telegram.start({ allowed_updates: ['message'] });
