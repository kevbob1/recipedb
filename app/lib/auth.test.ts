/**
 * Auth + session tests.
 *
 * The shared family password is a stateless pair: an argon2id hash in
 * FAMILY_PASSWORD_HASH and an HMAC-signed cookie in SESSION_SECRET.
 * These tests cover the failure modes operators actually hit:
 *   - wrong password returns false (and never throws for bad input)
 *   - malformed hash is detected up front, not silently
 *   - cookie without signature is rejected
 *   - cookie with tampered signature is rejected
 *   - cookie past the 30-day lifetime is rejected
 *   - logout cookie clears the session on the next read
 *   - requireAuth redirects HTML, 401s API
 *   - requireAuth's "next" param is the original path
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashSync } from "@node-rs/argon2";
import {
  assertHashIsArgon2id,
  buildSessionCookie,
  requireAuth,
  verifyPassword,
} from "./auth.server";
import {
  buildClearSessionCookie,
  parseSessionValue,
  readSessionFromRequest,
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_MS,
} from "./session.server";

const PASSWORD = "open-sesame-42";
let originalHash: string | undefined;
let originalSecret: string | undefined;

beforeEach(() => {
  originalHash = process.env.FAMILY_PASSWORD_HASH;
  originalSecret = process.env.SESSION_SECRET;
  process.env.FAMILY_PASSWORD_HASH = hashSync(PASSWORD);
  process.env.SESSION_SECRET = "test-secret-do-not-use-in-prod";
});

afterEach(() => {
  if (originalHash === undefined) delete process.env.FAMILY_PASSWORD_HASH;
  else process.env.FAMILY_PASSWORD_HASH = originalHash;
  if (originalSecret === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = originalSecret;
});

/* ----------------------------- verifyPassword ----------------------------- */

describe("verifyPassword", () => {
  it("accepts the correct password", async () => {
    expect(await verifyPassword(PASSWORD)).toBe(true);
  });

  it("rejects an incorrect password", async () => {
    expect(await verifyPassword("not-it")).toBe(false);
  });

  it("rejects empty input without throwing", async () => {
    expect(await verifyPassword("")).toBe(false);
  });

  it("rejects when FAMILY_PASSWORD_HASH is not configured (non-strict)", async () => {
    delete process.env.FAMILY_PASSWORD_HASH;
    expect(await verifyPassword(PASSWORD)).toBe(false);
  });

  it("throws when FAMILY_PASSWORD_HASH is missing under strict mode", async () => {
    delete process.env.FAMILY_PASSWORD_HASH;
    await expect(verifyPassword(PASSWORD, { strict: true })).rejects.toThrow(
      /FAMILY_PASSWORD_HASH is not configured/,
    );
  });

  it("returns false (and does not throw) for a structurally bad hash", async () => {
    process.env.FAMILY_PASSWORD_HASH = "not-an-argon2-phc-string";
    expect(await verifyPassword(PASSWORD)).toBe(false);
  });
});

/* ---------------------------- assertHashIsArgon2id ------------------------- */

describe("assertHashIsArgon2id", () => {
  it("accepts a real argon2id PHC string", () => {
    const h = hashSync("anything");
    expect(() => assertHashIsArgon2id(h)).not.toThrow();
  });

  it("rejects an argon2i PHC string (not the family spec)", () => {
    // Hand-craft an argon2i header. We don't care if verify() would
    // accept the body; the test is that the prefix check fires.
    const fake = "$argon2i$v=19$m=19456,t=2,p=1$YWFhYWFhYWFhYWFh$YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE";
    expect(() => assertHashIsArgon2id(fake)).toThrowError(/argon2id/);
  });

  it("rejects a bcrypt-style hash", () => {
    expect(() =>
      assertHashIsArgon2id("$2b$10$abcdefghijklmnopqrstuvwxyz1234567890"),
    ).toThrowError(/argon2id/);
  });
});

/* ----------------------------- session cookies ----------------------------- */

describe("buildSessionCookie / parseSessionValue", () => {
  it("round-trips a freshly issued cookie", () => {
    const cookie = buildSessionCookie();
    const value = extractCookieValue(cookie, SESSION_COOKIE_NAME);
    const session = parseSessionValue(value);
    expect(session).not.toBeNull();
    expect(session!.issuedAtMs).toBeGreaterThan(Date.now() - 5_000);
  });

  it("sets the security attributes operators expect", () => {
    const cookie = buildSessionCookie();
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).toMatch(/Max-Age=/);
    // MVP is LAN-only, no TLS. Secure is intentionally absent.
    expect(cookie).not.toMatch(/Secure/i);
  });

  it("sets Max-Age to 30 days in seconds", () => {
    const cookie = buildSessionCookie();
    const m = /Max-Age=(\d+)/.exec(cookie);
    expect(m).not.toBeNull();
    const expected = Math.floor(SESSION_MAX_AGE_MS / 1000);
    expect(Number(m![1])).toBe(expected);
  });

  it("rejects a cookie whose signature was tampered with", () => {
    const cookie = buildSessionCookie();
    const value = extractCookieValue(cookie, SESSION_COOKIE_NAME);
    const dot = value.indexOf(".");
    const tampered = value.slice(0, dot) + "." + "A".repeat(43);
    expect(parseSessionValue(tampered)).toBeNull();
  });

  it("rejects a cookie whose timestamp was tampered with", () => {
    const cookie = buildSessionCookie();
    const value = extractCookieValue(cookie, SESSION_COOKIE_NAME);
    const dot = value.indexOf(".");
    // Replace the issuedAtMs; the signature is now wrong.
    const tampered = (Date.now() - 1_000) + value.slice(dot);
    expect(parseSessionValue(tampered)).toBeNull();
  });

  it("rejects a malformed value (no separator)", () => {
    expect(parseSessionValue("not-a-cookie")).toBeNull();
  });

  it("rejects a value with a non-numeric timestamp", () => {
    expect(parseSessionValue("abc.somesig")).toBeNull();
  });

  it("rejects a cookie issued too long ago (past 30 days)", () => {
    // Build a cookie whose timestamp is older than the lifetime. The
    // signature is computed for the actual timestamp, so a valid
    // signature with an old timestamp exercises the lifetime check.
    const now = Date.now();
    const oldTimestamp = now - SESSION_MAX_AGE_MS - 60_000;
    const cookie = buildSessionCookie(oldTimestamp);
    const value = extractCookieValue(cookie, SESSION_COOKIE_NAME);
    expect(parseSessionValue(value)).toBeNull();
  });

  it("rejects a cookie issued in the far future (clock skew abuse)", () => {
    // A 1-hour-future timestamp is beyond the 5-minute skew window
    // and must be rejected.
    const future = Date.now() + 60 * 60 * 1000;
    const cookie = buildSessionCookie(future);
    const value = extractCookieValue(cookie, SESSION_COOKIE_NAME);
    expect(parseSessionValue(value)).toBeNull();
  });

  it("rejects a cookie signed with a different SESSION_SECRET", () => {
    const cookie = buildSessionCookie();
    const value = extractCookieValue(cookie, SESSION_COOKIE_NAME);
    process.env.SESSION_SECRET = "rotated-secret";
    expect(parseSessionValue(value)).toBeNull();
    // And the rotation worked: a fresh cookie under the new secret
    // is the only one that works now.
    const fresh = extractCookieValue(buildSessionCookie(), SESSION_COOKIE_NAME);
    expect(parseSessionValue(fresh)).not.toBeNull();
  });
});

/* ------------------------- readSessionFromRequest ------------------------- */

describe("readSessionFromRequest", () => {
  it("returns null when there is no Cookie header", () => {
    expect(readSessionFromRequest(new Request("https://x/"))).toBeNull();
  });

  it("returns null when the session cookie is absent", () => {
    const req = new Request("https://x/", {
      headers: { cookie: "other=junk" },
    });
    expect(readSessionFromRequest(req)).toBeNull();
  });

  it("returns a session for a valid cookie", () => {
    const value = extractCookieValue(buildSessionCookie(), SESSION_COOKIE_NAME);
    const req = new Request("https://x/", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${value}` },
    });
    const session = readSessionFromRequest(req);
    expect(session).not.toBeNull();
  });

  it("survives other cookies sitting alongside the session cookie", () => {
    const value = extractCookieValue(buildSessionCookie(), SESSION_COOKIE_NAME);
    const req = new Request("https://x/", {
      headers: {
        cookie: `preference=dark; ${SESSION_COOKIE_NAME}=${value}; tracker=ignored`,
      },
    });
    expect(readSessionFromRequest(req)).not.toBeNull();
  });
});

/* ------------------------------ buildClearSessionCookie -------------------- */

describe("buildClearSessionCookie", () => {
  it("sets Max-Age=0 so the browser drops the cookie immediately", () => {
    const c = buildClearSessionCookie();
    expect(c).toMatch(/Max-Age=0/);
    expect(c).toMatch(/HttpOnly/i);
    expect(c).toMatch(/SameSite=Lax/i);
  });

  it("makes the next read return null", () => {
    const value = extractCookieValue(buildSessionCookie(), SESSION_COOKIE_NAME);
    // Browser swaps in the empty/expired cookie value.
    const req = new Request("https://x/", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=` },
    });
    expect(readSessionFromRequest(req)).toBeNull();
  });
});

/* --------------------------------- requireAuth ----------------------------- */

describe("requireAuth", () => {
  it("returns session info when the cookie is valid", () => {
    const value = extractCookieValue(buildSessionCookie(), SESSION_COOKIE_NAME);
    const req = new Request("https://x/recipes/3/review", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${value}` },
    });
    const session = requireAuth(req);
    expect(session.issuedAtMs).toBeGreaterThan(Date.now() - 5_000);
  });

  it("throws a 302 to /login for an HTML route when unauthenticated", () => {
    const req = new Request("https://x/recipes/3/review");
    let thrown: Response | null = null;
    try {
      requireAuth(req);
    } catch (e) {
      thrown = e as Response;
    }
    expect(thrown).not.toBeNull();
    expect(thrown!.status).toBe(302);
    const loc = thrown!.headers.get("Location") ?? "";
    expect(loc).toMatch(/^\/login\?next=/);
    // The next param round-trips the original path + query.
    expect(decodeURIComponent(loc.split("next=")[1]!)).toBe(
      "/recipes/3/review",
    );
  });

  it("returns a 401 JSON body for API routes when unauthenticated", () => {
    const req = new Request("https://x/api/save-draft", { method: "POST" });
    let thrown: Response | null = null;
    try {
      requireAuth(req, { isApi: true });
    } catch (e) {
      thrown = e as Response;
    }
    expect(thrown).not.toBeNull();
    expect(thrown!.status).toBe(401);
    expect(thrown!.headers.get("content-type")).toMatch(/json/);
  });
});

/* --------------------------------- helpers -------------------------------- */

function extractCookieValue(setCookie: string, name: string): string {
  // Build-Cookie shape: `${name}=${value}; Path=/; ...`
  const head = setCookie.split(";")[0]!;
  const eq = head.indexOf("=");
  if (head.slice(0, eq) !== name) {
    throw new Error(`cookie ${name} not present in ${setCookie}`);
  }
  return head.slice(eq + 1);
}
