/**
 * Action endpoint: save a draft.
 *
 * POST RecipeDraft -> { recipeId: number }
 *
 * Bridges the client-side editor (Add flow's review screen, future "Edit
 * existing draft" screen) to the storage layer. Validation lives in
 * saveDraft; this route is a thin transport.
 */
import type { Route } from "./+types/api.save-draft";
import { saveDraft, SaveError } from "../lib/save-draft.server";
import type { RecipeDraft } from "../lib/draft";

export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "method-not-allowed" }, { status: 405 });
  }
  let body: RecipeDraft;
  try {
    body = (await request.json()) as RecipeDraft;
  } catch {
    return Response.json({ error: "bad-json" }, { status: 400 });
  }
  try {
    const result = saveDraft(body);
    return Response.json(result);
  } catch (err) {
    if (err instanceof SaveError) {
      return Response.json({ error: err.code, message: err.message }, { status: 400 });
    }
    console.error("[api.save-draft] unexpected error", err);
    return Response.json({ error: "internal" }, { status: 500 });
  }
}

export function loader() {
  return Response.json({ error: "method-not-allowed" }, { status: 405 });
}
