/**
 * Scan module: HTTP transport for POST /api/re-ocr (#28).
 *
 * Kept inside the Scan module (and behind its `.server` entry) so the route
 * module stays a thin adapter and this helper — which drags `auth.server`
 * along — can never be pulled into the client bundle.
 */
import { requireAuth } from "../auth.server";
import { ingest } from "./recognize-node.server";
import { ScanImageError, reocrRecipe } from "./storage.server";

export async function handleReOcrRequest(request: Request): Promise<Response> {
  requireAuth(request, { isApi: true });
  if (request.method !== "POST") {
    return Response.json({ error: "method-not-allowed" }, { status: 405 });
  }

  let body: { id?: unknown };
  try {
    body = (await request.json()) as { id?: unknown };
  } catch {
    return Response.json({ error: "bad-json" }, { status: 400 });
  }
  const id = typeof body.id === "number" ? body.id : Number(body.id);
  if (!Number.isInteger(id) || id <= 0) {
    return Response.json({ error: "bad-id" }, { status: 400 });
  }

  try {
    const result = await reocrRecipe(id, ingest);
    return Response.json(result);
  } catch (err) {
    if (err instanceof ScanImageError) {
      const status =
        err.code === "not-found" ||
        err.code === "no-image" ||
        err.code === "image-missing"
          ? 404
          : 400;
      return Response.json({ error: err.code, message: err.message }, { status });
    }
    console.error("[api.re-ocr] unexpected error", err);
    return Response.json({ error: "internal" }, { status: 500 });
  }
}
