/**
 * Scan module — sole public entry (NODE).
 *
 * One job: a photo in, recognized text out. Everything related to retaining and
 * re-reading a scan capture lives behind this entry:
 *
 *   storage        retained capture on disk (DATA_DIR/images/<id>/original.*)
 *   preprocess     sharp decode → shared pixel pipeline → lossless PNG
 *   recognize-node tesseract.js worker (same params as the browser capture path)
 *   http           POST /api/re-ocr transport
 *
 * Whichever module grows here next, callers keep importing this file — that is
 * what stops the reason-mixing the architecture review found (a route, a DB
 * helper, an engine wrapper and a tuning harness each knowing part of the scan).
 *
 * The BROWSER half deliberately stays outside: `recognizeText` and the canvas
 * pipeline live in app/lib/ocr.ts and app/lib/image-preprocess.ts, and the scan
 * adapter in app/lib/import.ts turns recognized text into a draft. They share
 * only app/lib/image-ops.ts with this module. `sharp` and node:fs cannot be in
 * the client bundle, so the seam is the shared pixel/param contract, not a
 * shared file.
 *
 * `.server` in the name is load-bearing: React Router strips it from the client
 * build, so importing this entry can never pull node:fs/sharp into the browser.
 */
export {
  MAX_SCAN_UPLOAD_BYTES,
  ScanImageError,
  attachImageFilename,
  deleteRecipeImage,
  reocrRecipe,
  resolveStoredImagePath,
  saveOriginalScanImage,
  validateScanUpload,
} from "./storage.server";
export type {
  Photo,
  ScanImageExt,
  ScanRun,
  StoredScanRecognizer,
} from "./storage.server";

export {
  DEFAULT_OCR_PREPROCESS,
  autoOrientOnly,
  computeScale,
  preprocessFixture,
  preprocessPixels,
} from "./preprocess.server";
export type {
  PreprocessOptions,
  PreprocessedFixture,
  RgbaImage,
  ThresholdMode,
} from "./preprocess.server";

export {
  FIXTURE_DIR,
  collectImagePaths,
  createOcrSession,
  defaultCachePath,
  fixturePaths,
  ingest,
} from "./recognize-node.server";
export type { OcrParamOverrides, OcrSession } from "./recognize-node.server";

export { handleReOcrRequest } from "./http.server";
