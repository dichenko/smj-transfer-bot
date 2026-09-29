import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redactSensitive } from '../src/redact.js';

test('Telegram token and local media path are hidden in errors', () => {
  const token = '12345:secret';
  const error = `EACCES /var/lib/telegram-bot-api/${token}/videos/file_0.mp4`;
  const safe = redactSensitive(error, token);
  assert.equal(safe.includes(token), false);
  assert.equal(safe.includes('file_0.mp4'), true);
  assert.match(safe, /\[redacted\]/);
});
