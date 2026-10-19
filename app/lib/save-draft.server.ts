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

/** Cleaned, DB-ready pieces shared by saveDraft and updateDraft. */
interface PreparedDraft {
  fields: {
    title: string;
    category: Category;
    yield: string | null;
    favorite: boolean;
    sourceType: RecipeDraft["sourceType"];
    sourceUrl: string | null;
    rawOcrText: string | null;
  };
  ingredients: Omit<NewIngredientLine, "recipeId">[];
  steps: Omit<NewStep, "recipeId">[];
  tags: Omit<NewTag, "recipeId">[];
}

/**
 * Validate + normalize a draft exactly once, for both insert and update.
 * Throws SaveError on a missing title or unknown category.
 */
function prepareDraft(draft: RecipeDraft): PreparedDraft {
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

  const ingredients: Omit<NewIngredientLine, "recipeId">[] = draft.ingredients
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

  const steps: Omit<NewStep, "recipeId">[] = draft.steps
    .map((s, i) => ({
      position: i + 1,
      text: trimOnlyRequired(s.text),
    }))
    .filter((row) => row.text.length > 0);

  const tags: Omit<NewTag, "recipeId">[] = (() => {
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

  return {
    fields: {
      title,
      category: draft.category as Category,
      yield: trimOnly(draft.yield),
      favorite: draft.favorite,
      sourceType: draft.sourceType,
      sourceUrl: trimOnly(draft.sourceUrl),
      rawOcrText: trimOnly(draft.rawOcrText),
    },
    ingredients,
    steps,
    tags,
  };
}

/** Insert the child rows for a recipe. Caller supplies the transaction. */
function insertChildren(recipeId: number, prepared: PreparedDraft): void {
  const db = getDb();
  if (prepared.ingredients.length > 0) {
    db.insert(ingredientLines)
      .values(prepared.ingredients.map((row) => ({ ...row, recipeId })))
      .run();
  }
  if (prepared.steps.length > 0) {
    db.insert(steps)
      .values(prepared.steps.map((row) => ({ ...row, recipeId })))
      .run();
  }
  if (prepared.tags.length > 0) {
    db.insert(tags)
      .values(prepared.tags.map((row) => ({ ...row, recipeId })))
      .run();
  }
}

/** Delete the child rows for a recipe. Caller supplies the transaction. */
function deleteChildren(recipeId: number): void {
  const db = getDb();
  db.delete(ingredientLines).where(eq(ingredientLines.recipeId, recipeId)).run();
  db.delete(steps).where(eq(steps.recipeId, recipeId)).run();
  db.delete(tags).where(eq(tags.recipeId, recipeId)).run();
}

/**
 * Persist a draft. Throws on validation failure (missing title, unknown
 * category). Returns the new recipe id.
 *
 * The caller is responsible for setting isDraft = true; we never publish
 * silently. (`publish: true` is not part of the MVP — see ticket #11.)
 */
export function saveDraft(draft: RecipeDraft): SaveDraftResult {
  const prepared = prepareDraft(draft);
  const now = new Date();
  const baseRecipe: NewRecipe = {
    ...prepared.fields,
    isDraft: true,
    createdAt: now,
    updatedAt: now,
  };

  const sqlite = getRawSqlite();
  let recipeId = 0;
  const run = sqlite.transaction(() => {
    const inserted = getDb()
      .insert(recipes)
      .values(baseRecipe)
      .returning()
      .get();
    if (!inserted) throw new SaveError("insert-failed", "Recipe insert failed.");
    recipeId = inserted.id;
    insertChildren(recipeId, prepared);
  });
  run();

  return { recipeId, isDraft: true };
}

/**
 * Revise an existing recipe in place. Same validation and normalization as
 * saveDraft; replaces title/provenance fields and rewrites all child rows
 * (ingredient lines, steps, tags) inside one transaction. Throws SaveError
 * with code "not-found" when no recipe has that id.
 *
 * The row keeps its id, createdAt, and isDraft flag: an edit revises the
 * stored recipe, it never creates a second one or changes its publish state.
 */
export function updateDraft(id: number, draft: RecipeDraft): SaveDraftResult {
  const prepared = prepareDraft(draft);
  const now = new Date();
  const db = getDb();

  const sqlite = getRawSqlite();
  const run = sqlite.transaction(() => {
    const existing = db
      .select({ id: recipes.id })
      .from(recipes)
      .where(eq(recipes.id, id))
      .get();
    if (!existing) {
      throw new SaveError("not-found", `Recipe #${id} was not found.`);
    }
    db.update(recipes)
      .set({ ...prepared.fields, updatedAt: now })
      .where(eq(recipes.id, id))
      .run();
    // Replace, do not merge: the review screen's state is the whole truth.
    deleteChildren(id);
    insertChildren(id, prepared);
  });
  run();

  return { recipeId: id, isDraft: true };
}

/**
 * Delete a recipe. Child rows are removed by ON DELETE CASCADE and the FTS
 * triggers keep recipe_fts consistent. Returns false when the id did not exist.
 */
export function deleteRecipe(id: number): boolean {
  const deleted = getDb()
    .delete(recipes)
    .where(eq(recipes.id, id))
    .returning({ id: recipes.id })
    .get();
  return deleted !== undefined;
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
      | "insert-failed"
      | "not-found",
    message: string,
  ) {
    super(message);
  }
}
