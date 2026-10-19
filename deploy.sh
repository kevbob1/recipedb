#!/usr/bin/env bash
# Top-level deploy wrapper for recipedb.
#
# Resolves the image tag (explicit argument > TAG env > UTC timestamp), refuses
# to ship a dirty working tree, then hands off to deploy/k8s/deploy.sh, which
# does the actual buildx push + helm upgrade.
#
# Usage: ./deploy.sh [image-tag]
#
#   ./deploy.sh                  # tag = UTC timestamp YYYYmmddHHMM (default)
#   ./deploy.sh 1a2b3c4          # deploy an explicit tag
#   TAG=1a2b3c4 ./deploy.sh      # same, via environment
#   DIRTY=1 ./deploy.sh          # allow deploying with uncommitted changes
#
# Passed through untouched to deploy/k8s/deploy.sh:
#   REGISTRY, IMAGE_NAME, RELEASE, NAMESPACE, CHART, SECRETS_FILE
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INNER="${SCRIPT_DIR}/deploy/k8s/deploy.sh"

usage() {
  cat <<'EOF'
Build, push and roll out recipedb (delegates to deploy/k8s/deploy.sh).

Usage: ./deploy.sh [image-tag]

  ./deploy.sh                  # tag = UTC timestamp YYYYmmddHHMM (default)
  ./deploy.sh 1a2b3c4          # deploy an explicit tag
  TAG=1a2b3c4 ./deploy.sh      # same, via environment
  DIRTY=1 ./deploy.sh          # allow deploying with uncommitted changes

Passed through untouched to deploy/k8s/deploy.sh:
  REGISTRY, IMAGE_NAME, RELEASE, NAMESPACE, CHART, SECRETS_FILE
EOF
}

case "${1:-}" in
  -h | --help)
    usage
    exit 0
    ;;
esac

[[ -f "$INNER" ]] || { printf '[deploy] error: missing %s\n' "$INNER" >&2; exit 1; }

TAG="${1:-${TAG:-$(date -u +%Y%m%d%H%M)}}"

REGISTRY="${REGISTRY:-registry.k.pd.o}"
IMAGE_NAME="${IMAGE_NAME:-recipedb}"
IMAGE="${REGISTRY}/${IMAGE_NAME}:${TAG}"

# Make sure overrides reach the inner script (exec preserves the environment,
# but only for variables that were actually exported by the caller).
for var in REGISTRY IMAGE_NAME RELEASE NAMESPACE CHART SECRETS_FILE; do
  if [[ -n "${!var:-}" ]]; then
    export "${var?}"
  fi
done

# Refuse to ship uncommitted code unless explicitly allowed.
if [[ "${DIRTY:-0}" != "1" ]]; then
  if git -C "$SCRIPT_DIR" rev-parse --git-dir >/dev/null 2>&1; then
    dirty_status="$(git -C "$SCRIPT_DIR" status --short)"
    if [[ -n "$dirty_status" ]]; then
      printf '[deploy] error: working tree is dirty (set DIRTY=1 to deploy anyway):\n%s\n' \
        "$dirty_status" >&2
      exit 1
    fi
  fi
else
  printf '[deploy] DIRTY=1: deploying with a dirty working tree\n' >&2
fi

printf '[deploy] Deploying %s ...\n' "$IMAGE"
exec "$INNER" "$TAG"
