/**
 * Action endpoint: save a draft.
 *
 * POST RecipeDraft (application/json) -> { recipeId: number }
 * POST multipart/form-data { draft: RecipeDraft, image?: File } -> { recipeId }
 *
 * The JSON form is used by URL imports and manual entries. A scan import posts
 * multipart: the ORIGINAL capture bytes ride alongside the draft, and the
 * server writes them untouched to DATA_DIR/images/<id>/original.<ext> and points
 * `recipes.image_filename` at it (#28). The artifact is retained indefinitely;
 * only deleting the recipe removes it.
 *
 * Validation lives in saveDraft and scan-image.server; the transport is in
 * ../lib/save-draft-http.server.ts so this route exports only route code.
 */
import type { Route } from "./+types/api.save-draft";
import { handleSaveDraftRequest } from "../lib/save-draft-http.server";

export async function action({ request }: Route.ActionArgs) {
  return handleSaveDraftRequest(request);
}

export function loader() {
  return Response.json({ error: "method-not-allowed" }, { status: 405 });
}
