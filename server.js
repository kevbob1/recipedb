/**
 * Production entrypoint: single `node server.js` process.
 *
 * 1. Run DB migrations (idempotent; journal in DATA_DIR).
 * 2. Boot the React Router request handler built to ./build/server/index.js.
 * 3. Listen on PORT (default 3000).
 *
 * Migrations/auth/port live in app/server-boot.ts, bundled by esbuild to
 * ./build/server/boot.mjs (see the `build` script). React Router's build emits
 * only the route graph, so app TypeScript cannot be imported from here
 * directly (#13).
 */
import { createRequestListener } from "@react-router/node";
import { createServer } from "node:http";

async function main() {
  const { bootstrap } = await import("./build/server/boot.mjs");
  const port = bootstrap();

  const build = await import("./build/server/index.js");
  const listener = createRequestListener({ build });
  const server = createServer((req, res) => {
    listener(req, res).catch((err) => {
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
