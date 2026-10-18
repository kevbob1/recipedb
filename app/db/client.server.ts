/**
 * SQLite client. Resolves the database file from DATA_DIR (default /data),
 * falling back to ./data for local dev. The directory and the file are created
 * on first use.
 */
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import * as schema from "./schema.server";

let _db: BetterSQLite3Database<typeof schema> | null = null;
let _raw: Database.Database | null = null;

export function getDataDir(): string {
  return process.env.DATA_DIR ?? path.resolve(process.cwd(), "data");
}

export function getDbPath(): string {
  const envPath = process.env.RECIPEDB_DB_PATH;
  if (envPath && envPath.length > 0) return envPath;
  return path.join(getDataDir(), "recipes.db");
}

export function getImagesDir(): string {
  return path.join(getDataDir(), "images");
}

export function getMigrationsAppliedPath(): string {
  return path.join(getDataDir(), "migrations-applied.json");
}

export function ensureDataDirs(): void {
  const dataDir = getDataDir();
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(getImagesDir(), { recursive: true });
  // The DB file is created by better-sqlite3 on first open; nothing to do
  // for the file itself here.
}

/**
 * Returns the singleton drizzle client. Ensures the data + images directories
 * exist on first call so callers don't have to think about layout.
 */
export function getDb(): BetterSQLite3Database<typeof schema> {
  if (_db) return _db;
  ensureDataDirs();
  const dbPath = getDbPath();
  const sqlite = new Database(dbPath);
  // Foreign keys are off by default in sqlite; enable for cascade deletes.
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  _raw = sqlite;
  _db = drizzle(sqlite, { schema });
  return _db;
}

/**
 * Escape hatch for places that need raw statements (FTS5 bookkeeping, the
 * migrations runner). Throws if the client hasn't been opened yet.
 */
export function getRawSqlite(): Database.Database {
  getDb();
  if (!_raw) throw new Error("sqlite client failed to open");
  return _raw;
}

export { schema };
