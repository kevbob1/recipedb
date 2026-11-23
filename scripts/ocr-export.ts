/**
 * Export accepted OCR samples for tesstrain. Run only against a COPY of
 * DATA_DIR, never the live recipe data directory:
 *
 *   DATA_DIR=/path/to/data-copy RECIPEDB_OCR_EXPORT_OUT=/path/to/export \
 *     npx tsx scripts/ocr-export.ts
 *
 * Or pass the output directory as the first positional argument.
 */
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { getDataDir, getRawSqlite } from "../app/db/client.server";

interface TrainingSample {
  recipe_id: number;
  page_no: number;
  image_filename: string | null;
  corrected_text: string;
}

interface UnreviewedCount {
  recipe_id: number;
  count: number;
}

export interface OcrExportCounts {
  exported: number;
  skippedMissing: string[];
  unreviewed: UnreviewedCount[];
}

const REQUIRED_COLUMNS = [
  "recipe_id",
  "page_no",
  "image_filename",
  "corrected_text",
  "accepted_at",
] as const;

function assertTrainingTable(sqlite: Database.Database): void {
  const columns = sqlite
    .prepare("PRAGMA table_info(ocr_training_samples)")
    .all() as { name: string }[];
  if (columns.length === 0) {
    throw new Error(
      "OCR export requires the ocr_training_samples table (migration 0003); this data copy may be pre-0003.",
    );
  }
  const names = new Set(columns.map((column) => column.name));
  const missing = REQUIRED_COLUMNS.filter((column) => !names.has(column));
  if (missing.length > 0) {
    throw new Error(
      `OCR export cannot use ocr_training_samples: missing column(s) ${missing.join(", ")}.`,
    );
  }
}

/**
 * Export human-accepted samples and report rows that cannot be exported.
 * `sqlite` is injectable for tests; normal callers use the DATA_DIR-backed DB.
 */
export function exportOcrTraining(
  outDir: string,
  dataDir: string,
  sqlite: Database.Database = getRawSqlite(),
): OcrExportCounts {
  assertTrainingTable(sqlite);

  const samples = sqlite
    .prepare(
      `SELECT recipe_id, page_no, image_filename, corrected_text
         FROM ocr_training_samples
        WHERE accepted_at IS NOT NULL
        ORDER BY recipe_id, page_no`,
    )
    .all() as TrainingSample[];
  const unreviewed = sqlite
    .prepare(
      `SELECT recipe_id, count(*) AS count
         FROM ocr_training_samples
        WHERE accepted_at IS NULL
        GROUP BY recipe_id
        ORDER BY recipe_id`,
    )
    .all() as UnreviewedCount[];

  const imageDir = path.join(outDir, "images");
  const groundTruthDir = path.join(outDir, "ground-truth");
  mkdirSync(imageDir, { recursive: true });
  mkdirSync(groundTruthDir, { recursive: true });

  const filelist: string[] = [];
  const skippedMissing: string[] = [];
  for (const sample of samples) {
    const baseName = `${sample.recipe_id}_page${sample.page_no}`;
    const sampleName = `recipe ${sample.recipe_id}, page ${sample.page_no}`;
    if (!sample.image_filename) {
      skippedMissing.push(`${sampleName} (no image filename)`);
      continue;
    }

    const sourceImage = path.join(dataDir, "images", sample.image_filename);
    if (!existsSync(sourceImage)) {
      skippedMissing.push(`${sampleName} (${sample.image_filename})`);
      continue;
    }

    const extension = path.extname(sample.image_filename);
    copyFileSync(sourceImage, path.join(imageDir, `${baseName}${extension}`));
    writeFileSync(
      path.join(groundTruthDir, `${baseName}.gt.txt`),
      sample.corrected_text,
      "utf8",
    );
    filelist.push(baseName);
  }

  const counts: OcrExportCounts = {
    exported: filelist.length,
    skippedMissing,
    unreviewed,
  };
  writeFileSync(
    path.join(outDir, "filelist.txt"),
    filelist.length > 0 ? `${filelist.join("\n")}\n` : "",
    "utf8",
  );

  const unreviewedTotal = unreviewed.reduce((total, row) => total + row.count, 0);
  writeFileSync(
    path.join(outDir, "README.md"),
    `This export contains accepted OCR training samples only (human-reviewed or backfilled). Unreviewed rows are excluded; ground truth is the accepted corrected text, and images are copied from the matching DATA_DIR image files.\n\nExported ${counts.exported} sample(s); skipped ${counts.skippedMissing.length} accepted sample(s) with missing images; ${unreviewedTotal} unreviewed row(s) across ${unreviewed.length} recipe(s).\n`,
    "utf8",
  );
  return counts;
}

// Direct invocation prints the export summary and always closes the DB.
if (process.argv[1]?.endsWith("ocr-export.ts")) {
  const outDir = process.env.RECIPEDB_OCR_EXPORT_OUT ?? process.argv[2];
  if (!outDir) {
    console.error(
      "Set RECIPEDB_OCR_EXPORT_OUT or pass an output directory as the first argument.",
    );
    process.exitCode = 1;
  } else {
    const sqlite = getRawSqlite();
    try {
      const counts = exportOcrTraining(outDir, getDataDir(), sqlite);
      console.log(`[ocr-export] exported ${counts.exported} sample(s)`);
      console.log(`[ocr-export] skipped missing images: ${counts.skippedMissing.length}`);
      if (counts.skippedMissing.length > 0) {
        console.log("[ocr-export] skipped samples:");
        for (const missing of counts.skippedMissing) console.log(`  - ${missing}`);
      }
      console.log(
        "[ocr-export] unreviewed rows per recipe (run Review or Phase 5 backfill, then re-export)",
      );
      if (counts.unreviewed.length === 0) {
        console.log("  (none)");
      } else {
        for (const row of counts.unreviewed) {
          console.log(`  recipe ${row.recipe_id}: ${row.count}`);
        }
      }
    } catch (error) {
      console.error(`[ocr-export] ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    } finally {
      sqlite.close();
    }
  }
}
