/**
 * Draft persistence seam — the one place that converts between the review
 * screen's editable RecipeDraft and the relational rows.
 *
 * Everything below the review UI goes through here: `prepareDraft` (validate
 * + normalize + derive the numeric view), `saveDraft`, `updateDraft`,
 * `loadDraft`, `deleteRecipe`. Routes and transports hand over a draft; they
 * never map fields onto columns themselves.
 *
 * Domain source of truth: ../GLOSSARY.md
 *  - Recipe: a single stored dish, one import or manual entry. No merge.
 *  - Draft: every import lands here awaiting review. Saving keeps isDraft=true
 *    until a person explicitly publishes it (out of MVP scope; see #11).
 *  - qty: TEXT so fractions, ranges, and words round-trip verbatim. The
 *    numeric view (qty_amount/qty_amount2/qty_unit_normalized/qty_parse_status)
 *    is derived on write by app/lib/ingredient-line.ts; qty itself is never
 *    rewritten. See the decision on #15.
 *
 * Two halves, split by what storage can actually hold (#2):
 *  - PersistedDraft: the columns we own, validated and normalized. This is the
 *    only thing that touches SQL.
 *  - Transient review state: per-field/per-line confidence and the `raw`
 *    drawer blob. Never written, always re-derived from the persisted text via
 *    the shared helpers in app/lib/draft.ts, so the importer and the read path
 *    cannot disagree about what needs eyes.
 *
 * Note on rawOcrText: it looks like editing state, but it is provenance — a
 * real column (recipes.raw_ocr_text) that re-OCR and the review drawer depend
 * on. It therefore lives in the persisted half, not the transient one.
 *
 * Scope (#2): this slice is persistence only. The URL / OCR / manual
 * constructors stay where they are (ADR-0001 deferred), and imageFilename
 * lifecycle stays with the Scan module for now.
 */
import { eq } from "drizzle-orm";
import { getDb, getRawSqlite } from "../db/client.server";
import {
  ingredientLines,
  recipes,
  steps,
  tags,
  type NewIngredientLine,
  type NewRecipe,
  type NewStep,
} from "../db/schema.server";
import { CATEGORIES, type Category } from "./categories";
import {
  type Confidence,
  type DraftIngredient,
  type RecipeDraft,
  ingredientConfidence,
  optionalFieldConfidence,
  requiredFieldConfidence,
} from "./draft";
import { normalizeTag, trimOnly, trimOnlyRequired } from "./normalize";
import { fromText } from "./ingredient-line";
import { deleteRecipeImage } from "./scan/index.server";

export interface SaveDraftResult {
  recipeId: number;
  isDraft: true;
}

/**
 * The persisted half of a draft: DB-ready recipe columns plus child rows.
 * Deliberately carries no confidence and no `raw` — preparing a draft is
 * exactly the act of dropping transient review state.
 */
export interface PersistedDraft {
  fields: {
    title: string;
    category: Category;
    yield: string | null;
    favorite: boolean;
    sourceType: RecipeDraft["sourceType"];
    sourceUrl: string | null;
    rawOcrText: string | null;
    imageFilename: string | null;
  };
  ingredients: Omit<NewIngredientLine, "recipeId">[];
  steps: Omit<NewStep, "recipeId">[];
  tags: string[];
}

/**
 * Validate + normalize a draft exactly once, for both insert and update.
 * Ignores every incoming confidence badge: those are derived, not stored.
 * Throws SaveError on a missing title, an unknown category, or a malformed
 * payload.
 */
export function prepareDraft(draft: RecipeDraft): PersistedDraft {
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

  // Positions are assigned after the empty-line filter, so a draft that loses
  // a middle line on its first save does not leave a positional gap that the
  // next save would close (prepareDraft must be a fixed point — #2).
  const ingredients: Omit<NewIngredientLine, "recipeId">[] = draft.ingredients
    .map((ing) => {
      const qty = trimOnlyRequired(ing.qty);
      const unit = trimOnly(ing.unit);
      // Parse-on-write, always from the text. Any `qty*` fields carried on the
      // draft are ignored: the numeric columns are derived here, so a stale or
      // crafted parse (e.g. amount 999 with status `parsed`) can never survive
      // a save. See the decision on #15.
      const parsed = fromText(qty, unit);
      return {
        qty,
        unit,
        item: trimOnlyRequired(ing.item || ing.text),
        note: trimOnly(ing.note),
        position: 0,
        qtyAmount: parsed.qtyAmount,
        qtyAmount2: parsed.qtyAmount2,
        qtyUnitNormalized: parsed.qtyUnitNormalized,
        qtyParseStatus: parsed.qtyParseStatus,
      };
    })
    .filter((row) => row.item.length > 0)
    .map((row, i) => ({ ...row, position: i + 1 }));

  const steps: Omit<NewStep, "recipeId">[] = draft.steps
    .map((s) => ({
      position: 0,
      text: trimOnlyRequired(s.text),
    }))
    .filter((row) => row.text.length > 0)
    .map((row, i) => ({ ...row, position: i + 1 }));

  const tagLabels = (() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const t of draft.tags) {
      const label = normalizeTag(t);
      if (!label || seen.has(label)) continue;
      seen.add(label);
      out.push(label);
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
      imageFilename: trimOnly(draft.imageFilename),
    },
    ingredients,
    steps,
    tags: tagLabels,
  };
}

/** Rebuild one editable ingredient line from its stored parts. */
function draftIngredientFromRow(
  row: Omit<NewIngredientLine, "recipeId">,
): DraftIngredient {
  const base: DraftIngredient = {
    text: [row.qty, row.unit, row.item, row.note]
      .filter(Boolean)
      .join(" ")
      .trim(),
    qty: row.qty,
    unit: row.unit ?? null,
    item: row.item,
    note: row.note ?? null,
    confidence: "ok",
  };
  return { ...base, confidence: ingredientConfidence(base) };
}

/**
 * The read half of the seam: turn persisted rows back into an editable draft,
 * deriving every confidence badge from the persisted text with the same
 * helpers the importer uses. This is the only place a loaded badge is decided.
 */
export function composeDraft(
  persisted: PersistedDraft,
  raw?: string,
): RecipeDraft {
  const draft: RecipeDraft = {
    title: persisted.fields.title,
    titleConfidence: requiredFieldConfidence(persisted.fields.title),
    category: persisted.fields.category,
    categoryConfidence: requiredFieldConfidence(persisted.fields.category),
    yield: persisted.fields.yield,
    yieldConfidence: optionalFieldConfidence(persisted.fields.yield),
    tags: [...persisted.tags],
    sourceType: persisted.fields.sourceType,
    sourceUrl: persisted.fields.sourceUrl,
    rawOcrText: persisted.fields.rawOcrText,
    imageFilename: persisted.fields.imageFilename,
    favorite: persisted.fields.favorite,
    ingredients: [...persisted.ingredients]
      .sort((a, b) => a.position - b.position)
      .map(draftIngredientFromRow),
    steps: [...persisted.steps]
      .sort((a, b) => a.position - b.position)
      .map((row) => ({ position: row.position, text: row.text })),
  };
  if (raw !== undefined) draft.raw = raw;
  return draft;
}

/**
 * Decode a draft payload from the wire so no caller has to cast by hand.
 * Accepts JSON text or an already-parsed value (JSON bodies). Throws
 * SaveError("bad-draft") for anything that is not an object.
 */
export function decodeDraftPayload(payload: string | unknown): RecipeDraft {
  const parsed =
    typeof payload === "string" ? (JSON.parse(payload) as unknown) : payload;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SaveError("bad-draft", "Draft payload must be a JSON object.");
  }
  return parsed as RecipeDraft;
}

/** Insert the child rows for a recipe. Caller supplies the transaction. */
function insertChildren(recipeId: number, prepared: PersistedDraft): void {
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
      .values(prepared.tags.map((label) => ({ label, recipeId })))
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
 * triggers keep recipe_fts consistent. The retained scan capture under
 * DATA_DIR/images/<id>/ is removed too — a stored image lives only as long as
 * its recipe (#28). Returns false when the id did not exist.
 */
export function deleteRecipe(id: number): boolean {
  const deleted = getDb()
    .delete(recipes)
    .where(eq(recipes.id, id))
    .returning({ id: recipes.id })
    .get();
  if (!deleted) return false;
  deleteRecipeImage(id);
  return true;
}

/**
 * Re-read a draft from the DB by id. Used by the review screen to load an
 * existing draft for further editing before publish.
 *
 * Confidence is not read from storage (it is not there): composeDraft derives
 * it from the persisted text, so a reload always agrees with the importer's
 * rules.
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

  return composeDraft({
    fields: {
      title: recipe.title,
      category: recipe.category,
      yield: recipe.yield,
      favorite: recipe.favorite,
      sourceType: recipe.sourceType,
      sourceUrl: recipe.sourceUrl,
      rawOcrText: recipe.rawOcrText,
      imageFilename: recipe.imageFilename,
    },
    ingredients: ings.map((row) => ({
      qty: row.qty,
      unit: row.unit,
      item: row.item,
      note: row.note,
      position: row.position,
      qtyAmount: row.qtyAmount,
      qtyAmount2: row.qtyAmount2,
      qtyUnitNormalized: row.qtyUnitNormalized,
      qtyParseStatus: row.qtyParseStatus,
    })),
    steps: sts.map((row) => ({ position: row.position, text: row.text })),
    tags: tgs.map((row) => row.label),
  });
}

export class SaveError extends Error {
  constructor(
    public code:
      | "title-required"
      | "invalid-category"
      | "insert-failed"
      | "not-found"
      | "bad-draft",
    message: string,
  ) {
    super(message);
  }
}
