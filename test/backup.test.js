import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.js';

test('online backup contains a consistent copy of route data', () => {
  const directory = mkdtempSync(join(tmpdir(), 'bridge-backup-'));
  const sourcePath = join(directory, 'bridge.sqlite');
  const backupPath = join(directory, 'backup.sqlite');
  try {
    const store = new Store(sourcePath);
    store.migrate();
    store.importLegacy({ telegramSourceChatId: '-1001', maxTargetChatId: '-2001',
      telegramAllowedUserIds: new Set(['1']), maxAllowedUserIds: new Set(['2']) });
    const result = spawnSync(process.execPath, ['scripts/backup-db.js', backupPath], {
      cwd: process.cwd(), env: { ...process.env, DATABASE_PATH: sourcePath }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const copy = new DatabaseSync(backupPath);
    assert.equal(copy.prepare('SELECT max_id FROM pairs WHERE key=?').get('main-chat').max_id, '-2001');
    copy.close(); store.close();
  } finally { rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
