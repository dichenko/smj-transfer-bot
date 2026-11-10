#!/usr/bin/env bash
set -euo pipefail

warp() {
  timeout 12 warp-cli --accept-tos "$@"
}

daemon_log=/tmp/warp-probe.log
warp-svc > "$daemon_log" 2>&1 &
daemon=$!
registered=false

cleanup() {
  if "$registered"; then
    warp registration delete >/dev/null 2>&1 || true
  fi
  kill -TERM "$daemon" 2>/dev/null || true
  wait "$daemon" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT TERM

diagnose() {
  warp status || true
  ip -brief link
  grep -Eoi 'permission denied|operation not permitted|network unreachable|timed out|failed to [a-z]+ (TUN|DNS|route|tunnel)|HTTP/[0-9.]+ [45][0-9][0-9]' \
    "$daemon_log" | sort | uniq -c || true
}

for attempt in {1..10}; do
  if warp status >/dev/null 2>&1; then break; fi
  if ! kill -0 "$daemon" || [[ "$attempt" == 10 ]]; then
    echo 'warp-svc did not start'
    diagnose
    exit 1
  fi
  sleep 1
done

if ! warp registration new; then
  diagnose
  exit 1
fi
registered=true
warp mode warp+doh

probe_media() {
  python3 - <<'PY'
import os
import socket
import struct
import time

endpoint = ("149.154.167.151", 443)
try:
    connection = socket.create_connection(endpoint, timeout=6)
except OSError as error:
    print(f"Telegram media {endpoint[0]}:{endpoint[1]} TCP: {error}")
    raise SystemExit(1)

print(f"Telegram media {endpoint[0]}:{endpoint[1]} TCP: connected")
try:
    with connection, connection.makefile("rb") as response:
        nonce = os.urandom(16)
        message_id = (time.time_ns() * (1 << 32) // 1_000_000_000) & ~3
        payload = struct.pack("<QQII16s", 0, message_id, 20, 0xbe7e8ef1, nonce)
        connection.sendall(bytes((0xef, len(payload) // 4)) + payload)
        header = response.read(1)
        if not header:
            raise OSError("connection closed before the MTProto response")
        words = int.from_bytes(response.read(3), "little") if header[0] == 0x7f else header[0]
        if not 10 <= words <= 512:
            raise OSError("unexpected MTProto packet length")
        body = response.read(words * 4)
        if body[20:40] != struct.pack("<I16s", 0x05162463, nonce):
            raise OSError("unexpected MTProto response")
except OSError as error:
    print(f"Telegram media MTProto: {error}")
    raise SystemExit(2)
print("Telegram media MTProto: valid resPQ")
PY
}

for protocol in MASQUE WireGuard; do
  echo "Testing $protocol"
  warp disconnect || true
  if ! warp tunnel protocol set "$protocol" || ! warp connect; then
    diagnose
    continue
  fi

  for attempt in {1..6}; do
    trace=$(curl --noproxy '*' -4fsS --max-time 5 https://www.cloudflare.com/cdn-cgi/trace || true)
    if grep -qx 'warp=on' <<< "$trace"; then
      echo "WARP confirmed over $protocol"
      warp status
      ip -4 route get 149.154.167.151
      api_ok=false
      if curl --noproxy '*' -4sS --max-time 10 -o /dev/null -w 'Telegram Bot API HTTP %{http_code}\n' https://api.telegram.org/; then
        api_ok=true
      fi
      if probe_media && "$api_ok"; then exit 0; fi
      break
    fi
    sleep 2
  done
  diagnose
done

echo 'WARP did not pass both Telegram checks'
exit 1
