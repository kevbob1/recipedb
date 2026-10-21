/**
 * Scan module: recognize-node — the Node OCR engine.
 *
 * NODE ONLY (`.server.ts`): tesseract.js runs in a worker and preprocessing uses
 * `sharp` (a native addon), neither of which can enter the browser build. The
 * browser recognizer stays in app/lib/ocr.ts (tesseract.js WASM on the client)
 * and app/lib/image-preprocess.ts (canvas); this module is the Node twin that
 * runs the same pixel pipeline and the same engine parameters.
 *
 * Two consumers:
 *   - `ingest` — one photo in, text/confidence/ms out. This is what
 *     `reocrRecipe` calls for POST /api/re-ocr, and
 *   - the tuning harness (`scripts/ocr-tune.ts`) + fixture tests, which reuse
 *     `createOcrSession`/`preprocessFixture` directly.
 *
 * Engine parameters are NOT re-declared here: `OcrParamOverrides` is derived
 * from `OCR_WORKER_PARAMS` (app/lib/ocr.ts) so the tuner can never drift from
 * what the browser capture path ships.
 */
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createWorker, PSM, type Worker } from "tesseract.js";
import { OCR_WORKER_PARAMS } from "../ocr";
import { preprocessFixture } from "./preprocess.server";
import type { Photo, ScanRun } from "./storage.server";

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

/**
 * Per-run engine parameter overrides. Derived from the shipped parameters, so a
 * knob added to `OCR_WORKER_PARAMS` is automatically sweepable and a typo'd name
 * is a type error instead of a silently ignored option.
 */
export type OcrParamOverrides = Partial<typeof OCR_WORKER_PARAMS>;

export interface OcrSession {
  recognize(
    image: Buffer | string,
    options?: { psm?: PSM; params?: OcrParamOverrides },
  ): Promise<ScanRun>;
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
    async recognize(image, overrides): Promise<ScanRun> {
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

/**
 * OCR a capture with the shipped preprocessing defaults and engine parameters.
 *
 * sharp re-encodes to a lossless PNG after orient + rescale + pixel work, so
 * tesseract never has to decode a camera JPEG itself.
 */
export async function ingest(photo: Photo): Promise<ScanRun> {
  const { png } = await preprocessFixture(photo.bytes);
  const session = await createOcrSession();
  try {
    return await session.recognize(png);
  } finally {
    await session.terminate();
  }
}
