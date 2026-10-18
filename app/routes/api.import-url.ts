/**
 * Action endpoint: URL import.
 *
 * POST { url: string } -> { draft: RecipeDraft, imageFilename: string|null }
 *
 * The Add flow fetches the page on the server, runs recipe-scrapers (or
 * falls back to JSON-LD), and returns the parsed draft. The browser never
 * sees the raw HTML.
 */
import type { Route } from "./+types/api.import-url";
import { importFromUrl, ImportError } from "../lib/recipe-scrapers.server";
import { requireAuth } from "../lib/auth.server";

export async function action({ request }: Route.ActionArgs) {
  // Auth gate: no valid session -> 401, before we touch the network.
  requireAuth(request, { isApi: true });
  if (request.method !== "POST") {
    return Response.json({ error: "method-not-allowed" }, { status: 405 });
  }
  let body: { url?: string };
  try {
    body = (await request.json()) as { url?: string };
  } catch {
    return Response.json({ error: "bad-json" }, { status: 400 });
  }
  const url = (body.url ?? "").trim();
  if (!url) {
    return Response.json({ error: "missing-url" }, { status: 400 });
  }
  try {
    const result = await importFromUrl(url);
    return Response.json({
      draft: result.draft,
      imageFilename: result.imageFilename,
    });
  } catch (err) {
    if (err instanceof ImportError) {
      return Response.json({ error: err.code, message: err.message }, { status: 400 });
    }
    console.error("[api.import-url] unexpected error", err);
    return Response.json({ error: "internal" }, { status: 500 });
  }
}

export function loader() {
  return Response.json({ error: "method-not-allowed" }, { status: 405 });
}
