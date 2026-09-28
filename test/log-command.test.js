import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { InputFile } from 'grammy';
import { sendLogs } from '../src/log-command.js';

test('only an allowlisted user in a private chat receives the log file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-test-'));
  const logFile = join(directory, 'bridge.log.txt');
  await writeFile(logFile, 'test event\n');
  const sent = [];
  const makeContext = (type, id) => ({
    chat: { type },
    from: { id },
    replyWithDocument: async (file) => sent.push(file),
    reply: async (text) => sent.push(text)
  });
  const options = { allowedUserIds: new Set(['123']), logFile, log: () => {} };

  try {
    await sendLogs(makeContext('private', 456), options);
    await sendLogs(makeContext('group', 123), options);
    assert.equal(sent.length, 0);

    await sendLogs(makeContext('private', 123), options);
    assert.equal(sent.length, 1);
    assert.ok(sent[0] instanceof InputFile);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('an allowlisted user gets a clear response if no log file exists', async () => {
  const replies = [];
  await sendLogs({
    chat: { type: 'private' },
    from: { id: 123 },
    replyWithDocument: async () => assert.fail('no file should be sent'),
    reply: async (text) => replies.push(text)
  }, {
    allowedUserIds: new Set(['123']),
    logFile: join(tmpdir(), 'missing-bridge-log-file.txt'),
    log: () => {}
  });

  assert.equal(replies.length, 1);
  assert.match(replies[0], /Журнал пока не создан/);
});
