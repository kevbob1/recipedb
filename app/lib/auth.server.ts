/**
 * Auth env reservation.
 *
 * The real password gate is implemented in ticket #12. This module exists so
 * the env shape is reserved and validated at startup. The server refuses to
 * boot if the required auth env is missing in non-dev mode.
 */
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
