/**
 * Action endpoint: save review state.
 *
 *   POST JSON      { draft, recipeId?            } -> { recipeId }
 *   POST JSON      { recipeId, intent: "delete"  } -> { recipeId, deleted: true }
 *   POST multipart { draft, image?, recipeId?    } -> { recipeId }
 *
 * New recipes come from URL/manual entries and from a scan whose ORIGINAL
 * capture still rides in the page (#28). Existing recipes come from the review
 * screen; its delete intent travels through the same endpoint.
 *
 * The pipeline is parse -> dispatch: app/lib/save-draft-http.server.ts turns
 * the body into a SaveCommand, app/lib/draft-store.server.ts owns validation
 * and persistence through executeSave. This module is the auth gate, the error
 * mapper, and nothing else — it never re-reads intent or a recipe id.
 */
import type { Route } from "./+types/api.save-draft";
import { requireAuth } from "../lib/auth.server";
import { SaveError, executeSave } from "../lib/draft-store.server";
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

  const command = await parseSaveBody(request);
  if ("error" in command) return command.error;

  try {
    return Response.json(executeSave(command));
  } catch (err) {
    return saveFailure(err);
  }
}

export function loader() {
  return Response.json({ error: "method-not-allowed" }, { status: 405 });
}
