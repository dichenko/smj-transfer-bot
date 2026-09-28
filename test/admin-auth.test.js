import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../src/store.js';
import { tokenHash } from '../src/login.js';

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('Admin API requires a session, Origin and CSRF for mutations', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'bridge-admin-'));
  const databasePath = join(directory, 'bridge.sqlite');
  const store = new Store(databasePath);
  store.migrate();
  const sessionToken = 'session-test-token';
  const csrfToken = 'csrf-test-token';
  const now = new Date().toISOString();
  store.db.prepare(`INSERT INTO admin_sessions(session_hash,telegram_user_id,csrf_hash,created_at,last_seen_at,expires_at)
    VALUES (?,?,?,?,?,?)`).run(tokenHash(sessionToken), '123', tokenHash(csrfToken), now, now,
      new Date(Date.now() + 3_600_000).toISOString());
  store.close();
  const port = await freePort();
  const processHandle = spawn(process.execPath, ['src/admin.js'], {
    cwd: process.cwd(), stdio: 'ignore', env: { ...process.env,
      TELEGRAM_BOT_TOKEN: '123456:fake', MAX_BOT_TOKEN: 'fake',
      MAX_WEBHOOK_URL: 'https://example.test/max/webhook', MAX_WEBHOOK_SECRET: 'test_secret',
      ADMIN_WEB_URL: 'https://admin.example.test', ADMIN_TELEGRAM_USER_IDS: '123',
      DATABASE_PATH: databasePath, ADMIN_PORT: String(port) }
  });
  const url = `http://127.0.0.1:${port}`;
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try { const response = await fetch(`${url}/`); if (response.ok) { ready = true; break; } }
      catch { await new Promise((resolve) => setTimeout(resolve, 25)); }
    }
    assert.equal(ready, true, 'admin server started');
    assert.equal((await fetch(`${url}/api/pairs`)).status, 401);
    const headers = { Cookie: `bridge_session=${sessionToken}` };
    assert.equal((await fetch(`${url}/api/pairs`, { headers })).status, 200);
    assert.equal((await fetch(`${url}/api/logout`, { method: 'POST', headers })).status, 403);
    assert.equal((await fetch(`${url}/api/logout`, { method: 'POST', headers: {
      ...headers, Origin: 'https://admin.example.test' } })).status, 403);
    assert.equal((await fetch(`${url}/api/logout`, { method: 'POST', headers: {
      ...headers, Origin: 'https://admin.example.test', 'X-CSRF-Token': csrfToken } })).status, 200);
    assert.equal((await fetch(`${url}/api/pairs`, { headers })).status, 401);
  } finally {
    processHandle.kill();
    if (processHandle.exitCode === null) await new Promise((resolve) => processHandle.once('exit', resolve));
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
