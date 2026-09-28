import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MaxClient } from '../src/max-client.js';

test('MAX subscription with HTTP 200 and success=false is a failure', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{"success":false,"message":"invalid endpoint"}', { status: 200 });
  try {
    await assert.rejects(new MaxClient('fake-token').subscribeToWebhook({
      url: 'https://example.test/max/webhook', secret: 'test_secret'
    }), /success=false/);
  } finally { globalThis.fetch = originalFetch; }
});
