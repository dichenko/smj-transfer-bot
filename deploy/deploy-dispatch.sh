#!/usr/bin/env bash
# Install as /usr/local/sbin/smj-transfer-deploy, owned by root.
set -euo pipefail

if (( EUID != 0 )); then
  [[ ${SSH_ORIGINAL_COMMAND:-} =~ ^deploy\ ([0-9a-f]{40})$ ]] || exit 64
  exec sudo -n /usr/local/sbin/smj-transfer-deploy "${BASH_REMATCH[1]}"
fi

[[ $# == 1 && $1 =~ ^[0-9a-f]{40}$ ]] || exit 64
cd /opt/smj-transfer-bot
exec 9>/run/lock/smj-transfer-bot-deploy.lock
flock -w 900 9
git fetch origin refs/heads/main
if [[ $(git rev-parse FETCH_HEAD) != "$1" ]]; then
  echo 'Superseded by a newer main commit.'
  exit 0
fi
[[ $(git branch --show-current) == main && -z $(git status --porcelain) ]]
git merge --ff-only "$1"
[[ $(git rev-parse HEAD) == "$1" ]]
exec bash deploy/deploy.sh
