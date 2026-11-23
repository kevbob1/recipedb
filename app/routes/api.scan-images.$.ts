/**
 * GET /api/scan-images/<recipeId>/<file> — serve a retained scan artifact to
 * the browser: the per-page review editor displays page rasters, and a
 * recipe's cover image, straight from the store that retains them (ADR-0004).
 *
 * Read-only and thin: authorization and the traversal guard live in the Scan
 * module (../lib/scan); this route maps the splat path onto it and nothing
 * else.
 */
import type { Route } from "./+types/api.scan-images.$";
import { handleScanImageRequest } from "../lib/scan/index.server";

export function loader({ request, params }: Route.LoaderArgs) {
  return handleScanImageRequest(request, params["*"] ?? "");
}

export function action() {
  return Response.json({ error: "method-not-allowed" }, { status: 405 });
}
