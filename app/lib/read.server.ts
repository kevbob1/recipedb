/**
 * Loading the read view's data (issue #25).
 *
 * /recipes/:id is the single-page read view: the recipe as stored, plus the
 * way in to editing (review) and cooking (cook). Like the cook screen it is
 * read-only — there is no action and nothing here writes.
 *
 * The load itself is exactly the validated, status-mapped one the cook screen
 * uses (app/lib/cook.server.ts): 400 for a malformed id, 404 for an unknown
 * one, otherwise the stored draft. It is exposed under the read view's own
 * name rather than imported directly so this screen's contract does not move
 * when the cook screen's loader does — the same reason cook.server.ts exists
 * instead of the cook route calling loadDraft by hand.
 */
import { loadCookRecipe, type CookLoad } from "./cook.server";

/** Result of loading the read view: the cook loader's shape, named for this screen. */
export type ReadLoad = CookLoad;

/**
 * Validate a route param and load the recipe it names.
 *
 * 400 when the id is not a positive integer (so `/recipes/abc` never reaches
 * the database), 404 when nothing is stored under that id (deleted, or never
 * saved).
 */
export function loadReadRecipe(idRaw: string | null | undefined): ReadLoad {
  return loadCookRecipe(idRaw);
}
