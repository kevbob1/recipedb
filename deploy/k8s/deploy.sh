#!/usr/bin/env bash
# Build + push the recipedb image and roll it out to the cluster (#21).
#
# Mirrors the other charts' deploy.sh (pharmacy-simulator, moviedb), with two
# local differences:
#   - the secrets file lives outside the repo (no SOPS in this project)
#   - the release is a single replica on a keep-annotated PVC, so the rollout
#     is Recreate (brief downtime while the pod's volume detaches)
#
# Usage: ./deploy.sh [image-tag]      (default: UTC timestamp YYYYmmddHHMM)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

REGISTRY="${REGISTRY:-registry.k.pd.o}"
IMAGE_NAME="${IMAGE_NAME:-recipedb}"
TAG="${1:-$(date -u +%Y%m%d%H%M)}"
RELEASE="${RELEASE:-recipedb}"
NAMESPACE="${NAMESPACE:-default}"
CHART="${CHART:-./helm/recipedb}"
SECRETS_FILE="${SECRETS_FILE:-$HOME/.config/recipedb/k8s-secrets.yaml}"

IMAGE="${REGISTRY}/${IMAGE_NAME}:${TAG}"

log() { printf '[deploy] %s\n' "$*"; }
die() { printf '[deploy] error: %s\n' "$*" >&2; exit 1; }

[[ -f "$SECRETS_FILE" ]] || die "missing secrets file $SECRETS_FILE (copy helm/recipedb/secrets.example.yaml there, chmod 600)"
chmod 600 "$SECRETS_FILE"

log "building and pushing ${IMAGE}"
docker buildx build --push --platform linux/amd64 -t "${IMAGE}" .

log "upgrading release ${RELEASE} in ${NAMESPACE}"
helm upgrade --install "${RELEASE}" "${CHART}" \
  -n "${NAMESPACE}" \
  -f "${CHART}/values.yaml" \
  -f "${SECRETS_FILE}" \
  --set image.repository="${REGISTRY}/${IMAGE_NAME}",image.tag="${TAG}" \
  --wait --timeout 5m

log "rollout status"
kubectl -n "${NAMESPACE}" rollout status "deploy/${RELEASE}" --timeout=120s

log "deployed ${IMAGE}"
