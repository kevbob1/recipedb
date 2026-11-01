/**
 * "What can I cook?" — ingredient-chip matching + ranked home filter
 * (ADR-0003 §B and §C).
 *
 * This module owns ONE question: given the ingredient lines of a recipe and a
 * set of chip terms the household typed, which lines are *missing*, and how do
 * recipes rank by that count? It is pure and isomorphic (no db, no request
 * imports), so the route can reason about chips client-side while the loader
 * does the real ranking on the server.
 *
 * Hard boundaries, fixed by the ADR:
 *  - Matching is a plain case-insensitive substring of the chip term against
 *    the stored ingredient `item` text. There is no canonical-food table, no
 *    alias list, and no stemming. False friends ("ham" in "hamburger") are
 *    accepted.
 *  - Every recipe stays visible. There is no cutoff and no exclusion term;
 *    the list is only re-ordered.
 *  - An ingredient line is missing unless it matches a chip or a staple. All
 *    lines weigh the same ("salt to taste" == "chicken thighs").
 *  - Staples are the hard-coded `STAPLES` list below. A fixed list was chosen
 *    over per-recipe flags or a settings UI: editing the constant is the one
 *    supported way to change the answer (ADR-0003 §C).
 *
 * `ingredient-line.ts`/`unit-convert.ts` stay untouched — this module reads
 * only `item` strings the caller already has.
 */

/**
 * Universal staples, exempt from the missing count (ADR-0003 §C).
 *
 * Plain lowercase substrings, matched against the whole ingredient `item`, so
 * one short entry covers its common phrasings: "oil" catches "olive oil" and
 * "vegetable oil"; "stock" catches "chicken stock"; "egg" catches "2 large
 * eggs". The list is deliberately generous — the household said these are
 * "almost always on the shelf" and accepted the occasional wrong answer
 * ("we count butter") as the price of a fixed list.
 *
 * Substring matching means a few false friends are expected: "egg" also
 * exempts "eggplant", "water" exempts "watercress". Accepted; the ADR prefers
 * a simple, editable constant over a curated pantry.
 */
export const STAPLES: readonly string[] = [
  "salt",
  "pepper",
  "oil",
  "butter",
  "flour",
  "sugar",
  "water",
  "stock",
  "broth",
  "vinegar",
  "milk",
  "cream",
  "egg",
  "soy sauce",
  "honey",
  "baking powder",
  "baking soda",
  "yeast",
  "cornstarch",
  "corn starch",
  "paprika",
  "cumin",
  "oregano",
  "bay leaf",
  "thyme",
  "parsley",
  "cinnamon",
  "vanilla",
  "mustard",
  "mayonnaise",
  "ketchup",
  "hot sauce",
  "garlic",
  "onion",
];

/** A recipe id plus its ingredient line items, as loaded by the server seam. */
export interface CookNowRecipe {
  id: number;
}

/** One ranked row: the original recipe plus what is still missing for it. */
export interface RankedRecipe<T> {
  recipe: T;
  /** Ingredient items (verbatim line text) that no chip or staple covers. */
  missingItems: string[];
  /** `missingItems.length`; what the card badge shows. */
  missingCount: number;
}

/** True when the item text contains any staple term (case-insensitive). */
export function isStaple(item: string): boolean {
  const text = item.toLowerCase();
  return STAPLES.some((staple) => text.includes(staple));
}

/**
 * True when the item text contains the chip term (case-insensitive substring).
 * A blank chip matches nothing — callers drop blanks via `parseChips`, but the
 * guard keeps the helper honest on its own.
 */
export function matchesChip(item: string, chip: string): boolean {
  const term = chip.trim().toLowerCase();
  if (term.length === 0) return false;
  return item.toLowerCase().includes(term);
}

/**
 * The missing lines for one recipe: items that match no chip and are not a
 * staple. Blank items are ignored (they carry no shopping meaning).
 */
export function missingItemsFor(
  items: readonly string[],
  chips: readonly string[],
): string[] {
  const terms = chips
    .map((c) => c.trim().toLowerCase())
    .filter((c) => c.length > 0);
  if (terms.length === 0) return [];

  const missing: string[] = [];
  for (const item of items) {
    const text = (item ?? "").trim();
    if (text.length === 0) continue;
    const lower = text.toLowerCase();
    const covered = terms.some((term) => lower.includes(term));
    if (covered || isStaple(text)) continue;
    missing.push(text);
  }
  return missing;
}

/**
 * Rank recipes by fewest missing ingredients (ADR-0003 §B).
 *
 * `itemsByRecipeId` is the bulk projection the server seam loads; a recipe
 * with no entry is treated as having no ingredient lines (zero missing, keeps
 * its input position). A stable sort keeps the incoming browse/search order as
 * the tie-breaker, so equal counts do not shuffle between requests.
 *
 * Empty chips → the input order is returned unchanged and every recipe is
 * reported as complete, which is the "filter is off" passthrough.
 */
export function rankByMissing<T extends CookNowRecipe>(
  recipes: readonly T[],
  itemsByRecipeId: ReadonlyMap<number, readonly string[]>,
  chips: readonly string[],
): RankedRecipe<T>[] {
  const terms = chips.filter((c) => c.trim().length > 0);
  if (terms.length === 0) {
    return recipes.map((recipe) => ({
      recipe,
      missingItems: [],
      missingCount: 0,
    }));
  }

  const ranked = recipes.map((recipe) => {
    const items = itemsByRecipeId.get(recipe.id) ?? [];
    const missingItems = missingItemsFor(items, terms);
    return { recipe, missingItems, missingCount: missingItems.length };
  });

  // Array.prototype.sort is stable per spec; V8 has honoured it since 2019.
  // The tie-breaker is therefore the caller's order (bm25 or recent-first).
  ranked.sort((a, b) => a.missingCount - b.missingCount);
  return ranked;
}

/**
 * Parse the `cook` URL param into chip terms: comma-separated, trimmed,
 * lower-cased, de-duplicated, blanks dropped. Kept here so the loader and the
 * UI agree on what a chip is.
 */
export function parseChips(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const chips: string[] = [];
  for (const part of raw.split(",")) {
    const term = part.trim().toLowerCase();
    if (term.length === 0 || seen.has(term)) continue;
    seen.add(term);
    chips.push(term);
  }
  return chips;
}

/** Serialize chips back into the `cook` URL param (inverse of `parseChips`). */
export function serializeChips(chips: readonly string[]): string {
  return parseChips(chips.join(",")).join(",");
}

/**
 * Badge display helper: show the first `max` missing items, count the rest.
 * The route renders `shown.join(", ")` and, when `more > 0`, " +N more".
 */
export function summarizeMissing(
  items: readonly string[],
  max = 3,
): { shown: string[]; more: number } {
  const limit = Math.max(0, max);
  if (items.length <= limit) return { shown: [...items], more: 0 };
  return { shown: items.slice(0, limit), more: items.length - limit };
}
