/**
 * RecipeDraft — the editable shape every import lands in.
 *
 * Domain source of truth: ../GLOSSARY.md
 *
 * This is the in-memory and over-the-wire shape used by the Add flow and the
 * shared review screen. It is intentionally richer than the persisted Recipe
 * row: it carries per-field and per-ingredient confidence so the review UI can
 * flag what needs eyes. The persisted Recipe (app/db/schema.server.ts) only
 * stores the source of truth; the review screen is what reconciles a draft
 * with the schema before saving.
 *
 * Why a separate type from the schema? The schema is the storage contract
 * (CHECK constraints, NOT NULLs, the four-part ingredient row). A draft is
 * the editor's view of a recipe: it can be empty, partial, untrusted. Keeping
 * them separate stops the editor from accidentally writing half-formed rows.
 */

import { CATEGORIES, type Category } from "./categories";

/** Closed MVP category list, re-exported for client code. */
export { CATEGORIES };
export type { Category };

/** Per-field confidence. Matches the prototype's badges. */
export type Confidence = "ok" | "warn" | "bad";

/**
 * Ingredient line as edited in the review screen.
 * Matches the persisted four-part shape (qty, unit, item, note) plus the raw
 * line text and the per-line confidence badge.
 *
 * The draft carries the TEXT truth only. The numeric view
 * (qtyAmount/qtyAmount2/qtyUnitNormalized/qtyParseStatus) lives in
 * app/lib/ingredient-line.ts and is derived from `(qty, unit)` at the point of
 * use — `fromText` for a read, `setQty` for an edit. Nothing carries it in the
 * draft, so a stale parse cannot outlive the text it came from (decision on #15).
 */
export interface DraftIngredient {
  /** Raw line as captured (e.g. "2-3 cloves garlic, minced"). */
  text: string;
  qty: string;
  unit: string | null;
  item: string;
  note: string | null;
  /** Per-line confidence, set by the importer. */
  confidence: Confidence;
}

/** Step as edited in the review screen. */
export interface DraftStep {
  position: number;
  text: string;
}

/**
 * The draft. One in-flight editable recipe.
 *
 * `sourceType` mirrors the GLOSSARY.md Provenance source-type enum and the
 * `recipes.source_type` CHECK constraint. `sourceUrl` is set for url imports,
 * `rawOcrText` for scan imports. Both are null for manual entries.
 */
export interface RecipeDraft {
  /** Title (required to save). */
  title: string;
  /** Per-field confidence. */
  titleConfidence: Confidence;
  /** MVP closed category list. */
  category: Category;
  categoryConfidence: Confidence;
  /** Free-form serving/yield notes, optional. Maps to the `yield` column. */
  yield: string | null;
  yieldConfidence: Confidence;
  /** Tags (free-text labels). */
  tags: string[];
  /** Provenance. */
  sourceType: "url" | "scan" | "manual";
  sourceUrl: string | null;
  /**
   * Raw OCR text captured at import. The original capture itself is retained
   * server-side (recipes.image_filename) so OCR can be re-run later (#28).
   */
  rawOcrText: string | null;
  /**
   * Path of the retained source image, relative to DATA_DIR/images/
   * (e.g. "12/original.png"). Null for manual entries and older imports.
   * Deleted only when the recipe is deleted.
   */
  imageFilename?: string | null;
  /** Whether the recipe is a favorite. */
  favorite: boolean;
  ingredients: DraftIngredient[];
  steps: DraftStep[];
  /**
   * Optional blob of the raw source for the review drawer.
   * For URL imports this is the JSON-LD; for scans it is the OCR text.
   * Not persisted — the review screen shows it but it is not saved to the
   * recipes row.
   */
  raw?: string;
}

/** An empty draft for the manual "Type it in" path. */
export function blankDraft(): RecipeDraft {
  return {
    title: "",
    titleConfidence: "bad",
    category: "other",
    categoryConfidence: "ok",
    yield: null,
    yieldConfidence: "bad",
    tags: [],
    sourceType: "manual",
    sourceUrl: null,
    rawOcrText: null,
    imageFilename: null,
    favorite: false,
    ingredients: [],
    steps: [],
  };
}

/**
 * Trim-only normalization (ticket #3).
 *
 * Auto-normalization at review is whitespace, never content. This function
 * enforces that: leading/trailing whitespace is removed and internal
 * whitespace is collapsed to single spaces, but the underlying text is never
 * re-ordered, re-cased, or otherwise "improved".
 */
export function trimOnly(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Same as `trimOnly` but for required fields. Returns empty string for
 * nullish input — callers can decide whether that's an error.
 */
export function trimOnlyRequired(value: string | null | undefined): string {
  return trimOnly(value) ?? "";
}

/** Confidence for a required text field: 'bad' if empty, otherwise 'ok'. */
export function requiredFieldConfidence(value: string): Confidence {
  return value.trim().length === 0 ? "bad" : "ok";
}

/** Confidence for an optional field. */
export function optionalFieldConfidence(
  value: string | null,
): Confidence {
  return value === null ? "bad" : "ok";
}

/** Per-ingredient confidence — mirrors the prototype's logic. */
export function ingredientConfidence(ing: DraftIngredient): Confidence {
  if (!ing.text.trim()) return "bad";
  if (!ing.qty.trim()) return "warn";
  return "ok";
}

/** How many fields are flagged as needing eyes in the draft summary. */
export function countNeedEyes(draft: RecipeDraft): {
  total: number;
  need: number;
} {
  const fieldBadges: Confidence[] = [
    draft.titleConfidence,
    draft.categoryConfidence,
    draft.yieldConfidence,
  ];
  const needFromFields = fieldBadges.filter((c) => c === "warn" || c === "bad").length;
  const needFromIngs = draft.ingredients.filter(
    (i) => ingredientConfidence(i) !== "ok",
  ).length;
  return {
    total:
      fieldBadges.length + draft.ingredients.length + draft.steps.length,
    need: needFromFields + needFromIngs,
  };
}
