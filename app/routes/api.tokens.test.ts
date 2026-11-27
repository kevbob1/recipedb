import { afterEach, describe, expect, it } from "vitest";
import { buildSessionCookie } from "../lib/auth.server";
import { withDb } from "../lib/testing/with-db";
import { action, loader } from "./api.tokens";

withDb();

let originalSecret: string | undefined;

afterEach(() => {
  if (originalSecret === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = originalSecret;
});

function sessionCookie(): string {
  originalSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = "token-route-test-secret";
  return buildSessionCookie().split(";")[0]!;
}

function args(request: Request) {
  return {
    request,
    params: {},
    context: {},
    url: new URL(request.url),
    pattern: new URL(request.url).pathname,
  };
}

function request(
  method: string,
  options: { body?: string; cookie?: string; authorization?: string } = {},
): Request {
  const headers = new Headers();
  if (options.body !== undefined) headers.set("content-type", "application/json");
  if (options.cookie) headers.set("cookie", options.cookie);
  if (options.authorization) headers.set("authorization", options.authorization);
  return new Request("http://localhost/api/tokens", {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: options.body }),
  });
}

describe("API token management route", () => {
  it("mints, lists, and revokes tokens with a cookie session", async () => {
    const cookie = sessionCookie();
    const minted = await action(
      args(request("POST", { cookie, body: JSON.stringify({ name: " backup " }) })),
    );
    expect(minted.status).toBe(201);
    const token = await minted.json();
    expect(token).toMatchObject({ name: "backup", secret: expect.stringMatching(/^rdb_/) });

    const listed = await loader(args(request("GET", { cookie })));
    expect(await listed.json()).toMatchObject([
      { id: token.id, name: "backup" },
    ]);
    expect(JSON.stringify(await (await loader(args(request("GET", { cookie })))).json()))
      .not.toContain(token.secret);

    const revoked = await action(
      args(new Request(`http://localhost/api/tokens?id=${token.id}`, {
        method: "DELETE",
        headers: { cookie },
      })),
    );
    expect(await revoked.json()).toEqual({ revoked: true });
    expect(await (await loader(args(request("GET", { cookie })))).json()).toEqual([]);
    const missing = await action(
      args(new Request("http://localhost/api/tokens?id=999", {
        method: "DELETE",
        headers: { cookie },
      })),
    );
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "not-found" });
  });

  it("rejects malformed and invalid names", async () => {
    const cookie = sessionCookie();
    expect((await action(args(request("POST", { cookie, body: "{" })))).status).toBe(400);
    expect((await action(args(request("POST", { cookie, body: "null" })))).status).toBe(400);
    expect((await action(args(request("POST", { cookie, body: JSON.stringify({ name: " " }) })))).status).toBe(400);
    expect((await action(args(request("POST", { cookie, body: JSON.stringify({ name: "x".repeat(65) }) })))).status).toBe(400);
    expect((await action(args(request("DELETE", { cookie })))).status).toBe(400);
  });

  it("does not allow bearer tokens to manage tokens", async () => {
    const cookie = sessionCookie();
    const minted = await action(
      args(request("POST", { cookie, body: JSON.stringify({ name: "manager" }) })),
    );
    const { secret } = await minted.json();
    const bearer = `Bearer ${secret}`;
    expect((await loader(args(request("GET", { authorization: bearer })))).status).toBe(401);
    expect(
      (await action(args(request("POST", {
        authorization: bearer,
        body: JSON.stringify({ name: "blocked" }),
      })))).status,
    ).toBe(401);
    expect(
      (await action(args(new Request("http://localhost/api/tokens?id=1", {
        method: "DELETE",
        headers: { authorization: bearer },
      })))).status,
    ).toBe(401);
  });
});
