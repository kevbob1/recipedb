/**
 * Save command — the store's single input shape, and the only place a save is
 * validated.
 *
 * Pure by construction: no Request/FormData, no SQLite, no image I/O. The
 * transport adapter (save-draft-http.server.ts) turns bytes into a raw
 * SaveCommand carrying the wire draft untouched; the store
 * (draft-store.server.ts) executes it. Decoding the payload and checking the
 * fields happen in `validateSaveCommand` here, so the decisions can be tested
 * without a server, a request, or a database (candidate #1).
 *
 * Layering rule: this module must never import the store, the db client, or
 * the scan module. `SaveError` lives here because both the validator and the
 * store throw it; draft-store.server.ts re-exports it for existing callers.
 */
import type { NewIngredientLine, NewStep } from "../db/schema.server";
import { CATEGORIES, type Category } from "./categories";
import type { RecipeDraft } from "./draft";
import { fromText } from "./ingredient-line";
import { normalizeTag, trimOnly, trimOnlyRequired } from "./normalize";

export class SaveError extends Error {
  constructor(
    public code:
      | "title-required"
      | "invalid-category"
      | "insert-failed"
      | "not-found"
      | "bad-draft"
      | "bad-recipe-id"
      | "bad-json",
    message: string,
  ) {
    super(message);
  }
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
 * Decode a draft payload from the wire so no caller has to cast by hand.
 * Accepts JSON text or an already-parsed value (JSON bodies). Throws
 * SaveError("bad-json") for text that is not JSON and
 * SaveError("bad-draft") for anything that is not an object.
 */
export function decodeDraftPayload(payload: unknown): RecipeDraft {
  let parsed: unknown = payload;
  if (typeof payload === "string") {
    try {
      parsed = JSON.parse(payload) as unknown;
    } catch {
      throw new SaveError("bad-json", "Draft payload is not valid JSON.");
    }
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SaveError("bad-draft", "Draft payload must be a JSON object.");
  }
  return parsed as RecipeDraft;
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

/**
 * What a save request asks the store to do. `draft` is the RAW wire value (a
 * JSON string from multipart, an already-parsed object from JSON bodies), not
 * a decoded draft: decoding is a validity decision and belongs to
 * `validateSaveCommand`.
 */
export type SaveCommand =
  | { kind: "new"; draft: unknown; imageBytes?: Buffer | null }
  | { kind: "revise"; recipeId: number; draft: unknown }
  | { kind: "delete"; recipeId: number };

/**
 * A command whose validity has been settled: the draft is decoded, normalized,
 * and reduced to its persisted half, and the id (where required) is checked.
 * The store only has to sequence storage from here.
 */
export type ValidatedSaveCommand =
  | { kind: "new"; prepared: PersistedDraft; imageBytes: Buffer | null }
  | { kind: "revise"; recipeId: number; prepared: PersistedDraft }
  | { kind: "delete"; recipeId: number };

function requireRecipeId(value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new SaveError(
      "bad-recipe-id",
      `Recipe id must be a positive integer (got ${String(value)}).`,
    );
  }
  return value;
}

function validateDraft(payload: unknown): PersistedDraft {
  if (payload === null || payload === undefined) {
    throw new SaveError("bad-draft", "A draft is required to save a recipe.");
  }
  return prepareDraft(decodeDraftPayload(payload));
}

/**
 * The pure validation step: SaveCommand -> ValidatedSaveCommand.
 *
 * Every reason a save can be rejected for its input is decided here — unknown
 * kind, bad recipe id, missing draft, unparseable payload, missing title,
 * unknown category. No I/O happens, so these rules are unit-testable on their
 * own.
 */
export function validateSaveCommand(command: SaveCommand): ValidatedSaveCommand {
  switch (command.kind) {
    case "new":
      return {
        kind: "new",
        prepared: validateDraft(command.draft),
        imageBytes: command.imageBytes ?? null,
      };
    case "revise":
      return {
        kind: "revise",
        recipeId: requireRecipeId(command.recipeId),
        prepared: validateDraft(command.draft),
      };
    case "delete":
      return { kind: "delete", recipeId: requireRecipeId(command.recipeId) };
    default: {
      // Compile-time exhaustive; reachable only from untyped callers.
      const unknown = command as { kind?: unknown };
      throw new SaveError(
        "bad-draft",
        `Unknown save command "${String(unknown.kind)}".`,
      );
    }
  }
}
