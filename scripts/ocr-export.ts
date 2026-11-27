/**
 * Export accepted OCR samples for tesstrain. Run only against a COPY of
 * DATA_DIR, never the live recipe data directory:
 *
 *   DATA_DIR=/path/to/data-copy RECIPEDB_OCR_EXPORT_OUT=/path/to/export \
 *     npx tsx scripts/ocr-export.ts
 *
 * Or pass the output directory as the first positional argument.
 */
import type Database from "better-sqlite3";
import { getDataDir, getRawSqlite } from "../app/db/client.server";
import {
  collectTrainingExport,
  writeTrainingExport,
  type OcrExportCounts,
} from "../app/lib/scan/training-export.server";

export type { OcrExportCounts } from "../app/lib/scan/training-export.server";

/**
 * Export human-accepted samples and report rows that cannot be exported.
 * `sqlite` is injectable for tests; normal callers use the DATA_DIR-backed DB.
 */
export function exportOcrTraining(
  outDir: string,
  dataDir: string,
  sqlite: Database.Database = getRawSqlite(),
): OcrExportCounts {
  const exportData = collectTrainingExport(dataDir, sqlite);
  writeTrainingExport(exportData, outDir);
  return exportData.counts;
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
