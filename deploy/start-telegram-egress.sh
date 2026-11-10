#!/usr/bin/env bash
set -euo pipefail

: "${TELEGRAM_EGRESS_SSH_TARGET:?Missing Telegram egress SSH target}"
ssh_command='ssh -F /dev/null -i /run/telegram-egress/id_ed25519 -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/run/telegram-egress/known_hosts -o GlobalKnownHostsFile=/dev/null -o ConnectTimeout=8 -o ServerAliveInterval=15 -o ServerAliveCountMax=2'
/opt/sshuttle/bin/sshuttle --method nat --disable-ipv6 --listen 127.0.0.1:0 \
  --remote "$TELEGRAM_EGRESS_SSH_TARGET" --ssh-cmd "$ssh_command" \
  --subnets /etc/telegram-ipv4.txt &
tunnel_pid=$!
api_pid=''

stop_children() {
  if [[ -n "$api_pid" ]]; then
    kill -TERM "$api_pid" 2>/dev/null || true
    wait "$api_pid" 2>/dev/null || true
  fi
  kill -TERM "$tunnel_pid" 2>/dev/null || true
  wait "$tunnel_pid" 2>/dev/null || true
}
trap stop_children EXIT
trap 'exit 0' TERM INT

# TLS proves the remote connection works; a TCP connect alone only reaches sshuttle.
for attempt in {1..6}; do
  kill -0 "$tunnel_pid"
  if su-exec 1000:1000 curl --noproxy '*' --ipv4 -sS -o /dev/null --max-time 5 https://api.telegram.org/; then
    echo 'Telegram egress is ready'
    if [[ "${1:-}" == '--probe' ]]; then exit 0; fi
    su-exec 1000:1000 telegram-bot-api "$@" &
    api_pid=$!
    wait -n "$tunnel_pid" "$api_pid"
    exit 1
  fi
  sleep 1
done
echo 'Telegram egress did not pass the TLS check' >&2
exit 1
