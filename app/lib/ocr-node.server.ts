/**
 * Node-side OCR harness helpers — used by `scripts/ocr-tune.ts` and
 * app/lib/ocr.fixtures.test.ts.
 *
 * NODE ONLY, hence the `.server.ts` suffix: React Router excludes `.server`
 * modules from the client bundle, so `sharp` (a native addon) can never be
 * pulled into the browser build. The browser pipeline lives in
 * app/lib/image-preprocess.ts. What *is* shared is the part that matters for
 * tuning: the pixel pipeline (app/lib/image-ops.ts `preprocessPixels`) and the
 * engine parameters (app/lib/ocr.ts `OCR_WORKER_PARAMS`). Preprocessing a
 * fixture here therefore exercises exactly the code the browser runs, with
 * sharp standing in for the canvas decode/encode.
 */

import { existsSync, mkdirSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createWorker, PSM, type Worker } from "tesseract.js";
import sharp from "sharp";
import {
  DEFAULT_OCR_PREPROCESS,
  computeScale,
  preprocessPixels,
  type PreprocessOptions,
  type RgbaImage,
} from "./image-ops";
import { OCR_WORKER_PARAMS } from "./ocr";

export const FIXTURE_DIR = "tests/fixtures/ocr";

/** Fixture photos shipped with the repo, sorted for stable output. */
export function fixturePaths(dir: string = FIXTURE_DIR): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /\.(jpe?g|png)$/i.test(name))
    .sort()
    .map((name) => path.join(dir, name));
}

/**
 * Recursively collect stored captures (DATA_DIR/images/<recipeId>/original.*)
 * so `scripts/ocr-tune.ts --dir` can sweep real retained scans. Sorted for
 * stable output.
 */
export function collectImagePaths(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.(jpe?g|png|webp)$/i.test(entry.name)) {
        out.push(full);
      }
    }
  };
  walk(dir);
  return out.sort();
}

/** Where tesseract.js caches eng.traineddata. Never the repo root. */
export function defaultCachePath(): string {
  return process.env.OCR_TESSDATA_CACHE ??
    path.join(os.tmpdir(), "opencode", "tesseract-cache");
}

/** Optional explicit traineddata location (offline / air-gapped runs). */
function langPathOverride(): string | undefined {
  const dir = process.env.OCR_LANG_PATH;
  return dir && existsSync(dir) ? dir : undefined;
}

export interface PreprocessedFixture {
  /** Lossless PNG of the preprocessed image. */
  png: Buffer;
  width: number;
  height: number;
  scale: number;
}

/**
 * Decode a fixture with sharp (honouring EXIF orientation, like the browser
 * `createImageBitmap({imageOrientation: "from-image"})`), rescale with
 * lanczos3, then run the shared pixel pipeline and re-encode losslessly.
 *
 * `resize: false` keeps the source resolution and runs only the pixel
 * pipeline — the knob that separates "the rescale hurt" from "the contrast /
 * normalize / sharpen hurt" when tuning.
 */
export async function preprocessFixture(
  file: string,
  options: PreprocessOptions = DEFAULT_OCR_PREPROCESS,
  resize = true,
): Promise<PreprocessedFixture> {
  const metadata = await sharp(file).metadata();
  const srcWidth = metadata.width ?? 0;
  const srcHeight = metadata.height ?? 0;
  if (srcWidth === 0 || srcHeight === 0) {
    throw new Error(`ocr-node: could not read dimensions from ${file}`);
  }

  // `.rotate()` with no argument applies EXIF orientation (which is why the
  // source dimensions above are only used for the scale decision).
  const scale = resize ? computeScale(srcWidth, srcHeight, options) : 1;
  const width = Math.max(1, Math.round(srcWidth * scale));
  const height = Math.max(1, Math.round(srcHeight * scale));

  const { data, info } = await sharp(file)
    .rotate()
    .resize(width, height, { kernel: "lanczos3" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const image: RgbaImage = {
    data: new Uint8ClampedArray(data),
    width: info.width,
    height: info.height,
  };
  preprocessPixels(image, options);

  const png = await sharp(Buffer.from(image.data), {
    raw: { width: info.width, height: info.height, channels: 4 },
  })
    .png()
    .toBuffer();

  return { png, width: info.width, height: info.height, scale };
}

/** Auto-orient only — the "cheap fixes, no rescale/contrast" control variant. */
export async function autoOrientOnly(file: string): Promise<Buffer> {
  return sharp(file).rotate().png().toBuffer();
}

export interface OcrRun {
  text: string;
  /** tesseract's overall confidence, 0..100. */
  confidence: number;
  ms: number;
}

/**
 * The engine parameters the tuner sweeps per variant. Deliberately narrow:
 * these are the ones with a measurement-backed effect on phone photos.
 */
export interface OcrParamOverrides {
  /** "300" (default), or "0" to let tesseract guess from the image. */
  user_defined_dpi?: string;
  preserve_interword_spaces?: string;
  tessedit_char_blacklist?: string;
}

export interface OcrSession {
  recognize(
    image: Buffer | string,
    options?: { psm?: PSM; params?: OcrParamOverrides },
  ): Promise<OcrRun>;
  terminate(): Promise<void>;
}

/**
 * One reusable worker for a whole tuning run: creating a worker reloads and
 * re-initializes the WASM model, which dominates runtime otherwise.
 */
export async function createOcrSession(
  options: {
    lang?: string;
    onProgress?: (status: string, progress: number) => void;
    cachePath?: string;
  } = {},
): Promise<OcrSession> {
  const cachePath = options.cachePath ?? defaultCachePath();
  mkdirSync(cachePath, { recursive: true });

  const worker: Worker = await createWorker(options.lang ?? "eng", undefined, {
    cachePath,
    ...(langPathOverride() ? { langPath: langPathOverride() } : {}),
    logger: options.onProgress
      ? (message) => options.onProgress!(message.status, message.progress)
      : () => {},
  });

  await worker.setParameters(OCR_WORKER_PARAMS);

  return {
    async recognize(image, overrides): Promise<OcrRun> {
      if (overrides) {
        await worker.setParameters({
          ...OCR_WORKER_PARAMS,
          ...overrides.params,
          ...(overrides.psm === undefined
            ? {}
            : { tessedit_pageseg_mode: overrides.psm }),
        });
      }
      const started = Date.now();
      const { data } = await worker.recognize(image);
      return {
        text: (data.text ?? "").replace(/\r/g, ""),
        confidence: data.confidence ?? 0,
        ms: Date.now() - started,
      };
    },
    async terminate() {
      await worker.terminate();
    },
  };
}
