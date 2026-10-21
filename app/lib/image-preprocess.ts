/**
 * Browser-side OCR image preprocessing (canvas + `createImageBitmap`).
 *
 * The preprocessed Blob never leaves the page: we decode the original, draw it
 * to a canvas, run the shared pixel pipeline from app/lib/image-ops.ts, and hand
 * tesseract a *new* Blob. The original capture itself is retained by the app
 * (uploaded once on save, #28), but this preprocessing output is never sent
 * anywhere.
 *
 * Why preprocessing at all: tesseract.js on a raw 12MP phone photo of a
 * printed page sees small, soft, unevenly lit glyphs and returns garbage
 * (`rn`/`m`, `l`/`1`/`I`, dropped spaces). Auto-orient + upscaling the short
 * side to ~2400px + grayscale + normalize + unsharp is what moves it from
 * "garbled" to "recognizable"; see scripts/ocr-tune.ts for the measurement.
 *
 * SEAM: this file is intentionally NOT part of app/lib/scan/. That module is
 * Node-only (it imports `sharp` and node:fs), and `sharp` is a native addon that
 * cannot enter the client bundle. The two halves share only the pixel contract
 * in app/lib/image-ops.ts, which is what keeps browser preprocessing and the
 * Node re-OCR path — and the tuning harness measuring both — in step.
 *
 * This module must stay DOM-only — no Node imports (`sharp` lives in the Scan
 * module and tests only, never in the app bundle).
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
  // `AnyCanvas` is a union, so `getContext` widens to every rendering context.
  // Narrow it to the 2d contexts this pipeline draws with.
  const ctx = canvas.getContext("2d", { willReadFrequently: true }) as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null;
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

  // Always lossless PNG: tesseract is handed pixels, not a photo, and a lossy
  // re-encode is exactly the artifact the pixel pipeline just removed. (The old
  // split — JPEG-0.92 when thresholding was off — made the encode format depend
  // on a tuning knob, so two variants differed by compression as well as by
  // pixels.)
  const outBlob = await encodeCanvas(canvas);

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

/**
 * Encode the preprocessed canvas as a lossless PNG. Both branches take the same
 * path so the browser and the Node twin (app/lib/scan/preprocess.server.ts, via
 * sharp) hand tesseract the same bytes semantics.
 */
async function encodeCanvas(canvas: AnyCanvas): Promise<Blob> {
  if ("convertToBlob" in canvas) {
    return canvas.convertToBlob({ type: "image/png" });
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (result) => {
        if (result) resolve(result);
        else reject(new Error("image-preprocess: canvas encode failed"));
      },
      "image/png",
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
