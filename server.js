/**
 * Production entrypoint: single `node server.js` process.
 *
 * 1. Run DB migrations (idempotent; journal in DATA_DIR).
 * 2. Boot the React Router request handler built to ./build/server/index.js.
 * 3. Listen on PORT (default 3000).
 */
import { createRequestHandler } from "@react-router/node";
import { createServer } from "node:http";
import { runMigrations } from "./build/server/migrate.server.js";
import { assertAuthEnvConfigured } from "./build/server/auth.server.js";
import { getPort } from "./build/server/env.server.js";

async function main() {
  // Migrations before listen — required by ticket #9.
  const { applied, skipped } = runMigrations();
  console.log(
    `[migrate] applied=${JSON.stringify(applied)} skipped=${JSON.stringify(skipped)}`,
  );

  // Reserved auth env: ticket #12 implements the real gate.
  assertAuthEnvConfigured();

  const build = await import("./build/server/index.js");
  const handler = createRequestHandler(build);

  const port = getPort();
  const server = createServer((req, res) => {
    handler(req, res).catch((err) => {
      console.error("[request] error", err);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end("Internal Server Error");
      }
    });
  });

  server.listen(port, () => {
    console.log(`[server] listening on port ${port}`);
  });
}

main().catch((err) => {
  console.error("[server] fatal", err);
  process.exit(1);
});
