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
needs an ssh key. It runs the **same image as the app** (the Dockerfile runtime
stage carries `openssh-client`, `rsync` and `backup-k8s.sh`), so there is no
separate backup image to build or push.

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

2. Put the key material in the backup block of the secrets values file
   (`~/.config/recipedb/k8s-secrets.yaml`, mode 0600 — the same file that holds
   `FAMILY_PASSWORD_HASH`/`SESSION_SECRET`, see `helm/recipedb/secrets.example.yaml`).
   Helm renders it into the `<release>-backup-ssh` Secret, which only the backup
   pod mounts (the Deployment never sees it):

   ```yaml
   backup:
     enabled: true
     sshKey: |
       -----BEGIN OPENSSH PRIVATE KEY-----
       ...contents of ~/.config/recipedb/backup-id_ed25519...
       -----END OPENSSH PRIVATE KEY-----
     knownHosts: |
       prox6 ssh-ed25519 AAAA...   # ssh-keyscan -t ed25519 prox6
     # host: prox6            # defaults
     # path: /srv/recipedb/backups
     # retentionDays: 14
   ```

   `backup.sshKey` and `backup.knownHosts` are required whenever
   `backup.enabled` is true — `helm template`/`upgrade` fails rather than arming
   a CronJob that cannot log in.

3. Redeploy with the normal script — no `kubectl create secret`, no separate
   image push:

   ```bash
   deploy/k8s/deploy.sh
   ```

One-shot test instead of waiting for the schedule (the job name follows the
release's fullname; `<release>` is `recipedb`):

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
