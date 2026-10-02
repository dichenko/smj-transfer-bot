import { createHash } from 'node:crypto';
import { escapeHtml, telegramToMaxHtml } from './formatting.js';
import { localTelegramPhoto, localTelegramVideo, localTelegramVoice,
  localTelegramAudio, localTelegramDocument } from './telegram-video.js';
import { withConvertedVoice } from './voice-convert.js';
import { sendMaxToTelegram } from './telegram-outgoing.js';
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
  if (store.wasRelayed(pair.key, 'telegram', message.message_id)) return;
  const mediaType = mediaTypeTelegram(message);
  const text = message.text ?? message.caption ?? '';
  const sender = message.from;
  const name = [sender?.first_name, sender?.last_name].filter(Boolean).join(' ') || sender?.username || 'Unknown sender';
  const photo = message.photo?.at(-1);
  const mediaItem = photo ? { type: 'image', message_id: message.message_id,
    file_id: photo.file_id, file_size: photo.file_size,
    width: photo.width, height: photo.height }
    : message.video ? { type: 'video', message_id: message.message_id,
      file_id: message.video.file_id, file_size: message.video.file_size,
      mime_type: message.video.mime_type, file_name: message.video.file_name } : null;
  const sourceMessageId = message.media_group_id ?? message.message_id;
  const key = `tg:${chatId}:${sourceMessageId}:to_max:${pair.key}`;
  const payload = { targetId: pair.max_id, text, name, kind, mediaType,
    media: mediaItem ? [mediaItem] : mediaType === 'album' ? [] : undefined,
    albumUnsupported: mediaType === 'album' && !mediaItem,
    voice: mediaType === 'voice' ? {
      file_id: message.voice.file_id, file_size: message.voice.file_size,
      duration: message.voice.duration, mime_type: message.voice.mime_type
    } : undefined,
    audio: mediaType === 'audio' ? {
      file_id: message.audio.file_id, file_size: message.audio.file_size,
      mime_type: message.audio.mime_type, file_name: message.audio.file_name
    } : undefined,
    document: mediaType === 'document' ? {
      file_id: message.document.file_id, file_size: message.document.file_size,
      mime_type: message.document.mime_type, file_name: message.document.file_name
    } : undefined,
    entities: message.entities ?? message.caption_entities ?? [], legacy: Boolean(pair.locked),
    legacyCaptionOnly: false };
  const inserted = store.enqueue({ key,
    pairKey: pair.key, direction: 'tg_to_max', sourceId: chatId,
    sourceMessageId, mediaType,
    payload, delayMs: mediaType === 'album' ? 5000 : 0 });
  if (!inserted && mediaType === 'album') {
    if (!store.appendTelegramAlbum(key, mediaItem, text, payload.entities, !mediaItem) && mediaItem) {
      // An unusually late album item is delivered individually.
      const lateType = mediaItem.type === 'image' ? 'photo' : 'video';
      store.enqueue({ key: `tg:${chatId}:${message.message_id}:late_media:${pair.key}`,
        pairKey: pair.key, direction: 'tg_to_max', sourceId: chatId,
        sourceMessageId: message.message_id, mediaType: lateType,
        payload: { ...payload, mediaType: lateType } });
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
  if (['message_edited', 'message_removed'].includes(type)) {
    const pair = store.route('max', kind, chatId);
    if (pair?.max_to_telegram) store.enqueue({ key: `max:${chatId}:${eventKey}:unsupported:${pair.key}`,
      pairKey: pair.key, direction: 'max_to_tg', sourceId: chatId,
      sourceMessageId: message?.body?.mid ?? eventKey, mediaType: type,
      payload: { targetId: pair.telegram_id, mediaType: type } });
  }
  if (type !== 'message_created' || !message) {
    store.recordEvent(eventKey, 'max');
    return;
  }
  const pair = store.route('max', kind, chatId);
  if (!pair || !pair.max_to_telegram || (kind === 'chat' && !authorized(pair.max_senders, message.sender))) return;
  const body = message.body ?? {};
  if (body.mid === undefined || body.mid === null) return;
  if (store.wasRelayed(pair.key, 'max', body.mid)) return;
  const attachments = body.attachments ?? [];
  const mediaType = attachments.some((attachment) => ['image', 'video', 'audio', 'file'].includes(attachment.type))
    ? 'attachments' : body.text || attachments.length ? 'text' : 'unsupported';
  const name = message.sender?.name || [message.sender?.first_name, message.sender?.last_name].filter(Boolean).join(' ') || 'MAX user';
  store.enqueue({ key: `max:${chatId}:${body.mid}:to_tg:${pair.key}`,
    pairKey: pair.key, direction: 'max_to_tg', sourceId: chatId,
    sourceMessageId: body.mid, mediaType,
    payload: { targetId: pair.telegram_id, text: body.text ?? '', name, kind, mediaType,
      attachments, markup: body.markup ?? [],
      legacy: Boolean(pair.locked),
      legacyCaptionOnly: false } });
  store.recordEvent(eventKey, 'max');
}

export function createWorker({ store, max, telegram, log, telegramToken, mediaRoot,
  convertVoice = withConvertedVoice, onFailure = () => {}, maxAttempts = 6 }) {
  let busy = false;
  let lastMaxSend = 0;
  async function tick() {
    if (busy) return;
    const job = store.nextDelivery();
    if (!job) return;
    busy = true;
    store.startDelivery(job.id);
    let stage = 'preparing';
    const onPublish = () => {
      store.setDeliveryStage(job.id, 'publishing');
      stage = 'publishing';
    };
    try {
      const payload = JSON.parse(job.payload);
      const sourcePlatform = job.direction === 'tg_to_max' ? 'telegram' : 'max';
      const sourceIds = job.direction === 'tg_to_max' && payload.media?.length
        ? payload.media.map((item) => item.message_id) : [job.source_message_id];
      if (sourceIds.some((messageId) => store.wasRelayed(job.pair_key, sourcePlatform, messageId))) {
        store.finishDelivery(job.id, 'ignored', null, 'Already relayed from the other platform');
        return;
      }
      const media = payload.media ?? (payload.photos?.map((photo) => ({ ...photo, type: 'image' }))
        ?? (payload.video ? [{ ...payload.video, type: 'video' }] : []));
      const sendMedia = job.direction === 'tg_to_max' && ['photo', 'video', 'album'].includes(job.media_type)
        && media.length > 0 && !payload.albumUnsupported;
      const sendVoice = job.direction === 'tg_to_max' && job.media_type === 'voice'
        && payload.voice?.file_id;
      const sendFile = job.direction === 'tg_to_max' && ['audio', 'document'].includes(job.media_type)
        && payload[job.media_type]?.file_id;
      const sendMaxMedia = job.direction === 'max_to_tg' && job.media_type === 'attachments';
      if (job.media_type !== 'text' && !payload.legacyCaptionOnly && !sendMedia && !sendVoice
          && !sendFile && !sendMaxMedia) {
        store.finishDelivery(job.id, 'unsupported', null, `Media type ${job.media_type} is not implemented`);
        return;
      }
      const deliveredStatus = payload.legacyCaptionOnly ? 'partial' : 'sent';
      if (job.direction === 'tg_to_max') {
        const wait = Math.max(0, 500 - (Date.now() - lastMaxSend));
        if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
        lastMaxSend = Date.now();
        const legacyText = payload.legacy && !sendMedia && !sendVoice && !sendFile;
        const content = legacyText ? payload.text : telegramToMaxHtml(payload.text, payload.entities);
        const visibleContent = sendVoice && !content ? 'Голосовое сообщение' : content;
        const outgoing = payload.kind === 'channel' ? visibleContent : legacyText
          ? `**${payload.name}**\n${visibleContent}` : `<b>${escapeHtml(payload.name)}</b>\n${visibleContent}`;
        if (outgoing.length > 4000 && !legacyText) {
          store.finishDelivery(job.id, 'failed', null, 'MAX text limit of 4000 characters exceeded');
          onFailure({ ...job, status: 'failed', stage });
          return;
        }
        let result;
        if (sendMedia) {
          const files = [];
          for (const item of media) files.push({ type: item.type,
            path: item.type === 'image'
              ? await localTelegramPhoto(telegram, item, mediaRoot)
              : await localTelegramVideo(telegram, item, mediaRoot),
            mimeType: item.mime_type });
          result = await max.sendMedia(payload.targetId, files, outgoing, 'html', onPublish);
        } else if (sendVoice) {
          const voicePath = await localTelegramVoice(telegram, payload.voice, mediaRoot);
          result = await convertVoice(voicePath,
            (convertedPath) => max.sendAudio(payload.targetId, convertedPath, outgoing, 'html', onPublish));
        } else if (sendFile) {
          const item = payload[job.media_type];
          const path = job.media_type === 'audio'
            ? await localTelegramAudio(telegram, item, mediaRoot)
            : await localTelegramDocument(telegram, item, mediaRoot);
          const audio = job.media_type === 'audio' && ['audio/mpeg', 'audio/mp4', 'audio/x-m4a', 'audio/aac']
            .includes(item.mime_type);
          result = await max.sendFile(payload.targetId, path, outgoing,
            item.mime_type || 'application/octet-stream', item.file_name || `${job.media_type}.bin`,
            audio ? 'audio' : 'file', onPublish);
        } else {
          onPublish();
          result = await max.sendText(payload.targetId,
            legacyText ? outgoing.slice(0, 4000) : outgoing, legacyText ? 'markdown' : 'html');
        }
        store.finishDelivery(job.id, deliveredStatus, [result.message?.body?.mid ?? result.message?.mid].filter(Boolean),
          payload.legacyCaptionOnly ? 'Legacy caption delivered without media' : null);
      } else {
        if (sendMaxMedia && typeof max.request === 'function') {
          try {
            const latest = await max.request(`/messages/${encodeURIComponent(job.source_message_id)}`);
            if (latest.body?.attachments) payload.attachments = latest.body.attachments;
          } catch { /* Use the attachment URLs saved with the webhook event. */ }
        }
        if (payload.legacy && job.media_type === 'text' && !payload.attachments?.length) {
          const outgoing = `[MAX] ${payload.name}:\n${payload.text}`;
          onPublish();
          const result = await telegram.api.sendMessage(payload.targetId, outgoing.slice(0, 4096));
          store.finishDelivery(job.id, deliveredStatus, [String(result.message_id)],
            payload.legacyCaptionOnly ? 'Legacy caption delivered without media' : null);
        } else {
          const result = await sendMaxToTelegram(telegram, max, payload, onPublish);
          store.finishDelivery(job.id, result.status, result.ids, result.note);
        }
      }
    } catch (error) {
      const message = redactSensitive(error.message ?? error, telegramToken).slice(0, 500);
      const retryAfter = error.parameters?.retry_after;
      const apiCode = error.error_code;
      const knownRetry = retryAfter || apiCode === 429 || apiCode >= 500;
      const rateLimited = retryAfter || apiCode === 429;
      const definiteFailure = apiCode >= 400 && apiCode < 500 && !rateLimited;
      const transient = knownRetry || ['HttpError', 'TimeoutError', 'AbortError'].includes(error.name)
        || /network|fetch failed|incomplete|ENOENT|ECONN|ETIMEDOUT|EAI_AGAIN/i.test(message);
      const beforeSend = stage === 'preparing' || error.beforeSend;
      // Only explicit API rejection is safe to retry after publication starts.
      const safeRetry = beforeSend ? transient : rateLimited;
      let status;
      let delayMs = 0;
      if (safeRetry && job.attempts + 1 < maxAttempts && !error.sentIds?.length) {
        status = 'retrying';
        delayMs = retryAfter ? retryAfter * 1000 : Math.min(60_000, 2000 * 2 ** job.attempts);
        store.finishDelivery(job.id, 'retrying', null, message,
          delayMs);
      } else {
        // A connection failure after POST can mean that the remote post exists.
        status = error.sentIds?.length ? 'unknown'
          : beforeSend || rateLimited || definiteFailure ? 'failed' : 'unknown';
        store.finishDelivery(job.id, status, error.sentIds, message);
      }
      const cause = error.error ?? error.cause;
      log('error', 'Delivery failed', { deliveryId: job.id, pairKey: job.pair_key,
        direction: job.direction, stage, status, attempt: job.attempts + 1, delayMs,
        error: message, cause: redactSensitive(cause?.message ?? '', telegramToken)
          .replace(/https?:\/\/\S+/g, '[redacted-url]').slice(0, 300),
        causeCode: cause?.code ?? cause?.cause?.code });
      if (status !== 'retrying') {
        // Notifications use a separate queue and never delay delivery processing.
        try { onFailure({ ...job, status, stage }); }
        catch (notificationError) { log('warn', 'Could not queue delivery alert', { error: notificationError.message }); }
      }
    } finally { busy = false; }
  }
  const timer = setInterval(() => void tick(), 500);
  timer.unref();
  return { tick, stop: () => clearInterval(timer) };
}
