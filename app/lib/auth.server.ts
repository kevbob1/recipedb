/**
 * Shared-password auth for the family recipe box.
 *
 * Single shared credential, one env-stored argon2id hash, one stateless
 * HMAC-signed cookie. The cookie is set on successful login and cleared
 * on logout. All non-public routes call `requireAuth(request)` at the
 * top of their loader/action; the helper throws the right Response
 * (redirect for HTML, 401 for API) when no valid session is present.
 *
 * Password rotation: generate a new hash with
 * `@node-rs/argon2`'s `hash()` (PHC string, Argon2id), set
 * FAMILY_PASSWORD_HASH to that value, and restart the server. The
 * restart changes SESSION_SECRET, which invalidates every outstanding
 * session cookie.
 */
import { verify as argonVerify } from "@node-rs/argon2";
import {
  buildSessionCookie,
  readSessionFromRequest,
  type SessionInfo,
} from "./session.server";

export type AuthEnv = {
  familyPasswordHash: string | undefined;
  sessionSecret: string | undefined;
};

export function getAuthEnv(): AuthEnv {
  return {
    familyPasswordHash: process.env.FAMILY_PASSWORD_HASH,
    sessionSecret: process.env.SESSION_SECRET,
  };
}

export function assertAuthEnvConfigured(): void {
  const env = getAuthEnv();
  const isDev = process.env.NODE_ENV !== "production";
  const missing: string[] = [];
  if (!env.familyPasswordHash) missing.push("FAMILY_PASSWORD_HASH");
  if (!env.sessionSecret) missing.push("SESSION_SECRET");
  if (missing.length === 0) return;
  if (isDev) {
    // Dev is permissive: warn loudly so the operator notices, but don't crash.
    console.warn(
      `[auth] WARNING: missing env: ${missing.join(", ")}. ` +
        `Ticket #12 will gate access; the app will start in dev anyway.`,
    );
    return;
  }
  throw new Error(
    `missing required auth env: ${missing.join(", ")}. ` +
      `Set both before starting in production.`,
  );
}

/**
 * Verify a submitted password against the configured argon2id hash.
 * Returns false on any failure (wrong password, missing hash, malformed
 * hash). Callers should treat false and a thrown error the same way:
 * reject the login attempt. The function only throws if the hash is
 * structurally invalid AND the caller passes `{ strict: true }`.
 */
export async function verifyPassword(
  password: string,
  opts: { strict?: boolean } = {},
): Promise<boolean> {
  const hash = process.env.FAMILY_PASSWORD_HASH;
  if (!hash || hash.length === 0) {
    if (opts.strict) {
      throw new Error("FAMILY_PASSWORD_HASH is not configured");
    }
    return false;
  }
  if (typeof password !== "string" || password.length === 0) return false;
  try {
    return await argonVerify(hash, password);
  } catch (err) {
    if (opts.strict) {
      throw new Error(
        `FAMILY_PASSWORD_HASH is not a valid argon2 PHC string: ${
          (err as Error).message
        }`,
      );
    }
    return false;
  }
}

/**
 * Marker for the alg parameter in the PHC hash. Used to confirm at
 * startup that the configured hash uses argon2id (the family-password
 * spec). A non-argon2id hash is rejected so the operator can't quietly
 * ship a weaker scheme.
 */
export function assertHashIsArgon2id(hash: string): void {
  // PHC format: $argon2id$v=19$m=...,t=...,p=...$<salt>$<hash>
  if (!/^\$argon2id\$/i.test(hash)) {
    throw new Error(
      "FAMILY_PASSWORD_HASH must be an argon2id PHC string " +
        "(starting with $argon2id$). Re-hash with @node-rs/argon2.",
    );
  }
}

/**
 * Throw a redirect to /login (HTML) or a 401 JSON Response (API) when
 * no valid session is present. The thrown Response propagates through
 * React Router and is sent to the browser untouched.
 *
 * Callers pass a hint about whether the request is for an HTML page
 * (so the user sees the login screen) or an API endpoint (so the
 * client gets a structured 401 instead of an HTML redirect).
 */
export function requireAuth(
  request: Request,
  opts: { isApi: boolean } = { isApi: false },
): SessionInfo {
  const session = readSessionFromRequest(request);
  if (session) return session;
  if (opts.isApi) {
    throw new Response(
      JSON.stringify({ error: "unauthorized" }),
      {
        status: 401,
        headers: { "content-type": "application/json" },
      },
    );
  }
  // For HTML routes, send the user to /login and remember where they
  // were headed so we can bounce them back after a successful login.
  const next = new URL(request.url).pathname + new URL(request.url).search;
  const loginUrl = `/login?next=${encodeURIComponent(next)}`;
  throw new Response(null, {
    status: 302,
    headers: { Location: loginUrl },
  });
}

export { buildSessionCookie } from "./session.server";
