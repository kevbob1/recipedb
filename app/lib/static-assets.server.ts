/**
 * Static assets for the production listener (#26).
 *
 * `react-router build` emits the browser bundle to `build/client` and the SSR
 * route graph to `build/server`. server.js hands every request straight to
 * `@react-router/node`'s `createRequestListener`, which only knows routes and
 * serves no files, so in production `GET /assets/entry.client-*.js` answered
 * with the app's own 404 HTML. The page's inline `import("/assets/entry.client-…js")`
 * therefore never resolved, React never hydrated, and every interactive
 * control — the ScaledIngredientList multiplier on /recipes/:id/review, Save
 * draft, the /add stepper — was inert while the server-rendered page still
 * looked correct.
 *
 * Dependency-free file server for `build/client`: only real files are served;
 * anything else returns false and falls through to the router unchanged.
 */
import { createReadStream, statSync, type Stats } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";

const CONTENT_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".wasm": "application/wasm",
};

/** Vite writes everything under assets/ with a content hash in the name. */
const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
const SHORT_CACHE = "public, max-age=3600";

export interface StaticAsset {
  filePath: string;
  contentType: string;
  cacheControl: string;
}

function isInside(child: string, parent: string): boolean {
  return child.startsWith(parent + sep);
}

function readStats(filePath: string): Stats | null {
  try {
    return statSync(filePath);
  } catch {
    return null;
  }
}

/**
 * Map a request pathname to a real file under `clientDir`, or null when the
 * path is not something we are willing to serve (missing, a directory, empty,
 * or a traversal attempt reaching outside the client build).
 */
export function resolveStaticAsset(
  pathname: string,
  clientDir: string,
): StaticAsset | null {
  if (typeof pathname !== "string" || pathname.length === 0) return null;

  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;

  const rel = decoded.replace(/^\/+/, "");
  if (rel.length === 0) return null;

  const root = resolve(clientDir);
  const filePath = resolve(root, rel);
  if (!isInside(filePath, root)) return null;

  const stats = readStats(filePath);
  if (!stats || !stats.isFile()) return null;

  const relative = filePath.slice(root.length + 1);
  const hashed = relative.startsWith(`assets${sep}`);
  return {
    filePath,
    contentType: CONTENT_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream",
    cacheControl: hashed ? IMMUTABLE_CACHE : SHORT_CACHE,
  };
}

/**
 * Answer `req` from the client build when it names a real file. Returns true
 * when the response was written — the caller must then not fall through to the
 * React Router listener (which would 404 the asset).
 */
export function handleStaticAsset(
  req: IncomingMessage,
  res: ServerResponse,
  clientDir: string,
): boolean {
  const method = req.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") return false;

  let pathname: string;
  try {
    pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  } catch {
    return false;
  }

  const asset = resolveStaticAsset(pathname, clientDir);
  if (!asset) return false;

  res.setHeader("Content-Type", asset.contentType);
  res.setHeader("Cache-Control", asset.cacheControl);
  if (method === "HEAD") {
    res.end();
    return true;
  }

  const stream = createReadStream(asset.filePath);
  stream.on("error", () => {
    // The file vanished between stat and read: close cleanly, don't crash the
    // request (the SSR response that referenced it is already stale).
    if (!res.headersSent) res.statusCode = 500;
    res.end();
  });
  stream.pipe(res);
  return true;
}
