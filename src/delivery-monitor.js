// Liveness and delivery readiness are separate: restarting a healthy process
// cannot resolve an ambiguous publication, but operators must see it.
export function deliveryHealth(store, stallSeconds = 600, now = Date.now()) {
  const cutoff = new Date(now - stallSeconds * 1000).toISOString();
  const unresolved = store.db.prepare(`SELECT d.id,d.pair_key,d.direction,d.status,d.stage
    FROM deliveries d JOIN pairs p ON p.key=d.pair_key
    WHERE p.enabled=1 AND p.archived=0 AND d.status IN ('failed','unknown') ORDER BY d.id`).all();
  const stalled = store.db.prepare(`SELECT d.id,d.pair_key,d.direction,d.status,d.stage
    FROM deliveries d JOIN pairs p ON p.key=d.pair_key
    WHERE p.enabled=1 AND p.archived=0 AND d.status IN ('queued','retrying')
    AND d.media_type IN ('text','photo','video','album','voice','audio','document','attachments')
    AND d.created_at<? AND d.next_attempt_at<=? ORDER BY d.id`).all(cutoff, new Date(now).toISOString());
  return { ok: unresolved.length === 0 && stalled.length === 0, unresolved, stalled };
}

export function createDeliveryMonitor({ store, telegram, adminIds, log, stallSeconds = 600 }) {
  const recipients = [...adminIds];
  let busy = false;
  function alert(job, reason = job.status) {
    const key = reason === 'stalled' ? `${job.id}:${reason}` : `${job.id}:${reason}:${job.attempts}`;
    const text = `Мост Telegram ↔ MAX: доставка №${job.id}, пара ${job.pair_key}, ${job.direction}.\n`
      + (reason === 'stalled' ? 'Очередь ожидает дольше установленного порога.'
        : reason === 'unknown' ? 'Результат публикации неизвестен. Проверьте канал перед повтором.'
          : 'Доставка не выполнена. Проверьте ошибку и повторите через панель.')
      + '\nПодробности в панели администратора → Доставки.';
    store.transaction(() => {
      const now = new Date().toISOString();
      const inserted = store.db.prepare(`INSERT OR IGNORE INTO delivery_alerts
        (alert_key,delivery_id,message,created_at) VALUES (?,?,?,?)`).run(key, job.id, text, now);
      if (inserted.changes) for (const recipient of recipients) {
        store.db.prepare(`INSERT INTO alert_notifications(alert_key,recipient,next_attempt_at)
          VALUES (?,?,?)`).run(key, recipient, now);
      }
    });
  }
  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const health = deliveryHealth(store, stallSeconds);
      for (const job of health.stalled) alert(job, 'stalled');
      const notification = store.db.prepare(`SELECT n.*,a.message FROM alert_notifications n
        JOIN delivery_alerts a ON a.alert_key=n.alert_key
        WHERE n.status='queued' AND n.next_attempt_at<=? ORDER BY a.created_at LIMIT 1`)
        .get(new Date().toISOString());
      if (!notification) return;
      try {
        await telegram.api.sendMessage(notification.recipient, notification.message);
        store.db.prepare("UPDATE alert_notifications SET status='sent',attempts=attempts+1 WHERE alert_key=? AND recipient=?")
          .run(notification.alert_key, notification.recipient);
      } catch (error) {
        const attempts = notification.attempts + 1;
        const delayMs = Math.max((error.parameters?.retry_after ?? 0) * 1000,
          Math.min(3_600_000, 60_000 * 2 ** (attempts - 1)));
        store.db.prepare(`UPDATE alert_notifications SET attempts=?,status=?,next_attempt_at=?
          WHERE alert_key=? AND recipient=?`).run(attempts, attempts >= 6 ? 'failed' : 'queued',
          new Date(Date.now() + delayMs).toISOString(), notification.alert_key, notification.recipient);
        // No URLs or nested errors here: they can contain credentials.
        log('warn', 'Delivery alert send failed', { alertKey: notification.alert_key, attempts, errorName: error.name });
      }
    } catch (error) { log('error', 'Delivery monitor failed', { errorName: error.name }); }
    finally { busy = false; }
  }
  const timer = setInterval(() => void tick(), 30_000);
  timer.unref();
  return { alert, tick, stop: () => clearInterval(timer) };
}
