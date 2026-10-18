/**
 * Persist a reviewed draft to the relational tables.
 *
 * This is the bridge between the editor's view of a recipe (RecipeDraft)
 * and the storage contract (Drizzle schema, FTS5 triggers). It applies the
 * trim-only normalizer, drops empty fields, and writes a single recipe row
 * plus its ingredients, steps, and tags inside one transaction.
 *
 * Domain source of truth: ../GLOSSARY.md
 *  - Recipe: a single stored dish, one import or manual entry. No merge.
 *  - Draft: every import lands here awaiting review. Saving keeps isDraft=true
 *    until a person explicitly publishes it (out of MVP scope; see #11).
 *  - qty: TEXT so fractions, ranges, and words round-trip verbatim. The
 *    numeric view (qty_amount/qty_amount2/qty_unit_normalized/qty_parse_status)
 *    is derived on write by app/lib/quantity-parse.ts; qty itself is never
 *    rewritten. See the decision on #15.
 */
import { eq } from "drizzle-orm";
import { getRawSqlite } from "../db/client.server";
import {
  CATEGORIES,
  type Category,
  ingredientLines,
  recipes,
  steps,
  tags,
  type NewIngredientLine,
  type NewRecipe,
  type NewStep,
  type NewTag,
} from "../db/schema.server";
import { getDb } from "../db/client.server";
import type { RecipeDraft } from "./draft";
import { normalizeTag, trimOnly, trimOnlyRequired } from "./normalize";
import { resolveQuantity } from "./quantity-parse";

export interface SaveDraftResult {
  recipeId: number;
  isDraft: true;
}

/**
 * Persist a draft. Throws on validation failure (missing title, unknown
 * category). Returns the new recipe id.
 *
 * The caller is responsible for setting isDraft = true; we never publish
 * silently. (`publish: true` is not part of the MVP — see ticket #11.)
 */
export function saveDraft(draft: RecipeDraft): SaveDraftResult {
  const title = trimOnlyRequired(draft.title);
  if (!title) {
    throw new SaveError("title-required", "A title is required to save a draft.");
  }
  if (!CATEGORIES.includes(draft.category as Category)) {
    throw new SaveError(
      "invalid-category",
      `Category "${draft.category}" is not in the MVP list.`,
    );
  }

  const db = getDb();
  const now = new Date();
  const baseRecipe: NewRecipe = {
    title,
    isDraft: true,
    yield: trimOnly(draft.yield),
    category: draft.category as Category,
    favorite: draft.favorite,
    sourceType: draft.sourceType,
    sourceUrl: trimOnly(draft.sourceUrl),
    rawOcrText: trimOnly(draft.rawOcrText),
    createdAt: now,
    updatedAt: now,
  };

  const cleanIngredients: Omit<NewIngredientLine, "recipeId">[] =
    draft.ingredients
      .map((ing, i) => {
        const qty = trimOnlyRequired(ing.qty);
        const unit = trimOnly(ing.unit);
        // Parse-on-write. A row that already carries a trusted parse (importer
        // output, or a draft re-loaded from the DB) keeps it; anything else —
        // including a hand-edited qty, which the editor resets to `unparsed` —
        // is parsed here so the numeric columns are never left stale.
        // See the decision on #15.
        const parsed = resolveQuantity({ ...ing, qty, unit });
        return {
          qty,
          unit,
          item: trimOnlyRequired(ing.item || ing.text),
          note: trimOnly(ing.note),
          position: i + 1,
          qtyAmount: parsed.amount,
          qtyAmount2: parsed.amount2,
          qtyUnitNormalized: parsed.unitNormalized,
          qtyParseStatus: parsed.status,
        };
      })
      .filter((row) => row.item.length > 0);

  const cleanSteps: Omit<NewStep, "recipeId">[] = draft.steps
    .map((s, i) => ({
      position: i + 1,
      text: trimOnlyRequired(s.text),
    }))
    .filter((row) => row.text.length > 0);

  const cleanTags: Omit<NewTag, "recipeId">[] = (() => {
    const seen = new Set<string>();
    const out: Omit<NewTag, "recipeId">[] = [];
    for (const t of draft.tags) {
      const label = normalizeTag(t);
      if (!label || seen.has(label)) continue;
      seen.add(label);
      out.push({ label });
    }
    return out;
  })();

  const sqlite = getRawSqlite();
  let recipeId = 0;
  const run = sqlite.transaction(() => {
    const inserted = db.insert(recipes).values(baseRecipe).returning().get();
    if (!inserted) throw new SaveError("insert-failed", "Recipe insert failed.");
    recipeId = inserted.id;
    if (cleanIngredients.length > 0) {
      db.insert(ingredientLines)
        .values(
          cleanIngredients.map((row) => ({ ...row, recipeId })),
        )
        .run();
    }
    if (cleanSteps.length > 0) {
      db.insert(steps)
        .values(
          cleanSteps.map((row) => ({ ...row, recipeId })),
        )
        .run();
    }
    if (cleanTags.length > 0) {
      db.insert(tags)
        .values(
          cleanTags.map((row) => ({ ...row, recipeId })),
        )
        .run();
    }
  });
  run();

  return { recipeId, isDraft: true };
}

/**
 * Re-read a draft from the DB by id. Used by the review screen to load an
 * existing draft for further editing before publish.
 */
export function loadDraft(id: number): RecipeDraft | null {
  const db = getDb();
  const recipe = db.select().from(recipes).where(eq(recipes.id, id)).get();
  if (!recipe) return null;
  const ings = db
    .select()
    .from(ingredientLines)
    .where(eq(ingredientLines.recipeId, id))
    .all();
  const sts = db.select().from(steps).where(eq(steps.recipeId, id)).all();
  const tgs = db.select().from(tags).where(eq(tags.recipeId, id)).all();

  return {
    title: recipe.title,
    titleConfidence: "ok",
    category: recipe.category,
    categoryConfidence: "ok",
    yield: recipe.yield,
    yieldConfidence: recipe.yield ? "ok" : "bad",
    tags: tgs.map((t) => t.label),
    sourceType: recipe.sourceType,
    sourceUrl: recipe.sourceUrl,
    rawOcrText: recipe.rawOcrText,
    favorite: recipe.favorite,
    ingredients: ings
      .sort((a, b) => a.position - b.position)
      .map((row) => ({
        text: [row.qty, row.unit, row.item, row.note].filter(Boolean).join(" ").trim(),
        qty: row.qty,
        unit: row.unit,
        item: row.item,
        note: row.note,
        confidence: row.qty ? "ok" : "warn",
        // Carry the stored numeric view back into the editor so the scaled view
        // is exact (and so a save without edits does not re-derive anything).
        qtyAmount: row.qtyAmount,
        qtyAmount2: row.qtyAmount2,
        qtyUnitNormalized: row.qtyUnitNormalized,
        qtyParseStatus: row.qtyParseStatus,
      })),
    steps: sts
      .sort((a, b) => a.position - b.position)
      .map((row) => ({ position: row.position, text: row.text })),
  };
}

export class SaveError extends Error {
  constructor(
    public code:
      | "title-required"
      | "invalid-category"
      | "insert-failed",
    message: string,
  ) {
    super(message);
  }
}
