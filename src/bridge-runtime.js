import { createHash } from 'node:crypto';
import { escapeHtml, telegramToMaxHtml } from './formatting.js';
import { localTelegramVideo } from './telegram-video.js';
import { localTelegramPhoto } from './telegram-video.js';
import { redactSensitive } from './redact.js';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const id = (value) => String(value);
const authorized = (policyJson, sender) => {
  if (!sender || sender.is_bot) return false;
  const policy = JSON.parse(policyJson);
  return policy.mode === 'all_non_bot' || (policy.mode === 'allowlist' && policy.ids.includes(id(sender.user_id ?? sender.id)));
};

function mediaTypeTelegram(message) {
  if (message.media_group_id) return 'album';
  for (const type of ['photo', 'video', 'audio', 'voice', 'document', 'sticker', 'poll']) {
    if (message[type]) return type;
  }
  return message.text ? 'text' : 'unsupported';
}

export function acceptTelegram(store, update) {
  const eventKey = `tg:${update.update_id}`;
  store.recordEvent(eventKey, 'telegram');
  if (update.my_chat_member) {
    const change = update.my_chat_member;
    const chat = change.chat;
    const kind = chat.type === 'channel' ? 'channel' : ['group', 'supergroup'].includes(chat.type) ? 'chat' : null;
    if (!kind) return;
    const status = change.new_chat_member?.status;
    store.discover({ platform: 'telegram', kind, id: chat.id, title: chat.title,
      publicLink: chat.username ? `https://t.me/${chat.username}` : null,
      status: ['left', 'kicked'].includes(status) ? 'removed' : 'active',
      rights: change.new_chat_member, source: 'my_chat_member', eventKey,
      eventType: 'my_chat_member', detail: status });
    return;
  }
  const message = update.message ?? update.channel_post;
  if (!message) return;
  const kind = message.chat.type === 'channel' ? 'channel' : ['group', 'supergroup'].includes(message.chat.type) ? 'chat' : null;
  if (!kind) return;
  const chatId = id(message.chat.id);
  store.discover({ platform: 'telegram', kind, id: chatId, title: message.chat.title,
    publicLink: message.chat.username ? `https://t.me/${message.chat.username}` : null,
    source: update.channel_post ? 'channel_post' : 'message' });
  const pair = store.route('telegram', kind, chatId);
  if (!pair) return;
  if (kind === 'chat' && !authorized(pair.telegram_senders, message.from)) return;
  const mediaType = mediaTypeTelegram(message);
  const text = message.text ?? message.caption ?? '';
  const sender = message.from;
  const name = [sender?.first_name, sender?.last_name].filter(Boolean).join(' ') || sender?.username || 'Unknown sender';
  const photo = message.photo?.at(-1);
  const photoItem = photo ? {
    message_id: message.message_id, file_id: photo.file_id, file_size: photo.file_size,
    width: photo.width, height: photo.height
  } : null;
  const sourceMessageId = pair.locked ? message.message_id : message.media_group_id ?? message.message_id;
  const key = `tg:${chatId}:${sourceMessageId}:to_max:${pair.key}`;
  const payload = { targetId: pair.max_id, text, name, kind, mediaType,
    photos: photoItem ? [photoItem] : mediaType === 'album' ? [] : undefined,
    albumUnsupported: mediaType === 'album' && !photoItem,
    video: mediaType === 'video' ? {
      file_id: message.video.file_id, file_size: message.video.file_size,
      mime_type: message.video.mime_type, file_name: message.video.file_name
    } : undefined,
    entities: message.entities ?? message.caption_entities ?? [], legacy: Boolean(pair.locked),
    legacyCaptionOnly: Boolean(pair.locked && mediaType !== 'text' && text) };
  const inserted = store.enqueue({ key,
    pairKey: pair.key, direction: 'tg_to_max', sourceId: chatId,
    sourceMessageId, mediaType,
    payload, delayMs: mediaType === 'album' && !pair.locked ? 5000 : 0 });
  if (!inserted && mediaType === 'album' && !pair.locked) {
    if (!store.appendTelegramAlbum(key, photoItem, text, payload.entities, !photoItem) && photoItem) {
      // An unusually late album item is still delivered as an individual photo.
      store.enqueue({ key: `tg:${chatId}:${message.message_id}:late_photo:${pair.key}`,
        pairKey: pair.key, direction: 'tg_to_max', sourceId: chatId,
        sourceMessageId: message.message_id, mediaType: 'photo',
        payload: { ...payload, mediaType: 'photo' } });
    }
  }
}

export function acceptUnsupportedTelegram(store, update) {
  store.recordEvent(`tg:${update.update_id}`, 'telegram');
  const type = Object.keys(update).find((key) => key !== 'update_id');
  const event = update[type];
  const chat = event?.chat;
  const kind = chat?.type === 'channel' ? 'channel' : ['group', 'supergroup'].includes(chat?.type) ? 'chat' : null;
  if (!kind) return;
  const pair = store.route('telegram', kind, chat.id);
  if (!pair) return;
  store.enqueue({ key: `tg:${chat.id}:${update.update_id}:unsupported:${pair.key}`,
    pairKey: pair.key, direction: 'tg_to_max', sourceId: chat.id,
    sourceMessageId: event.message_id ?? update.update_id, mediaType: type,
    payload: { targetId: pair.max_id, mediaType: type } });
}

export function acceptMax(store, update, rawBody) {
  const eventKey = `max:${hash(rawBody)}`;
  const type = update.update_type;
  const message = update.message;
  const chatId = update.chat_id ?? message?.recipient?.chat_id;
  if (chatId === undefined || chatId === null) return;
  const existing = store.db.prepare("SELECT kind FROM discovered_resources WHERE platform='max' AND resource_id=?").get(String(chatId));
  const kind = update.is_channel === true || message?.recipient?.chat_type === 'channel' ? 'channel'
    : update.is_channel === false || message?.recipient?.chat_type === 'chat' ? 'chat' : existing?.kind ?? null;
  if (!kind) return;
  const title = update.title ?? update.chat_title ?? null;
  const status = type === 'bot_removed' ? 'removed' : type === 'bot_added' ? 'active' : null;
  const discoveryType = ['bot_added', 'bot_removed', 'bot_admin_permissions_changed', 'chat_title_changed'].includes(type) ? type : null;
  store.discover({ platform: 'max', kind, id: chatId, title, status,
    rights: type === 'bot_admin_permissions_changed' ? update.permissions : undefined,
    source: type, eventKey, eventType: discoveryType });
  if (['message_edited', 'message_removed'].includes(type) && kind === 'chat') {
    const pair = store.route('max', 'chat', chatId);
    if (pair?.max_to_telegram) store.enqueue({ key: `max:${chatId}:${eventKey}:unsupported:${pair.key}`,
      pairKey: pair.key, direction: 'max_to_tg', sourceId: chatId,
      sourceMessageId: message?.body?.mid ?? eventKey, mediaType: type,
      payload: { targetId: pair.telegram_id, mediaType: type } });
  }
  if (type !== 'message_created' || kind !== 'chat' || !message) {
    store.recordEvent(eventKey, 'max');
    return;
  }
  const pair = store.route('max', 'chat', chatId);
  if (!pair || !pair.max_to_telegram || !authorized(pair.max_senders, message.sender)) return;
  const body = message.body ?? {};
  if (body.mid === undefined || body.mid === null) return;
  const mediaType = body.attachments?.length ? 'attachments' : body.text ? 'text' : 'unsupported';
  const name = message.sender?.name || [message.sender?.first_name, message.sender?.last_name].filter(Boolean).join(' ') || 'MAX user';
  store.enqueue({ key: `max:${chatId}:${body.mid}:to_tg:${pair.key}`,
    pairKey: pair.key, direction: 'max_to_tg', sourceId: chatId,
    sourceMessageId: body.mid, mediaType,
    payload: { targetId: pair.telegram_id, text: body.text ?? '', name, kind, mediaType,
      legacy: Boolean(pair.locked),
      legacyCaptionOnly: Boolean(pair.locked && mediaType !== 'text' && body.text) } });
  store.recordEvent(eventKey, 'max');
}

export function createWorker({ store, max, telegram, log, telegramToken }) {
  let busy = false;
  let lastMaxSend = 0;
  async function tick() {
    if (busy) return;
    const job = store.nextDelivery();
    if (!job) return;
    busy = true;
    store.startDelivery(job.id);
    try {
      const payload = JSON.parse(job.payload);
      const sendVideo = job.direction === 'tg_to_max' && job.media_type === 'video'
        && payload.video?.file_id && !payload.legacy;
      const sendPhotos = job.direction === 'tg_to_max' && ['photo', 'album'].includes(job.media_type)
        && payload.photos?.length && !payload.albumUnsupported && !payload.legacy;
      if (job.media_type !== 'text' && !payload.legacyCaptionOnly && !sendVideo && !sendPhotos) {
        store.finishDelivery(job.id, 'unsupported', null, `Media type ${job.media_type} is not implemented`);
        return;
      }
      const deliveredStatus = payload.legacyCaptionOnly ? 'partial' : 'sent';
      if (job.direction === 'tg_to_max') {
        const wait = Math.max(0, 500 - (Date.now() - lastMaxSend));
        if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
        lastMaxSend = Date.now();
        const content = payload.legacy ? payload.text : telegramToMaxHtml(payload.text, payload.entities);
        const outgoing = payload.kind === 'channel' ? content : payload.legacy
          ? `**${payload.name}**\n${content}` : `<b>${escapeHtml(payload.name)}</b>\n${content}`;
        if (outgoing.length > 4000 && !payload.legacy) {
          store.finishDelivery(job.id, 'failed', null, 'MAX text limit of 4000 characters exceeded');
          return;
        }
        let result;
        if (sendVideo) result = await max.sendVideo(payload.targetId,
          await localTelegramVideo(telegram, payload.video), outgoing, 'html', payload.video.mime_type);
        else if (sendPhotos) {
          const files = [];
          for (const photo of payload.photos) files.push(await localTelegramPhoto(telegram, photo));
          result = await max.sendPhotos(payload.targetId, files, outgoing, 'html');
        } else result = await max.sendText(payload.targetId,
          payload.legacy ? outgoing.slice(0, 4000) : outgoing, payload.legacy ? 'markdown' : 'html');
        store.finishDelivery(job.id, deliveredStatus, [result.message?.body?.mid ?? result.message?.mid].filter(Boolean),
          payload.legacyCaptionOnly ? 'Legacy caption delivered without media' : null);
      } else {
        const outgoing = `[MAX] ${payload.name}:\n${payload.text}`;
        if (outgoing.length > 4096 && !payload.legacy) {
          store.finishDelivery(job.id, 'failed', null, 'Telegram text limit of 4096 characters exceeded');
          return;
        }
        const result = await telegram.api.sendMessage(payload.targetId,
          payload.legacy ? outgoing.slice(0, 4096) : outgoing);
        store.finishDelivery(job.id, deliveredStatus, [String(result.message_id)],
          payload.legacyCaptionOnly ? 'Legacy caption delivered without media' : null);
      }
    } catch (error) {
      const message = redactSensitive(error.message ?? error, telegramToken).slice(0, 500);
      const retryAfter = error.parameters?.retry_after;
      const knownRetry = retryAfter || /\b(?:429|5\d\d)\b/.test(message);
      const definiteFailure = /\b4\d\d\b/.test(message) && !knownRetry;
      if (knownRetry && job.attempts < 5) {
        store.finishDelivery(job.id, 'retrying', null, message,
          retryAfter ? retryAfter * 1000 : Math.min(60_000, 1000 * 2 ** job.attempts));
      } else {
        // A connection failure after POST can mean that the remote post exists.
        store.finishDelivery(job.id, knownRetry || definiteFailure ? 'failed' : 'unknown', null, message);
      }
      log('error', 'Delivery failed', { deliveryId: job.id, error: message });
    } finally { busy = false; }
  }
  const timer = setInterval(() => void tick(), 500);
  timer.unref();
  return { tick, stop: () => clearInterval(timer) };
}
