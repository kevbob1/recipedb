/**
 * Production static assets — regression guard for #26.
 *
 * Live symptom: /recipes/1/review rendered fine (SSR) but the multiplier
 * buttons did nothing. Cause: server.js hands every request to React Router's
 * request listener, which only knows routes, so /assets/entry.client-*.js
 * answered 404 with the app's own 404 HTML. The browser's inline
 * `import("/assets/entry.client-…js")` never resolved, React never hydrated,
 * and no onClick anywhere could fire.
 *
 * These tests drive the real handler over a real HTTP server, the same way the
 * production listener does: a hashed asset is served, everything else falls
 * through to the router.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { handleStaticAsset, resolveStaticAsset } from "./static-assets.server";

const ENTRY = "export const hydrated = true;\n";

let clientDir: string;
let baseUrl: string;
let server: ReturnType<typeof createServer>;

beforeAll(async () => {
  clientDir = mkdtempSync(join(tmpdir(), "recipedb-client-"));
  mkdirSync(join(clientDir, "assets"));
  writeFileSync(join(clientDir, "assets", "entry.client-abc123.js"), ENTRY);
  writeFileSync(join(clientDir, "assets", "root-abc123.css"), "body{}\n");
  writeFileSync(join(clientDir, "favicon.ico"), "icon");
  // A file outside the client dir, to prove traversal is refused.
  writeFileSync(join(clientDir, "..", "outside-secret.txt"), "secret");

  server = createServer((req, res) => {
    if (handleStaticAsset(req, res, clientDir)) return;
    res.statusCode = 404;
    res.setHeader("content-type", "text/html");
    res.end("<!DOCTYPE html><h1>404</h1>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a TCP address");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("resolveStaticAsset", () => {
  it("maps a hashed client asset to its file and type", () => {
    const asset = resolveStaticAsset("/assets/entry.client-abc123.js", clientDir);
    expect(asset?.contentType).toBe("text/javascript; charset=utf-8");
    expect(asset?.cacheControl).toContain("immutable");
  });

  it("falls through (null) for route paths, directories and traversal", () => {
    expect(resolveStaticAsset("/login", clientDir)).toBeNull();
    expect(resolveStaticAsset("/recipes/1/review", clientDir)).toBeNull();
    expect(resolveStaticAsset("/", clientDir)).toBeNull();
    expect(resolveStaticAsset("/assets", clientDir)).toBeNull();
    expect(resolveStaticAsset("/..%2foutside-secret.txt", clientDir)).toBeNull();
    expect(resolveStaticAsset("/assets/../outside-secret.txt", clientDir)).toBeNull();
  });
});

describe("handleStaticAsset over http", () => {
  it("serves the client entry the browser actually imports (was 404)", async () => {
    const res = await fetch(`${baseUrl}/assets/entry.client-abc123.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(await res.text()).toBe(ENTRY);
  });

  it("serves css and favicon with their own types", async () => {
    const css = await fetch(`${baseUrl}/assets/root-abc123.css`);
    expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");

    const icon = await fetch(`${baseUrl}/favicon.ico`);
    expect(icon.status).toBe(200);
    expect(icon.headers.get("cache-control")).toBe("public, max-age=3600");
  });

  it("answers HEAD without a body", async () => {
    const res = await fetch(`${baseUrl}/assets/entry.client-abc123.js`, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });

  it("leaves route requests to the router", async () => {
    const res = await fetch(`${baseUrl}/recipes/1/review`);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("<!DOCTYPE html><h1>404</h1>");
  });

  it("does not serve files outside the client dir", async () => {
    const res = await fetch(`${baseUrl}/..%2foutside-secret.txt`);
    expect(res.status).toBe(404);
  });
});
