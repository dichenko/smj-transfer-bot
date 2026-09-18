# Telegram ↔ MAX bridge

Minimal two-way relay for a Telegram group and a MAX group. It uses Telegram long polling and a MAX HTTPS webhook.

## What it does

- receives new messages from one configured Telegram group and one configured MAX group;
- sends text and media captions in both directions, with a source label;
- accepts messages only from the two configured group IDs and never from private chats;
- relays messages only from allowlisted users;
- skips media-only messages until attachment transfer is implemented.

Telegram uses long polling. MAX uses an HTTPS webhook at `https://your-domain.example/max/webhook`; the bridge registers it with MAX automatically at startup.

## Local setup

1. Install Node.js 20 or later on the VPS.
2. Create a Telegram bot with BotFather and add it to the source group. To receive every ordinary group message, disable the bot's privacy mode in BotFather or grant the bot appropriate group access.
3. Create and approve a MAX bot, enable adding it to group chats, then add it manually to the destination MAX group.
4. Copy `.env.example` to `.env`, then fill in the tokens and Telegram source chat ID. `MAX_TARGET_CHAT_ID` can remain empty during the first setup. The real `.env` is intentionally ignored by Git.
5. Install and run:

   ```bash
   npm install
   npm start
   ```

6. If the Telegram source chat ID is unknown, leave `TELEGRAM_SOURCE_CHAT_ID` empty once, write a message in the group, and read its ID from the application log. Then set it in `.env` and restart.

The MAX bot must be allowed to join the group, be an administrator with permission to read group messages, and have permission to write there. Keep the bot token and `MAX_WEBHOOK_SECRET` private.

## Chat and user access control

The bridge follows a deny-by-default policy:

- Telegram accepts only `group` and `supergroup` updates whose ID exactly matches `TELEGRAM_SOURCE_CHAT_ID`.
- MAX accepts only group-chat updates whose ID exactly matches `MAX_TARGET_CHAT_ID`; private dialogs use a different chat type and are ignored.
- `TELEGRAM_ALLOWED_USER_IDS` and `MAX_ALLOWED_USER_IDS` are comma-separated user-ID allowlists. An empty list means no messages are relayed on that side.
- Messages from bots are ignored to prevent relay loops.

For example:

```env
TELEGRAM_ALLOWED_USER_IDS=123456789,987654321
MAX_ALLOWED_USER_IDS=111222333,444555666
```

## Logging and finding MAX user IDs

The service writes readable text lines to `logs/bridge.log.txt` in the project folder on the VPS. The file is bind-mounted from the host, so it remains after container recreation and can be opened directly through a file manager or SFTP client—no Docker command is needed to read it. It records a user's ID, display name, username when available, bot flag, and MAX last-activity timestamp when provided by MAX. It also records the first 100 characters of message text or a media caption; the full message is not written to logs.

Only messages from the configured Telegram and MAX groups are logged. Private dialogs and all unconfigured groups are ignored without a reply or user-data log entry. Users who are not yet allowlisted are still logged in the configured groups, but their messages are not relayed; this lets you discover and approve their IDs safely.

To watch the logs:

```bash
docker compose logs -f bridge
```

When a user posts in the configured MAX group, look for `MAX group user observed` and copy `userId` into `MAX_ALLOWED_USER_IDS`. The MAX webhook contains the sender as `message.sender.user_id`.

The same lines also remain available via `docker compose logs`; Docker retains three 10 MB rotated log files. `logs/bridge.log.txt` is not automatically rotated, so review or archive it periodically and restrict access to the project folder because it contains user metadata and message previews.

## Obtaining `MAX_TARGET_CHAT_ID`

The ID is supplied by MAX in the `bot_added` webhook event. The setup sequence is:

1. Leave `MAX_TARGET_CHAT_ID=` empty in `.env` and set a real `MAX_WEBHOOK_SECRET`.
2. Start the container and confirm that Caddy and `https://your-domain.example/max/webhook` are reachable.
3. Add the MAX bot to the destination group. If it was already added before the webhook was configured, remove it and add it again.
4. Read the `chatId` from `docker compose logs -f bridge`. The application also prints a direct instruction to set `MAX_TARGET_CHAT_ID`.
5. Put that value into `.env` and recreate the container:

   ```bash
   docker compose up -d --force-recreate
   ```

The ID is usually a negative integer. Copy it exactly, without quotes or spaces.

While `MAX_TARGET_CHAT_ID` is empty, the bridge automatically runs in MAX diagnostic mode. It logs every update received from MAX, including the chat ID, chat type, sender details, message ID, and the first 100 characters of text or caption. It does not relay or reply to any of those messages. This lets you discover the target chat and MAX user IDs. As soon as `MAX_TARGET_CHAT_ID` is filled in and the container is recreated, diagnostic mode switches off automatically; only that one group is then processed and logged.

## Limits and next steps

This template intentionally starts with text and captions. Photos, files, voice messages, edits, replies, and retries/outbox storage can be added after the basic route is confirmed. MAX permits no more than two outgoing messages per second to one chat, so a production version carrying traffic or attachments should add a persistent queue.

Official MAX references: [sending messages](https://dev.max.ru/docs-api/methods/POST/messages) and [long polling limits](https://dev.max.ru/docs-api/methods/GET/updates).

## Docker deployment

The image has no exposed ports: Telegram polling and outgoing requests to MAX only require outbound HTTPS. The container runs as an unprivileged user and restarts automatically after a server reboot or application failure.

1. Keep `.env` only on the server. It is ignored by Git and is not copied into the image.
2. Build and start the bridge:

   ```bash
   mkdir -p logs && chown 1000:1000 logs
   docker compose up -d --build
   ```

3. Inspect the service:

   ```bash
   docker compose logs -f
   ```

4. After changing `.env`, recreate the container:

   ```bash
   docker compose up -d --force-recreate
   ```

To stop it:

```bash
docker compose down
```

### GitHub and VPS checklist

- Commit `Dockerfile`, `compose.yaml`, `.dockerignore`, `src/`, `package.json`, `.env.example`, and `README.md`.
- Never commit `.env` or bot tokens.
- Clone the repository on the VPS, create `.env` there from `.env.example`, fill the values, and run the Docker command above.
- No manual certificate installation is needed on the VPS. During the Docker build, the image downloads the official Russian Ministry of Digital Development root and issuing certificates, adds them to its own trusted certificate store, and explicitly supplies their chain to Node.js. The root download is accepted only when its SHA-256 fingerprint matches the value pinned in `scripts/install-mincifry-ca.sh`; the issuing certificate must verify against that pinned root.
- Copy and adapt [`deploy/Caddyfile.example`](deploy/Caddyfile.example) into the shared Caddyfile, then validate and reload Caddy. It accepts public HTTPS at your domain and proxies the webhook to the container's loopback-only `APP_PORT`. The same `APP_PORT` is used inside the container and on the loopback binding.
- Point your webhook domain's DNS record to the VPS before starting the bridge. Caddy must obtain a publicly trusted TLS certificate; MAX does not accept a self-signed certificate.
