import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach } from "vitest";
import { runMigrations } from "../../db/migrate.server";
import { getImagesDir, getRawSqlite } from "../../db/client.server";

/**
 * Register an isolated migrated SQLite database for a test suite.
 *
 * Each test starts with empty recipe data and an empty images directory.
 */
export function withDb(): void {
  let dataDir: string;
  let previousDataDir: string | undefined;
  let previousDbPath: string | undefined;

  beforeAll(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "recipedb-test-"));
    previousDataDir = process.env.DATA_DIR;
    previousDbPath = process.env.RECIPEDB_DB_PATH;
    process.env.DATA_DIR = dataDir;
    delete process.env.RECIPEDB_DB_PATH;
    runMigrations();
  });

  beforeEach(() => {
    getRawSqlite().exec(
      "DELETE FROM api_tokens; DELETE FROM save_events; DELETE FROM ocr_training_samples; DELETE FROM recipe_pages; DELETE FROM ingredient_lines; DELETE FROM steps; DELETE FROM tags; DELETE FROM recipes;",
    );
    fs.rmSync(getImagesDir(), { recursive: true, force: true });
    fs.mkdirSync(getImagesDir(), { recursive: true });
  });

  afterAll(() => {
    getRawSqlite().close();
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    if (previousDbPath === undefined) delete process.env.RECIPEDB_DB_PATH;
    else process.env.RECIPEDB_DB_PATH = previousDbPath;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
}
