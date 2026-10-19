/**
 * Browser-side OCR image preprocessing (canvas + `createImageBitmap`).
 *
 * The photo never leaves the page: we decode the Blob, draw it to a canvas,
 * run the shared pixel pipeline from app/lib/image-ops.ts, and hand tesseract
 * a *new* Blob. The caller's original Blob is untouched, so nothing is written
 * to disk and no bytes are serialized to the server.
 *
 * Why preprocessing at all: tesseract.js on a raw 12MP phone photo of a
 * printed page sees small, soft, unevenly lit glyphs and returns garbage
 * (`rn`/`m`, `l`/`1`/`I`, dropped spaces). Auto-orient + upscaling the short
 * side to ~2400px + grayscale + normalize + unsharp is what moves it from
 * "garbled" to "recognizable"; see scripts/ocr-tune.ts for the measurement.
 *
 * This module must stay DOM-only — no Node imports (`sharp` lives in
 * scripts/ and tests only, never in the app bundle).
 */

import {
  DEFAULT_OCR_PREPROCESS,
  computeScale,
  preprocessPixels,
  type PreprocessOptions,
  type RgbaImage,
} from "./image-ops";

export interface PreprocessResult {
  /** The preprocessed image, ready to hand to tesseract.js. */
  blob: Blob;
  width: number;
  height: number;
  /** Scale applied to the decoded image (1 = untouched resolution). */
  scale: number;
  durationMs: number;
}

/**
 * Preprocess an image Blob for OCR. Auto-orients from EXIF, rescales to the
 * OCR target resolution, then applies the shared pixel pipeline.
 *
 * Throws when the environment cannot decode/draw at all (no canvas, corrupt
 * image); `recognizeText` catches that and falls back to the raw bytes.
 */
export async function preprocessImageBlob(
  blob: Blob,
  options: PreprocessOptions = DEFAULT_OCR_PREPROCESS,
): Promise<PreprocessResult> {
  const started = Date.now();
  const bitmap = await decodeImage(blob);
  const { width: srcWidth, height: srcHeight } = bitmap;
  if (srcWidth <= 0 || srcHeight <= 0) {
    bitmap.close?.();
    throw new Error("image-preprocess: decoded image has no pixels");
  }

  const scale = computeScale(srcWidth, srcHeight, options);
  const width = Math.max(1, Math.round(srcWidth * scale));
  const height = Math.max(1, Math.round(srcHeight * scale));

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    bitmap.close?.();
    throw new Error("image-preprocess: 2d canvas context unavailable");
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();

  const imageData = ctx.getImageData(0, 0, width, height);
  const image: RgbaImage = {
    data: imageData.data,
    width,
    height,
  };
  preprocessPixels(image, options);
  ctx.putImageData(imageData, 0, 0);

  // Binarized output compresses better as PNG; photographic output as JPEG.
  const outBlob = await encodeCanvas(
    canvas,
    options.threshold === "none" ? "image/jpeg" : "image/png",
  );

  return {
    blob: outBlob,
    width,
    height,
    scale,
    durationMs: Date.now() - started,
  };
}

/**
 * Decode, honouring EXIF orientation. `createImageBitmap({imageOrientation:
 * "from-image"})` is the clean path; the `<img>` fallback exists because some
 * older Safari builds ignore the option but do apply orientation to a plain
 * `<img>` element (the CSS default `image-orientation: from-image`).
 */
async function decodeImage(blob: Blob): Promise<ImageBitmap> {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(blob, { imageOrientation: "from-image" });
    } catch {
      // fall through to the <img> path
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImageElement(url);
    return await createImageBitmap(img);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImageElement(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image-preprocess: image decode failed"));
    img.src = url;
  });
}

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

function createCanvas(width: number, height: number): AnyCanvas {
  if (typeof OffscreenCanvas === "function") return new OffscreenCanvas(width, height);
  if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  throw new Error("image-preprocess: no canvas implementation available");
}

async function encodeCanvas(canvas: AnyCanvas, type: string): Promise<Blob> {
  if ("convertToBlob" in canvas) {
    return canvas.convertToBlob({
      type,
      quality: type === "image/jpeg" ? 0.92 : undefined,
    });
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (result) => {
        if (result) resolve(result);
        else reject(new Error("image-preprocess: canvas encode failed"));
      },
      type,
      type === "image/jpeg" ? 0.92 : undefined,
    );
  });
}

/**
 * Best-effort wrapper for callers that must never fail: returns the original
 * blob if preprocessing is unavailable, and reports which path was taken.
 * Raw bytes still OCR (badly) — a degraded import beats a dead one.
 */
export async function tryPreprocessImageBlob(
  blob: Blob,
  options: PreprocessOptions = DEFAULT_OCR_PREPROCESS,
): Promise<{ result: PreprocessResult; preprocessed: boolean; error?: Error }> {
  try {
    const result = await preprocessImageBlob(blob, options);
    return { result, preprocessed: true };
  } catch (error) {
    return {
      result: { blob, width: 0, height: 0, scale: 1, durationMs: 0 },
      preprocessed: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}
