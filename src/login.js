import { createHash, randomBytes, randomUUID } from 'node:crypto';

export const randomToken = () => randomBytes(32).toString('base64url');
export const tokenHash = (value) => createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();

export async function issueLoginLink({ store, config, ctx, log }) {
  const userId = String(ctx.from?.id);
  if (!config.adminTelegramUserIds.has(userId) || !config.adminWebUrl?.startsWith('https://')) {
    await ctx.reply('Команда недоступна.');
    return;
  }
  const recent = store.db.prepare('SELECT created_at FROM admin_login_requests WHERE telegram_user_id=? ORDER BY created_at DESC LIMIT 1').get(userId);
  if (recent && Date.now() - Date.parse(recent.created_at) < 10_000) {
    await ctx.reply('Подождите несколько секунд перед новым запросом.');
    return;
  }
  const token = randomToken();
  const requestId = randomUUID();
  const createdAt = now();
  store.transaction(() => {
    store.db.prepare("UPDATE admin_login_requests SET status='cancelled' WHERE telegram_user_id=? AND status IN ('issued','pending')").run(userId);
    store.db.prepare(`INSERT INTO admin_login_requests
      (id,token_hash,telegram_user_id,status,expires_at,created_at) VALUES (?,?,?,?,?,?)`).run(
      requestId, tokenHash(token), userId, 'issued', new Date(Date.now() + 300_000).toISOString(), createdAt);
  });
  await ctx.reply(`Ссылка для входа (5 минут): ${config.adminWebUrl.replace(/\/$/, '')}/login#${token}`,
    { link_preview_options: { is_disabled: true } });
  log('info', 'Admin login link issued', { userId });
}

export async function handleLoginCallback({ store, config, ctx, log }) {
  const match = /^admin:(confirm|cancel):([0-9a-f-]{36})$/.exec(ctx.callbackQuery.data ?? '');
  if (!match) return;
  const [, action, requestId] = match;
  const userId = String(ctx.from?.id);
  const request = store.db.prepare('SELECT * FROM admin_login_requests WHERE id=?').get(requestId);
  if (!request || request.telegram_user_id !== userId || !config.adminTelegramUserIds.has(userId)
      || request.status !== 'pending' || request.expires_at <= now()) {
    await ctx.answerCallbackQuery({ text: 'Запрос недействителен или истёк.' });
    log('warn', 'Admin login confirmation rejected', { userId });
    return;
  }
  const status = action === 'confirm' ? 'confirmed' : 'cancelled';
  const changed = store.db.prepare("UPDATE admin_login_requests SET status=? WHERE id=? AND status='pending'").run(status, requestId).changes;
  await ctx.answerCallbackQuery({ text: changed ? (action === 'confirm' ? 'Вход подтверждён.' : 'Вход отменён.') : 'Запрос уже обработан.' });
  log('info', `Admin login ${status}`, { userId });
}
