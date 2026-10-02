import { MAX_UPDATE_TYPES } from './update-types.js';
import { parseMaxJson } from './lossless-json.js';
import { openAsBlob } from 'node:fs';
import { extname } from 'node:path';

const API_BASE = 'https://platform-api2.max.ru';

export class MaxClient {
  constructor(token) {
    this.token = token;
  }

  async request(path, options = {}) {
    const response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers: {
        Authorization: this.token,
        'Content-Type': 'application/json',
        ...options.headers
      },
      signal: AbortSignal.timeout(100_000)
    });

    if (!response.ok) {
      const details = await response.text();
      const error = new Error(`MAX API ${response.status}: ${details.slice(0, 500)}`);
      error.error_code = response.status;
      throw error;
    }

    return parseMaxJson(await response.text());
  }

  sendText(chatId, text, format = 'markdown') {
    const query = new URLSearchParams({ chat_id: String(chatId) });
    return this.request(`/messages?${query}`, {
      method: 'POST',
      body: JSON.stringify({ text, format })
    });
  }

  async sendVideo(chatId, filePath, text, format = 'html', mimeType = 'video/mp4') {
    return this.sendMedia(chatId, [{ type: 'video', path: filePath, mimeType }], text, format);
  }

  async sendPhotos(chatId, filePaths, text, format = 'html') {
    return this.sendMedia(chatId, filePaths.map((path) => ({ type: 'image', path })), text, format);
  }

  async sendAudio(chatId, filePath, text, format = 'html', onPublish = () => {}) {
    const token = await this.uploadBinary('audio', filePath, 'audio/mp4', 'voice.m4a');
    return this.sendAttachments(chatId, [{ type: 'audio', payload: { token } }], text, format, onPublish);
  }

  async sendFile(chatId, filePath, text, mimeType = 'application/octet-stream', filename = 'file', type = 'file', onPublish = () => {}) {
    const token = await this.uploadBinary(type, filePath, mimeType, filename);
    return this.sendAttachments(chatId, [{ type, payload: { token } }], text, 'html', onPublish);
  }

  async uploadBinary(type, filePath, mimeType, filename) {
    const upload = await this.request(`/uploads?type=${type}`, { method: 'POST' });
    if (!upload.url || (type !== 'file' && !upload.token))
      throw new Error(`MAX ${type} upload URL or token is missing`);
    const form = new FormData();
    form.set('data', await openAsBlob(filePath, { type: mimeType }), filename);
    const response = await fetch(upload.url, {
      method: 'POST', body: form, signal: AbortSignal.timeout(600_000)
    });
    const body = await response.text();
    if (type === 'file') {
      const result = response.ok ? parseMaxJson(body) : null;
      if (!result?.token) throw Object.assign(new Error(`MAX file upload failed (${response.status})`), { error_code: response.status });
      return result.token;
    }
    if (!response.ok || !/<retval>1<\/retval>/.test(body))
      throw Object.assign(new Error(`MAX ${type} upload failed (${response.status})`), { error_code: response.status });
    return upload.token;
  }

  async sendMedia(chatId, files, text, format = 'html', onPublish = () => {}) {
    if (!files.length || files.length > 12) throw new Error('MAX accepts 1-12 media attachments');
    const attachments = [];
    for (const file of files) {
      if (file.type === 'video') {
        const extension = extname(file.path).toLowerCase();
        const filename = ['.mp4', '.mov', '.mkv', '.webm'].includes(extension)
          ? `video${extension}` : 'video.mp4';
        const token = await this.uploadBinary('video', file.path, file.mimeType || 'video/mp4', filename);
        attachments.push({ type: 'video', payload: { token } });
        continue;
      }
      if (file.type !== 'image') throw new Error('Unsupported MAX media type');
      const upload = await this.request('/uploads?type=image', { method: 'POST' });
      if (!upload.url) throw new Error('MAX image upload URL is missing');
      const form = new FormData();
      const extension = extname(file.path).toLowerCase();
      form.set('data', await openAsBlob(file.path, { type: 'image/jpeg' }),
        ['.jpg', '.jpeg', '.png', '.gif', '.tiff', '.bmp', '.heic'].includes(extension)
          ? `photo${extension}` : 'photo.jpg');
      const response = await fetch(upload.url, {
        method: 'POST', body: form, headers: { Authorization: this.token },
        signal: AbortSignal.timeout(600_000)
      });
      if (!response.ok) throw Object.assign(new Error(`MAX image upload failed (${response.status})`), { error_code: response.status });
      const result = parseMaxJson(await response.text());
      const token = Object.values(result.photos ?? {}).map((photo) => photo?.token).find(Boolean);
      if (!token) throw new Error('MAX image upload token is missing');
      attachments.push({ type: 'image', payload: { token } });
    }
    return this.sendAttachments(chatId, attachments, text, format, onPublish);
  }

  async sendAttachments(chatId, attachments, text, format, onPublish = () => {}) {
    const query = new URLSearchParams({ chat_id: String(chatId) });
    const message = { text, format, attachments };
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        onPublish();
        return await this.request(`/messages?${query}`, { method: 'POST', body: JSON.stringify(message) });
      } catch (error) {
        if (!/attachment\.not\.ready/.test(String(error.message)) || attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 2000 * 2 ** attempt));
      }
    }
  }

  getChat(chatId) {
    return this.request(`/chats/${encodeURIComponent(String(chatId))}`);
  }

  async subscribeToWebhook({ url, secret }) {
    const result = await this.request('/subscriptions', {
      method: 'POST',
      body: JSON.stringify({
        url,
        secret,
        update_types: MAX_UPDATE_TYPES
      })
    });
    if (result.success !== true) throw new Error('MAX webhook subscription failed (success=false)');
    return result;
  }
}
