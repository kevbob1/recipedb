/**
 * Regression test for #25: a real browser's login POST returned
 * `400 Bad Request` while `curl` was fine.
 *
 * React Router 7 guards every mutation request: the `Origin` header must
 * match `new URL(request.url).origin`, unless the origin's host appears in
 * `allowedActionOrigins`. Behind the nginx ingress TLS terminates at the
 * edge, so this process sees `http://recipedb.k.pd.o` while the browser
 * correctly sends `Origin: https://recipedb.k.pd.o`. The scheme-only
 * mismatch tripped the guard, which answered `400 Bad Request` before the
 * login action ever ran. `curl` sends no `Origin` header at all, so it
 * skipped the check and looked healthy.
 *
 * This test drives the REAL production build over a plain-HTTP socket with
 * the headers the ingress adds — the same path `server.js` serves — so it
 * goes red on the scheme mismatch rather than on a re-implementation of it.
 * The build is refreshed from `react-router.config.ts` when stale, because
 * `allowedActionOrigins` is baked into the bundle at build time.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type Server,
} from "node:http";
import type { AddressInfo } from "node:net";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { hashSync } from "@node-rs/argon2";
import { createRequestListener } from "@react-router/node";
import type { ServerBuild } from "react-router";

const PASSWORD = "open-sesame-42";

/** Public host the browser resolves; the ingress forwards Host unchanged. */
const PUBLIC_HOST = "recipedb.k.pd.o";
const PUBLIC_ORIGIN = `https://${PUBLIC_HOST}`;

const CONFIG_FILE = path.resolve(process.cwd(), "react-router.config.ts");
const BUILD_ENTRY = path.resolve(process.cwd(), "build/server/index.js");

/** Headers a browser sends on a top-level form POST, plus the ingress'. */
const BROWSER_HEADERS: Record<string, string> = {
  origin: PUBLIC_ORIGIN,
  referer: `${PUBLIC_ORIGIN}/login`,
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
  "sec-fetch-site": "same-origin",
  "sec-fetch-mode": "navigate",
  "sec-fetch-dest": "document",
  "sec-fetch-user": "?1",
  "upgrade-insecure-requests": "1",
  // Set by the nginx ingress when it terminates TLS.
  "x-forwarded-proto": "https",
  "x-forwarded-for": "203.0.113.7",
};

type LoginResponse = {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
};

let server: Server;
let port: number;
let dataDir: string;
let build: ServerBuild;
let envBackup: Record<string, string | undefined>;

function ensureFreshBuild(): void {
  const stale =
    !existsSync(BUILD_ENTRY) ||
    statSync(BUILD_ENTRY).mtimeMs < statSync(CONFIG_FILE).mtimeMs;
  if (stale) {
    execFileSync("npm", ["run", "build"], { stdio: "inherit" });
  }
}

/** POST /login over plain HTTP, exactly as the pod receives it. */
function postLogin(
  password: string,
  extraHeaders: Record<string, string> = {},
): Promise<LoginResponse> {
  const body = new URLSearchParams({ password, next: "/" }).toString();
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: "/login",
        method: "POST",
        headers: {
          host: PUBLIC_HOST,
          "content-type": "application/x-www-form-urlencoded",
          "content-length": Buffer.byteLength(body),
          ...extraHeaders,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

function setCookies(res: LoginResponse): string {
  const raw = res.headers["set-cookie"];
  return Array.isArray(raw) ? raw.join("\n") : (raw ?? "");
}

beforeAll(async () => {
  ensureFreshBuild();

  envBackup = {
    FAMILY_PASSWORD_HASH: process.env.FAMILY_PASSWORD_HASH,
    SESSION_SECRET: process.env.SESSION_SECRET,
    DATA_DIR: process.env.DATA_DIR,
  };
  dataDir = mkdtempSync(path.join(tmpdir(), "recipedb-origin-"));
  process.env.FAMILY_PASSWORD_HASH = hashSync(PASSWORD);
  process.env.SESSION_SECRET = "test-secret-do-not-use-in-prod";
  process.env.DATA_DIR = dataDir;

  // The untyped production bundle: dynamic specifier keeps TS out of it.
  const entry = pathToFileURL(BUILD_ENTRY).href;
  build = (await import(/* @vite-ignore */ entry)) as ServerBuild;

  const listener = createRequestListener({ build });
  server = createServer((req, res) => {
    Promise.resolve(listener(req, res)).catch(() => {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end("Internal Server Error");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
}, 300_000);

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(envBackup ?? {})) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("login POST origin handling (#25)", () => {
  it("bakes the public hosts into the server build", () => {
    // Fail loudly on a stale build: this is the knob the guard reads.
    expect(build.allowedActionOrigins).toEqual([
      "recipedb.k.pd.o",
      "recipedb.p.drule.org",
    ]);
  });

  it("does not 400 a browser-shaped POST from the HTTPS public origin", async () => {
    const res = await postLogin("definitely-wrong", BROWSER_HEADERS);
    // Wrong password re-renders the form, but it must reach the action.
    expect(res.status).toBe(200);
    expect(res.body).toContain("That password didn&#x27;t match");
    expect(setCookies(res)).toBe("");
  });

  it("issues a Secure session cookie for a correct password over TLS", async () => {
    const res = await postLogin(PASSWORD, BROWSER_HEADERS);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/");
    const cookie = setCookies(res);
    expect(cookie).toContain("recipedb_session=");
    expect(cookie).toContain("Secure");
  });

  it("still rejects a foreign origin (the guard stays armed)", async () => {
    const res = await postLogin(PASSWORD, {
      ...BROWSER_HEADERS,
      origin: "https://evil.example",
    });
    expect(res.status).toBe(400);
    expect(res.body).toBe("Bad Request");
  });

  it("keeps the curl shape (no Origin) working, without Secure off-TLS", async () => {
    const wrong = await postLogin("definitely-wrong");
    expect(wrong.status).toBe(200);

    const ok = await postLogin(PASSWORD);
    expect(ok.status).toBe(302);
    const cookie = setCookies(ok);
    expect(cookie).toContain("recipedb_session=");
    expect(cookie).not.toContain("Secure");
  });
});
