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
      throw new Error(`MAX API ${response.status}: ${details.slice(0, 500)}`);
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
    const upload = await this.request('/uploads?type=video', { method: 'POST' });
    if (!upload.url || !upload.token) throw new Error('MAX video upload URL or token is missing');
    const form = new FormData();
    const extension = extname(filePath).toLowerCase();
    const filename = ['.mp4', '.mov', '.mkv', '.webm'].includes(extension)
      ? `video${extension}` : 'video.mp4';
    form.set('data', await openAsBlob(filePath, { type: mimeType }), filename);
    const response = await fetch(upload.url, {
      method: 'POST', body: form, signal: AbortSignal.timeout(600_000)
    });
    const body = await response.text();
    if (!response.ok || !/<retval>1<\/retval>/.test(body)) {
      throw new Error(`MAX video upload failed (${response.status}): ${body.slice(0, 200)}`);
    }
    return this.sendAttachments(chatId, [{ type: 'video', payload: { token: upload.token } }], text, format);
  }

  async sendPhotos(chatId, filePaths, text, format = 'html') {
    if (!filePaths.length || filePaths.length > 12) throw new Error('MAX accepts 1-12 photos per message');
    const attachments = [];
    for (const filePath of filePaths) {
      const upload = await this.request('/uploads?type=image', { method: 'POST' });
      if (!upload.url) throw new Error('MAX image upload URL is missing');
      const form = new FormData();
      const extension = extname(filePath).toLowerCase();
      form.set('data', await openAsBlob(filePath, { type: 'image/jpeg' }),
        ['.jpg', '.jpeg', '.png', '.gif', '.tiff', '.bmp', '.heic'].includes(extension)
          ? `photo${extension}` : 'photo.jpg');
      const response = await fetch(upload.url, {
        method: 'POST', body: form, headers: { Authorization: this.token },
        signal: AbortSignal.timeout(600_000)
      });
      if (!response.ok) throw new Error(`MAX image upload failed (${response.status})`);
      const result = parseMaxJson(await response.text());
      const token = Object.values(result.photos ?? {}).map((photo) => photo?.token).find(Boolean);
      if (!token) throw new Error('MAX image upload token is missing');
      attachments.push({ type: 'image', payload: { token } });
    }
    return this.sendAttachments(chatId, attachments, text, format);
  }

  async sendAttachments(chatId, attachments, text, format) {
    const query = new URLSearchParams({ chat_id: String(chatId) });
    const message = { text, format, attachments };
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
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
