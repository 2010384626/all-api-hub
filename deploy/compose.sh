#!/usr/bin/env bash
set -Eeuo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
[[ -f "$ROOT/.env.web" ]] || { echo 'Run bash deploy/setup.sh first.' >&2; exit 1; }
mkdir -p "$ROOT/.deploy"
if [[ ! -f "$ROOT/.deploy/image.env" ]]; then
  (umask 077; printf 'AAH_IMAGE=all-api-hub-web:local\n' > "$ROOT/.deploy/image.env")
fi
exec docker compose --project-directory "$ROOT" --env-file "$ROOT/.env.web" --env-file "$ROOT/.deploy/image.env" -f "$ROOT/compose.web.yaml" "$@"
