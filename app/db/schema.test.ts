/**
 * Schema unit tests.
 *
 * The MVP rule from GLOSSARY.md: ingredient-line qty is a STRING that must
 * round-trip fractions, ranges, and words without numeric coercion. This test
 * inserts a row through the Drizzle schema and reads the raw value back to
 * confirm there is no silent parsing happening.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { runMigrations } from "./migrate.server";
import { ensureDataDirs, getDb, getRawSqlite } from "./client.server";
import {
  CATEGORIES,
  ingredientLines,
  recipes,
  type NewRecipe,
} from "./schema.server";

let tmpDir: string;
let originalDataDir: string | undefined;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "recipedb-test-"));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tmpDir;
  ensureDataDirs();
  runMigrations();
});

afterAll(() => {
  if (originalDataDir === undefined) {
    delete process.env.DATA_DIR;
  } else {
    process.env.DATA_DIR = originalDataDir;
  }
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  getRawSqlite().close();
});

describe("ingredient line qty preservation", () => {
  it("CATEGORIES is exactly the MVP fixed list", () => {
    expect([...CATEGORIES]).toEqual([
      "one-dish",
      "soup",
      "salad",
      "bread",
      "dessert",
      "cookies",
      "cake",
      "pie",
      "other",
    ]);
  });

  it("round-trips qty strings verbatim (fractions, ranges, words)", () => {
    const db = getDb();
    const now = Date.now();
    const baseRecipe: NewRecipe = {
      title: "Test recipe",
      isDraft: true,
      category: "soup",
      favorite: false,
      sourceType: "manual",
      createdAt: new Date(now),
      updatedAt: new Date(now),
    };
    const [recipe] = db.insert(recipes).values(baseRecipe).returning().all();
    expect(recipe).toBeDefined();

    const cases = [
      "2-3 cloves", // range
      "1/2", // fraction
      "a pinch", // words
      "1 1/2 cups", // mixed
      "0.5", // looks numeric; still a string
      "1½", // unicode fraction
      "", // empty allowed at column level (line is still required to have item)
    ];
    for (const [i, qty] of cases.entries()) {
      const inserted = db
        .insert(ingredientLines)
        .values({
          recipeId: recipe!.id,
          qty,
          unit: null,
          item: "garlic",
          note: null,
          position: i + 1,
        })
        .returning()
        .get();
      expect(inserted, `insert returned row for qty=${qty}`).toBeDefined();
      expect(inserted!.qty).toBe(qty);

      const fetched = db
        .select()
        .from(ingredientLines)
        .where(eq(ingredientLines.id, inserted!.id))
        .get();
      expect(fetched).toBeDefined();
      expect(fetched!.qty).toBe(qty);
    }

    // Raw column type check: SQLite must store qty as TEXT, not INTEGER/REAL.
    const rawRows = getRawSqlite()
      .prepare(
        "SELECT qty, typeof(qty) AS t FROM ingredient_lines WHERE recipe_id = ?",
      )
      .all(recipe!.id) as Array<{ qty: unknown; t: string }>;
    expect(rawRows.length).toBe(cases.length);
    for (const row of rawRows) {
      expect(row.t).toBe("text");
    }
  });

  it("rejects categories outside the fixed list via CHECK constraint", () => {
    const db = getDb();
    const now = Date.now();
    expect(() =>
      db
        .insert(recipes)
        .values({
          title: "Bad category",
          isDraft: true,
          // Cast bypass: this MUST fail at the SQL layer.
          category: "nope" as unknown as (typeof CATEGORIES)[number],
          favorite: false,
          sourceType: "manual",
          createdAt: new Date(now),
          updatedAt: new Date(now),
        })
        .run(),
    ).toThrow();
  });
});
