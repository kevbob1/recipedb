/**
 * Upgrade-path test for 0001_scaling_quantity (#16).
 *
 * This is the *existing* database path, not the fresh one (migrate.test.ts
 * covers fresh): we stand up a pre-#16 database by applying 0000_init.sql
 * alone, record it in migrations-applied.json exactly like a running instance
 * would, then run the real runner and assert that:
 *   - only 0001 is applied and 0000_init is skipped (never replayed),
 *   - the four derived columns appear,
 *   - pre-existing rows and their qty text survive,
 *   - the one-shot backfill derives numbers from them, and is idempotent.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDataDirs, getDb, getDbPath, getRawSqlite } from "./client.server";
import { runMigrations } from "./migrate.server";
import { backfillQuantities } from "../../scripts/backfill-quantity";
import { recipes } from "./schema.server";

let tmpDir: string;
let originalDataDir: string | undefined;

const HERE = path.dirname(fileURLToPath(import.meta.url));

function seedLegacyDatabase(): void {
  const initPath = path.resolve(HERE, "../../drizzle/0000_init.sql");
  const sqlText = fs.readFileSync(initPath, "utf8");
  const legacy = new Database(getDbPath());
  legacy.exec(sqlText);
  legacy
    .prepare(
      `INSERT INTO recipes (title, is_draft, category, favorite, source_type, created_at, updated_at)
       VALUES (?, 1, 'other', 0, 'manual', 1, 1)`,
    )
    .run("Grandma's cake");
  const insert = legacy.prepare(
    "INSERT INTO ingredient_lines (recipe_id, qty, unit, item, note, position) VALUES (1, ?, ?, ?, NULL, ?)",
  );
  insert.run("1 1/2 cups", null, "flour", 1);
  insert.run("2-3", "cloves", "garlic", 2);
  insert.run("a pinch", null, "salt", 3);
  legacy.close();

  fs.writeFileSync(
    path.join(tmpDir, "migrations-applied.json"),
    JSON.stringify(
      {
        "0000_init": {
          appliedAt: Date.now(),
          checksum: createHash("sha256").update(sqlText).digest("hex"),
        },
      },
      null,
      2,
    ),
    "utf8",
  );
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "recipedb-scaling-"));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tmpDir;
  delete process.env.RECIPEDB_DB_PATH;
  ensureDataDirs();
  seedLegacyDatabase();
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

describe("0001_scaling_quantity on an existing database", () => {
  it("applies only the new migration and never replays 0000_init", () => {
    const result = runMigrations();
    expect(result.applied).toEqual([
      "0001_scaling_quantity",
      "0002_scan_image",
    ]);
    expect(result.skipped).toEqual(["0000_init"]);
  });

  it("adds the derived columns", () => {
    const cols = (
      getRawSqlite().prepare("PRAGMA table_info(ingredient_lines)").all() as Array<{
        name: string;
        notnull: number;
        dflt_value: string | null;
      }>
    );
    const names = cols.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "qty_amount",
        "qty_amount2",
        "qty_unit_normalized",
        "qty_parse_status",
      ]),
    );
    const status = cols.find((c) => c.name === "qty_parse_status");
    expect(status?.notnull).toBe(1);
    expect(status?.dflt_value).toContain("unparsed");
  });

  it("keeps pre-existing rows, marks them unparsed, and leaves qty untouched", () => {
    const rows = getRawSqlite()
      .prepare("SELECT qty, unit, item, qty_parse_status FROM ingredient_lines ORDER BY position")
      .all() as Array<{ qty: string; unit: string | null; item: string; qty_parse_status: string }>;
    expect(rows.map((r) => r.qty)).toEqual(["1 1/2 cups", "2-3", "a pinch"]);
    expect(rows.every((r) => r.qty_parse_status === "unparsed")).toBe(true);
    // The recipe itself survived too (no table rebuild).
    expect(getRawSqlite().prepare("SELECT count(*) AS n FROM recipes").get()).toEqual({ n: 1 });
  });

  it("is discoverable by the schema module (new columns selectable)", () => {
    const viaDrizzle = getDb().select().from(recipes).all();
    expect(viaDrizzle).toHaveLength(1);
    const all = getRawSqlite()
      .prepare("SELECT qty_amount, qty_amount2, qty_unit_normalized FROM ingredient_lines")
      .all();
    expect(all).toHaveLength(3);
  });

  it("backfills the legacy rows once and is idempotent", () => {
    const first = backfillQuantities();
    expect(first).toEqual({ scanned: 3, parsed: 1, ranges: 1, unparseable: 1 });

    const rows = getRawSqlite()
      .prepare(
        `SELECT qty, qty_amount, qty_amount2, qty_unit_normalized, qty_parse_status
           FROM ingredient_lines ORDER BY position`,
      )
      .all() as Array<{
      qty: string;
      qty_amount: number | null;
      qty_amount2: number | null;
      qty_unit_normalized: string | null;
      qty_parse_status: string;
    }>;

    expect(rows[0]).toMatchObject({
      qty: "1 1/2 cups",
      qty_amount: 1.5,
      qty_amount2: null,
      qty_unit_normalized: "cup",
      qty_parse_status: "parsed",
    });
    expect(rows[1]).toMatchObject({
      qty: "2-3",
      qty_amount: 2,
      qty_amount2: 3,
      qty_unit_normalized: "clove",
      qty_parse_status: "range",
    });
    expect(rows[2]).toMatchObject({
      qty: "a pinch",
      qty_amount: null,
      qty_amount2: null,
      qty_parse_status: "unparseable",
    });

    expect(backfillQuantities()).toEqual({
      scanned: 0,
      parsed: 0,
      ranges: 0,
      unparseable: 0,
    });

    // Re-running the migration runner after the backfill is still a no-op.
    expect(runMigrations().applied).toEqual([]);
  });
});
