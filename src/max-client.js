import { MAX_UPDATE_TYPES } from './update-types.js';
import { parseMaxJson } from './lossless-json.js';

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
