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

test('MAX webhook does not acknowledge an event that failed to persist', async () => {
  const failed = await startWebhookServer({ port: 0, secret: 'test_secret', log: () => {},
    onReceive: () => { throw new Error('disk unavailable'); }, onUpdate: async () => {} });
  try {
    const response = await fetch(`http://127.0.0.1:${failed.address().port}/max/webhook`, {
      method: 'POST', headers: { 'x-max-bot-api-secret': 'test_secret' }, body: '{"update_type":"bot_added"}' });
    assert.equal(response.status, 500);
  } finally { await new Promise((resolve) => failed.close(resolve)); }
});

test('delivery health reports problems while liveness stays available', async () => {
  let healthy = false;
  const checked = await startWebhookServer({ port: 0, secret: 'test_secret', log: () => {},
    onReceive: () => {}, onUpdate: async () => {},
    getDeliveryHealth: () => ({ ok: healthy, unresolved: healthy ? [] : [{ id: 42 }], stalled: [] }) });
  const base = `http://127.0.0.1:${checked.address().port}`;
  try {
    const failed = await fetch(`${base}/health/delivery`);
    assert.equal(failed.status, 503);
    assert.deepEqual(await failed.json(), { ok: false, unresolved: 1, stalled: 0 });
    assert.equal((await fetch(`${base}/health`)).status, 200);
    healthy = true;
    assert.equal((await fetch(`${base}/health/delivery`)).status, 200);
  } finally { await new Promise((resolve) => checked.close(resolve)); }
});
