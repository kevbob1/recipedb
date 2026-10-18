/**
 * Parse-on-write coverage for the quantity columns (#16).
 *
 * saveDraft derives the numeric columns from the qty text; loadDraft hands the
 * stored parse back to the editor. A hand edit of qty in the editor clears the
 * derived fields (see applyQtyEdit), and the next save re-parses — that is the
 * "manual edit resets to unparsed" rule from the decision on #15.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureDataDirs, getRawSqlite } from "../db/client.server";
import { runMigrations } from "../db/migrate.server";
import { clearParsedQuantity, type RecipeDraft } from "./draft";
import { loadDraft, saveDraft } from "./save-draft.server";

let tmpDir: string;
let originalDataDir: string | undefined;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "recipedb-qty-"));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tmpDir;
  delete process.env.RECIPEDB_DB_PATH;
  ensureDataDirs();
  runMigrations();
});

afterAll(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  try {
    getRawSqlite().close();
  } catch {
    // already closed
  }
});

function draftWith(qty: string, unit: string | null): RecipeDraft {
  return {
    title: "Scaling test",
    titleConfidence: "ok",
    category: "other",
    categoryConfidence: "ok",
    yield: null,
    yieldConfidence: "bad",
    tags: [],
    sourceType: "manual",
    sourceUrl: null,
    rawOcrText: null,
    favorite: false,
    ingredients: [
      { text: `${qty} ${unit ?? ""} salt`.trim(), qty, unit, item: "salt", note: null, confidence: "ok" },
    ],
    steps: [],
  };
}

describe("saveDraft — parse on write", () => {
  it("persists the numeric view for a fraction, a range and an unparseable qty", () => {
    const { recipeId } = saveDraft(draftWith("1/2", "cups"));
    const row = getRawSqlite()
      .prepare("SELECT qty, qty_amount, qty_amount2, qty_unit_normalized, qty_parse_status FROM ingredient_lines WHERE recipe_id = ?")
      .get(recipeId) as Record<string, unknown>;
    expect(row).toMatchObject({
      qty: "1/2",
      qty_amount: 0.5,
      qty_amount2: null,
      qty_unit_normalized: "cup",
      qty_parse_status: "parsed",
    });
  });

  it("records a range with both ends and the unit", () => {
    const { recipeId } = saveDraft(draftWith("2-3", "cloves"));
    const row = getRawSqlite()
      .prepare("SELECT qty_amount, qty_amount2, qty_unit_normalized, qty_parse_status FROM ingredient_lines WHERE recipe_id = ?")
      .get(recipeId) as Record<string, unknown>;
    expect(row).toMatchObject({
      qty_amount: 2,
      qty_amount2: 3,
      qty_unit_normalized: "clove",
      qty_parse_status: "range",
    });
  });

  it("marks a word quantity unparseable and keeps the text verbatim", () => {
    const { recipeId } = saveDraft(draftWith("a pinch", null));
    const row = getRawSqlite()
      .prepare("SELECT qty, qty_amount, qty_parse_status FROM ingredient_lines WHERE recipe_id = ?")
      .get(recipeId) as Record<string, unknown>;
    expect(row).toMatchObject({ qty: "a pinch", qty_amount: null, qty_parse_status: "unparseable" });
  });

  it("re-parses a row a hand edit reset to unparsed", () => {
    const draft = draftWith("2", "cups");
    // The editor clears the derived fields when the person types a new qty…
    draft.ingredients[0] = { ...clearParsedQuantity(draft.ingredients[0]!), qty: "3" };
    expect(draft.ingredients[0]!.qtyParseStatus).toBe("unparsed");
    expect(draft.ingredients[0]!.qtyAmount).toBeNull();
    // …and the write path derives fresh numbers from the new text.
    const { recipeId } = saveDraft(draft);
    const row = getRawSqlite()
      .prepare("SELECT qty, qty_amount, qty_parse_status FROM ingredient_lines WHERE recipe_id = ?")
      .get(recipeId) as Record<string, unknown>;
    expect(row).toMatchObject({ qty: "3", qty_amount: 3, qty_parse_status: "parsed" });
  });

  it("trusts an importer parse instead of re-deriving it", () => {
    const draft = draftWith("1½", "tbsp");
    draft.ingredients[0] = {
      ...draft.ingredients[0]!,
      qtyAmount: 1.5,
      qtyAmount2: null,
      qtyUnitNormalized: "tbsp",
      qtyParseStatus: "parsed",
    };
    const { recipeId } = saveDraft(draft);
    const row = getRawSqlite()
      .prepare("SELECT qty, qty_amount, qty_unit_normalized, qty_parse_status FROM ingredient_lines WHERE recipe_id = ?")
      .get(recipeId) as Record<string, unknown>;
    expect(row).toMatchObject({
      qty: "1½",
      qty_amount: 1.5,
      qty_unit_normalized: "tbsp",
      qty_parse_status: "parsed",
    });
  });
});

describe("loadDraft — round-trip", () => {
  it("carries the stored parse back to the editor", () => {
    const { recipeId } = saveDraft(draftWith("2-3", "cloves"));
    const loaded = loadDraft(recipeId);
    expect(loaded).not.toBeNull();
    expect(loaded!.ingredients[0]).toMatchObject({
      qty: "2-3",
      qtyAmount: 2,
      qtyAmount2: 3,
      qtyUnitNormalized: "clove",
      qtyParseStatus: "range",
    });
  });
});
