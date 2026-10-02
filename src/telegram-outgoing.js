import { InputFile } from 'grammy';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadMaxMedia } from './max-media.js';
import { escapeHtml, telegramToMaxHtml } from './formatting.js';

const MEDIA_TYPES = new Set(['image', 'video', 'audio', 'file']);

function describeAttachments(attachments) {
  const media = [];
  const links = [];
  const unsupported = [];
  for (const attachment of attachments) {
    if (MEDIA_TYPES.has(attachment.type)) { media.push(attachment); continue; }
    if (attachment.type === 'share' && /^https?:\/\//.test(attachment.payload?.url ?? '')) {
      links.push(attachment.payload.url); continue;
    }
    if (attachment.type === 'inline_keyboard') {
      for (const row of attachment.payload?.buttons ?? []) for (const button of row) {
        if (button.type === 'link' && /^https?:\/\//.test(button.url ?? '')) links.push(`${button.text}: ${button.url}`);
        else unsupported.push(`кнопка ${button.type ?? 'unknown'}`);
      }
      continue;
    }
    unsupported.push(attachment.type ?? 'unknown');
  }
  return { media, links, unsupported };
}

function textChunks(value, limit = 4096) {
  const chunks = [];
  for (let offset = 0; offset < value.length; offset += limit) chunks.push(value.slice(offset, offset + limit));
  return chunks;
}

function maxMarkupHtml(text, markup = []) {
  const types = { strong: 'bold', emphasized: 'italic', link: 'text_link',
    underline: 'underline', strikethrough: 'strikethrough', code: 'code' };
  return telegramToMaxHtml(text, markup.filter((item) => types[item.type]).map((item) => ({
    type: types[item.type], offset: item.from, length: item.length, url: item.url
  })));
}

async function sendSingle(telegram, chatId, item, caption = '', html = false) {
  const file = new InputFile(item.path, item.filename);
  const options = caption ? { caption, ...(html ? { parse_mode: 'HTML' } : {}) } : undefined;
  if (item.type === 'image') return item.mime === 'image/gif'
    ? telegram.api.sendAnimation(chatId, file, options)
    : item.photoSuitable ? telegram.api.sendPhoto(chatId, file, options)
      : telegram.api.sendDocument(chatId, file, options);
  if (item.type === 'video') return item.mime === 'video/mp4'
    ? telegram.api.sendVideo(chatId, file, options) : telegram.api.sendDocument(chatId, file, options);
  if (item.type === 'audio') return item.mime === 'audio/ogg'
    ? telegram.api.sendVoice(chatId, file, options)
    : ['audio/mpeg', 'audio/mp4', 'audio/x-m4a'].includes(item.mime)
      ? telegram.api.sendAudio(chatId, file, options)
      : telegram.api.sendDocument(chatId, file, options);
  return telegram.api.sendDocument(chatId, file, options);
}

export async function sendMaxToTelegram(telegram, max, payload, onPublish = () => {}) {
  const { media, links, unsupported } = describeAttachments(payload.attachments ?? []);
  const content = `${payload.text ?? ''}${links.length ? `\n${links.join('\n')}` : ''}`.trim();
  if (!content && !media.length) return { ids: [], status: 'unsupported',
    note: unsupported.length ? `Unsupported MAX attachments: ${unsupported.join(', ')}`
      : 'MAX message has no deliverable content' };
  const label = payload.kind === 'channel' ? '' : `[MAX] ${payload.name}:\n`;
  const text = `${label}${content}`.trim();
  const html = `${escapeHtml(label)}${maxMarkupHtml(payload.text ?? '', payload.markup)}${links.length
    ? `\n${links.map(escapeHtml).join('\n')}` : ''}`.trim();
  const ids = [];
  const directory = media.length ? await mkdtemp(join(tmpdir(), 'smj-max-media-')) : null;
  try {
    const files = [];
    try {
      for (const [index, attachment] of media.entries()) {
        files.push(await downloadMaxMedia(max, attachment, directory, index));
      }
    } catch (error) { error.beforeSend = true; throw error; }
    const mediaCaption = files.length && text.length <= 1024 ? html : '';
    const split = files.length > 10 || files.some((file) =>
      (file.type === 'image' && !file.photoSuitable)
      || (file.type === 'video' && file.mime !== 'video/mp4')
      || (file.type === 'audio' && !['audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/x-m4a'].includes(file.mime)))
      || (files.length > 1
      && !files.every((file) => ['image', 'video'].includes(file.type)
        && file.mime !== 'image/gif' && file.photoSuitable
        && (file.type !== 'video' || file.mime === 'video/mp4')))
      || (files.length > 0 && text.length > 1024);
    if (!files.length || !mediaCaption) {
      for (const chunk of textChunks(text)) {
        const useHtml = text.length <= 4096;
        onPublish();
        const result = await telegram.api.sendMessage(payload.targetId, useHtml ? html : chunk,
          useHtml ? { parse_mode: 'HTML' } : undefined);
        ids.push(String(result.message_id));
      }
    }
    if (files.length && files.every((file) => ['image', 'video'].includes(file.type)
        && file.mime !== 'image/gif' && file.photoSuitable
        && (file.type !== 'video' || file.mime === 'video/mp4'))) {
      for (let offset = 0; offset < files.length; offset += 10) {
        const batch = files.slice(offset, offset + 10);
        const caption = offset === 0 ? mediaCaption : '';
        onPublish();
        if (batch.length === 1) {
          const result = await sendSingle(telegram, payload.targetId, batch[0], caption, Boolean(caption));
          ids.push(String(result.message_id));
        } else {
          const group = batch.map((item, index) => ({
            type: item.type === 'image' ? 'photo' : 'video',
            media: new InputFile(item.path, item.filename),
            ...(index === 0 && caption ? { caption, parse_mode: 'HTML' } : {})
          }));
          const results = await telegram.api.sendMediaGroup(payload.targetId, group);
          ids.push(...results.map((result) => String(result.message_id)));
        }
      }
    } else {
      for (const [index, item] of files.entries()) {
        onPublish();
        const result = await sendSingle(telegram, payload.targetId, item, index === 0 ? mediaCaption : '',
          index === 0 && Boolean(mediaCaption));
        ids.push(String(result.message_id));
      }
    }
    if (!ids.length) throw new Error('MAX message has no deliverable content');
    return { ids, status: unsupported.length || split ? 'partial' : 'sent',
      note: [unsupported.length ? `Unsupported MAX attachments: ${unsupported.join(', ')}` : null,
        split ? 'MAX message was split into multiple Telegram messages' : null].filter(Boolean).join('; ') || null };
  } catch (error) {
    error.sentIds = ids;
    throw error;
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
