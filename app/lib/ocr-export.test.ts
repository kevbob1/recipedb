import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { exportOcrTraining } from "../../scripts/ocr-export";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "recipedb-ocr-export-"));
  tempDirs.push(dir);
  return dir;
}

function createTrainingDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE ocr_training_samples (
      recipe_id INTEGER NOT NULL,
      page_no INTEGER NOT NULL,
      image_filename TEXT,
      corrected_text TEXT,
      accepted_at INTEGER
    )
  `);
  return db;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("exportOcrTraining", () => {
  it("exports accepted samples, skips missing images, and excludes unreviewed rows", () => {
    const dataDir = tempDir();
    const outDir = path.join(tempDir(), "export");
    mkdirSync(path.join(dataDir, "images", "42"), { recursive: true });
    writeFileSync(path.join(dataDir, "images", "42", "page-1.png"), "image bytes");
    const db = createTrainingDb();
    db.prepare(
      `INSERT INTO ocr_training_samples
         (recipe_id, page_no, image_filename, corrected_text, accepted_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(42, 1, "42/page-1.png", "Café\nline two\n", 1);
    db.prepare(
      `INSERT INTO ocr_training_samples
         (recipe_id, page_no, image_filename, corrected_text, accepted_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(42, 2, "42/page-2.jpg", "missing image", 1);
    db.prepare(
      `INSERT INTO ocr_training_samples
         (recipe_id, page_no, image_filename, corrected_text, accepted_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(42, 3, "42/page-3.png", "not accepted", null);

    try {
      const counts = exportOcrTraining(outDir, dataDir, db);

      expect(counts).toEqual({
        exported: 1,
        skippedMissing: ["recipe 42, page 2 (42/page-2.jpg)"],
        unreviewed: [{ recipe_id: 42, count: 1 }],
      });
      expect(readFileSync(path.join(outDir, "images", "42_page1.png"), "utf8")).toBe(
        "image bytes",
      );
      expect(
        readFileSync(path.join(outDir, "ground-truth", "42_page1.gt.txt"), "utf8"),
      ).toBe("Café\nline two\n");
      expect(readFileSync(path.join(outDir, "filelist.txt"), "utf8")).toBe("42_page1\n");
      expect(readFileSync(path.join(outDir, "README.md"), "utf8")).toContain(
        "accepted OCR training samples only",
      );
    } finally {
      db.close();
    }
  });

  it("reports a missing migration table clearly", () => {
    const db = new Database(":memory:");
    try {
      expect(() => exportOcrTraining(tempDir(), tempDir(), db)).toThrow(
        "ocr_training_samples table (migration 0003)",
      );
    } finally {
      db.close();
    }
  });
});
