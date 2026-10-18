/**
 * Cookie-based session for the single shared family password.
 *
 * The MVP ships a stateless session: the cookie carries a signed
 * timestamp; verifying the HMAC and the 30-day lifetime is enough to
 * prove "this browser logged in recently". There is no session store
 * and no rotation. Password rotation is done by re-hashing
 * FAMILY_PASSWORD_HASH and restarting the server, which invalidates
 * every existing session by changing SESSION_SECRET.
 *
 * Wire format: `${issuedAtMs}.${signatureB64Url}` where signatureB64Url
 * is the base64url-encoded HMAC-SHA256(issuedAtMs, SESSION_SECRET).
 * The dot is a separator; everything before it is the unsigned payload.
 *
 * This module only deals with cookie bytes. Auth decisions live in
 * auth.server.ts.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE_NAME = "recipedb_session";
export const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000; // forgive 5 min of clock drift on first issue

function getSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length === 0) {
    throw new Error(
      "SESSION_SECRET is required for session cookies. " +
        "Set it before starting the server (see ticket #12).",
    );
  }
  return secret;
}

function sign(issuedAtMs: number, secret: string): string {
  return createHmac("sha256", secret)
    .update(String(issuedAtMs))
    .digest("base64url");
}

function safeEqualB64Url(a: string, b: string): boolean {
  // timingSafeEqual requires equal-length buffers. Both signatures are
  // base64url(SHA-256), so they always have the same length. If anything
  // is off, we fail closed.
  const ab = Buffer.from(a, "base64url");
  const bb = Buffer.from(b, "base64url");
  if (ab.length !== bb.length || ab.length === 0) return false;
  return timingSafeEqual(ab, bb);
}

export type SessionInfo = {
  /** Milliseconds since epoch when the cookie was issued. */
  issuedAtMs: number;
};

/**
 * Build a Set-Cookie value that authenticates the browser for 30 days.
 * The returned string is the raw `name=value; ...attrs` form ready to
 * drop on a Response.
 */
export function buildSessionCookie(now: number = Date.now()): string {
  const secret = getSecret();
  // Tokens issued slightly in the future are tolerated to absorb clock
  // skew; tokens dated too far in the past are rejected outright.
  const issuedAtMs = now;
  const sig = sign(issuedAtMs, secret);
  const value = `${issuedAtMs}.${sig}`;
  const maxAgeSeconds = Math.floor(SESSION_MAX_AGE_MS / 1000);
  // httpOnly: no JS access (XSS can't steal the session).
  // SameSite=Lax: top-level GETs from off-site still get the cookie,
  // so the kitchen phone works; cross-site POSTs do not.
  // Secure is intentionally NOT set: MVP is LAN-only no-TLS per #8.
  return [
    `${SESSION_COOKIE_NAME}=${value}`,
    "Path=/",
    `Max-Age=${maxAgeSeconds}`,
    "HttpOnly",
    "SameSite=Lax",
  ].join("; ");
}

/**
 * Build a Set-Cookie value that immediately expires the session cookie
 * in the browser. Used by /logout.
 */
export function buildClearSessionCookie(): string {
  return [
    `${SESSION_COOKIE_NAME}=`,
    "Path=/",
    "Max-Age=0",
    "HttpOnly",
    "SameSite=Lax",
  ].join("; ");
}

/**
 * Read the session cookie off a Request and verify it. Returns the
 * session info on success and null on any failure (missing, malformed,
 * bad signature, expired). Failures are not distinguished on purpose;
 * callers should treat all of them the same.
 */
export function readSessionFromRequest(request: Request): SessionInfo | null {
  const raw = readCookie(request, SESSION_COOKIE_NAME);
  if (!raw) return null;
  return parseSessionValue(raw);
}

/**
 * Internal: parse a raw cookie value. Exposed for tests.
 */
export function parseSessionValue(value: string): SessionInfo | null {
  const dot = value.indexOf(".");
  if (dot <= 0 || dot === value.length - 1) return null;
  const issuedAtRaw = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  const issuedAtMs = Number.parseInt(issuedAtRaw, 10);
  if (!Number.isFinite(issuedAtMs) || issuedAtMs <= 0) return null;

  const secret = getSecret();
  const expected = sign(issuedAtMs, secret);
  if (!safeEqualB64Url(sig, expected)) return null;

  const now = Date.now();
  // Issued slightly in the future (clock skew) is accepted, but we
  // still cap the lifetime from the issue date forward.
  if (issuedAtMs - now > MAX_CLOCK_SKEW_MS) return null;
  if (now - issuedAtMs > SESSION_MAX_AGE_MS) return null;
  return { issuedAtMs };
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    if (trimmed.slice(0, eq) === name) {
      return trimmed.slice(eq + 1);
    }
  }
  return null;
}
