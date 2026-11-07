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

`make check` runs `typecheck` then `test` inside the dev container via `$(RUN)`
(`docker compose run --rm dev …`), so the container's `node_modules` and native
bindings are used. `npm run test:patch` runs natively on the host (it needs git
metadata and the local `coverage/` dir); `make patch` runs the same thing in the
container. Never create a host `node_modules/` to make these work.

Pre-commit validation runs, in order:
1. `typecheck` — `react-router typegen && tsc --noEmit` (0 errors)
2. `test` — `vitest run` (0 failures)
3. `test:patch` — `vitest run --coverage` + `scripts/patch-coverage.mjs`
   (≥ 95% of changed lines under `app/`; override `PATCH_COVERAGE_MIN`)
4. `build` — `react-router build` + esbuild boot bundle

```bash
make typecheck
make test
make patch
make build
```

If any command fails, fix it before committing. Report the exact command run
and its result.

### Acceptance checks for delegated work

Verify delegated work with `npm run verify` and require the `VERIFY_OK`
sentinel — a green summary without it is not acceptance:

```
check: run command="npm run verify" expect=VERIFY_OK
```

For changes with new logic, also require `npm run test:patch` to pass. Express
acceptance as criteria + deliverables where a harness is not involved.

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
