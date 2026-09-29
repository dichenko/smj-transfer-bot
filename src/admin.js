import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Bot } from 'grammy';
import { config } from './config.js';
import { Store } from './store.js';
import { MaxClient } from './max-client.js';
import { randomToken, tokenHash } from './login.js';

const store = new Store(config.databasePath);
const max = new MaxClient(config.maxToken);
const telegram = new Bot(config.telegramToken, config.telegramApiRoot
  ? { client: { apiRoot: config.telegramApiRoot } } : undefined);
const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'admin.html'));
const publicOrigin = config.adminWebUrl ? new URL(config.adminWebUrl).origin : null;
const starts = new Map();
const iso = () => new Date().toISOString();
const cookies = (request) => Object.fromEntries((request.headers.cookie ?? '').split(';').map((part) => part.trim().split('=')));
async function sendLoginConfirmation(userId, message, options) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try { return await telegram.api.sendMessage(userId, message, options); }
    catch (error) {
      if (!error.message.startsWith('Network request') || attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
}
const respond = (response, status, value, headers = {}) => {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff', ...headers });
  response.end(JSON.stringify(value));
};
const fail = (response, status, message) => respond(response, status, { error: message });
const cookie = (name, value, maxAge) => `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`;

function readJson(request) {
  return new Promise((resolve, reject) => {
    let data = '';
    request.on('data', (chunk) => {
      data += chunk;
      if (Buffer.byteLength(data) > 16_384) { reject(new Error('Request body too large')); request.destroy(); }
    });
    request.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { reject(new Error('Invalid JSON')); } });
    request.on('error', reject);
  });
}

function session(request) {
  const raw = cookies(request).bridge_session;
  if (!raw) return null;
  const row = store.db.prepare('SELECT * FROM admin_sessions WHERE session_hash=?').get(tokenHash(raw));
  if (!row || row.expires_at <= iso() || Date.now() - Date.parse(row.last_seen_at) > 1_800_000
      || !config.adminTelegramUserIds.has(row.telegram_user_id)) return null;
  store.db.prepare('UPDATE admin_sessions SET last_seen_at=? WHERE session_hash=?').run(iso(), row.session_hash);
  return row;
}

function csrfValid(request, row) {
  const value = request.headers['x-csrf-token'];
  return typeof value === 'string' && tokenHash(value) === row.csrf_hash;
}

async function verifyPair(pair) {
  const tg = await telegram.api.getChat(pair.telegram_id);
  const expectedTg = pair.kind === 'channel' ? 'channel' : ['group', 'supergroup'];
  if (Array.isArray(expectedTg) ? !expectedTg.includes(tg.type) : tg.type !== expectedTg)
    throw new Error('Telegram object has the wrong type');
  const me = await telegram.api.getMe();
  const member = await telegram.api.getChatMember(pair.telegram_id, me.id);
  if (['left', 'kicked'].includes(member.status)) throw new Error('Telegram bot is not a member');
  if (pair.kind === 'channel' && (member.status !== 'administrator' || member.can_post_messages !== true))
    throw new Error('Telegram bot lacks channel rights');
  if (pair.kind === 'chat' && pair.max_to_telegram && member.status === 'restricted' && member.can_send_messages === false)
    throw new Error('Telegram bot cannot send messages to this chat');
  const chat = await max.getChat(pair.max_id);
  if (chat.type !== pair.kind || chat.status !== 'active') throw new Error('MAX object type or bot status is invalid');
  const membership = await max.request(`/chats/${encodeURIComponent(pair.max_id)}/members/me`);
  if (pair.kind === 'channel' && !membership.permissions?.includes('write'))
    throw new Error('MAX bot lacks channel write permission');
  if (pair.kind === 'channel' && pair.max_to_telegram
      && !membership.permissions?.includes('read_all_messages'))
    throw new Error('MAX bot lacks channel read_all_messages permission');
  if (pair.kind === 'chat' && pair.max_to_telegram && !membership.permissions?.includes('read_all_messages'))
    throw new Error('MAX bot lacks read_all_messages permission');
  store.checkedResource('telegram', pair.kind, pair.telegram_id, tg.title, 'active', member,
    tg.username ? `https://t.me/${tg.username}` : null);
  store.checkedResource('max', pair.kind, pair.max_id, chat.title, chat.status, membership.permissions ?? [], chat.link);
  return { telegram: { title: tg.title, id: pair.telegram_id, type: tg.type, member },
    max: { title: chat.title, id: pair.max_id, type: chat.type, status: chat.status, permissions: membership.permissions ?? [] } };
}

function audit(userId, action, pairKey, before, after) {
  store.db.prepare(`INSERT INTO pair_audit(telegram_user_id,action,pair_key,before_json,after_json,created_at)
    VALUES (?,?,?,?,?,?)`).run(userId, action, pairKey,
    before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, iso());
}

function validateSenders(value) {
  if (!value || !['all_non_bot', 'allowlist'].includes(value.mode)) throw new Error('Choose a sender policy');
  if (value.mode === 'all_non_bot') return { mode: value.mode, ids: [] };
  if (!Array.isArray(value.ids) || value.ids.some((id) => !/^-?\d+$/.test(String(id))))
    throw new Error('Sender IDs must be numeric');
  return { mode: value.mode, ids: [...new Set(value.ids.map(String))] };
}

function resource(platform, kind, id) {
  const row = store.db.prepare('SELECT * FROM discovered_resources WHERE platform=? AND kind=? AND resource_id=?')
    .get(platform, kind, id);
  if (!row || ['removed', 'left', 'closed'].includes(row.bot_status))
    throw new Error(`${platform} object is not available in the registry`);
  return row;
}

function createPair(body, userId) {
  const { key, kind, telegramId, maxId } = body;
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(key ?? '')) throw new Error('Invalid pair key');
  if (!['chat', 'channel'].includes(kind)) throw new Error('Invalid pair type');
  if (!/^-?\d+$/.test(telegramId ?? '') || !/^-?\d+$/.test(maxId ?? '')) throw new Error('Invalid object ID');
  resource('telegram', kind, telegramId);
  resource('max', kind, maxId);
  const tgPolicy = kind === 'chat' ? validateSenders(body.telegramSenders) : { mode: 'all_non_bot', ids: [] };
  const maxPolicy = kind === 'chat' ? validateSenders(body.maxSenders) : { mode: 'all_non_bot', ids: [] };
  const title = String(body.title ?? key).trim().slice(0, 100) || key;
  const pair = { key, kind, title, telegram_id: telegramId, max_id: maxId, enabled: 0,
    max_to_telegram: body.maxToTelegram ? 1 : 0,
    telegram_senders: JSON.stringify(tgPolicy), max_senders: JSON.stringify(maxPolicy) };
  return store.transaction(() => {
    store.db.prepare(`INSERT INTO pairs(key,kind,title,telegram_id,max_id,enabled,max_to_telegram,
      telegram_senders,max_senders,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      key, kind, title, telegramId, maxId, 0, pair.max_to_telegram,
      pair.telegram_senders, pair.max_senders, iso(), iso());
    audit(userId, 'create', key, null, pair);
    return pair;
  });
}

function pairForEdit(key) {
  const pair = store.db.prepare('SELECT * FROM pairs WHERE key=? AND archived=0').get(key);
  if (!pair) throw new Error('Pair not found');
  if (pair.locked) throw new Error('The original pair is read only');
  return pair;
}

async function handle(request, response) {
  const url = new URL(request.url, 'http://localhost');
  if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/login')) {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'" });
    response.end(html);
    return;
  }
  if (!url.pathname.startsWith('/api/')) return fail(response, 404, 'Not found');
  if (request.method !== 'GET' && (!publicOrigin || request.headers.origin !== publicOrigin))
    return fail(response, 403, 'Invalid origin');

  if (url.pathname === '/api/auth/start' && request.method === 'POST') {
    const source = request.socket.remoteAddress ?? 'unknown';
    const recent = (starts.get(source) ?? []).filter((time) => Date.now() - time < 300_000);
    if (recent.length >= 10) return fail(response, 429, 'Too many login attempts');
    recent.push(Date.now()); starts.set(source, recent);
    const body = await readJson(request);
    const token = String(body.token ?? '');
    if (token.length < 40 || token.length > 100) return fail(response, 400, 'Invalid link');
    const rawBrowser = randomToken();
    const row = store.transaction(() => {
      const item = store.db.prepare("SELECT * FROM admin_login_requests WHERE token_hash=? AND status='issued' AND expires_at>?")
        .get(tokenHash(token), iso());
      if (!item || !config.adminTelegramUserIds.has(item.telegram_user_id)) return null;
      store.db.prepare("UPDATE admin_login_requests SET status='pending',browser_hash=? WHERE id=? AND status='issued'")
        .run(tokenHash(rawBrowser), item.id);
      return item;
    });
    if (!row) return fail(response, 400, 'Link expired or used');
    const browser = String(request.headers['user-agent'] ?? 'Unknown browser').slice(0, 80);
    try {
      await sendLoginConfirmation(row.telegram_user_id, `Подтвердите вход в панель. Браузер: ${browser}`,
        { reply_markup: { inline_keyboard: [[
          { text: 'Подтвердить вход', callback_data: `admin:confirm:${row.id}` },
          { text: 'Отменить', callback_data: `admin:cancel:${row.id}` }
        ]] } });
    } catch {
      store.db.prepare("UPDATE admin_login_requests SET status='cancelled' WHERE id=?").run(row.id);
      return fail(response, 503, 'Could not send confirmation');
    }
    return respond(response, 200, { status: 'pending' }, { 'Set-Cookie': cookie('bridge_browser', rawBrowser, 300) });
  }

  if (url.pathname === '/api/auth/poll' && request.method === 'GET') {
    const browser = cookies(request).bridge_browser;
    if (!browser) return fail(response, 401, 'No pending login');
    const row = store.db.prepare('SELECT * FROM admin_login_requests WHERE browser_hash=? ORDER BY created_at DESC LIMIT 1')
      .get(tokenHash(browser));
    if (!row || row.expires_at <= iso()) return fail(response, 401, 'Login expired');
    if (row.status === 'pending') return respond(response, 200, { status: 'pending' });
    if (row.status !== 'confirmed' || !config.adminTelegramUserIds.has(row.telegram_user_id))
      return fail(response, 401, 'Login cancelled');
    const rawSession = randomToken();
    const csrf = randomToken();
    const created = store.transaction(() => {
      const changed = store.db.prepare("UPDATE admin_login_requests SET status='consumed' WHERE id=? AND status='confirmed'").run(row.id).changes;
      if (!changed) return false;
      store.db.prepare(`INSERT INTO admin_sessions(session_hash,telegram_user_id,csrf_hash,created_at,last_seen_at,expires_at)
        VALUES (?,?,?,?,?,?)`).run(tokenHash(rawSession), row.telegram_user_id, tokenHash(csrf), iso(), iso(),
        new Date(Date.now() + 43_200_000).toISOString());
      return true;
    });
    if (!created) return fail(response, 401, 'Login already used');
    return respond(response, 200, { status: 'active', csrf }, { 'Set-Cookie': [
      cookie('bridge_session', rawSession, 43_200), cookie('bridge_browser', '', 0)] });
  }

  const auth = session(request);
  if (!auth) return fail(response, 401, 'Sign in required');
  if (request.method !== 'GET' && !csrfValid(request, auth)) return fail(response, 403, 'Invalid CSRF token');
  if (url.pathname === '/api/me' && request.method === 'GET') {
    const csrf = randomToken();
    store.db.prepare('UPDATE admin_sessions SET csrf_hash=? WHERE session_hash=?').run(tokenHash(csrf), auth.session_hash);
    return respond(response, 200, { userId: auth.telegram_user_id, csrf });
  }
  if (url.pathname === '/api/logout' && request.method === 'POST') {
    store.db.prepare('DELETE FROM admin_sessions WHERE session_hash=?').run(auth.session_hash);
    return respond(response, 200, { ok: true }, { 'Set-Cookie': cookie('bridge_session', '', 0) });
  }
  if (url.pathname === '/api/overview' && request.method === 'GET') {
    const pairs = store.db.prepare('SELECT kind,COUNT(*) AS count FROM pairs WHERE enabled=1 AND archived=0 GROUP BY kind').all();
    const queue = store.db.prepare("SELECT COUNT(*) AS count, MIN(created_at) AS oldest FROM deliveries WHERE status IN ('queued','retrying','uploading')").get();
    const errors = store.db.prepare("SELECT COUNT(*) AS count FROM deliveries WHERE status IN ('failed','unknown','unsupported') AND updated_at>=?")
      .get(new Date(Date.now() - 86_400_000).toISOString());
    return respond(response, 200, { pairs, queue, errors, observedAt: iso() });
  }
  if (url.pathname === '/api/resources' && request.method === 'GET') return respond(response, 200,
    store.db.prepare('SELECT * FROM discovered_resources ORDER BY last_seen_at DESC LIMIT 500').all());
  if (url.pathname === '/api/discovery-events' && request.method === 'GET') return respond(response, 200,
    store.db.prepare('SELECT * FROM discovery_events ORDER BY id DESC LIMIT 500').all());
  if (url.pathname === '/api/pairs' && request.method === 'GET') return respond(response, 200, store.pairs());
  if (url.pathname === '/api/pairs' && request.method === 'POST')
    return respond(response, 201, createPair(await readJson(request), auth.telegram_user_id));
  const pairMatch = /^\/api\/pairs\/([a-z0-9-]+)\/(verify|activate|pause|archive|update)$/.exec(url.pathname);
  if (pairMatch && request.method === 'POST') {
    const [, key, action] = pairMatch;
    const pair = pairForEdit(key);
    if (action === 'verify') return respond(response, 200, await verifyPair(pair));
    if (action === 'activate') {
      const confirmation = await readJson(request);
      const verified = await verifyPair(pair);
      if (confirmation.telegramId !== pair.telegram_id || confirmation.maxId !== pair.max_id
          || confirmation.telegramTitle !== verified.telegram.title || confirmation.maxTitle !== verified.max.title)
        throw new Error('Object names or IDs changed; verify and confirm again');
      store.transaction(() => {
        const changed = store.db.prepare('UPDATE pairs SET enabled=1,pause_reason=NULL,updated_at=? WHERE key=? AND archived=0 AND locked=0 AND updated_at=?')
          .run(iso(), key, pair.updated_at).changes;
        if (!changed) throw new Error('Pair changed during verification; try again');
        audit(auth.telegram_user_id, 'activate', key, pair, { ...pair, enabled: 1, pause_reason: null,
          verified: { telegram: { id: verified.telegram.id, title: verified.telegram.title },
            max: { id: verified.max.id, title: verified.max.title } } });
      });
      return respond(response, 200, { enabled: true, verified });
    }
    if (action === 'pause' || action === 'archive') {
      store.transaction(() => {
        store.db.prepare(`UPDATE pairs SET enabled=0,${action === 'archive' ? 'archived=1,' : ''}updated_at=? WHERE key=?`).run(iso(), key);
        audit(auth.telegram_user_id, action, key, pair, { ...pair, enabled: 0, archived: action === 'archive' ? 1 : pair.archived });
      });
      return respond(response, 200, { ok: true });
    }
    const body = await readJson(request);
    const title = String(body.title ?? pair.title).trim().slice(0, 100);
    if (!title) throw new Error('Title required');
    const tgPolicy = pair.kind === 'chat' ? validateSenders(body.telegramSenders) : JSON.parse(pair.telegram_senders);
    const maxPolicy = pair.kind === 'chat' ? validateSenders(body.maxSenders) : JSON.parse(pair.max_senders);
    const reverse = Boolean(body.maxToTelegram) ? 1 : 0;
    if (pair.enabled && reverse && !pair.max_to_telegram)
      await verifyPair({ ...pair, max_to_telegram: reverse });
    store.transaction(() => {
      store.db.prepare(`UPDATE pairs SET title=?,max_to_telegram=?,telegram_senders=?,max_senders=?,updated_at=? WHERE key=?`)
        .run(title, reverse, JSON.stringify(tgPolicy), JSON.stringify(maxPolicy), iso(), key);
      audit(auth.telegram_user_id, 'update', key, pair, { ...pair, title, max_to_telegram: reverse,
        telegram_senders: tgPolicy, max_senders: maxPolicy });
    });
    return respond(response, 200, { ok: true });
  }
  if (url.pathname === '/api/deliveries' && request.method === 'GET') {
    const where = []; const args = [];
    for (const [query, column] of [['pair', 'pair_key'], ['direction', 'direction'], ['status', 'status'], ['media', 'media_type'], ['source', 'source_message_id']]) {
      if (url.searchParams.has(query)) { where.push(`${column}=?`); args.push(url.searchParams.get(query)); }
    }
    if (url.searchParams.has('from')) { where.push('created_at>=?'); args.push(url.searchParams.get('from')); }
    if (url.searchParams.has('to')) { where.push('created_at<=?'); args.push(url.searchParams.get('to')); }
    const rows = store.db.prepare(`SELECT id,pair_key,direction,source_id,source_message_id,media_type,status,
      attempts,target_ids,error,created_at,updated_at FROM deliveries ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY id DESC LIMIT 500`).all(...args);
    return respond(response, 200, rows);
  }
  const detail = /^\/api\/deliveries\/(\d+)$/.exec(url.pathname);
  if (detail && request.method === 'GET') {
    const row = store.db.prepare(`SELECT id,pair_key,direction,source_id,source_message_id,media_type,status,
      attempts,target_ids,error,created_at,updated_at FROM deliveries WHERE id=?`).get(Number(detail[1]));
    if (!row) return fail(response, 404, 'Delivery not found');
    const attempts = store.db.prepare('SELECT started_at,finished_at,result,error FROM delivery_attempts WHERE delivery_id=? ORDER BY id')
      .all(row.id);
    return respond(response, 200, { ...row, attemptsHistory: attempts });
  }
  const retry = /^\/api\/deliveries\/(\d+)\/retry$/.exec(url.pathname);
  if (retry && request.method === 'POST') {
    const row = store.db.prepare('SELECT * FROM deliveries WHERE id=?').get(Number(retry[1]));
    if (!row || row.status !== 'failed') return fail(response, 409, 'Only failed deliveries can be retried');
    store.transaction(() => {
      store.db.prepare("UPDATE deliveries SET status='queued',error=NULL,next_attempt_at=?,updated_at=? WHERE id=?")
        .run(iso(), iso(), row.id);
      audit(auth.telegram_user_id, 'retry', row.pair_key, { deliveryId: row.id, status: row.status }, { status: 'queued' });
    });
    return respond(response, 200, { ok: true });
  }
  if (url.pathname === '/api/audit' && request.method === 'GET') return respond(response, 200,
    store.db.prepare('SELECT * FROM pair_audit ORDER BY id DESC LIMIT 500').all());
  return fail(response, 404, 'Not found');
}

createServer((request, response) => {
  handle(request, response).catch((error) => {
    console.error(`${iso()} Admin request failed: ${error.message}`);
    if (!response.headersSent) fail(response, /constraint|Invalid|wrong|not available|required|lacks/i.test(error.message) ? 400 : 500, error.message);
  });
}).listen(config.adminPort, '0.0.0.0', () => console.log(`${iso()} Admin server listening on ${config.adminPort}`));
