import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { startWebhookServer } from '../src/webhook-server.js';

const received = [];
const server = await startWebhookServer({
  port: 0,
  secret: 'test_secret',
  log: () => {},
  onReceive: (update, rawBody) => received.push({ update, rawBody }),
  onUpdate: async () => {}
});

after(() => new Promise((resolve) => server.close(resolve)));

test('MAX webhook delivers every valid event with its original 64-bit IDs', async () => {
  const rawBody = '{"update_type":"message_created","chat_id":9223372036854775807,"message":{"body":{"text":"video caption"}}}';
  const response = await fetch(`http://127.0.0.1:${server.address().port}/max/webhook`, {
    method: 'POST',
    headers: { 'x-max-bot-api-secret': 'test_secret' },
    body: rawBody
  });

  assert.equal(response.status, 200);
  assert.equal(received.length, 1);
  assert.equal(received[0].update.update_type, 'message_created');
  assert.equal(received[0].rawBody, rawBody);
});

test('MAX webhook ignores requests with an invalid secret', async () => {
  const response = await fetch(`http://127.0.0.1:${server.address().port}/max/webhook`, {
    method: 'POST',
    headers: { 'x-max-bot-api-secret': 'wrong' },
    body: '{"update_type":"bot_added"}'
  });

  assert.equal(response.status, 401);
  assert.equal(received.length, 1);
});
