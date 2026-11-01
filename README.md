# recipedb

Single-household recipe organizer — MVP scaffold (ticket #9).

## Stack

- React Router v7 (framework mode, single `node server.js` process)
- TypeScript
- Drizzle ORM + better-sqlite3
- Vitest

## Layout

- `app/` — React Router app code
  - `db/schema.server.ts` — Drizzle schema (source of truth alongside GLOSSARY.md)
  - `db/client.server.ts` — better-sqlite3 + drizzle client
  - `db/migrate.server.ts` — migration runner (called before listen)
  - `db/schema.test.ts`, `db/migrate.test.ts` — Vitest tests
  - `lib/auth.server.ts` — reserved auth env (gate implemented in #12)
  - `lib/env.server.ts` — PORT/NODE_ENV
  - `routes/_index.tsx`, `routes/health.tsx` — minimal routes
- `drizzle/` — hand-written SQL migrations (incl. FTS5 virtual table)
- `server.js` — production entrypoint (runs migrations, then listens)
- `Dockerfile` — single-image build (full deploy lives in #13)

## /data layout

`DATA_DIR` (default `/data`, fall back to `./data` for local dev) holds:

- `recipes.db` — the SQLite database file (FTS5 index lives inside it)
- `images/` — recipe images (future ticket)
- `migrations-applied.json` — migration journal

The DB file path can be overridden with `RECIPEDB_DB_PATH`.

## Backups (k8s)

The chart can run a nightly `CronJob` (`<release>-backup`) that is the only
insurance for the k8s PVC. It mounts the `/data` claim **read-only**, makes a
consistent copy with `deploy/backup.cjs` (better-sqlite3's online backup API —
never a raw copy of a live WAL), tars `images/` when present, copies
`migrations-applied.json`, `rsync`s all three artifacts to
`root@prox6:/srv/recipedb/backups/` over ssh, and prunes remote artifacts older
than 14 days. It is **off by default** (`backup.enabled: false`) because it
needs an ssh key that this chart does not own.

Bootstrap, once:

1. Generate a dedicated ed25519 keypair on prox6 and authorize it for root:

   ```bash
   ssh root@prox6
   ssh-keygen -t ed25519 -N '' -C recipedb-backup -f /root/.ssh/recipedb-backup
   cat /root/.ssh/recipedb-backup.pub >> /root/.ssh/authorized_keys
   chmod 600 /root/.ssh/authorized_keys
   # fetch the private half onto the workstation (used in step 2) and then
   # keep it in a 0600 file outside the repo
   ```

2. Create the Secret in the cluster (key + pinned host key; no key material in
   git or in the helm values file):

   ```bash
   kubectl -n default create secret generic recipedb-backup-ssh \
     --from-file=id_ed25519=$HOME/.config/recipedb/backup-id_ed25519 \
     --from-file=known_hosts=<(ssh-keyscan -t ed25519 prox6)
   ```

3. Turn it on and redeploy — in `~/.config/recipedb/k8s-secrets.yaml` (see
   `helm/recipedb/secrets.example.yaml`):

   ```yaml
   backup:
     enabled: true
     sshSecretName: recipedb-backup-ssh
     # host: prox6            # defaults
     # path: /srv/recipedb/backups
     # retentionDays: 14
   ```

   then `deploy/k8s/deploy.sh`. The job image is the Dockerfile `backup` stage
   (`<image.tag>-backup`, runtime + openssh-client + rsync), so build and push
   that tag from the same commit as the app image:

   ```bash
   docker buildx build --target backup --platform linux/amd64 --push \
     -t registry.k.pd.o/recipedb:<tag>-backup .
   ```

One-shot test instead of waiting for the schedule:

```bash
kubectl -n default create job --from=cronjob/recipedb-backup recipedb-backup-manual
kubectl -n default logs -f job/recipedb-backup-manual   # expect "ok stamp=... db=..."
```

Restore: copy `recipes-<stamp>.db` back as `recipes.db`, copy
`migrations-applied-<stamp>.json` back as `migrations-applied.json` **alongside
it** (without the journal the app replays `0000_init` and dies at boot), and
untar the images archive into `/data/images`. See the migrate notes: clear
stale `recipes.db-wal`/`-shm` before starting the pod.

## Auth env (reserved for ticket #12)

- `FAMILY_PASSWORD_HASH` — required in production
- `SESSION_SECRET` — required in production

Both are validated at startup; the app boots with a warning in dev if either is missing.

## Scripts

```
npm run dev          # react-router dev
npm run build        # react-router build
npm start            # node server.js (runs migrations first)
npm test             # vitest run
npm run typecheck    # tsc --noEmit
npm run db:generate  # drizzle-kit generate
```

## Dev container (Docker)

Node/TS commands run in the container (`make help` lists all targets; VS Code
users can reopen in the container via `.devcontainer/devcontainer.json`):

```bash
make up        # dev server on http://127.0.0.1:3000 (Ctrl-C stops)
make test      # vitest run          make typecheck   # typegen + tsc
make build     # production build    make shell       # container shell
make down      # stop (dev DB + node_modules volumes persist)
```

Production still deploys only via `helm/recipedb` — this stack is dev-only.

## Domain source of truth

`GLOSSARY.md` defines the canonical domain terms. The schema, the FTS5
indexing choices, and the URL/import flows are all written to match.
