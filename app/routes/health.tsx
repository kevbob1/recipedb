import type { Route } from "./+types/health";
import { getRawSqlite } from "~/db/client.server";

export async function loader(_args: Route.LoaderArgs) {
  // Touch the database so a missing file shows up here, not in a route.
  const sqlite = getRawSqlite();
  const result = sqlite.prepare("SELECT 1 AS ok").get() as { ok: number };
  return Response.json({
    status: "ok",
    db: result.ok === 1 ? "ok" : "unexpected",
  });
}
