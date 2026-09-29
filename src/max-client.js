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
    const query = new URLSearchParams({ chat_id: String(chatId) });
    const message = { text, format, attachments: [{ type: 'video', payload: { token: upload.token } }] };
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
