#!/usr/bin/env bash
set -Eeuo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
[[ ! -e "$ROOT/.env.web" ]] || { echo '.env.web already exists; nothing overwritten.' >&2; exit 1; }
command -v openssl >/dev/null || { echo 'Install openssl first.' >&2; exit 1; }
ORIGIN=${1:-http://localhost:8787}
BASE_PATH=${2:-/}
[[ "$ORIGIN" =~ ^https?://[a-zA-Z0-9.:-]+$ ]] || { echo 'Origin must be http(s)://hostname[:port], without a path.' >&2; exit 1; }
[[ "$BASE_PATH" =~ ^/([a-zA-Z0-9_-]+/)*$ ]] || { echo 'Base path must start and end with /, such as /hub/.' >&2; exit 1; }
umask 077
ADMIN_SECRET=$(openssl rand -hex 24)
DATA_SECRET=$(openssl rand -hex 32)
# noclobber also protects against two setup processes racing.
set -o noclobber
printf 'ADMIN_PASSWORD=%s\nENCRYPTION_KEY=%s\nPUBLIC_ORIGIN=%s\nBASE_PATH=%s\nWEB_PORT=8787\n' "$ADMIN_SECRET" "$DATA_SECRET" "$ORIGIN" "$BASE_PATH" > "$ROOT/.env.web"
mkdir -p "$ROOT/.deploy"
chmod 700 "$ROOT/.deploy"
echo 'Created .env.web (mode 600). Read ADMIN_PASSWORD locally to sign in; keep ENCRYPTION_KEY with your backups.'
echo 'Start with: bash deploy/start.sh'
