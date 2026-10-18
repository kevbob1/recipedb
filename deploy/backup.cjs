#!/usr/bin/env node
// Consistent online backup of the live recipe DB, run inside the running
// container (so it sees the same WAL / -shm files the app is using):
//   docker exec recipedb node /app/backup.cjs /backups/recipes-YYYYMMDD.db
// Uses better-sqlite3's online backup API, then verifies the copy.
"use strict";

const fs = require("node:fs");
const Database = require("better-sqlite3");

const SOURCE = "/data/recipes.db";

function openReadOnly(path) {
  return new Database(path, { readonly: true, fileMustExist: true });
}

async function main() {
  const dest = process.argv[2];
  if (!dest) {
    throw new Error("usage: backup.cjs <destination.db>");
  }

  const source = openReadOnly(SOURCE);
  try {
    await source.backup(dest);
  } finally {
    source.close();
  }

  const copy = openReadOnly(dest);
  try {
    const integrity = copy.pragma("integrity_check", { simple: true });
    if (integrity !== "ok") {
      throw new Error(`integrity_check on ${dest} returned: ${integrity}`);
    }
    const recipes = copy.prepare("SELECT COUNT(*) AS n FROM recipes").get().n;
    const ingredientLines = copy
      .prepare("SELECT COUNT(*) AS n FROM ingredient_lines")
      .get().n;
    console.log(
      `ok integrity_check=ok recipes=${recipes} ingredient_lines=${ingredientLines} dest=${dest}`
    );
  } finally {
    copy.close();
  }

  // Opening a WAL-mode copy read-only can leave -wal/-shm side files behind;
  // a backup is a single self-contained file, so drop them.
  for (const suffix of ["-wal", "-shm"]) {
    try {
      fs.unlinkSync(dest + suffix);
    } catch {
      // nothing to clean up
    }
  }
}

main().catch((err) => {
  console.error(`backup failed: ${(err && err.stack) || err}`);
  process.exitCode = 1;
});
