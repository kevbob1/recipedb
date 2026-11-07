# Project: RecipeDB (React Router v7 + Drizzle/SQLite)

Single-household recipe organizer. One Node container serves SSR + assets;
better-sqlite3 file database under `DATA_DIR` (`/data` in production). There is
no separate API service — routes and their actions/loaders are the API.

See `GLOSSARY.md` for domain terms and `docs/adr/` for decisions.

## Validation & Quality Checks

**Run validation before completing any change to app code or dependencies.**
(Tree byte-identical to the last green run counts as validated — cite that log
instead of re-running.)

Validation prevents:
- **Type drift** — `react-router typegen` + `tsc --noEmit` catch stale route types
- **Regressions** — Vitest suite covers parsers, drafts, save commands, search
- **Untested new code** — patch coverage gates changed lines at 95%
- **Broken production bundle** — `npm run build` exercises the real build path

### Commands to run

The authoritative command is:

```bash
npm run verify     # = make check && echo VERIFY_OK
```

`make check` runs `typecheck` then `patch` inside the dev container via `$(RUN)`
(`docker compose run --rm dev …`), so the container's `node_modules` and native
bindings are used. `patch` is `npm run test:patch` = `vitest run --coverage`
followed by `scripts/patch-coverage.mjs`; because that coverage run executes the
whole Vitest suite, `make check` needs no separate plain `test` step. The dev
image installs `git` (Dockerfile `development` stage) because the gate resolves
a merge-base and reads the working-tree diff. Never create a host `node_modules/`
to make these work.

Pre-commit validation runs, in order:
1. `typecheck` — `react-router typegen && tsc --noEmit` (0 errors)
2. `test:patch` — `vitest run --coverage` (0 failures) then
   `scripts/patch-coverage.mjs` (≥ 95% of changed lines under `app/`)
3. `build` — `react-router build` + esbuild boot bundle (`make build`; not part
   of `make check`)

```bash
make typecheck
make patch
make build
```

`make test` remains available for a plain, coverage-free `vitest run`.

The patch gate diffs the working tree against `merge-base(HEAD, <ref>)`, where
`<ref>` resolves in order: `PATCH_COVERAGE_BASE` (explicit override) →
`origin/main` → `main` → `HEAD~1`. If no ref resolves, the gate exits 2 instead
of skipping. On failure it prints up to 100 uncovered `file:line` entries
alongside the per-file table. Override the threshold with `PATCH_COVERAGE_MIN`
(default 95); both env vars pass through `compose.yaml`.

If any command fails, fix it before committing. Report the exact command run
and its result.

### Acceptance checks for delegated work

Verify delegated work with `npm run verify` and require the `VERIFY_OK`
sentinel — a green summary without it is not acceptance:

```
check: run command="npm run verify" expect=VERIFY_OK
```

For changes with new logic, the patch gate is part of `make check`, so the
`VERIFY_OK` sentinel covers it too. Express acceptance as criteria +
deliverables where a harness is not involved.

## Deployment

Production is the k8s release (`helm/recipedb`, release `recipedb`). Local
containers (`deploy/run-container.sh`) are dev/verify only — `compose.yaml` is
never a production target.

Before deploying, run the authoritative validation above. Then:

```bash
deploy/k8s/deploy.sh
```

The script builds and pushes `registry.k.pd.o/recipedb:<UTC timestamp>` and
upgrades the Helm release; secrets come from `~/.config/recipedb/k8s-secrets.yaml`.
Run it with a timeout of at least 10 minutes (image export + push). A successful
deploy reports the pushed image tag and the Helm release as deployed. Note the
`recipedb-data` PVC is annotated `helm.sh/resource-policy: keep` — `helm
uninstall` does not delete recipes; remove the PVC manually if that is intended.
