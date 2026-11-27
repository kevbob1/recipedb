import { describe, expect, it } from "vitest";
import { getDb, getRawSqlite } from "../db/client.server";
import { apiTokens } from "../db/schema.server";
import { withDb } from "./testing/with-db";
import {
  listTokens,
  mintToken,
  revokeToken,
  verifyTokenSecret,
} from "./tokens.server";

withDb();

describe("API tokens", () => {
  it("mints a secret that verifies and stores only its hash", () => {
    const token = mintToken("Kitchen assistant");

    expect(token.secret).toMatch(/^rdb_[A-Za-z0-9_-]{43}$/);
    expect(verifyTokenSecret(token.secret)).toEqual({
      id: token.id,
      name: token.name,
      createdAt: token.createdAt,
    });
    expect(verifyTokenSecret("rdb_wrong-secret")).toBeNull();

    const stored = getDb()
      .select({ tokenHash: apiTokens.tokenHash })
      .from(apiTokens)
      .get();
    expect(stored?.tokenHash).not.toBe(token.secret);
    expect(stored?.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(getRawSqlite().prepare("SELECT token_hash FROM api_tokens").get())
      .not.toHaveProperty("secret");
  });

  it("lists metadata without hashes and revokes a token", () => {
    const token = mintToken("Meal planner");

    expect(listTokens()).toEqual([
      { id: token.id, name: token.name, createdAt: token.createdAt },
    ]);
    expect(listTokens()[0]).not.toHaveProperty("tokenHash");
    expect(revokeToken(token.id)).toBe(true);
    expect(revokeToken(token.id)).toBe(false);
    expect(verifyTokenSecret(token.secret)).toBeNull();
    expect(listTokens()).toEqual([]);
  });
});
