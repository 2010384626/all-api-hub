#!/usr/bin/env bash
# This script runs on the VPS host. The web container never gets Docker access.
set -Eeuo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"
MODE=update
DETECTOR_VERSION=
DATA_VERSION=
while [[ $# -gt 0 ]]; do
  case "$1" in
    --check) MODE=check; shift ;;
    --detector)
      [[ $# -ge 2 && "$2" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.-]+)?$ ]] || { echo 'Expected --detector X.Y.Z' >&2; exit 2; }
      DETECTOR_VERSION=$2; shift 2 ;;
    --data)
      [[ $# -ge 2 && "$2" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.-]+)?$ ]] || { echo 'Expected --data X.Y.Z' >&2; exit 2; }
      DATA_VERSION=$2; shift 2 ;;
    *) echo 'Usage: bash deploy/update.sh [--check] [--detector X.Y.Z] [--data X.Y.Z]' >&2; exit 2 ;;
  esac
done
for tool in git docker mktemp; do command -v "$tool" >/dev/null || { echo "Missing $tool" >&2; exit 1; }; done
[[ $(git rev-parse --show-toplevel) -ef "$ROOT" ]] || { echo 'Run from the repository checkout.' >&2; exit 1; }
[[ -z $(git status --porcelain) ]] || { echo 'Commit or stash local changes before updating; nothing has been deployed.' >&2; exit 1; }
[[ -f .env.web ]] || { echo 'Run deploy/setup.sh first.' >&2; exit 1; }
[[ -f web/server/index.mjs && -f web/package-lock.json ]] || { echo 'The Web adaptation must be committed on this branch.' >&2; exit 1; }
umask 077
mkdir -p .deploy/backups
mkdir .deploy/update.lock 2>/dev/null || { echo 'Another update is running (.deploy/update.lock).' >&2; exit 1; }
CANDIDATE=
OLD_IMAGE=
VOLUME=
BACKUP=
STOPPED=0
ACTIVATED=0
COMPLETE=0

compose() { bash "$ROOT/deploy/compose.sh" "$@"; }
wait_healthy() {
  local container state
  for ((attempt=0; attempt<45; attempt++)); do
    container=$(compose ps -q app)
    state=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$container" 2>/dev/null || true)
    [[ "$state" = healthy ]] && return 0
    [[ "$state" = unhealthy || "$state" = missing ]] && return 1
    sleep 2
  done
  return 1
}
cleanup() {
  local result=$?
  trap - EXIT INT TERM
  set +e
  if [[ "$COMPLETE" = 0 && "$STOPPED" = 1 ]]; then
    echo 'Update did not complete; restoring the previous service.' >&2
    if [[ "$ACTIVATED" = 1 ]]; then
      compose stop app
      if ! docker run --rm --user 0 --mount "type=volume,source=$VOLUME,target=/data" --mount "type=bind,source=$BACKUP,target=/backup,readonly" --entrypoint sh "$OLD_IMAGE" -c 'find /data -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + && tar -C /data -xzf /backup/data.tgz'; then
        echo "DATA RESTORE FAILED. Backup retained at $BACKUP/data.tgz. Service remains stopped; restore it before restarting." >&2
        result=1
        STOPPED=0
      fi
    fi
    if [[ "$STOPPED" = 1 ]]; then
      printf 'AAH_IMAGE=%s\n' "$OLD_IMAGE" > "$ROOT/.deploy/image.env"
      AAH_IMAGE="$OLD_IMAGE" compose up -d --no-build app
      if ! wait_healthy; then echo 'Previous image did not become healthy; inspect Docker logs.' >&2; result=1; fi
    fi
  fi
  [[ -z "$CANDIDATE" ]] || git worktree remove --force "$CANDIDATE" >/dev/null 2>&1
  rmdir "$ROOT/.deploy/update.lock" 2>/dev/null
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

BASE=$(git rev-parse HEAD)
echo 'Fetching the maintained Web fork and preparing an isolated deployment...'
git fetch --no-tags https://github.com/2010384626/all-api-hub.git main
UPSTREAM=$(git rev-parse FETCH_HEAD)
CANDIDATE=$(mktemp -d "${TMPDIR:-/tmp}/all-api-hub-update.XXXXXXXX")
git worktree add --detach "$CANDIDATE" "$BASE"
if ! git -C "$CANDIDATE" -c core.hooksPath=/dev/null -c user.name='All API Hub updater' -c user.email='updater@localhost' merge --no-edit "$UPSTREAM"; then
  echo 'Upstream conflicts with this fork. Live service is unchanged; resolve the merge on your maintained fork before retrying.' >&2
  exit 1
fi
PACKAGES=()
[[ -z "$DETECTOR_VERSION" ]] || PACKAGES+=("lmfpd-sdk@$DETECTOR_VERSION")
[[ -z "$DATA_VERSION" ]] || PACKAGES+=("lmfpd-data@$DATA_VERSION")
if [[ ${#PACKAGES[@]} -gt 0 ]]; then
  docker run --rm --user "$(id -u):$(id -g)" --env npm_config_cache=/tmp/npm --mount "type=bind,source=$CANDIDATE,target=/work" --workdir /work/web node:24-bookworm-slim npm install --package-lock-only --ignore-scripts --save-exact "${PACKAGES[@]}"
fi
sed -E "s/\"revision\": \"[a-f0-9]+\"/\"revision\": \"$UPSTREAM\"/" "$CANDIDATE/deploy/upstream.json" > "$CANDIDATE/deploy/upstream.json.next"
mv "$CANDIDATE/deploy/upstream.json.next" "$CANDIDATE/deploy/upstream.json"
git -C "$CANDIDATE" add deploy/upstream.json web/package.json web/package-lock.json
if ! git -C "$CANDIDATE" diff --cached --quiet; then
  git -C "$CANDIDATE" -c core.hooksPath=/dev/null -c user.name='All API Hub updater' -c user.email='updater@localhost' commit -m 'chore(web): record tested upstream and detector dependencies'
fi
NEXT=$(git -C "$CANDIDATE" rev-parse HEAD)
TAG="all-api-hub-web:$NEXT"
docker build --file "$CANDIDATE/Dockerfile.web" --target test --tag all-api-hub-web:test "$CANDIDATE"
docker build --file "$CANDIDATE/Dockerfile.web" --target runtime --tag "$TAG" "$CANDIDATE"
if [[ "$MODE" = check ]]; then
  echo "Candidate build and checks passed ($NEXT). Live service and checkout unchanged."
  COMPLETE=1
  exit 0
fi
# Recheck after the build so an operator's concurrent edit is never overwritten.
[[ $(git rev-parse HEAD) = "$BASE" && -z $(git status --porcelain) ]] || { echo 'Checkout changed during update; deployment cancelled.' >&2; exit 1; }
CONTAINER=$(compose ps -q app)
[[ -n "$CONTAINER" ]] || { echo 'No running app to back up. Use deploy/start.sh for the first deployment.' >&2; exit 1; }
OLD_IMAGE=$(docker inspect --format '{{.Image}}' "$CONTAINER")
VOLUME=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' "$CONTAINER")
[[ "$OLD_IMAGE" = sha256:* && "$VOLUME" = all-api-hub-web-data ]] || { echo 'Unexpected image/data mount; update stopped before touching the service.' >&2; exit 1; }
BACKUP="$ROOT/.deploy/backups/$(date -u +%Y%m%dT%H%M%SZ)-${BASE:0:12}"
mkdir "$BACKUP"
cp "$ROOT/.env.web" "$BACKUP/environment.env"
printf '%s\n' "$BASE" > "$BACKUP/revision"
printf '%s\n' "$OLD_IMAGE" > "$BACKUP/image"
echo 'Backing up encrypted data before switching the image...'
compose stop app
STOPPED=1
docker run --rm --user 0 --mount "type=volume,source=$VOLUME,target=/data,readonly" --mount "type=bind,source=$BACKUP,target=/backup" --entrypoint sh "$OLD_IMAGE" -c 'tar -C /data -czf /backup/data.tgz . && chmod 600 /backup/data.tgz'
ACTIVATED=1
AAH_IMAGE="$TAG" compose up -d --no-build app
wait_healthy || { echo 'Candidate health check failed.' >&2; exit 1; }
git -c core.hooksPath=/dev/null merge --ff-only "$NEXT"
printf 'AAH_IMAGE=%s\n' "$TAG" > "$ROOT/.deploy/image.env.next"
mv "$ROOT/.deploy/image.env.next" "$ROOT/.deploy/image.env"
COMPLETE=1
echo "Updated to $NEXT. Backup: $BACKUP. Keep its environment.env secret."
