/**
 * saveDraft + loadDraft end-to-end test against a real better-sqlite3
 * database using the FTS5 migration. Confirms:
 *   - a URL-derived draft round-trips through the storage layer
 *   - the review screen's qty / unit / item / note edit pattern lands as
 *     a four-part ingredient row (GLOSSARY.md)
 *   - a scan-derived draft keeps the raw OCR text but no source URL
 *   - loadDraft produces an editable RecipeDraft for the review screen
 *   - saving with no title throws
 *   - saving with an unknown category throws (CHECK constraint)
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { runMigrations } from "../db/migrate.server";
import { ensureDataDirs, getDb, getRawSqlite } from "../db/client.server";
import { recipes, ingredientLines, steps, tags } from "../db/schema.server";
import { blankDraft, type RecipeDraft } from "./draft";
import { loadDraft, saveDraft, SaveError } from "./save-draft.server";

let tmpDir: string;
let originalDataDir: string | undefined;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "recipedb-save-"));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tmpDir;
  ensureDataDirs();
  runMigrations();
});

afterAll(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  getRawSqlite().close();
});

function urlDraft(): RecipeDraft {
  return {
    ...blankDraft(),
    title: "  Big Stew  ",
    titleConfidence: "ok",
    category: "soup",
    categoryConfidence: "ok",
    yield: "4 servings",
    yieldConfidence: "ok",
    tags: ["beef", "stew", "Beef"],
    sourceType: "url",
    sourceUrl: "https://example.com/stew",
    ingredients: [
      { text: "1 lb beef chuck", qty: "1 lb", unit: "lb", item: "beef chuck", note: "cut into cubes", confidence: "ok" },
      { text: "2 onions", qty: "2", unit: null, item: "onions", note: null, confidence: "ok" },
    ],
    steps: [
      { position: 1, text: "Brown the beef." },
      { position: 2, text: "Add the onions." },
    ],
  };
}

function scanDraft(): RecipeDraft {
  return {
    ...blankDraft(),
    title: "Handwritten Cookies",
    titleConfidence: "warn",
    category: "cookies",
    categoryConfidence: "ok",
    sourceType: "scan",
    sourceUrl: null,
    rawOcrText: "1 cup flour\n2 eggs\n1. Mix.\n2. Bake.",
    ingredients: [
      { text: "1 cup flour", qty: "1 cup", unit: "cup", item: "flour", note: null, confidence: "ok" },
      { text: "2 eggs", qty: "2", unit: null, item: "eggs", note: null, confidence: "ok" },
    ],
    steps: [
      { position: 1, text: "Mix." },
      { position: 2, text: "Bake." },
    ],
  };
}

describe("saveDraft", () => {
  it("round-trips a URL-derived draft through the storage layer", () => {
    const { recipeId } = saveDraft(urlDraft());
    const db = getDb();
    const row = db.select().from(recipes).where(eq(recipes.id, recipeId)).get();
    expect(row).toBeDefined();
    expect(row!.title).toBe("Big Stew"); // trim-only
    expect(row!.sourceType).toBe("url");
    expect(row!.sourceUrl).toBe("https://example.com/stew");
    expect(row!.isDraft).toBe(true);

    const ings = db.select().from(ingredientLines).where(eq(ingredientLines.recipeId, recipeId)).all();
    expect(ings.length).toBe(2);
    expect(ings[0]!.qty).toBe("1 lb");
    expect(ings[0]!.unit).toBe("lb");
    expect(ings[0]!.item).toBe("beef chuck");
    expect(ings[0]!.note).toBe("cut into cubes");

    const sts = db.select().from(steps).where(eq(steps.recipeId, recipeId)).all();
    expect(sts.length).toBe(2);

    const tgs = db.select().from(tags).where(eq(tags.recipeId, recipeId)).all();
    // duplicate "beef"/"Beef" must collapse to one row
    expect(tgs.length).toBe(2);
    const labels = tgs.map((t) => t.label).sort();
    expect(labels).toEqual(["beef", "stew"]);
  });

  it("round-trips a scan draft, keeping raw OCR text but no source URL", () => {
    const { recipeId } = saveDraft(scanDraft());
    const db = getDb();
    const row = db.select().from(recipes).where(eq(recipes.id, recipeId)).get();
    expect(row).toBeDefined();
    expect(row!.sourceType).toBe("scan");
    expect(row!.sourceUrl).toBeNull();
    expect(row!.rawOcrText).toContain("1 cup flour");
  });

  it("loadDraft returns an editable RecipeDraft for the review screen", () => {
    const { recipeId } = saveDraft(urlDraft());
    const loaded = loadDraft(recipeId);
    expect(loaded).not.toBeNull();
    expect(loaded!.title).toBe("Big Stew");
    expect(loaded!.ingredients.length).toBe(2);
    expect(loaded!.ingredients[0]!.qty).toBe("1 lb");
    expect(loaded!.steps.length).toBe(2);
  });

  it("rejects an empty title", () => {
    expect(() => saveDraft({ ...blankDraft() })).toThrowError(SaveError);
  });

  it("rejects a category outside the MVP fixed list", () => {
    expect(() =>
      saveDraft({
        ...blankDraft(),
        title: "X",
        // @ts-expect-error testing the runtime guard
        category: "fusion",
      }),
    ).toThrowError(SaveError);
  });
});
