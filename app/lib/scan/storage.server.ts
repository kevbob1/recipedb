/**
 * Retained scan captures (#28) — Scan module: storage.
 *
 * A scan import used to be transient: the browser OCR'd the photo and threw the
 * bytes away. To iterate on OCR quality we keep the ORIGINAL bytes server-side,
 * per recipe, for as long as the recipe exists:
 *
 *   DATA_DIR/images/<recipeId>/original.<ext>
 *
 * The recipe row stores the path relative to DATA_DIR/images/ in
 * `recipes.image_filename`. The artifact is deleted only when the recipe is
 * deleted (see deleteRecipe in ../../draft-store.server.ts).
 *
 * Deliberately depends on nothing heavier than fs/path + the DB client: the
 * recognizer is injected into `reocrRecipe`, so storage code stays cheap to
 * import (and test) and never pulls `sharp`/tesseract into a route that does
 * not need it. The real recognizer lives in ./recognize-node.server.ts.
 */
import { eq } from "drizzle-orm";
import fs from "node:fs";
import path from "node:path";
import { getDb, getImagesDir } from "../../db/client.server";
import { recipes } from "../../db/schema.server";

/**
 * Upload ceiling for a scan capture (~15MB). Defined in ./limits so the Add
 * flow's browser-side pre-check can use the same number; re-exported here
 * because this module is where the ceiling is enforced.
 */
export { MAX_SCAN_UPLOAD_BYTES, MAX_SCAN_UPLOAD_MB } from "./limits";
import {
  MAX_SCAN_UPLOAD_BYTES,
  MAX_SCAN_UPLOAD_MB,
} from "./limits";

/** Extension actually written, derived from the bytes, not the client header. */
export type ScanImageExt = "jpg" | "png" | "webp";

export class ScanImageError extends Error {
  constructor(
    public code:
      | "bad-image"
      | "image-too-large"
      | "not-found"
      | "no-image"
      | "image-missing"
      | "image-write-failed",
    message: string,
  ) {
    super(message);
  }
}

/**
 * Identify the image by magic bytes. Trusting the browser's Content-Type (or
 * the filename extension) would let a client store arbitrary bytes under an
 * image name; the recognizer later opens the file, so validate what it is.
 */
function sniffImageExt(bytes: Buffer): ScanImageExt | null {
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "jpg";
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "png";
  }
  if (
    bytes.length >= 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "webp";
  }
  return null;
}

/**
 * Validate an uploaded capture. Throws ScanImageError when the bytes are empty,
 * over the ceiling, or not a supported image. Returns the extension to store.
 */
export function validateScanUpload(bytes: Buffer): {
  ext: ScanImageExt;
  bytes: number;
} {
  if (bytes.byteLength === 0) {
    throw new ScanImageError("bad-image", "The uploaded image is empty.");
  }
  if (bytes.byteLength > MAX_SCAN_UPLOAD_BYTES) {
    throw new ScanImageError(
      "image-too-large",
      `Images must be ${MAX_SCAN_UPLOAD_MB}MB or smaller.`,
    );
  }
  const ext = sniffImageExt(bytes);
  if (!ext) {
    throw new ScanImageError(
      "bad-image",
      "The uploaded file is not a JPEG, PNG, or WebP image.",
    );
  }
  return { ext, bytes: bytes.byteLength };
}

/**
 * Write the untouched upload bytes to DATA_DIR/images/<id>/original.<ext>.
 * Returns the path relative to DATA_DIR/images/ (what `image_filename` stores).
 */
export function saveOriginalScanImage(recipeId: number, bytes: Buffer): string {
  const { ext } = validateScanUpload(bytes);
  const dir = path.join(getImagesDir(), String(recipeId));
  const filename = `original.${ext}`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, filename), bytes);
  } catch (err) {
    throw new ScanImageError(
      "image-write-failed",
      `Could not store the scan capture: ${(err as Error).message}`,
    );
  }
  return `${recipeId}/${filename}`;
}

/**
 * Resolve a stored relative filename to an absolute path, refusing anything
 * that escapes DATA_DIR/images/. Returns null for a traversal attempt.
 */
export function resolveStoredImagePath(filename: string): string | null {
  const root = getImagesDir();
  const resolved = path.resolve(root, filename);
  const rel = path.relative(root, resolved);
  if (rel.length === 0 || rel.startsWith("..") || path.isAbsolute(rel)) {
    return null;
  }
  return resolved;
}

/** Point a recipe row at its retained capture (null clears it). */
export function attachImageFilename(
  recipeId: number,
  filename: string | null,
): void {
  getDb()
    .update(recipes)
    .set({ imageFilename: filename })
    .where(eq(recipes.id, recipeId))
    .run();
}

/** Remove a recipe's retained capture directory. Idempotent. */
export function deleteRecipeImage(recipeId: number): void {
  fs.rmSync(path.join(getImagesDir(), String(recipeId)), {
    recursive: true,
    force: true,
  });
}

/** One OCR pass over a capture: text plus engine confidence/timing. */
export interface ScanRun {
  text: string;
  confidence: number;
  ms: number;
}

/** A capture to recognize — raw image bytes (JPEG/PNG/WebP). */
export interface Photo {
  bytes: Buffer;
}

/**
 * Runs OCR against a capture. Injected by ./recognize-node.server.ts (`ingest`)
 * so storage stays testable without loading a tesseract worker, and so this
 * module never imports `sharp`/tesseract itself.
 */
export type StoredScanRecognizer = (photo: Photo) => Promise<ScanRun>;

/**
 * Re-run OCR against a recipe's retained capture.
 *
 * Returns the fresh text; it NEVER writes to the recipe. The review screen
 * shows the text and only the person's explicit approval applies it (#28).
 */
export async function reocrRecipe(
  id: number,
  recognize: StoredScanRecognizer,
): Promise<ScanRun & { recipeId: number }> {
  const row = getDb()
    .select({ id: recipes.id, imageFilename: recipes.imageFilename })
    .from(recipes)
    .where(eq(recipes.id, id))
    .get();
  if (!row) {
    throw new ScanImageError("not-found", `Recipe #${id} was not found.`);
  }
  if (!row.imageFilename) {
    throw new ScanImageError(
      "no-image",
      `Recipe #${id} has no retained scan capture.`,
    );
  }
  const filePath = resolveStoredImagePath(row.imageFilename);
  if (!filePath) {
    throw new ScanImageError(
      "image-missing",
      `The retained capture for recipe #${id} is missing on disk.`,
    );
  }
  // Read the bytes here instead of checking `existsSync` first: the read *is*
  // the existence check, so a capture deleted between check and use surfaces as
  // one deterministic error instead of a recognizer crash (TOCTOU closed).
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ScanImageError(
        "image-missing",
        `The retained capture for recipe #${id} is missing on disk.`,
      );
    }
    throw err;
  }
  const run = await recognize({ bytes });
  return {
    recipeId: id,
    text: run.text,
    confidence: run.confidence,
    ms: run.ms,
  };
}
