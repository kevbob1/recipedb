import { isStagedPath, retainedName } from "./scan/image-path";

/**
 * Draft persistence seam — the one place that converts between the review
 * screen's editable RecipeDraft and the relational rows.
 *
 * Everything below the review UI goes through `executeSave`, the one command
 * entry that owns every save decision (new / revise / delete), plus
 * `loadDraft` and `deleteRecipe`. Routes and transports hand over a
 * SaveCommand; they never map fields onto columns themselves.
 *
 * `executeSave` is a thin sequencer over app/lib/save-command.ts, which holds
 * the pure half of the seam: payload decoding, field validation, and the
 * SaveCommand -> ValidatedSaveCommand step. This module adds the transactions
 * and the capture lifecycle.
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
import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { getDb, getImagesDir, getRawSqlite } from "../db/client.server";
import {
  ingredientLines,
  ocrTrainingSamples,
  recipePages,
  recipes,
  steps,
  tags,
  type NewIngredientLine,
  type NewRecipe,
  type NewRecipePage,
} from "../db/schema.server";
import {
  type DraftIngredient,
  type RecipeDraft,
  ingredientConfidence,
  optionalFieldConfidence,
  requiredFieldConfidence,
} from "./draft";
import {
  SaveError,
  validateSaveCommand,
  type PersistedDraft,
  type SaveCommand,
  type SavePageFile,
} from "./save-command";
import {
  ScanImageError,
  attachImageFilename,
  deleteRecipeImage,
  saveOriginalScanImage,
  savePageScanImage,
  saveSourcePdf,
  validatePdfUpload,
  validateScanUpload,
} from "./scan/index.server";

// The pure half of the seam lives in ./save-command (payload decode + field
// validation + the command union); re-exported here so existing callers keep
// importing the store as their single entry point.
export { SaveError, decodeDraftPayload, prepareDraft } from "./save-command";
export type {
  PersistedDraft,
  SaveCommand,
  ValidatedSaveCommand,
} from "./save-command";

export interface SaveDraftResult {
  recipeId: number;
  isDraft: true;
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
  // Pages round-trip as page-order DraftPage rows; absent when there are
  // none so single-image drafts look exactly as they did before (ADR-0004).
  if (persisted.pages && persisted.pages.length > 0) {
    draft.pages = [...persisted.pages]
      .sort((a, b) => a.pageNo - b.pageNo)
      .map((row) => ({
        pageNo: row.pageNo,
        imageFilename: row.imageFilename ?? null,
        text: row.rawOcrText ?? "",
      }));
  }
  if (raw !== undefined) draft.raw = raw;
  return draft;
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
  if (prepared.pages && prepared.pages.length > 0) {
    db.insert(recipePages)
      .values(prepared.pages.map((row) => ({ ...row, recipeId })))
      .run();
  }
}

/**
 * OCR training capture (ADR-0004): one sample per persisted page.
 *
 * The raw side is write-once — the text as first persisted for that page,
 * which is the engine's output for an auto-saved import — and survives
 * revisions; the corrected side is the page text at THIS save. `accepted`
 * marks a review acceptance (a revise: the review screen is the only caller),
 * which is when a human has had the text in front of them.
 *
 * Runs inside the caller's transaction. Rows are deleted-then-rewritten per
 * recipe, so pages removed in a revise leave no strays, and deleting the
 * recipe cascades (the samples are provenance, never standalone). Nothing
 * trains off these rows here — export is offline, training never runs in the
 * container.
 */
function captureTrainingSamples(
  recipeId: number,
  pages: Omit<NewRecipePage, "recipeId">[],
  accepted: boolean,
  acceptedAt?: Date,
): void {
  if (pages.length === 0) return;
  const db = getDb();
  const existing = db
    .select({
      pageNo: ocrTrainingSamples.pageNo,
      rawOcrText: ocrTrainingSamples.rawOcrText,
    })
    .from(ocrTrainingSamples)
    .where(eq(ocrTrainingSamples.recipeId, recipeId))
    .all();
  const rawByPageNo = new Map(
    existing.map((row) => [row.pageNo, row.rawOcrText]),
  );
  db.delete(ocrTrainingSamples)
    .where(eq(ocrTrainingSamples.recipeId, recipeId))
    .run();
  db.insert(ocrTrainingSamples)
    .values(
      pages.map((page) => ({
        recipeId,
        pageNo: page.pageNo,
        imageFilename: page.imageFilename,
        rawOcrText: rawByPageNo.get(page.pageNo) ?? page.rawOcrText ?? "",
        correctedText: page.rawOcrText ?? "",
        acceptedAt: accepted ? acceptedAt ?? new Date() : null,
      })),
    )
    .run();
}

/** Delete the child rows for a recipe. Caller supplies the transaction. */
function deleteChildren(recipeId: number): void {
  const db = getDb();
  db.delete(ingredientLines).where(eq(ingredientLines.recipeId, recipeId)).run();
  db.delete(steps).where(eq(steps.recipeId, recipeId)).run();
  db.delete(tags).where(eq(tags.recipeId, recipeId)).run();
  db.delete(recipePages).where(eq(recipePages.recipeId, recipeId)).run();
}

/** Result of a dispatched save command. */
export type SaveResult = SaveDraftResult | DeleteDraftResult;

/**
 * The store's single entry point: validate the command, then sequence storage.
 *
 * Every validity decision — payload decode, field checks, recipe-id checks —
 * belongs to `validateSaveCommand` in ./save-command. This function only
 * chooses the storage path, so no transport can re-open a decision by shaping
 * its own arguments (candidate #1).
 */
export function executeSave(command: SaveCommand): SaveResult {
  const validated = validateSaveCommand(command);
  switch (validated.kind) {
    case "new":
      return insertNewRecipe(
        validated.prepared,
        validated.imageBytes,
        validated.pageFiles,
        validated.pdfBytes,
      );
    case "revise":
      return reviseDraft(validated.recipeId, validated.prepared);
    case "delete":
      return removeRecipe(validated.recipeId);
  }
}

/** Narrow a dispatched result to one that left a draft in storage. */
function savedDraft(result: SaveResult): SaveDraftResult {
  if ("deleted" in result) {
    throw new SaveError(
      "insert-failed",
      "A save that stores a draft cannot also delete it.",
    );
  }
  return result;
}

/**
 * Persist an ALREADY-VALIDATED new recipe, optionally attaching the original
 * scan capture.
 *
 * The capture is part of the same unit of work as the recipe: bytes are
 * validated before any write, then written and linked inside the transaction.
 * A capture that cannot be stored rolls the recipe back and cleans up the
 * directory it may have created, so no caller ever has to sequence "insert,
 * then attach, then maybe delete the leftover".
 *
 * The caller is responsible for setting isDraft = true; we never publish
 * silently. (`publish: true` is not part of the MVP — see ticket #11.)
 */
function insertNewRecipe(
  prepared: PersistedDraft,
  imageBytes: Buffer | null,
  pageFiles: SavePageFile[] = [],
  pdfBytes: Buffer | null = null,
): SaveDraftResult {
  // Validate before touching storage: a bad capture cannot create a recipe.
  if (imageBytes) validateScanUpload(imageBytes);
  for (const page of pageFiles) validateScanUpload(page.bytes);
  if (pdfBytes) validatePdfUpload(pdfBytes);

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

    // URL-import images are staged before the recipe id exists. Move them into
    // the recipe directory now so every retained image is recipe-scoped.
    const stagedImage = prepared.fields.imageFilename;
    let importedImageFilename: string | null = null;
    if (stagedImage && isStagedPath(stagedImage)) {
      importedImageFilename = retainedName(recipeId, "webp");
      const imagesDir = getImagesDir();
      const recipeDir = path.join(imagesDir, String(recipeId));
      try {
        fs.mkdirSync(recipeDir, { recursive: true });
        fs.renameSync(
          path.join(imagesDir, stagedImage),
          path.join(imagesDir, importedImageFilename),
        );
      } catch (err) {
        throw new ScanImageError(
          "image-write-failed",
          `Could not store the imported image: ${(err as Error).message}`,
        );
      }
    }

    // Retained bytes (ADR-0004): the original capture, one raster per page,
    // and the untouched source PDF. Filenames are decided here — pages by
    // their number, the capture as original.<ext> — so no transport can.
    const originalFilename = imageBytes
      ? saveOriginalScanImage(recipeId, imageBytes)
      : importedImageFilename;
    const pageFilenameByNo = new Map<number, string>();
    for (const page of pageFiles) {
      pageFilenameByNo.set(
        page.pageNo,
        savePageScanImage(recipeId, page.pageNo, page.bytes),
      );
    }
    if (pdfBytes) saveSourcePdf(recipeId, pdfBytes);

    // Page rows: an uploaded raster wins; else the draft's own filename
    // round-trips (existing tests pin this); else the capture (the camera
    // flow's single page row).
    const pages = (prepared.pages ?? []).map((row) => ({
      ...row,
      imageFilename:
        pageFilenameByNo.get(row.pageNo) ??
        row.imageFilename ??
        originalFilename,
    }));
    insertChildren(recipeId, pages ? { ...prepared, pages } : prepared);
    captureTrainingSamples(recipeId, pages ?? [], false);

    // The recipe cover points at page 1 when there are page rasters, else at
    // the original capture.
    const cover =
      pageFilenameByNo.get(1) ??
      (prepared.pages?.length
        ? (prepared.pages.find((p) => p.pageNo === 1)?.imageFilename ??
          originalFilename)
        : originalFilename);
    if (cover) attachImageFilename(recipeId, cover);
  });

  try {
    run();
  } catch (err) {
    // The transaction rolled the row back; remove any capture directory the
    // failed attach managed to create before the error surfaced (#28).
    if (recipeId !== 0 && err instanceof ScanImageError) deleteRecipeImage(recipeId);
    throw err;
  }

  return { recipeId, isDraft: true };
}

/** Back-compat wrapper for the new-draft path. Prefer executeSave. */
export function saveNewDraft(
  draft: RecipeDraft,
  imageBytes?: Buffer | null,
): SaveDraftResult {
  return savedDraft(
    executeSave({ kind: "new", draft, imageBytes: imageBytes ?? null }),
  );
}

/** Back-compat alias for the no-image save path. Prefer saveNewDraft. */
export function saveDraft(draft: RecipeDraft): SaveDraftResult {
  return saveNewDraft(draft);
}

/** Options for saving over an existing recipe. */
export interface SaveExistingDraftOptions {
  /**
   * The review screen's delete intent: remove the stored recipe (and its
   * capture) instead of revising it.
   */
  delete?: boolean;
}

/** Result of an existing-recipe save that removed the row. */
export interface DeleteDraftResult {
  recipeId: number;
  deleted: true;
}

/**
 * Back-compat wrapper for the review screen's existing-recipe path. Prefer
 * executeSave({ kind: "revise" | "delete", ... }).
 *
 * `delete: true` removes the row (child rows via CASCADE, capture via the Scan
 * module) and returns `{ deleted: true }`; `draft` is ignored in that case.
 * Otherwise the draft is validated and written exactly like a new save.
 */
export function saveExistingDraft(
  id: number,
  draft: RecipeDraft | null,
  opts: SaveExistingDraftOptions = {},
): SaveDraftResult | DeleteDraftResult {
  if (opts.delete) return executeSave({ kind: "delete", recipeId: id });
  // A null draft is rejected by validateSaveCommand (bad-draft); the wrapper
  // adds no rule of its own.
  return executeSave({ kind: "revise", recipeId: id, draft });
}

/** Back-compat alias for the revise path. Prefer saveExistingDraft. */
export function updateDraft(id: number, draft: RecipeDraft): SaveDraftResult {
  return savedDraft(executeSave({ kind: "revise", recipeId: id, draft }));
}

/**
 * Backfill-only revise path. The caller owns the surrounding transaction and
 * deletes old training samples first so the fresh OCR becomes the immutable
 * raw text. Normal review continues to preserve its original raw text.
 */
export function updateDraftFromBackfill(
  id: number,
  draft: RecipeDraft,
  acceptedAt: Date,
): SaveDraftResult {
  const validated = validateSaveCommand({ kind: "revise", recipeId: id, draft });
  if (validated.kind !== "revise") {
    throw new SaveError("bad-draft", "Expected a revise command.");
  }
  return reviseDraft(id, validated.prepared, acceptedAt);
}

/** Remove an already-validated recipe id. */
function removeRecipe(recipeId: number): DeleteDraftResult {
  if (!deleteRecipe(recipeId)) {
    throw new SaveError("not-found", `Recipe #${recipeId} was not found.`);
  }
  return { recipeId, deleted: true };
}

/**
 * Revise an ALREADY-VALIDATED recipe in place. Replaces title/provenance
 * fields and rewrites all child rows (ingredient lines, steps, tags) inside one
 * transaction. Throws SaveError with code "not-found" when no recipe has that
 * id.
 */
function reviseDraft(
  id: number,
  prepared: PersistedDraft,
  acceptedAt?: Date,
): SaveDraftResult {
  const now = acceptedAt ?? new Date();
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
    captureTrainingSamples(id, prepared.pages ?? [], true, acceptedAt);
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
export function loadDraft(id: number): RecipeDraft | null {  const db = getDb();
  const recipe = db.select().from(recipes).where(eq(recipes.id, id)).get();
  if (!recipe) return null;
  const ings = db
    .select()
    .from(ingredientLines)
    .where(eq(ingredientLines.recipeId, id))
    .all();
  const sts = db.select().from(steps).where(eq(steps.recipeId, id)).all();
  const tgs = db.select().from(tags).where(eq(tags.recipeId, id)).all();
  const pgs = db
    .select()
    .from(recipePages)
    .where(eq(recipePages.recipeId, id))
    .all();

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
    pages: pgs.map((row) => ({
      pageNo: row.pageNo,
      imageFilename: row.imageFilename,
      rawOcrText: row.rawOcrText,
    })),
  });
}
