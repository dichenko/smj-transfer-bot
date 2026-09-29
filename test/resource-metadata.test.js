import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../src/store.js';
import { maxRefreshMode, refreshMaxResource, refreshMissingResources } from '../src/resource-metadata.js';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'metadata-db-'));
  const store = new Store(join(directory, 'bridge.sqlite'));
  store.migrate();
  return { store, close: () => { store.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('MAX user_added without a title triggers metadata lookup without changing event time', async () => {
  const { store, close } = fixture();
  try {
    store.discover({ platform: 'max', kind: 'channel', id: '-718', source: 'user_added' });
    const before = store.db.prepare("SELECT * FROM discovered_resources WHERE platform='max'").get();
    assert.equal(maxRefreshMode(before, 'user_added'), 'metadata');
    const max = { getChat: async () => ({ type: 'channel', title: 'Channel name', status: 'active' }) };
    await refreshMaxResource(store, max, '-718');
    const after = store.db.prepare("SELECT * FROM discovered_resources WHERE platform='max'").get();
    assert.equal(after.title, 'Channel name');
    assert.equal(after.bot_status, 'active');
    assert.equal(after.last_seen_at, before.last_seen_at);
    assert.equal(after.source, 'user_added');
    assert.ok(after.last_checked_at);
    assert.equal(maxRefreshMode(after, 'message_created'), null);
  } finally { close(); }
});

test('metadata scan fills legacy MAX title and Telegram member status', async () => {
  const { store, close } = fixture();
  try {
    store.discover({ platform: 'max', kind: 'chat', id: '-724', source: 'message_removed' });
    store.discover({ platform: 'telegram', kind: 'chat', id: '-917', title: 'Group', source: 'message' });
    const max = { getChat: async () => ({ type: 'chat', title: 'MAX group', status: 'active' }) };
    const telegram = { api: {
      getChat: async () => ({ type: 'group', title: 'Group' }),
      getMe: async () => ({ id: 1 }), getChatMember: async () => ({ status: 'member' })
    } };
    await refreshMissingResources(store, max, telegram, () => {});
    const rows = store.db.prepare('SELECT platform,title,bot_status FROM discovered_resources ORDER BY platform')
      .all().map((row) => ({ ...row }));
    assert.deepEqual(rows, [
      { platform: 'max', title: 'MAX group', bot_status: 'active' },
      { platform: 'telegram', title: 'Group', bot_status: 'active' }
    ]);
  } finally { close(); }
});
