import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../db/client.server";
import { apiTokens } from "../db/schema.server";

export interface ApiTokenSummary {
  id: number;
  name: string;
  createdAt: Date;
}

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/** Mint a token and return its plaintext secret exactly once. */
export function mintToken(
  name: string,
  db: ReturnType<typeof getDb> = getDb(),
): ApiTokenSummary & { secret: string } {
  const secret = `rdb_${randomBytes(32).toString("base64url")}`;
  const result = db
    .insert(apiTokens)
    .values({ name, tokenHash: hashSecret(secret) })
    .run();
  const id = Number(result.lastInsertRowid);
  const token = db
    .select({
      id: apiTokens.id,
      name: apiTokens.name,
      createdAt: apiTokens.createdAt,
    })
    .from(apiTokens)
    .where(eq(apiTokens.id, id))
    .get();
  if (!token) throw new Error("Minted API token could not be read.");
  return { ...token, secret };
}

/** List token metadata without exposing stored hashes. */
export function listTokens(): ApiTokenSummary[] {
  return getDb()
    .select({
      id: apiTokens.id,
      name: apiTokens.name,
      createdAt: apiTokens.createdAt,
    })
    .from(apiTokens)
    .all();
}

/** Revoke a token by id; returns whether a row was deleted. */
export function revokeToken(id: number): boolean {
  const result = getDb().delete(apiTokens).where(eq(apiTokens.id, id)).run();
  return result.changes > 0;
}

/** Verify a plaintext secret without ever persisting or returning it. */
export function verifyTokenSecret(secret: string): ApiTokenSummary | null {
  const token = getDb()
    .select({
      id: apiTokens.id,
      name: apiTokens.name,
      createdAt: apiTokens.createdAt,
    })
    .from(apiTokens)
    .where(eq(apiTokens.tokenHash, hashSecret(secret)))
    .get();
  return token ?? null;
}
