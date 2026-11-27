import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import type { Pack } from "tar-stream";
import { getRawSqlite } from "../../db/client.server";
import { isAccepted } from "./training-samples.server";
import { isStoredPath } from "./image-path";

interface TrainingSample {
  recipe_id: number;
  page_no: number;
  image_filename: string | null;
  corrected_text: string | null;
  accepted_at: number | null;
}

export interface UnreviewedCount {
  recipe_id: number;
  count: number;
}

export interface OcrExportCounts {
  exported: number;
  skippedMissing: string[];
  unreviewed: UnreviewedCount[];
}

export interface TrainingExportEntry {
  path: string;
  contents: Buffer;
  type: "file" | "directory";
}

export interface TrainingExport {
  counts: OcrExportCounts;
  entries: TrainingExportEntry[];
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

function fileEntry(pathname: string, contents: string | Buffer): TrainingExportEntry {
  return {
    path: pathname,
    contents: Buffer.isBuffer(contents) ? contents : Buffer.from(contents, "utf8"),
    type: "file",
  };
}

/**
 * Collect accepted OCR training samples and their export entries.
 * Images are read while collecting so a disappeared or unreadable image is
 * recorded as skipped rather than failing a later archive stream.
 */
export function collectTrainingExport(
  dataDir: string,
  sqlite: Database.Database = getRawSqlite(),
): TrainingExport {
  assertTrainingTable(sqlite);
  const allSamples = sqlite
    .prepare(
      `SELECT recipe_id, page_no, image_filename, corrected_text, accepted_at
         FROM ocr_training_samples
        ORDER BY recipe_id, page_no`,
    )
    .all() as TrainingSample[];
  const accepted = allSamples.filter((sample) =>
    isAccepted({ acceptedAt: sample.accepted_at }),
  );
  const unreviewed: UnreviewedCount[] = [];
  for (const sample of allSamples) {
    if (isAccepted({ acceptedAt: sample.accepted_at })) continue;
    const previous = unreviewed.at(-1);
    if (previous?.recipe_id === sample.recipe_id) previous.count += 1;
    else unreviewed.push({ recipe_id: sample.recipe_id, count: 1 });
  }

  const entries: TrainingExportEntry[] = [
    { path: "images/", contents: Buffer.alloc(0), type: "directory" },
    { path: "ground-truth/", contents: Buffer.alloc(0), type: "directory" },
  ];
  const skippedMissing: string[] = [];
  const filelist: string[] = [];
  const imageRoot = path.resolve(dataDir, "images");
  for (const sample of accepted) {
    const baseName = `${sample.recipe_id}_page${sample.page_no}`;
    const sampleName = `recipe ${sample.recipe_id}, page ${sample.page_no}`;
    const filename = sample.image_filename;
    if (!filename) {
      skippedMissing.push(`${sampleName} (no image filename)`);
      continue;
    }
    if (!isStoredPath(filename)) {
      skippedMissing.push(`${sampleName} (${filename})`);
      continue;
    }
    const sourceImage = path.resolve(imageRoot, filename);
    let imageContents: Buffer;
    try {
      const realImageRoot = fs.realpathSync(imageRoot);
      const realSourceImage = fs.realpathSync(sourceImage);
      if (!realSourceImage.startsWith(`${realImageRoot}${path.sep}`)) {
        skippedMissing.push(`${sampleName} (${filename})`);
        continue;
      }
      imageContents = fs.readFileSync(realSourceImage);
    } catch {
      skippedMissing.push(`${sampleName} (${filename})`);
      continue;
    }

    const extension = path.extname(filename);
    entries.push(fileEntry(`images/${baseName}${extension}`, imageContents));
    entries.push(
      fileEntry(
        `ground-truth/${baseName}.gt.txt`,
        sample.corrected_text ?? "",
      ),
    );
    filelist.push(baseName);
  }

  const counts: OcrExportCounts = {
    exported: filelist.length,
    skippedMissing,
    unreviewed,
  };
  entries.push(
    fileEntry("filelist.txt", filelist.length > 0 ? `${filelist.join("\n")}\n` : ""),
  );
  const unreviewedTotal = unreviewed.reduce((total, row) => total + row.count, 0);
  entries.push(
    fileEntry(
      "README.md",
      `This export contains accepted OCR training samples only (human-reviewed or backfilled). Unreviewed rows are excluded; ground truth is the accepted corrected text, and images are copied from the matching DATA_DIR image files.\n\nExported ${counts.exported} sample(s); skipped ${counts.skippedMissing.length} accepted sample(s) with missing images; ${unreviewedTotal} unreviewed row(s) across ${unreviewed.length} recipe(s).\n`,
    ),
  );
  return { counts, entries };
}

/** Write the collected export using the offline CLI's filesystem layout. */
export function writeTrainingExport(exportData: TrainingExport, outDir: string): void {
  for (const entry of exportData.entries) {
    const destination = path.join(outDir, entry.path);
    if (entry.type === "directory") {
      fs.mkdirSync(destination, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, entry.contents);
  }
}

/** Append the same entries to a tar-stream pack for the authenticated API. */
export function appendTrainingExportToTar(
  archive: Pack,
  exportData: TrainingExport,
): void {
  for (const entry of exportData.entries) {
    if (entry.type === "directory") {
      archive.entry({ name: entry.path, type: "directory" }, entry.contents);
    } else {
      archive.entry({ name: entry.path, size: entry.contents.length }, entry.contents);
    }
  }
}
