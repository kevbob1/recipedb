/**
 * Parse-on-write coverage for the quantity columns (#16).
 *
 * saveDraft derives the numeric columns from the qty text; loadDraft hands the
 * stored parse back to the editor. The editor rebuilds a line through
 * `setQty` (app/lib/ingredient-line.ts) whenever qty or unit changes, and the
 * write path re-parses unconditionally — a carried numeric view can never
 * survive a save. That is the "qty truth by construction" rule from the
 * decision on #15.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureDataDirs, getRawSqlite } from "../db/client.server";
import { runMigrations } from "../db/migrate.server";
import type { RecipeDraft } from "./draft";
import { setQty } from "./ingredient-line";
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

function storedRow(recipeId: number): Record<string, unknown> {
  return getRawSqlite()
    .prepare(
      "SELECT qty, qty_amount, qty_amount2, qty_unit_normalized, qty_parse_status FROM ingredient_lines WHERE recipe_id = ?",
    )
    .get(recipeId) as Record<string, unknown>;
}

describe("saveDraft — parse on write", () => {
  it("persists the numeric view for a fraction, a range and an unparseable qty", () => {
    const { recipeId } = saveDraft(draftWith("1/2", "cups"));
    expect(storedRow(recipeId)).toMatchObject({
      qty: "1/2",
      qty_amount: 0.5,
      qty_amount2: null,
      qty_unit_normalized: "cup",
      qty_parse_status: "parsed",
    });
  });

  it("records a range with both ends and the unit", () => {
    const { recipeId } = saveDraft(draftWith("2-3", "cloves"));
    expect(storedRow(recipeId)).toMatchObject({
      qty_amount: 2,
      qty_amount2: 3,
      qty_unit_normalized: "clove",
      qty_parse_status: "range",
    });
  });

  it("marks a word quantity unparseable and keeps the text verbatim", () => {
    const { recipeId } = saveDraft(draftWith("a pinch", null));
    expect(storedRow(recipeId)).toMatchObject({
      qty: "a pinch",
      qty_amount: null,
      qty_parse_status: "unparseable",
    });
  });

  it("re-parses a row whose qty a hand edit replaced", () => {
    const draft = draftWith("2", "cups");
    // The editor rebuilds the line from the new text…
    draft.ingredients[0] = setQty(draft.ingredients[0]!, "3", "cups");
    expect(draft.ingredients[0]!.qtyAmount).toBe(3);
    // …and the write path derives the same numbers again.
    const { recipeId } = saveDraft(draft);
    expect(storedRow(recipeId)).toMatchObject({
      qty: "3",
      qty_amount: 3,
      qty_parse_status: "parsed",
    });
  });

  it("does not let a stale 999 parse survive a save (regression)", () => {
    const draft = draftWith("2", "cups");
    // Crafted row: the text says 2, the carried numeric view claims 999 with a
    // status that the old trust branch would have believed.
    draft.ingredients[0] = {
      ...draft.ingredients[0]!,
      qtyAmount: 999,
      qtyAmount2: 999,
      qtyUnitNormalized: "bogus",
      qtyParseStatus: "parsed",
    };
    const { recipeId } = saveDraft(draft);
    expect(storedRow(recipeId)).toMatchObject({
      qty: "2",
      qty_amount: 2,
      qty_amount2: null,
      qty_unit_normalized: "cup",
      qty_parse_status: "parsed",
    });
  });

  it("clears stale numbers when the unit is edited", () => {
    const draft = draftWith("1½", "cups");
    draft.ingredients[0] = {
      ...draft.ingredients[0]!,
      qtyAmount: 999,
      qtyAmount2: 999,
      qtyUnitNormalized: "cup",
      qtyParseStatus: "parsed",
    };
    // Only the unit changes; the derived view must be rebuilt from (qty, unit).
    draft.ingredients[0] = setQty(draft.ingredients[0]!, draft.ingredients[0]!.qty, "tbsp");
    expect(draft.ingredients[0]!.qtyAmount).toBe(1.5);
    expect(draft.ingredients[0]!.qtyUnitNormalized).toBe("tbsp");
    const { recipeId } = saveDraft(draft);
    expect(storedRow(recipeId)).toMatchObject({
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
