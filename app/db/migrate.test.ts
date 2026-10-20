/**
 * Migration + FTS5 smoke test.
 *
 * Verifies:
 *  - the migration runner applies a fresh journal;
 *  - the FTS5 virtual table exists and is queryable;
 *  - the FTS5 index picks up content from the relational tables via triggers.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runMigrations } from "./migrate.server";
import { ensureDataDirs, getDb, getRawSqlite } from "./client.server";
import {
  ingredientLines,
  recipes,
  steps,
  tags,
  type NewRecipe,
} from "./schema.server";

let tmpDir: string;
let originalDataDir: string | undefined;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "recipedb-mig-"));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tmpDir;
  ensureDataDirs();
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

describe("migrations + FTS5", () => {
  it("applies the journal and writes migrations-applied.json", () => {
    const first = runMigrations();
    expect(first.applied.length).toBeGreaterThan(0);

    const journalPath = path.join(tmpDir, "migrations-applied.json");
    expect(fs.existsSync(journalPath)).toBe(true);
    const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
    expect(Object.keys(journal).length).toBe(first.applied.length);

    // Fresh DB: the whole journal lands, 0000_init included (no replay dance
    // needed — a fresh file has nothing applied).
    expect(first.applied).toEqual([
      "0000_init",
      "0001_scaling_quantity",
      "0002_scan_image",
    ]);

    // Re-running is a no-op.
    const second = runMigrations();
    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(first.applied);
  });

  it("fresh DB has the derived quantity columns from 0001_scaling_quantity", () => {
    const cols = (
      getRawSqlite().prepare("PRAGMA table_info(ingredient_lines)").all() as Array<{
        name: string;
      }>
    ).map((c) => c.name);
    expect(cols).toEqual(
      expect.arrayContaining([
        "qty_amount",
        "qty_amount2",
        "qty_unit_normalized",
        "qty_parse_status",
      ]),
    );
    // qty stays the display source of truth.
    expect(cols).toContain("qty");
  });

  it("FTS5 index returns rows matching title / ingredient / tag content", () => {
    const db = getDb();
    const now = new Date();
    const base: NewRecipe = {
      title: "Sourdough Pancakes",
      isDraft: true,
      category: "bread",
      favorite: false,
      sourceType: "manual",
      createdAt: now,
      updatedAt: now,
    };
    const [r] = db.insert(recipes).values(base).returning().all();
    expect(r).toBeDefined();

    db.insert(ingredientLines)
      .values({
        recipeId: r!.id,
        qty: "2 cups",
        unit: "cups",
        item: "flour",
        note: null,
        position: 1,
      })
      .run();
    db.insert(steps)
      .values({ recipeId: r!.id, position: 1, text: "Whisk until smooth." })
      .run();
    db.insert(tags)
      .values({ recipeId: r!.id, label: "breakfast" })
      .run();

    // FTS5 query for the title term.
    const titleHits = getRawSqlite()
      .prepare(
        "SELECT rowid FROM recipe_fts WHERE recipe_fts MATCH 'Sourdough'",
      )
      .all() as Array<{ rowid: number }>;
    expect(titleHits.map((h) => h.rowid)).toContain(r!.id);

    // FTS5 query for an ingredient term (the qty "cups" appears in the
    // ingredient cell).
    const ingHits = getRawSqlite()
      .prepare("SELECT rowid FROM recipe_fts WHERE recipe_fts MATCH 'flour'")
      .all() as Array<{ rowid: number }>;
    expect(ingHits.map((h) => h.rowid)).toContain(r!.id);

    // FTS5 query for a tag term.
    const tagHits = getRawSqlite()
      .prepare(
        "SELECT rowid FROM recipe_fts WHERE recipe_fts MATCH 'breakfast'",
      )
      .all() as Array<{ rowid: number }>;
    expect(tagHits.map((h) => h.rowid)).toContain(r!.id);

    // A term that doesn't exist returns no rows.
    const miss = getRawSqlite()
      .prepare("SELECT rowid FROM recipe_fts WHERE recipe_fts MATCH 'xyzzy'")
      .all() as Array<{ rowid: number }>;
    expect(miss).toEqual([]);
  });
});
