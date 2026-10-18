#!/usr/bin/env bash
# LOCAL DEV / VERIFICATION ONLY.
#
# Docker-on-prox6 was retired 2026-10-18 (its dataset was migrated into the k8s
# PVC `recipedb-data`); prox6-docker is never a deployment target again.
# Production is the helm release on k8s — see deploy/k8s/deploy.sh.
#
# This script still works for running a single throwaway container on a dev box;
# point RECIPEDB_BASE at a writable directory you own to avoid needing /srv.
#
# Usage: ./run-container.sh [image-tag]   (default: recipedb:0.1)
set -euo pipefail

IMAGE="${1:-recipedb:0.1}"
NAME=recipedb
BASE="${RECIPEDB_BASE:-/srv/recipedb}"
ENV_FILE="$BASE/env"

log() { printf '[run-container] %s\n' "$*"; }
die() { printf '[run-container] error: %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || die "docker not found"
[[ -f "$ENV_FILE" ]] || die "missing env file $ENV_FILE (copy deploy/recipedb.env.example there, chmod 600)"

# Keep the secret file private even if it was copied with looser modes.
chmod 600 "$ENV_FILE"

mkdir -p "$BASE/data" "$BASE/backups"

# The image runs as the unprivileged `node` user (uid 1000); it must own the
# /data volume or migrations fail with EACCES on /data/images. The backups dir
# is mounted into the container for the nightly `docker exec` backup (#13).
mkdir -p "$BASE/data/images"
chown -R 1000:1000 "$BASE/data"
mkdir -p "$BASE/backups"
chown 1000:1000 "$BASE/backups"

if docker container inspect "$NAME" >/dev/null 2>&1; then
  log "removing existing container $NAME"
  docker rm -f "$NAME" >/dev/null
fi

log "starting $NAME from $IMAGE"
docker run -d \
  --name "$NAME" \
  --restart unless-stopped \
  -p 3000:3000 \
  --env-file "$ENV_FILE" \
  -v "$BASE/data:/data" \
  -v "$BASE/backups:/backups" \
  -v "$BASE/backup.cjs:/app/backup.cjs:ro" \
  "$IMAGE" >/dev/null

fetch_health() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsS --max-time 2 http://127.0.0.1:3000/health 2>/dev/null
  elif command -v wget >/dev/null 2>&1; then
    wget -qO- --timeout=2 http://127.0.0.1:3000/health 2>/dev/null
  else
    docker exec "$NAME" node -e \
      'fetch("http://127.0.0.1:3000/health").then(r=>r.text()).then(t=>process.stdout.write(t)).catch(()=>process.exit(1))' 2>/dev/null
  fi
}

log "waiting for http://127.0.0.1:3000/health (up to 30s)"
body=""
for _ in $(seq 1 30); do
  if body=$(fetch_health) && grep -q '"status":"ok"' <<<"$body"; then
    log "healthy: $body"
    exit 0
  fi
  sleep 1
done

printf '[run-container] error: %s never became healthy; last logs:\n' "$NAME" >&2
docker logs --tail 100 "$NAME" >&2 2>&1 || true
exit 1
