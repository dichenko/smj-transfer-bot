#!/usr/bin/env bash
set -euo pipefail
cd /opt/smj-transfer-bot
compose=(docker compose --env-file .env --env-file /etc/smj-transfer-bot/deploy.env
  -f compose.yaml -f compose.telegram-egress.yaml)

"${compose[@]}" config --quiet
"${compose[@]}" build bridge telegram-api
"${compose[@]}" run --rm --no-deps -T telegram-api --probe </dev/null
if [[ -n $("${compose[@]}" ps --status running -q bridge) ]]; then
  "${compose[@]}" exec -T bridge node scripts/backup-db.js
fi
"${compose[@]}" up -d --no-build --wait --wait-timeout 180
# The bridge healthcheck covers its HTTP server. Also verify the panel and live egress.
"${compose[@]}" exec -T admin node -e '
  fetch("http://127.0.0.1:"+(process.env.ADMIN_PORT||3700)+"/login",
    {signal:AbortSignal.timeout(10000)}).then(r=>process.exit(r.ok?0:1))'
for attempt in {1..12}; do
  if "${compose[@]}" exec -T telegram-api sh -ec 'pidof sshuttle >/dev/null && pidof telegram-bot-api >/dev/null &&
    su-exec 1000:1000 curl --noproxy "*" -4fsS -o /dev/null --max-time 5 https://api.telegram.org/'; then
    "${compose[@]}" exec -T bridge node -e '
      const url = process.env.TELEGRAM_API_ROOT + "/bot" + process.env.TELEGRAM_BOT_TOKEN + "/getMe";
      fetch(url,{signal:AbortSignal.timeout(15000)}).then(r=>r.json())
        .then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'
    printf 'Deployed and verified %s\n' "$(git rev-parse HEAD)"
    exit 0
  fi
  sleep 2
done
echo 'Live Telegram egress check failed' >&2
exit 1
