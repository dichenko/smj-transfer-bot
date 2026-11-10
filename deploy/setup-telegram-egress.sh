#!/usr/bin/env bash
set -euo pipefail

account=smj-telegram-egress
relay_home=/var/lib/smj-telegram-egress
umask 077

ed25519_key() {
  local key_type key_data
  read -r key_type key_data _ <<< "$1"
  if [[ "$key_type" != ssh-ed25519 || ! "$key_data" =~ ^[A-Za-z0-9+/=]+$ ]]; then
    echo 'Expected an Ed25519 public key' >&2
    return 1
  fi
  printf '%s %s\n' "$key_type" "$key_data" | ssh-keygen -l -f /dev/stdin >&2 || return 1
  printf '%s %s\n' "$key_type" "$key_data"
}

case "${1:-}" in
  init)
    client_dir=${2:-.telegram-egress}
    install -d -m 0700 "$client_dir"
    if [[ ! -e "$client_dir/id_ed25519" ]]; then
      ssh-keygen -q -t ed25519 -N '' -C smj-telegram-egress -f "$client_dir/id_ed25519"
    fi
    ssh-keygen -y -f "$client_dir/id_ed25519"
    ;;
  trust)
    client_dir=${2:?Specify the client directory}
    host=${3:?Specify the SSH host from the Compose target}
    host_key=$(ed25519_key "${4:?Specify the verified public host key}")
    printf '%s %s\n' "$host" "$host_key" > "$client_dir/known_hosts"
    ;;
  authorize)
    source_ip=${2:?Specify the current VPS public IPv4 address}
    public_key=$(ed25519_key "${3:?Specify the public key from init}")
    if [[ ! "$source_ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      echo 'Expected an IPv4 source' >&2
      exit 1
    fi
    if ! id "$account" >/dev/null 2>&1; then
      useradd --system --no-create-home --home-dir "$relay_home" --shell /bin/sh "$account"
    fi
    install -d -o root -g root -m 0755 "$relay_home" "$relay_home/.ssh"
    key_file=$(mktemp "$relay_home/.ssh/key.XXXXXX")
    trap 'rm -f -- "$key_file"' EXIT
    printf 'from="%s",restrict %s\n' "$source_ip" "$public_key" > "$key_file"
    chmod 0644 "$key_file"
    mv -f -- "$key_file" "$relay_home/.ssh/authorized_keys"
    ;;
  *)
    echo 'Usage: setup-telegram-egress.sh init [directory] | trust directory host "host-public-key" | authorize source-ip "client-public-key"' >&2
    exit 2
    ;;
esac
