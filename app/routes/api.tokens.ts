import type { Route } from "./+types/api.tokens";
import { readSessionFromRequest } from "../lib/session.server";
import { listTokens, mintToken, revokeToken } from "../lib/tokens.server";

function unauthorized(): Response {
  return Response.json({ error: "unauthorized" }, { status: 401 });
}

function hasCookieSession(request: Request): boolean {
  return readSessionFromRequest(request) !== null;
}

export function loader({ request }: Route.LoaderArgs) {
  if (!hasCookieSession(request)) return unauthorized();
  return Response.json(listTokens());
}

export async function action({ request }: Route.ActionArgs) {
  if (!hasCookieSession(request)) return unauthorized();

  if (request.method === "DELETE") {
    const rawId = new URL(request.url).searchParams.get("id");
    const id = rawId === null ? Number.NaN : Number(rawId);
    if (!Number.isInteger(id) || id <= 0) {
      return Response.json({ error: "invalid-id" }, { status: 400 });
    }
    if (!revokeToken(id)) {
      return Response.json({ error: "not-found" }, { status: 404 });
    }
    return Response.json({ revoked: true });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid-json" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return Response.json({ error: "invalid-body" }, { status: 400 });
  }
  const name = "name" in body && typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 64) {
    return Response.json({ error: "invalid-name" }, { status: 400 });
  }
  return Response.json(mintToken(name), { status: 201 });
}

export default function ApiTokensRoute() {
  return null;
}
