#!/usr/bin/env bash
# Nightly host-side backup: consistent DB copy via better-sqlite3, images tarball,
# then prune artifacts older than 7 days.
# Usage: ./backup.sh            (IMAGE=recipedb:0.1 by default)
set -euo pipefail

IMAGE="${IMAGE:-recipedb:0.1}"
BASE=/srv/recipedb
DATA="$BASE/data"
BACKUPS="$BASE/backups"
STAMP="$(date +%Y%m%d)"
RETENTION_DAYS=7

log() { printf '[backup] %s\n' "$*"; }
die() { printf '[backup] error: %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || die "docker not found"
[[ -d "$DATA" ]] || die "missing data dir $DATA"
mkdir -p "$BACKUPS"

log "database -> $BACKUPS/recipes-$STAMP.db"
# Run inside the live container: the DB lives there (WAL + -shm), the script is
# bind-mounted at /app/backup.cjs, and /backups is mounted for the output.
docker container inspect -f '{{.State.Running}}' recipedb 2>/dev/null | grep -q true \
  || die "container recipedb is not running"
docker exec recipedb node /app/backup.cjs "/backups/recipes-$STAMP.db"

if [[ -d "$DATA/images" ]]; then
  log "images -> $BACKUPS/images-$STAMP.tar.gz"
  tar -czf "$BACKUPS/images-$STAMP.tar.gz" -C "$DATA" images
else
  log "warning: $DATA/images missing, skipping images tarball"
fi

# The migration journal is part of the restored state: without it the app
# replays 0000_init over an existing schema and dies at boot (#13 drill).
if [[ -f "$DATA/migrations-applied.json" ]]; then
  log "migration journal -> $BACKUPS/migrations-applied-$STAMP.json"
  cp "$DATA/migrations-applied.json" "$BACKUPS/migrations-applied-$STAMP.json"
else
  log "warning: $DATA/migrations-applied.json missing"
fi

log "pruning backup files older than ${RETENTION_DAYS} days"
find "$BACKUPS" -maxdepth 1 -type f \
  \( -name 'recipes-*.db' -o -name 'images-*.tar.gz' -o -name 'migrations-applied-*.json' \) \
  -mtime "+$RETENTION_DAYS" -print -delete

log "summary:"
ls -lh "$BACKUPS" | sed 's/^/  /'
