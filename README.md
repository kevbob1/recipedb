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
