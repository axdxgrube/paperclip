#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

log() {
  echo "[db-migration-smoke] $*"
}

fail() {
  echo "[db-migration-smoke] ERROR: $*" >&2
  exit 1
}

make_temp_dir() {
  local dir
  if dir="$(mktemp -d 2>/dev/null)"; then
    printf "%s" "$dir"
    return 0
  fi
  mktemp -d -t paperclip-db-migration-smoke
}

snapshot_migrations() {
  (
    cd "$REPO_ROOT"
    find packages/db/src/migrations -type f | LC_ALL=C sort | while IFS= read -r path; do
      shasum -a 256 "$path"
    done
  )
}

wait_for_health() {
  local url="$1"
  local pid="$2"
  local attempt=0
  while (( attempt < 60 )); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    if ! kill -0 "$pid" >/dev/null 2>&1; then
      return 1
    fi
    attempt=$((attempt + 1))
    sleep 1
  done
  return 1
}

TMP_DIR="$(make_temp_dir)"
INSTANCE_ID="db-migration-smoke"
SERVER_PORT="${PAPERCLIP_DB_SMOKE_PORT:-3241}"
SERVER_LOG="${TMP_DIR}/server.log"
SERVER_PID=""

cleanup() {
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

cd "$REPO_ROOT"

log "Capturing migration snapshot before generation"
before_snapshot="$(snapshot_migrations)"

log "Running drizzle generation compile path (pnpm db:generate)"
pnpm db:generate

log "Verifying db:generate did not mutate tracked migrations"
after_snapshot="$(snapshot_migrations)"
if [[ "$before_snapshot" != "$after_snapshot" ]]; then
  git --no-pager diff -- packages/db/src/migrations || true
  fail "db:generate produced migration changes. Commit schema/migration updates before merging."
fi

log "Applying migrations in a clean embedded Postgres home"
env \
  -u DATABASE_URL \
  PAPERCLIP_HOME="${TMP_DIR}/paperclip-home" \
  PAPERCLIP_INSTANCE_ID="$INSTANCE_ID" \
  pnpm db:migrate

log "Building workspace packages required for server startup"
pnpm --filter @paperclipai/plugin-sdk build

log "Booting API against the freshly prepared schema"
env \
  -u DATABASE_URL \
  PAPERCLIP_HOME="${TMP_DIR}/paperclip-home" \
  PAPERCLIP_INSTANCE_ID="$INSTANCE_ID" \
  PAPERCLIP_UI_DEV_MIDDLEWARE=false \
  PAPERCLIP_MIGRATION_PROMPT=never \
  PAPERCLIP_MIGRATION_AUTO_APPLY=false \
  HOST=127.0.0.1 \
  PORT="$SERVER_PORT" \
  pnpm --filter @paperclipai/server dev >"$SERVER_LOG" 2>&1 &
SERVER_PID="$!"

if ! wait_for_health "http://127.0.0.1:${SERVER_PORT}/api/health" "$SERVER_PID"; then
  cat "$SERVER_LOG" >&2 || true
  fail "Server failed to become healthy after migration smoke startup check."
fi

log "Smoke validation passed"
