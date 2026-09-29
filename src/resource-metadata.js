export function maxRefreshMode(row, updateType) {
  if (!row) return null;
  if (['bot_added', 'bot_admin_permissions_changed', 'chat_title_changed'].includes(updateType)) return 'rights';
  return !row.title || !row.bot_status ? 'metadata' : null;
}

export async function refreshMaxResource(store, max, id, includeRights = false) {
  const row = store.db.prepare("SELECT kind FROM discovered_resources WHERE platform='max' AND resource_id=?")
    .get(String(id));
  if (!row) return false;
  const chat = await max.getChat(id);
  if (chat.type !== row.kind) throw new Error('MAX resource type changed');
  store.updateResourceMetadata('max', id, chat.title, chat.status, chat.link);
  if (includeRights) {
    const member = await max.request(`/chats/${encodeURIComponent(String(id))}/members/me`);
    store.checkedResource('max', row.kind, id, chat.title, chat.status, member.permissions ?? [], chat.link);
  }
  return true;
}

export async function refreshMissingResources(store, max, telegram, log) {
  const rows = store.db.prepare(`SELECT platform,kind,resource_id FROM discovered_resources
    WHERE title IS NULL OR title='' OR bot_status IS NULL ORDER BY platform,resource_id LIMIT 100`).all();
  let me;
  for (const row of rows) {
    try {
      if (row.platform === 'max') {
        await refreshMaxResource(store, max, row.resource_id);
      } else if (row.platform === 'telegram') {
        const chat = await telegram.api.getChat(row.resource_id);
        if (row.kind === 'channel' ? chat.type !== 'channel' : !['group', 'supergroup'].includes(chat.type)) {
          throw new Error('Telegram resource type changed');
        }
        me ??= await telegram.api.getMe();
        const member = await telegram.api.getChatMember(row.resource_id, me.id);
        const status = ['left', 'kicked'].includes(member.status) ? 'removed' : 'active';
        store.updateResourceMetadata('telegram', row.resource_id, chat.title, status,
          chat.username ? `https://t.me/${chat.username}` : null);
      }
    } catch (error) {
      log('warn', 'Resource metadata refresh failed', {
        platform: row.platform, id: row.resource_id, error: error.message
      });
    }
  }
}
