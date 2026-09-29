import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const iso = () => new Date().toISOString();
const json = (value) => JSON.stringify(value ?? null);

export class Store {
  constructor(path) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pairs (
        key TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('chat','channel')),
        title TEXT NOT NULL, telegram_id TEXT NOT NULL, max_id TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
        locked INTEGER NOT NULL DEFAULT 0, max_to_telegram INTEGER NOT NULL DEFAULT 0,
        telegram_senders TEXT NOT NULL, max_senders TEXT NOT NULL,
        pause_reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS pairs_tg_active ON pairs(kind,telegram_id) WHERE archived=0;
      CREATE UNIQUE INDEX IF NOT EXISTS pairs_max_active ON pairs(kind,max_id) WHERE archived=0;
      CREATE TABLE IF NOT EXISTS discovered_resources (
        platform TEXT NOT NULL, kind TEXT NOT NULL, resource_id TEXT NOT NULL,
        title TEXT, public_link TEXT, bot_status TEXT, rights TEXT,
        first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
        last_checked_at TEXT, source TEXT NOT NULL, configured_pair_key TEXT,
        PRIMARY KEY(platform,resource_id)
      );
      CREATE TABLE IF NOT EXISTS discovery_events (
        id INTEGER PRIMARY KEY, event_key TEXT NOT NULL UNIQUE,
        platform TEXT NOT NULL, kind TEXT NOT NULL, resource_id TEXT NOT NULL,
        event_type TEXT NOT NULL, observed_at TEXT NOT NULL,
        detail TEXT
      );
      CREATE TABLE IF NOT EXISTS incoming_events (
        event_key TEXT PRIMARY KEY, platform TEXT NOT NULL, received_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS deliveries (
        id INTEGER PRIMARY KEY, delivery_key TEXT NOT NULL UNIQUE,
        pair_key TEXT NOT NULL, direction TEXT NOT NULL, source_id TEXT NOT NULL,
        source_message_id TEXT NOT NULL, media_type TEXT NOT NULL,
        payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
        attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL,
        target_ids TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        FOREIGN KEY(pair_key) REFERENCES pairs(key)
      );
      CREATE INDEX IF NOT EXISTS deliveries_pending ON deliveries(status,next_attempt_at,id);
      CREATE TABLE IF NOT EXISTS delivery_attempts (
        id INTEGER PRIMARY KEY, delivery_id INTEGER NOT NULL, started_at TEXT NOT NULL,
        finished_at TEXT NOT NULL, result TEXT NOT NULL, error TEXT,
        FOREIGN KEY(delivery_id) REFERENCES deliveries(id)
      );
      CREATE TABLE IF NOT EXISTS relayed_messages (
        pair_key TEXT NOT NULL, platform TEXT NOT NULL, message_id TEXT NOT NULL,
        created_at TEXT NOT NULL, PRIMARY KEY(pair_key,platform,message_id)
      );
      CREATE TABLE IF NOT EXISTS admin_login_requests (
        id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, telegram_user_id TEXT NOT NULL,
        browser_hash TEXT, status TEXT NOT NULL, expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS admin_sessions (
        session_hash TEXT PRIMARY KEY, telegram_user_id TEXT NOT NULL,
        csrf_hash TEXT NOT NULL, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pair_audit (
        id INTEGER PRIMARY KEY, telegram_user_id TEXT NOT NULL, action TEXT NOT NULL,
        pair_key TEXT, before_json TEXT, after_json TEXT, created_at TEXT NOT NULL
      );
    `);
    const columns = this.db.prepare('PRAGMA table_info(discovered_resources)').all();
    if (!columns.some((column) => column.name === 'configured_pair_key'))
      this.db.exec('ALTER TABLE discovered_resources ADD COLUMN configured_pair_key TEXT');
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS pairs_link_resources AFTER INSERT ON pairs WHEN NEW.archived=0 BEGIN
        UPDATE discovered_resources SET configured_pair_key=NEW.key
        WHERE kind=NEW.kind AND ((platform='telegram' AND resource_id=NEW.telegram_id)
          OR (platform='max' AND resource_id=NEW.max_id));
      END;
      CREATE TRIGGER IF NOT EXISTS pairs_unlink_resources AFTER UPDATE OF archived ON pairs WHEN NEW.archived=1 BEGIN
        UPDATE discovered_resources SET configured_pair_key=NULL WHERE configured_pair_key=NEW.key;
      END;
      UPDATE discovered_resources SET configured_pair_key=(
        SELECT key FROM pairs WHERE archived=0 AND kind=discovered_resources.kind
          AND ((platform='telegram' AND telegram_id=resource_id)
            OR (platform='max' AND max_id=resource_id)) LIMIT 1);
    `);
  }

  transaction(action) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  importLegacy(config) {
    if (!config.telegramSourceChatId || !config.maxTargetChatId) return false;
    return this.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM pairs WHERE key=?').get('main-chat')) return false;
      const timestamp = iso();
      this.db.prepare(`INSERT INTO pairs
        (key,kind,title,telegram_id,max_id,enabled,locked,max_to_telegram,telegram_senders,max_senders,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        'main-chat', 'chat', 'Функционал №1', String(config.telegramSourceChatId),
        String(config.maxTargetChatId), 1, 1, 1,
        json({ mode: 'allowlist', ids: [...config.telegramAllowedUserIds] }),
        json({ mode: 'allowlist', ids: [...config.maxAllowedUserIds] }), timestamp, timestamp
      );
      return true;
    });
  }

  pairs(kind) {
    return this.db.prepare(`SELECT * FROM pairs WHERE archived=0 ${kind ? 'AND kind=?' : ''} ORDER BY created_at,key`).all(...(kind ? [kind] : []));
  }

  route(platform, kind, id) {
    const column = platform === 'telegram' ? 'telegram_id' : 'max_id';
    return this.db.prepare(`SELECT * FROM pairs WHERE kind=? AND ${column}=? AND enabled=1 AND archived=0 AND pause_reason IS NULL`).get(kind, String(id));
  }

  discover({ platform, kind, id, title, publicLink, status, rights, source, eventKey, eventType, detail }) {
    const resourceId = String(id);
    const now = iso();
    return this.transaction(() => {
      const before = this.db.prepare('SELECT * FROM discovered_resources WHERE platform=? AND resource_id=?').get(platform, resourceId);
      const pairColumn = platform === 'telegram' ? 'telegram_id' : 'max_id';
      const pair = this.db.prepare(`SELECT key FROM pairs WHERE kind=? AND ${pairColumn}=? AND archived=0`).get(kind, resourceId);
      this.db.prepare(`INSERT INTO discovered_resources
        (platform,kind,resource_id,title,public_link,bot_status,rights,first_seen_at,last_seen_at,source,configured_pair_key)
        VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(platform,resource_id) DO UPDATE SET
        kind=excluded.kind,title=COALESCE(excluded.title,discovered_resources.title),
        public_link=COALESCE(excluded.public_link,discovered_resources.public_link),
        bot_status=COALESCE(excluded.bot_status,discovered_resources.bot_status),
        rights=COALESCE(excluded.rights,discovered_resources.rights),
        last_seen_at=excluded.last_seen_at,source=excluded.source,
        configured_pair_key=excluded.configured_pair_key`).run(
        platform, kind, resourceId, title ?? null, publicLink ?? null, status ?? null,
        rights === undefined ? null : json(rights), now, now, source, pair?.key ?? null
      );
      if (eventType && eventKey) this.db.prepare(`INSERT OR IGNORE INTO discovery_events
        (event_key,platform,kind,resource_id,event_type,observed_at,detail)
        VALUES (?,?,?,?,?,?,?)`).run(eventKey, platform, kind, resourceId, eventType, now, detail ?? null);
      const lostChannelWrite = kind === 'channel' && (
        platform === 'telegram' && rights?.status === 'administrator' && rights.can_post_messages !== true
        || platform === 'max' && Array.isArray(rights) && !rights.includes('write')
      );
      if (status === 'removed' || status === 'left' || lostChannelWrite) {
        const column = platform === 'telegram' ? 'telegram_id' : 'max_id';
        this.db.prepare(`UPDATE pairs SET pause_reason=?,updated_at=? WHERE kind=? AND ${column}=? AND archived=0`)
          .run(lostChannelWrite ? `${platform}: channel write permission lost` : `${platform}: bot ${status}`, now, kind, resourceId);
      }
      return !before;
    });
  }

  checkedResource(platform, kind, id, title, status, rights, publicLink = null) {
    this.discover({ platform, kind, id, title, status, rights, publicLink, source: 'rights_check' });
    this.db.prepare('UPDATE discovered_resources SET last_checked_at=? WHERE platform=? AND resource_id=?')
      .run(iso(), platform, String(id));
  }

  updateResourceMetadata(platform, id, title, status, publicLink = null) {
    return this.db.prepare(`UPDATE discovered_resources SET
      title=COALESCE(?,title),bot_status=COALESCE(?,bot_status),
      public_link=COALESCE(?,public_link),last_checked_at=?
      WHERE platform=? AND resource_id=?`).run(
      title ?? null, status ?? null, publicLink ?? null, iso(), platform, String(id)).changes > 0;
  }

  recordEvent(key, platform) {
    return this.db.prepare('INSERT OR IGNORE INTO incoming_events VALUES (?,?,?)').run(key, platform, iso()).changes > 0;
  }

  enqueue({ key, pairKey, direction, sourceId, sourceMessageId, mediaType, payload, delayMs = 0 }) {
    const now = iso();
    return this.db.prepare(`INSERT OR IGNORE INTO deliveries
      (delivery_key,pair_key,direction,source_id,source_message_id,media_type,payload,next_attempt_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(key, pairKey, direction, String(sourceId), String(sourceMessageId), mediaType,
        json(payload), new Date(Date.now() + delayMs).toISOString(), now, now).changes > 0;
  }

  appendTelegramAlbum(key, item, caption, entities, unsupported = false) {
    return this.transaction(() => {
      const job = this.db.prepare('SELECT payload,status FROM deliveries WHERE delivery_key=?').get(key);
      if (!job) return false;
      const payload = JSON.parse(job.payload);
      payload.media ??= (payload.photos ?? []).map((photo) => ({ ...photo, type: 'image' }));
      if (payload.media.some((entry) => entry.message_id === item?.message_id)) return true;
      if (job.status !== 'queued') return false;
      if (item) payload.media.push(item);
      payload.media.sort((a, b) => a.message_id - b.message_id);
      if (caption && !payload.text) { payload.text = caption; payload.entities = entities; }
      payload.albumUnsupported ||= unsupported || payload.media.length > 12;
      const now = iso();
      this.db.prepare('UPDATE deliveries SET payload=?,next_attempt_at=?,updated_at=? WHERE delivery_key=?')
        .run(json(payload), new Date(Date.now() + 5000).toISOString(), now, key);
      return true;
    });
  }

  nextDelivery() {
    return this.db.prepare(`SELECT d.* FROM deliveries d WHERE d.status IN ('queued','retrying')
      AND d.next_attempt_at<=? AND NOT EXISTS (
        SELECT 1 FROM deliveries earlier WHERE earlier.pair_key=d.pair_key
          AND earlier.direction=d.direction AND earlier.id<d.id
          AND earlier.status IN ('queued','retrying','uploading','unknown')
      ) ORDER BY d.id LIMIT 1`).get(iso());
  }

  startDelivery(id) {
    this.db.prepare("UPDATE deliveries SET status='uploading',attempts=attempts+1,updated_at=? WHERE id=? AND status IN ('queued','retrying')").run(iso(), id);
  }

  wasRelayed(pairKey, platform, messageId) {
    return Boolean(this.db.prepare('SELECT 1 FROM relayed_messages WHERE pair_key=? AND platform=? AND message_id=?')
      .get(pairKey, platform, String(messageId)));
  }

  finishDelivery(id, status, targetIds = null, error = null, delayMs = 0) {
    const now = iso();
    const job = this.db.prepare('SELECT attempts,pair_key,direction FROM deliveries WHERE id=?').get(id);
    this.transaction(() => {
      this.db.prepare(`UPDATE deliveries SET status=?,target_ids=?,error=?,next_attempt_at=?,updated_at=? WHERE id=?`)
        .run(status, targetIds ? json(targetIds) : null, error?.slice(0, 500) ?? null,
          new Date(Date.now() + delayMs).toISOString(), now, id);
      this.db.prepare(`INSERT INTO delivery_attempts(delivery_id,started_at,finished_at,result,error) VALUES (?,?,?,?,?)`)
        .run(id, now, now, status, error?.slice(0, 500) ?? null);
      if (['sent', 'partial', 'unknown'].includes(status) && targetIds?.length) {
        const platform = job.direction === 'tg_to_max' ? 'max' : 'telegram';
        const insert = this.db.prepare(`INSERT OR IGNORE INTO relayed_messages(pair_key,platform,message_id,created_at)
          VALUES (?,?,?,?)`);
        for (const targetId of targetIds) insert.run(job.pair_key, platform, String(targetId), now);
      }
    });
    return job?.attempts;
  }

  close() { this.db.close(); }
}
