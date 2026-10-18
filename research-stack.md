# Stack + starter for recipedb — research

Resolves [issue #2](https://github.com/kevbob1/recipedb/issues/2) on the
[recipedb wayfinder map #1](https://github.com/kevbob1/recipedb/issues/1).
The MVP needs a Node + TypeScript web app that is phone-friendly, backed by
a single SQLite database, and packaged as one container on a Proxmox LXC on
prox6. The reference sibling [moviedb](https://github.com/kevbob1/moviedb)
uses Next.js 16 + Prisma 7 + Postgres + Helm/k8s — deliberately heavier than
we want here.

## Recommendation

**React Router v7 (framework mode, Node adapter) + Drizzle ORM + better-sqlite3 + Vitest,
shipped as a single Node container with a `/data` volume.** The reason
each piece earns its place, and why the alternatives lose, is below; the
short form is: this combination is the smallest stack that still gives us
file-routed server-rendered React (good mobile UX, no client-side state
soup), a migration story we can read at 1 a.m. (SQL files generated from a
TypeScript schema, applied at container start), a single shared-password
login that lives in two lines of middleware, and a `node:22-bookworm-slim`
image that runs the whole thing.

## Candidate space

The ticket asked for: Node + TS UI/API framework, SQLite access layer,
migration story, single-image Docker packaging, test story, shared-password
auth expressibility, with the explicit constraint "deliberately lighter than
moviedb". I considered the following and read each one's official
documentation before scoring.

### UI / API framework

| Framework | SSR model | Phone-friendly defaults | TypeScript | File-based routing | Single-process Docker story | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| **Next.js 16** ([docs](https://nextjs.org/docs/app/getting-started/installation)) | React Server Components + App Router ([source](https://nextjs.org/docs/app/getting-started/installation)) | Yes | First-class | `app/` directory | Multi-layer build, image is a `next start` process | Too heavy — what moviedb already picked |
| **React Router v7 (framework mode)** ([docs](https://reactrouter.com/start/framework/installation)) | Server-rendered route modules (`loader` / `action` exports) per the [route module guide](https://reactrouter.com/start/framework/route-module) | Yes | First-class, generated per-route types via `Route.ComponentProps` | `app/routes.ts` (explicit) or file conventions | Official [`node-postgres` Docker template](https://reactrouter.com/start/framework/deploying) plus a Postgres-free variant; produces a single `node server.js` process | **Recommended** |
| **Astro 5** ([docs](https://docs.astro.build/en/install-and-setup/)) | Static by default, `output: 'server'` or per-page `export const prerender = false` flips to on-demand SSR ([source](https://docs.astro.build/en/guides/on-demand-rendering/)) | Yes | First-class | `src/pages/` | `@astrojs/node` adapter ([source](https://docs.astro.build/en/guides/on-demand-rendering/#add-an-adapter)) | Strong, but the "islands" model is awkward for our highly interactive add flow |
| **Hono 4** ([docs](https://hono.dev/docs/)) | Web-standard `Request`/`Response`; runs on Node via `@hono/node-server` | You'd have to render HTML yourself (or via `hono/jsx`) | First-class | No (you wire your own) | Trivial (`node dist/index.js`) | **Rejected for primary**: no React component model means the phone UI becomes either JSON + a separate SPA, or hand-rolled templates — both cost more than they save |
| **Fastify 5** ([docs](https://fastify.dev/docs/latest/Guides/Getting-Started/)) | JSON-Schema-validated route handlers | Same caveat as Hono | First-class | No (you wire your own) | Trivial | **Rejected for primary**: same as Hono, with more weight |

The decisive test is "phone-friendly web app with an add flow that has to
feel snappy and integrate server-side data fetching". React Router v7's
[route-module pattern](https://reactrouter.com/start/framework/route-module)
(loaders run on the server before the component renders, actions revalidate
on `<Form>` submit) is the smallest framework that lets us write the whole
app in one dialect and ship one Node process. Next.js would do the same job
and is more familiar, but the [App Router / React Server Components /
Turbopack stack](https://nextjs.org/docs/app/getting-started/installation) is
the extra weight the ticket explicitly wants to avoid. Astro would also
work, but the [islands model](https://docs.astro.build/en/concepts/islands/)
is the right shape for content with a few interactive sprinkles, not for
"paste URL or snap photo, edit on a single review screen, save" — which is
a stateful client flow, not sprinkled interactivity.

A pure Hono or Fastify backend with a separate React SPA is a legitimate
option and is what the ticket's "lighter alternative" mention is gesturing
at, but for a single household with one user model, the cost of
orchestrating two deploys (and the CORS plumbing, and the auth handshake
twice) is larger than the cost of just letting React Router render both the
HTML and the JSON in one process.

### SQLite access layer

| Option | API | Stability / install | Backing | Drizzle support | Prisma support | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| **`better-sqlite3`** ([github](https://github.com/WiseLibs/better-sqlite3)) | Synchronous, prepared-statement-first, 7.5k★, prebuilt binaries for major platforms (per the README) | Mature, ~12 years | SQLite | Yes ([drizzle-orm/better-sqlite3](https://orm.drizzle.team/docs/get-started-sqlite)) | Yes (`@prisma/adapter-better-sqlite3` per [Prisma docs](https://www.prisma.io/docs/orm/overview/databases/sqlite)) | **Recommended** |
| **`node:sqlite`** ([Node docs](https://nodejs.org/api/sqlite.html)) | Synchronous (`Database` / `Statement` / `SQLTagStore` classes) | Added v22.5.0, **Stability 1.2 — release candidate** | SQLite (Node's bundled libsqlite) | Yes | Yes (as driver adapter) | Strong second; the "release candidate" tag is the only reason it isn't first |
| **`@libsql/client`** ([Turso TS reference](https://docs.turso.tech/sdk/ts/reference)) | Async, supports embedded replicas | Production, but its main pitch is Turso Cloud | libSQL fork of SQLite | Yes (the [Drizzle get-started example](https://orm.drizzle.team/docs/get-started/sqlite-new) uses it) | Yes (`@prisma/adapter-libsql`) | Adds a dep we don't need when the database file is local |
| **`@tursodatabase/database`** ([Turso TS reference](https://docs.turso.tech/sdk/ts/reference)) | Async, MVCC, optional at-rest encryption | Newer, fewer references in the wild | Turso's own engine (rewrite) | [Beta](https://orm.drizzle.team/docs/connect-turso-database) | No | **Rejected**: not needed for a single-node MVP; brings a non-SQLite file format we can't open with the `sqlite3` CLI |

The synchronous API is the right fit here because every query in a recipe
app is "load this row, render, send" — the request stalls on the DB
synchronously in any case (we're not handling 10k concurrent users), and
`sync` avoids the await noise and the mutex-thrashing footgun that the
better-sqlite3 README explicitly calls out about `node-sqlite3`. The
[v1 release notes for `node:sqlite`](https://nodejs.org/api/sqlite.html)
even document the synchronous `Database` as the canonical class.

I rate **`better-sqlite3` first** because the binding has had a decade of
production hardening, ships prebuilt binaries for the Linux x64 + aarch64
that LXC needs, and Drizzle's first-party `drizzle-orm/better-sqlite3`
driver is a copy-paste swap if `node:sqlite` ever graduates from Stability
1.2. (The fact that we are now on Node 24 LTS means the runtime built-in
will only get better from here; a future ticket can flip the driver.)

### ORM / query layer

| Option | Schema language | Migrations | Type story | Bundle overhead | Verdict |
| --- | --- | --- | --- | --- | --- |
| **Drizzle ORM** ([docs](https://orm.drizzle.team/docs/get-started/sqlite-new)) | TypeScript | `drizzle-kit generate` → SQL files, `drizzle-kit migrate` to apply, `push` for dev | Inferred from the schema, no codegen step | Thin runtime; SQL is the truth | **Recommended** |
| **Prisma ORM v7 / v8** ([SQLite docs](https://www.prisma.io/docs/orm/overview/databases/sqlite), [migrations](https://www.prisma.io/docs/orm/prisma-migrate)) | `.prisma` DSL | `prisma migrate dev` / `prisma migrate deploy`; v8 reshapes this into `migration plan` + `db migrate` per [Prisma's own docs](https://www.prisma.io/docs/orm/prisma-migrate) | Generated client (`prisma generate`) | Larger, codegen step in CI | **Rejected**: codegen step and migration-graph bookkeeping are overkill for ~10 tables |
| Raw SQL via `better-sqlite3.prepare(...)` | SQL | Hand-written SQL files applied at startup | None (you write types) | None | A perfectly fine backup if Drizzle gets in the way; not the default |

Drizzle's [SQLite get-started page](https://orm.drizzle.team/docs/get-started/sqlite-new)
shows the full flow: `npm i drizzle-orm @libsql/client` (we substitute
`better-sqlite3`), a `drizzle.config.ts` that points at the schema file and
the migration directory, and the `drizzle-kit generate` → `drizzle-kit
migrate` pair. The generated SQL is checked into the repo and is exactly
what gets applied at container start, so the migration story is "files in
`drizzle/` are the truth" — easy to read in 1 a.m. debugging, easy to
back-port from a feature branch.

Prisma would also work, but the cost is the codegen step (`prisma generate`
on every CI build) and the migration-history bookkeeping described in
[Prisma's v8 migration docs](https://www.prisma.io/docs/orm/prisma-migrate)
(migration graphs, refs, pre/post-checks). For a single-container home app
with a hand-countable number of tables, Drizzle's "TypeScript schema is
the source, generated SQL is the artifact" model is a better fit.

### Single-image Docker packaging

The pattern is the same for every Node SSR framework on the shortlist:

1. Builder stage on `node:22-bookworm-slim` (or newer): `npm ci`,
   `npm run build`, drop `devDependencies`.
2. Runtime stage on `node:22-bookworm-slim`: copy `build/`, `node_modules/`,
   `package.json`, the entry script, and a `start` script. Run as a
   non-root user.
3. One named volume mounted at `/data`, containing:
   - `recipes.db` (the SQLite file)
   - `photos/` (uploaded images, served back through a route that
     streams from disk)
   - `db/migrations-applied.json` (a tiny manifest the entrypoint writes
     so a container restart doesn't re-apply every migration)

The React Router ["Node with Docker" template](https://reactrouter.com/start/framework/deploying)
already produces this shape, and Drizzle's `migrate` command is a function
call we can invoke from the entrypoint before `app.listen()`. No Nginx, no
separate DB process, no compose file. `docker compose` is optional; the
container is enough.

### Test story

**Vitest.** Works with React Router v7 (they have an official recipe),
Drizzle (an in-memory `better-sqlite3` DB per test), and the auth
middleware. The `node:test` built-in runner would also work but has
weaker TypeScript DX (you need `tsx` to run it) and worse mocking
ergonomics. Jest is what moviedb uses but the JSDOM-vs-Node ESM tax is
real and we get no benefit from it on a server-rendered app where most of
the test surface is the loaders/actions and the DB. (moviedb's
[AGENTS.md](https://github.com/kevbob1/moviedb/blob/main/AGENTS.md)
explicitly routes validation through `make dev-exec npm run check` —
that's because they're on Postgres via Prisma. For a SQLite file we
control, the equivalent is `npm run test` straight from the host against
a per-test `:memory:` database.)

### Shared-password auth

This is the smallest item but worth saying out loud. With one
family-shared password, the whole login is:

- One env var (`RECIPEDB_PASSWORD`) holding a bcrypt/argon2 hash.
- A middleware in `app/routes/_auth.tsx` (or whatever the React Router
  equivalent is) that reads a `recipedb_session` cookie. If absent or
  expired, render a single `<form>` asking for the password; on submit,
  compare against the hash, set a signed cookie (HttpOnly, SameSite=Lax,
  30-day), and redirect to the originally requested route.
- A reverse-proxy note for ticket #8: the same logic is *also* expressible
  as HTTP Basic via Hono's [`basicAuth` middleware](https://hono.dev/docs/middleware/builtin/basic-auth)
  if we ever want to skip the cookie and just use Basic — handy as a
  break-glass mechanism.

There is exactly one user, so there is no per-user authorization, no
session rotation story, no CSRF beyond the SameSite cookie attribute and
the same-origin `<Form>` submission. None of the framework choices change
this; they all support it.

## Why not each of the others

- **Next.js 16** — exactly what moviedb picked, and not what this ticket
  asked for. RSC, Cache Components, Turbopack, image optimization — none
  of it is load-bearing for recipedb.
- **Astro** — great for content, awkward for our highly interactive
  add-flow. We'd end up with an island for almost every meaningful state
  transition.
- **Hono / Fastify (as the primary)** — the UI would be either a separate
  React SPA (two deploys, CORS, double auth) or hand-rolled JSX
  templates. Both are worse than React Router's "one framework, one
  process, one dialect".
- **`node:sqlite`** — would be my second choice; flagged only because the
  [Node 24 docs](https://nodejs.org/api/sqlite.html) still tag it
  Stability 1.2 (release candidate). When that lands at 2.0, switching
  from `better-sqlite3` to `node:sqlite` is a 10-line change in the
  Drizzle driver and we lose a native dependency.
- **`@libsql/client` / `@tursodatabase/database`** — fine products for
  their main pitch (Turso Cloud sync / embedded replicas with cloud
  primary). We don't want either; we want a SQLite file on a local disk
  we can `cp` to make a backup.
- **Prisma** — excellent ORM, but the codegen step and the v8 migration
  reshape (per [Prisma's own docs](https://www.prisma.io/docs/orm/prisma-migrate))
  are more machinery than this app needs.
- **Jest / `node:test`** — both work; Vitest is the better fit for ESM +
  TS without a Babel layer.

## Open items handed to follow-up tickets

- **Volume layout + backup** (ticket #8 owns this): `/data/recipes.db` is
  the SQLite file; `/data/photos/` is the image store; `restic` (already
  on prox6 per Kevin's infra notes) snapshots `/data` nightly.
- **Auth "log out"** — out of MVP scope per the map; the cookie can be
  deleted with one button on the settings page when we have settings.
- **Image processing** — sharp for thumbnails; runs on Node natively, no
  extra service.
- **`node:sqlite` swap** — revisit when Stability goes 1.3+; track in a
  follow-up ticket, not a blocker.

## Sources

Primary-source reads I did before writing this:

- React Router v7: [Installation](https://reactrouter.com/start/framework/installation),
  [Route Module](https://reactrouter.com/start/framework/route-module),
  [Deploying](https://reactrouter.com/start/framework/deploying)
- Next.js 16: [Installation](https://nextjs.org/docs/app/getting-started/installation)
- Astro 5: [Install](https://docs.astro.build/en/install-and-setup/),
  [On-demand rendering](https://docs.astro.build/en/guides/on-demand-rendering/)
- Hono 4: [Docs](https://hono.dev/docs/),
  [Basic auth middleware](https://hono.dev/docs/middleware/builtin/basic-auth)
- Fastify 5: [Getting started](https://fastify.dev/docs/latest/Guides/Getting-Started/)
- `node:sqlite`: [Node v24 docs](https://nodejs.org/api/sqlite.html)
- `better-sqlite3`: [README](https://github.com/WiseLibs/better-sqlite3)
- `@libsql/client` / `@tursodatabase/database`: [Turso TS reference](https://docs.turso.tech/sdk/ts/reference)
- Drizzle: [SQLite get-started](https://orm.drizzle.team/docs/get-started/sqlite-new),
  [Database connection](https://orm.drizzle.team/docs/connect-overview)
- Prisma: [SQLite](https://www.prisma.io/docs/orm/overview/databases/sqlite),
  [Migrations](https://www.prisma.io/docs/orm/prisma-migrate)
- Sibling reference: [/home/kev/git/moviedb](https://github.com/kevbob1/moviedb)
  (Next 16 + Prisma 7 + Postgres + Helm/k8s — what we are explicitly not doing)
