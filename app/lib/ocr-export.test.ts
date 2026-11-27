import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import tar from "tar-stream";
import { afterEach, describe, expect, it } from "vitest";
import { exportOcrTraining } from "../../scripts/ocr-export";
import {
  appendTrainingExportToTar,
  collectTrainingExport,
} from "./scan/training-export.server";

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
    db.prepare(
      `INSERT INTO ocr_training_samples
         (recipe_id, page_no, image_filename, corrected_text, accepted_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(42, 4, "42/page-4.png", "also not accepted", null);

    try {
      const counts = exportOcrTraining(outDir, dataDir, db);

      expect(counts).toEqual({
        exported: 1,
        skippedMissing: ["recipe 42, page 2 (42/page-2.jpg)"],
        unreviewed: [{ recipe_id: 42, count: 2 }],
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

  it("reports missing required columns clearly", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE ocr_training_samples (recipe_id INTEGER)");
    try {
      expect(() => collectTrainingExport(tempDir(), db)).toThrow(
        "missing column(s) page_no, image_filename, corrected_text, accepted_at",
      );
    } finally {
      db.close();
    }
  });

  it("skips unsafe and absent accepted image paths without failing collection", () => {
    const dataDir = tempDir();
    const imageDir = path.join(dataDir, "images", "42");
    mkdirSync(imageDir, { recursive: true });
    writeFileSync(path.join(dataDir, "outside.png"), "outside");
    symlinkSync(path.join(dataDir, "outside.png"), path.join(imageDir, "linked.png"));
    const db = createTrainingDb();
    db.prepare(
      `INSERT INTO ocr_training_samples
         (recipe_id, page_no, image_filename, corrected_text, accepted_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(42, 1, "../outside.png", "unsafe", 1);
    db.prepare(
      `INSERT INTO ocr_training_samples
         (recipe_id, page_no, image_filename, corrected_text, accepted_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(42, 2, null, "no filename", 1);
    db.prepare(
      `INSERT INTO ocr_training_samples
         (recipe_id, page_no, image_filename, corrected_text, accepted_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(42, 3, "42/missing.png", "missing", 1);
    db.prepare(
      `INSERT INTO ocr_training_samples
         (recipe_id, page_no, image_filename, corrected_text, accepted_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(42, 4, "42/linked.png", "symlink", 1);

    try {
      const result = collectTrainingExport(dataDir, db);
      expect(result.counts).toEqual({
        exported: 0,
        skippedMissing: [
          "recipe 42, page 1 (../outside.png)",
          "recipe 42, page 2 (no image filename)",
          "recipe 42, page 3 (42/missing.png)",
          "recipe 42, page 4 (42/linked.png)",
        ],
        unreviewed: [],
      });
    } finally {
      db.close();
    }
  });

  it("round-trips the shared entries through tar-stream", async () => {
    const dataDir = tempDir();
    mkdirSync(path.join(dataDir, "images", "42"), { recursive: true });
    writeFileSync(path.join(dataDir, "images", "42", "page-1.png"), "image bytes");
    const db = createTrainingDb();
    db.prepare(
      `INSERT INTO ocr_training_samples
         (recipe_id, page_no, image_filename, corrected_text, accepted_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(42, 1, "42/page-1.png", "Café\nline two\n", 1);

    try {
      const exportData = collectTrainingExport(dataDir, db);
      const archive = tar.pack();
      const chunks: Buffer[] = [];
      const archiveDone = new Promise<Buffer>((resolve, reject) => {
        archive.on("data", (chunk: unknown) => {
          if (!Buffer.isBuffer(chunk)) throw new Error("tar stream emitted non-buffer data");
          chunks.push(chunk);
        });
        archive.on("end", () => resolve(Buffer.concat(chunks)));
        archive.on("error", reject);
      });
      appendTrainingExportToTar(archive, exportData);
      archive.finalize();
      const packed = await archiveDone;
      const extractor = tar.extract();
      const files = await new Promise<Map<string, Buffer>>((resolve, reject) => {
        const unpacked = new Map<string, Buffer>();
        extractor.on("entry", (header, stream, next) => {
          const contents: Buffer[] = [];
          stream.on("data", (chunk: unknown) => {
            if (!Buffer.isBuffer(chunk)) throw new Error("tar entry emitted non-buffer data");
            contents.push(chunk);
          });
          stream.on("end", () => {
            unpacked.set(header.name, Buffer.concat(contents));
            next();
          });
        });
        extractor.on("finish", () => resolve(unpacked));
        extractor.on("error", reject);
        extractor.write(packed);
        extractor.end(() => undefined);
      });
      expect([...files.keys()]).toEqual([
        "images/",
        "ground-truth/",
        "images/42_page1.png",
        "ground-truth/42_page1.gt.txt",
        "filelist.txt",
        "README.md",
      ]);
      expect(files.get("images/42_page1.png")?.toString()).toBe("image bytes");
      expect(files.get("ground-truth/42_page1.gt.txt")?.toString()).toBe(
        "Café\nline two\n",
      );
      expect(files.get("filelist.txt")?.toString()).toBe("42_page1\n");
      expect(files.get("README.md")?.toString()).toContain("Exported 1 sample(s)");
    } finally {
      db.close();
    }
  });
});
