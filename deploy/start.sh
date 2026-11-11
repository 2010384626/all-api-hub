#!/usr/bin/env bash
set -Eeuo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
docker build --file "$ROOT/Dockerfile.web" --target test --tag all-api-hub-web:test "$ROOT"
bash "$ROOT/deploy/compose.sh" up -d --build --wait --wait-timeout 90
