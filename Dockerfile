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
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/build ./build
COPY --from=build /app/server.js ./server.js
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/package.json ./package.json
# better-sqlite3 is a native module; the build stage's node_modules already
# has the compiled binding for the same Node version + arch.
EXPOSE 3000
USER node
CMD ["node", "server.js"]
