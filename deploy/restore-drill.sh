#!/usr/bin/env bash
# Prove the latest backup restores: start a throwaway container on port 3001
# against a copy of the newest backup, check health/auth/row counts, clean up.
set -euo pipefail

IMAGE="${IMAGE:-recipedb:0.1}"
BASE=/srv/recipedb
BACKUPS="$BASE/backups"
DRILL="$BASE/restore-drill"
DATA="$DRILL/data"
ENV_FILE="$BASE/env"
NAME=recipedb-drill
PORT=3001

log() { printf '[restore-drill] %s\n' "$*"; }
die() { printf '[restore-drill] error: %s\n' "$*" >&2; exit 1; }

cleanup() {
  local rc=$?
  if [[ $rc -ne 0 ]]; then
    printf '[restore-drill] container logs:\n' >&2
    docker logs --tail 40 "$NAME" >&2 2>&1 || true
  fi
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  if [[ $rc -eq 0 ]]; then
    log "PASS"
  else
    log "FAIL (exit $rc)"
  fi
}
trap cleanup EXIT

command -v docker >/dev/null 2>&1 || die "docker not found"
[[ -f "$ENV_FILE" ]] || die "missing env file $ENV_FILE"

latest_db="$(ls -1t "$BACKUPS"/recipes-*.db 2>/dev/null | head -n1 || true)"
latest_images="$(ls -1t "$BACKUPS"/images-*.tar.gz 2>/dev/null | head -n1 || true)"
latest_journal="$(ls -1t "$BACKUPS"/migrations-applied-*.json 2>/dev/null | head -n1 || true)"
[[ -n "$latest_db" ]] || die "no recipes-*.db found in $BACKUPS"
[[ -n "$latest_journal" ]] || die "no migrations-applied-*.json found in $BACKUPS (needed: the app replays migrations without it)"

log "restoring $(basename "$latest_db") into $DATA"
docker rm -f "$NAME" >/dev/null 2>&1 || true
rm -rf "$DRILL"
mkdir -p "$DATA"
cp "$latest_db" "$DATA/recipes.db"
cp "$latest_journal" "$DATA/migrations-applied.json"
rm -f "$DATA/recipes.db-wal" "$DATA/recipes.db-shm"

if [[ -n "$latest_images" ]]; then
  log "extracting $(basename "$latest_images")"
  tar -xzf "$latest_images" -C "$DATA"
else
  log "warning: no images-*.tar.gz found, drill continues without images"
fi

# Same uid the image runs as (see run-container.sh): the container must be able
# to write /data (migrations, WAL side files).
chown -R 1000:1000 "$DATA"

log "starting $NAME from $IMAGE on port $PORT"
docker run -d --rm \
  --name "$NAME" \
  -p "$PORT:3000" \
  --env-file "$ENV_FILE" \
  -v "$DATA:/data" \
  "$IMAGE" >/dev/null

fetch() { curl -sS --max-time 2 -o /dev/null -w '%{http_code}' "$1" 2>/dev/null || true; }

health_body=""
for _ in $(seq 1 30); do
  health_body="$(curl -fsS --max-time 2 "http://127.0.0.1:$PORT/health" 2>/dev/null || true)"
  if grep -Eq '"db"[[:space:]]*:[[:space:]]*"ok"' <<<"$health_body"; then
    break
  fi
  sleep 1
done
grep -Eq '"db"[[:space:]]*:[[:space:]]*"ok"' <<<"$health_body" \
  || die "health did not report db ok (last body: ${health_body:-<empty>})"
log "health: $health_body"

root_code="$(fetch "http://127.0.0.1:$PORT/")"
[[ "$root_code" == "302" ]] || die "expected / to return 302, got $root_code"
root_location="$(curl -sS --max-time 2 -o /dev/null -w '%{redirect_url}' "http://127.0.0.1:$PORT/" 2>/dev/null || true)"
grep -q '/login' <<<"$root_location" || die "expected / redirect to /login, got '${root_location:-<empty>}'"

login_code="$(fetch "http://127.0.0.1:$PORT/login")"
[[ "$login_code" == "200" ]] || die "expected /login to return 200, got $login_code"
log "auth gate: / -> 302 /login, /login -> 200"

# No sqlite3 CLI on the host: count rows from inside the drill container.
counts="$(docker exec "$NAME" node -e '
const Database = require("better-sqlite3");
const db = new Database("/data/recipes.db", { readonly: true, fileMustExist: true });
const integrity = db.pragma("integrity_check", { simple: true });
const recipes = db.prepare("SELECT COUNT(*) AS n FROM recipes").get().n;
const lines = db.prepare("SELECT COUNT(*) AS n FROM ingredient_lines").get().n;
db.close();
console.log(JSON.stringify({ integrity, recipes, ingredient_lines: lines }));
' </dev/null)"
log "restored db: $counts"
grep -q '"integrity":"ok"' <<<"$counts" || die "integrity_check on restored db failed"
grep -q '"recipes":[1-9]' <<<"$counts" || die "restored db has no recipes"
