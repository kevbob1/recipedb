/**
 * Action endpoint: save review state.
 *
 *   POST JSON      { draft, recipeId?            } -> { recipeId }
 *   POST JSON      { recipeId, intent: "delete"  } -> { recipeId, deleted: true }
 *   POST multipart { draft, image?, recipeId?    } -> { recipeId }
 *
 * New recipes come from URL/manual entries and from a scan whose ORIGINAL
 * capture still rides in the page (#28). Existing recipes come from the review
 * screen; its delete intent travels through the same endpoint. Persistence
 * decisions live in app/lib/draft-store.server.ts, body parsing in
 * app/lib/save-draft-http.server.ts; this module is the auth gate and dispatcher.
 */
import type { Route } from "./+types/api.save-draft";
import { requireAuth } from "../lib/auth.server";
import { SaveError, saveExistingDraft, saveNewDraft } from "../lib/draft-store.server";
import { parseSaveBody } from "../lib/save-draft-http.server";
import { ScanImageError } from "../lib/scan/index.server";

function saveFailure(err: unknown): Response {
  if (err instanceof ScanImageError) {
    const status =
      err.code === "image-too-large"
        ? 413
        : err.code === "image-write-failed"
          ? 500
          : 400;
    return Response.json({ error: err.code, message: err.message }, { status });
  }
  if (err instanceof SaveError) {
    const status = err.code === "not-found" ? 404 : 400;
    return Response.json(
      { error: err.code, message: err.message },
      { status },
    );
  }
  console.error("[api.save-draft] unexpected error", err);
  return Response.json({ error: "internal" }, { status: 500 });
}

export async function action({ request }: Route.ActionArgs) {
  requireAuth(request, { isApi: true });
  if (request.method !== "POST") {
    return Response.json({ error: "method-not-allowed" }, { status: 405 });
  }

  const parsed = await parseSaveBody(request);
  if ("error" in parsed) return parsed.error;

  try {
    if (parsed.intent === "delete") {
      if (parsed.recipeId === null) {
        return Response.json({ error: "bad-recipe-id" }, { status: 400 });
      }
      return Response.json(
        saveExistingDraft(parsed.recipeId, parsed.draft, { delete: true }),
      );
    }
    const { draft } = parsed;
    if (draft === null) {
      return Response.json({ error: "missing-draft" }, { status: 400 });
    }
    if (parsed.recipeId !== null) {
      return Response.json(saveExistingDraft(parsed.recipeId, draft));
    }
    return Response.json(saveNewDraft(draft, parsed.imageBytes));
  } catch (err) {
    return saveFailure(err);
  }
}

export function loader() {
  return Response.json({ error: "method-not-allowed" }, { status: 405 });
}
