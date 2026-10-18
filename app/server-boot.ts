/**
 * Production bootstrap (#13): migrations, auth env check, port.
 *
 * `react-router build` only emits the route graph (build/server/index.js), so
 * the plain-Node entrypoint (server.js) cannot import `app/...` TypeScript at
 * runtime. This module is bundled separately by esbuild into
 * `build/server/boot.mjs`; server.js then does a single dynamic import from the
 * build output. Keeping the logic here (rather than reimplementing it in
 * server.js) means the tested migration runner and the auth assertion are the
 * ones that actually run in production.
 */
import { runMigrations } from "./db/migrate.server";
import { assertAuthEnvConfigured } from "./lib/auth.server";
import { getPort } from "./lib/env.server";

/**
 * Run everything that must happen before the HTTP listener opens.
 * Throws on failure so server.js can exit non-zero.
 */
export function bootstrap(): number {
  // Migrations before listen — required by ticket #9.
  const { applied, skipped } = runMigrations();
  console.log(
    `[migrate] applied=${JSON.stringify(applied)} skipped=${JSON.stringify(skipped)}`,
  );

  // Fail fast if FAMILY_PASSWORD_HASH / SESSION_SECRET are missing.
  assertAuthEnvConfigured();

  return getPort();
}
