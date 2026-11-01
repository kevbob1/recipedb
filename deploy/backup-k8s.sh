#!/usr/bin/env bash
# Nightly in-cluster backup orchestrator (roadmap item 3, disaster recovery).
#
# Runs inside the app's own runtime image (see Dockerfile) as a k8s CronJob
# that mounts the /data PVC READ-ONLY and the rendered backup ssh Secret at
# /secrets (helm/recipedb/templates/backup-secret.yaml). It produces the
# same three artifacts as the retired docker-era deploy/backup.sh:
#
#   recipes-<STAMP>.db            consistent copy via backup.cjs (online API)
#   images-<STAMP>.tar.gz         uploads, when present
#   migrations-applied-<STAMP>.json  the journal, without which a restore
#                                 replays 0000_init over the restored schema
#                                 and the app dies at boot (#13 drill)
#
# and pushes them to BACKUP_HOST:BACKUP_PATH with rsync-over-ssh, then prunes
# remote artifacts older than RETENTION_DAYS.
#
# SQLite: the copy is made by better-sqlite3's online backup API, which is
# consistent under concurrent WAL writes -- no quiescing / scale-to-zero is
# needed. Never copy the DB file directly (docker-era gotcha: a raw copy of a
# live WAL is not a backup).
#
# Usage (the CronJob passes these as env vars; every one has a default):
#   DATA_DIR=/data WORKDIR=/tmp/backup BACKUP_HOST=prox6 \
#   BACKUP_PATH=/srv/recipedb/backups RETENTION_DAYS=14 \
#   /app/backup-k8s.sh
set -euo pipefail

DATA_DIR="${DATA_DIR:-/data}"
WORKDIR="${WORKDIR:-/tmp/backup}"
STAMP="${STAMP:-$(date -u +%Y%m%d-%H%M)}"

BACKUP_HOST="${BACKUP_HOST:-}"
BACKUP_USER="${BACKUP_USER:-root}"
BACKUP_PATH="${BACKUP_PATH:-/srv/recipedb/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
BACKUP_SSH_PORT="${BACKUP_SSH_PORT:-22}"

# Mounted from the chart's rendered <fullname>-backup-ssh Secret (its
# stringData comes from backup.sshKey / backup.knownHosts in the values file).
BACKUP_SSH_KEY="${BACKUP_SSH_KEY:-/secrets/id_ed25519}"
BACKUP_KNOWN_HOSTS="${BACKUP_KNOWN_HOSTS:-/secrets/known_hosts}"

# /app/backup.cjs is baked into the runtime image at that path and pins its
# source to /data/recipes.db; DATA_DIR only affects the side artifacts.
BACKUP_CJS="${BACKUP_CJS:-/app/backup.cjs}"

log() { printf '[backup] %s\n' "$*"; }
die() { printf '[backup] error: %s\n' "$*" >&2; exit 1; }

# --- preflight -------------------------------------------------------------
[[ -n "$BACKUP_HOST" ]] || die "BACKUP_HOST is empty (set backup.host in the chart values)"
[[ -f "$BACKUP_SSH_KEY" ]] || die "missing SSH key $BACKUP_SSH_KEY -- set backup.sshKey in the chart values (helm renders it into the -backup-ssh Secret)"
[[ -r "$BACKUP_SSH_KEY" ]] || die "SSH key $BACKUP_SSH_KEY is not readable by uid $(id -u) (secret defaultMode must be 0400 and owned by the pod uid)"
[[ -f "$BACKUP_KNOWN_HOSTS" ]] || die "missing known_hosts $BACKUP_KNOWN_HOSTS -- set backup.knownHosts from ssh-keyscan $BACKUP_HOST"
[[ -f "$BACKUP_CJS" ]] || die "missing $BACKUP_CJS -- this pod is not running the recipedb runtime image"
[[ -f "$DATA_DIR/recipes.db" ]] || die "missing $DATA_DIR/recipes.db -- is the data PVC mounted read-only at $DATA_DIR?"

# StrictHostKeyChecking=yes + a mounted known_hosts is deliberate: host keys are
# pinned, never trust-on-first-use.
SSH_OPTS=(
  -i "$BACKUP_SSH_KEY"
  -o IdentitiesOnly=yes
  -o BatchMode=yes
  -o StrictHostKeyChecking=yes
  -o UserKnownHostsFile="$BACKUP_KNOWN_HOSTS"
  -o ConnectTimeout=20
  -o ServerAliveInterval=15
  -o ServerAliveCountMax=3
  -p "$BACKUP_SSH_PORT"
)
REMOTE="${BACKUP_USER}@${BACKUP_HOST}"
# rsync -e takes one string; none of these values contain spaces.
RSYNC_SSH="ssh -i $BACKUP_SSH_KEY -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$BACKUP_KNOWN_HOSTS -o ConnectTimeout=20 -p $BACKUP_SSH_PORT"

# --- 1. workdir ------------------------------------------------------------
umask 077
mkdir -p "$WORKDIR"
log "stamp=$STAMP workdir=$WORKDIR source=$DATA_DIR"

# --- 2. consistent DB copy (never a raw file copy over a live WAL) ---------
DB_ARTIFACT="$WORKDIR/recipes-$STAMP.db"
log "database -> $DB_ARTIFACT"
node "$BACKUP_CJS" "$DB_ARTIFACT"

# --- 3. images tarball (absent or empty is fine) ---------------------------
IMAGE_ARTIFACT=""
ARTIFACTS=("$DB_ARTIFACT")
if [[ -d "$DATA_DIR/images" ]] && [[ -n "$(ls -A "$DATA_DIR/images" 2>/dev/null)" ]]; then
  IMAGE_ARTIFACT="$WORKDIR/images-$STAMP.tar.gz"
  log "images -> $IMAGE_ARTIFACT"
  tar -czf "$IMAGE_ARTIFACT" -C "$DATA_DIR" images
  ARTIFACTS+=("$IMAGE_ARTIFACT")
else
  log "warning: $DATA_DIR/images absent or empty, skipping images tarball"
fi

# --- 4. migration journal (required for a restorable backup) ---------------
JOURNAL_ARTIFACT="$WORKDIR/migrations-applied-$STAMP.json"
if [[ -f "$DATA_DIR/migrations-applied.json" ]]; then
  cp "$DATA_DIR/migrations-applied.json" "$JOURNAL_ARTIFACT"
  ARTIFACTS+=("$JOURNAL_ARTIFACT")
else
  # Without this the restore replays 0000_init over an existing schema and the
  # app dies at boot, so fail loudly instead of shipping an unrestorable DB.
  die "missing $DATA_DIR/migrations-applied.json -- refusing to ship an unrestorable backup"
fi

# --- 5. ship to $BACKUP_HOST ----------------------------------------------
log "ensuring $REMOTE:$BACKUP_PATH"
ssh "${SSH_OPTS[@]}" "$REMOTE" "mkdir -p '$BACKUP_PATH'" \
  || die "ssh to $REMOTE failed (check the key is authorized for $BACKUP_USER@$BACKUP_HOST and that known_hosts matches)"

log "rsync ${#ARTIFACTS[@]} artifact(s) -> $REMOTE:$BACKUP_PATH/"
rsync -e "$RSYNC_SSH" -a --partial --chmod=Du=rwx,Dgo=rx,Fu=rw,Fgo=r \
  "${ARTIFACTS[@]}" "$REMOTE:$BACKUP_PATH/" \
  || die "rsync to $REMOTE:$BACKUP_PATH failed"

# --- 6. remote retention ---------------------------------------------------
# -mtime +N is the docker-era semantics: strictly older than N*24h.
log "pruning $BACKUP_PATH artifacts older than ${RETENTION_DAYS} days"
ssh "${SSH_OPTS[@]}" "$REMOTE" \
  "find '$BACKUP_PATH' -maxdepth 1 -type f \( -name 'recipes-*.db' -o -name 'images-*.tar.gz' -o -name 'migrations-applied-*.json' \) -mtime +$RETENTION_DAYS -print -delete" \
  || die "ssh prune on $REMOTE failed"

# --- 7. one-line summary ---------------------------------------------------
DB_SIZE="$(du -h "$DB_ARTIFACT" | cut -f1)"
IMAGES_NOTE="images=skipped"
[[ -n "$IMAGE_ARTIFACT" ]] && IMAGES_NOTE="images=$(du -h "$IMAGE_ARTIFACT" | cut -f1)"
log "ok stamp=$STAMP db=$DB_SIZE $IMAGES_NOTE journal=yes -> $REMOTE:$BACKUP_PATH (retention ${RETENTION_DAYS}d)"
