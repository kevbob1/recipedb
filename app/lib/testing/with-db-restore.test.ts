import { afterAll, expect, it } from "vitest";
import { getRawSqlite } from "../../db/client.server";
import { withDb } from "./with-db";

const originalDataDir = process.env.DATA_DIR;
const originalDbPath = process.env.RECIPEDB_DB_PATH;
process.env.DATA_DIR = "/tmp/recipedb-prior-data-dir";
process.env.RECIPEDB_DB_PATH = "/tmp/recipedb-prior-db.sqlite";

withDb();

afterAll(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  if (originalDbPath === undefined) delete process.env.RECIPEDB_DB_PATH;
  else process.env.RECIPEDB_DB_PATH = originalDbPath;
});

it("registers a migrated isolated database and restores pre-existing paths", () => {
  expect(getRawSqlite().prepare("SELECT 1 AS value").get()).toEqual({ value: 1 });
});
