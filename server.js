/**
 * Production entrypoint: single `node server.js` process.
 *
 * 1. Run DB migrations (idempotent; journal in DATA_DIR).
 * 2. Serve build/client (the hashed browser bundle) ourselves — the React
 *    Router request listener only knows routes, so without this every
 *    /assets/*.js request 404s and the page never hydrates (#26).
 * 3. Boot the React Router request handler built to ./build/server/index.js.
 * 4. Listen on PORT (default 3000).
 *
 * Migrations/auth/port live in app/server-boot.ts, bundled by esbuild to
 * ./build/server/boot.mjs (see the `build` script). React Router's build emits
 * only the route graph, so app TypeScript cannot be imported from here
 * directly (#13).
 */
import { createRequestListener } from "@react-router/node";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

/** build/client sits next to this file inside the image (/app). */
const CLIENT_DIR = fileURLToPath(new URL("./build/client/", import.meta.url));

async function main() {
  const { bootstrap, handleStaticAsset } = await import("./build/server/boot.mjs");
  const port = bootstrap();

  const build = await import("./build/server/index.js");
  const listener = createRequestListener({ build });
  const server = createServer((req, res) => {
    if (handleStaticAsset(req, res, CLIENT_DIR)) return;
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
