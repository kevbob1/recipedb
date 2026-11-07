# syntax=docker/dockerfile:1
# Multi-stage build: compile TS, then a slim runtime image with only prod deps.
# Ticket #13 owns the full deploy story; this image must satisfy ticket #9
# (single container, no nginx / compose / DB sidecar).
#
# Node base image is pinned to an exact patch (26.10.0, 2026-10) rather than a
# floating tag: better-sqlite3 / sharp / @node-rs/argon2 ship prebuilt native
# bindings keyed to the Node version + ABI, so a minor/patch bump can silently
# require a recompile. Pinning keeps builds reproducible. Any CI/devcontainer
# image (#22) should adopt the same 26.10.0 pin.

FROM node:26.10.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
RUN npm run build

# Prune dev deps so the runtime image only carries production deps.
RUN npm prune --omit=dev

FROM node:26.10.0-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# /data is where the DB + images + migrations-applied.json live.
# Compose / k8s should mount a volume here; the entrypoint creates the
# directory if it doesn't exist.
ENV DATA_DIR=/data
ENV PORT=3000
RUN mkdir -p /data

# Backup tooling (roadmap item 3). There is deliberately ONE image: the nightly
# k8s CronJob runs exactly this tag, the same one the Deployment runs, so a
# deploy cannot ship an app without a matching backup image (or back up with a
# stale one). openssh-client + rsync are all deploy/backup-k8s.sh needs beyond
# what the base image already has (bash, tar, cp, node, mkdir, du, date).
# The cleanup keeps the apt lists out of the image (~2 MB).
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-client rsync \
 && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/build ./build
COPY --from=build /app/server.js ./server.js
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/package.json ./package.json
# The backup CronJob executes these from this same image. backup.cjs is the
# unchanged online-backup helper (better-sqlite3 backup API); backup-k8s.sh
# tars images + the migration journal and rsyncs them over ssh.
COPY deploy/backup.cjs deploy/backup-k8s.sh /app/
RUN chmod 0755 /app/backup.cjs /app/backup-k8s.sh
# better-sqlite3 is a native module; the build stage's node_modules already
# has the compiled binding for the same Node version + arch.
EXPOSE 3000
USER node
CMD ["node", "server.js"]

# ---------------------------------------------------------------------------
# Stage – development (ticket #22): docker compose / devcontainer only.
# Additive: the build + runtime stages above are unchanged, so helm/recipedb
# keeps deploying exactly what it deployed before.
#
# Same base + same 26.10.0 pin as the two stages above, deliberately: the
# prebuilt native bindings (better-sqlite3 / sharp / @node-rs/argon2) are keyed
# to the Node ABI and libc, so the dev image must match or requires recompiles.
# No DB sidecar — SQLite lives inside the /data volume.
# ---------------------------------------------------------------------------
FROM node:26.10.0-bookworm-slim AS development

# UID/GID of the calling host user, injected from compose build args. Files
# created in bind mounts and in the node_modules volume then belong to that
# user instead of root.
ARG DEV_UID=1000
ARG DEV_GID=1000

# python3/make/g++ are the node-gyp toolchain, kept as a fallback for any
# native module that has no prebuilt binary for this platform/ABI.
# git is required by scripts/patch-coverage.mjs (merge-base + diff), which
# `make check` runs inside this container.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates git \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN set -eu; \
    if getent group "$DEV_GID" >/dev/null; then \
      DEV_GROUP="$(getent group "$DEV_GID" | cut -d: -f1)"; \
    else \
      groupadd -g "$DEV_GID" dev; DEV_GROUP=dev; \
    fi; \
    if getent passwd "$DEV_UID" >/dev/null; then \
      DEV_USER="$(getent passwd "$DEV_UID" | cut -d: -f1)"; \
    else \
      useradd -u "$DEV_UID" -g "$DEV_GROUP" -M -d /home/dev -s /bin/bash dev; \
    fi; \
    mkdir -p /data /home/dev; \
    chown -R "$DEV_UID:$DEV_GID" /app /data /home/dev

USER ${DEV_UID}:${DEV_GID}
# HOME is its own directory (compose mounts a named volume there) so npm's cache
# and logs never leak into the bind-mounted repo root as `./.npm`.
ENV HOME=/home/dev
ENV DATA_DIR=/data
ENV PORT=3000

# Install deps into the image so the node_modules named volume is seeded with
# bindings compiled for this container (never the host's node_modules).
COPY package.json package-lock.json ./
RUN npm ci
ENV PATH=/app/node_modules/.bin:$PATH

EXPOSE 3000
CMD ["npm", "run", "dev"]
