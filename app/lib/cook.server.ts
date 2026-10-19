/**
 * Loading the cook screen's data (issue #18).
 *
 * The cook route is strictly read-only: it renders a stored recipe and the
 * browser holds all ephemeral state (checked-off ingredients, current step).
 * Nothing here writes, and no new query is needed — a cook session is just
 * `loadDraft` plus the id validation the review route also does.
 *
 * The decision is a discriminated result rather than thrown Responses so the
 * route can map it to a status code and the loader behaviour stays testable
 * without standing up React Router.
 */
import { loadDraft } from "./save-draft.server";
import type { RecipeDraft } from "./draft";

export type CookLoad =
  | { ok: true; recipeId: number; draft: RecipeDraft }
  | { ok: false; status: 400 | 404; message: string };

/**
 * Validate a route param and load the recipe it names.
 *
 * 400 when the id is not a positive integer (so `/recipes/abc/cook` does not
 * reach the database), 404 when nothing is stored under that id.
 */
export function loadCookRecipe(idRaw: string | null | undefined): CookLoad {
  const id = Number(idRaw);
  if (
    idRaw === null ||
    idRaw === undefined ||
    String(idRaw).trim() === "" ||
    !Number.isInteger(id) ||
    id <= 0
  ) {
    return { ok: false, status: 400, message: "Not a recipe id" };
  }
  const draft = loadDraft(id);
  if (!draft) {
    return { ok: false, status: 404, message: "Not found" };
  }
  return { ok: true, recipeId: id, draft };
}
