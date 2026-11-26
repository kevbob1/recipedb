import { retainedName } from "./scan/image-path";

import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { getDb, getImagesDir } from "../db/client.server";
import {
  ocrTrainingSamples,
  recipePages,
  recipes,
} from "../db/schema.server";
import { resolveStoredImagePath } from "./scan/storage.server";

export interface NormalizeResult {
  moved: { recipeId: number; from: string; to: string }[];
  failed: { recipeId: number; from: string; reason: string }[];
  orphans: { deleted?: string[]; reported?: string[] };
}

export interface NormalizeOptions {
  dryRun?: boolean;
  keepOrphans?: boolean;
}

function listFiles(dir: string, prefix = ""): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return listFiles(fullPath, relative);
    return entry.isFile() ? [relative] : [];
  });
}

export function normalizeImages(
  options: NormalizeOptions = {},
): NormalizeResult {
  const { dryRun = false, keepOrphans = false } = options;
  const db = getDb();
  const imagesDir = getImagesDir();
  const moved: NormalizeResult["moved"] = [];
  const failed: NormalizeResult["failed"] = [];
  const flatRows = db
    .select({ id: recipes.id, imageFilename: recipes.imageFilename })
    .from(recipes)
    .all()
    .filter(
      (row): row is { id: number; imageFilename: string } =>
        row.imageFilename !== null && !row.imageFilename.includes("/"),
    );

  for (const row of flatRows) {
    const from = row.imageFilename;
    const extension = path.extname(from);
    const to = retainedName(row.id, extension.replace(/^\./, ""));
    const sourcePath = resolveStoredImagePath(from);
    const destinationPath = path.join(imagesDir, to);
    if (!sourcePath || !extension || !fs.existsSync(sourcePath)) {
      failed.push({ recipeId: row.id, from, reason: "source-missing" });
      continue;
    }
    if (dryRun) {
      moved.push({ recipeId: row.id, from, to });
      continue;
    }
    try {
      fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
      fs.renameSync(sourcePath, destinationPath);
      try {
        db.update(recipes)
          .set({ imageFilename: to })
          .where(eq(recipes.id, row.id))
          .run();
      } catch (error) {
        fs.renameSync(destinationPath, sourcePath);
        throw error;
      }
      moved.push({ recipeId: row.id, from, to });
    } catch (error) {
      failed.push({
        recipeId: row.id,
        from,
        reason: error instanceof Error ? error.message : "move-failed",
      });
    }
  }

  const referenced = new Set<string>();
  for (const filename of [
    ...db.select({ filename: recipes.imageFilename }).from(recipes).all().map((row) => row.filename),
    ...db.select({ filename: recipePages.imageFilename }).from(recipePages).all().map((row) => row.filename),
    ...db.select({ filename: ocrTrainingSamples.imageFilename }).from(ocrTrainingSamples).all().map((row) => row.filename),
  ]) {
    if (filename) referenced.add(filename.replaceAll("\\", "/"));
  }
  const orphanFiles = listFiles(imagesDir).filter((filename) => !referenced.has(filename));
  if (dryRun || keepOrphans) {
    return {
      moved,
      failed,
      orphans: { reported: orphanFiles },
    };
  }
  const deleted: string[] = [];
  for (const filename of orphanFiles) {
    try {
      fs.unlinkSync(path.join(imagesDir, filename));
      deleted.push(filename);
    } catch (error) {
      failed.push({
        recipeId: 0,
        from: filename,
        reason: error instanceof Error ? error.message : "orphan-delete-failed",
      });
    }
  }
  return { moved, failed, orphans: { deleted } };
}
