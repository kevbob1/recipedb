/**
 * Client-side OCR — tesseract.js.
 *
 * Ticket #5: snap-photo OCR runs in the browser. The camera bytes are read as a
 * Blob from the input/camera stream and handed to tesseract.js, so the person
 * sees text before anything leaves the page.
 *
 * Amended by #28: the ORIGINAL capture is no longer discarded. It is kept in
 * the Add flow's state and uploaded (multipart, untouched) with the draft when
 * the person saves; the server stores it under DATA_DIR/images/<id>/ and points
 * recipes.image_filename at it so OCR can be re-run later. Deleting the recipe
 * deletes the capture. This module still does not write to disk and is not the
 * code that stores anything — it only recognizes. Server-side re-OCR lives in
 * the Scan module (app/lib/scan).
 *
 * SEAM: this module stays OUTSIDE app/lib/scan/ on purpose. The Scan module is
 * Node-only (`sharp` + node:fs), while this one ships to the browser, so the
 * shared surface is app/lib/image-ops.ts (pixels) plus OCR_WORKER_PARAMS below
 * (engine params) — not a shared module tree. `ocrTextToDraft`/`guessCategory`
 * also stay here: turning text into a draft is the deferred Draft-import seam
 * (docs/adr/0001), not a scan concern.
 *
 * Why tesseract.js runs in the browser: tesseract.js is a WASM build. It
 * doesn't fit the React Router server runtime without a dedicated process and a
 * shipped language model, and the photo already lives in the page for capture.
 * The Node side uses the same engine parameters (OCR_WORKER_PARAMS) and pixel
 * pipeline (app/lib/image-ops.ts) for re-OCR, so tuning carries over.
 *
 * Preprocessing happens here, client-side, on a canvas — NOT with `sharp`.
 * `sharp` is a native Node addon and cannot run in the browser bundle; it is
 * used only by the Node tuning harness and tests (scripts/, *.test.ts). The
 * browser path is app/lib/image-preprocess.ts (canvas) and the pixel work it
 * shares with the harness is app/lib/image-ops.ts. Passing raw phone photos
 * straight to tesseract produced garbled text: small soft print, dim indoor
 * lighting and a 12MP frame with no upscaling. `scripts/ocr-tune.ts` measures
 * the difference on the fixture photos.
 */

import { createWorker, PSM, type Worker } from "tesseract.js";
import type {
  DraftIngredient,
  DraftStep,
  RecipeDraft,
} from "./draft";
import {
  CATEGORIES,
  type Category,
  type Confidence,
  blankDraft,
} from "./draft";
import {
  DEFAULT_OCR_PREPROCESS,
  type PreprocessOptions,
} from "./image-ops";
import { tryPreprocessImageBlob } from "./image-preprocess";
import { trimOnlyRequired } from "./normalize";

/**
 * Tesseract engine parameters shared by the browser worker and the Node
 * tuning harness, so what Kevin measures in `scripts/ocr-tune.ts` is what the
 * app actually runs.
 *
 * - `tessedit_pageseg_mode`: AUTO (3). Measured on the fixtures: AUTO recovered
 *   more ingredient rows than SINGLE_BLOCK (mean 10.0 vs 7.0 lines) at equal
 *   confidence, because these photos catch two-page spreads and recipe cards
 *   with side notes — layouts that SINGLE_BLOCK assumes away.
 * - `preserve_interword_spaces`: keeps `2 tbsp soy sauce` from collapsing into
 *   `2tbspsoysauce`, which the quantity parser needs.
 * - `user_defined_dpi`: phone photos carry no DPI; without this tesseract
 *   guesses (often 70) and skips its scale heuristics.
 * - `tessedit_char_blacklist`: `|`, `~` and backtick are never real recipe
 *   characters, and are the classic misreads of `l`/`I`/`1`.
 */
export const OCR_WORKER_PARAMS = {
  tessedit_pageseg_mode: PSM.AUTO,
  preserve_interword_spaces: "1",
  user_defined_dpi: "300",
  tessedit_char_blacklist: "|~`",
};

export interface RecognizeOptions {
  /**
   * Set false to OCR the raw bytes — used by the tuning script and fixture
   * tests to quantify what preprocessing buys.
   */
  preprocess?: boolean;
  /** Override the preprocessing knobs (see DEFAULT_OCR_PREPROCESS). */
  preprocessOptions?: PreprocessOptions;
  /** Page segmentation mode; defaults to OCR_WORKER_PARAMS. */
  psm?: PSM;
  lang?: string;
  /** tesseract.js status/progress callback (quiet by default). */
  onProgress?: (status: string, progress: number) => void;
}

/**
 * Run OCR on an in-memory image Blob. Returns the raw recognized text.
 * Does not touch disk; the Blob is consumed and dropped. When canvas
 * preprocessing is unavailable the raw bytes are OCR'd rather than failing.
 */
export async function recognizeText(
  blob: Blob,
  options: RecognizeOptions = {},
): Promise<string> {
  const { psm, lang = "eng", onProgress } = options;
  const worker: Worker = await createWorker(lang, undefined, {
    // Quiet by default; tesseract.js is chatty.
    logger: onProgress
      ? (message) => onProgress(message.status, message.progress)
      : () => {},
  });
  try {
    await worker.setParameters({
      ...OCR_WORKER_PARAMS,
      ...(psm === undefined ? {} : { tessedit_pageseg_mode: psm }),
    });

    const source =
      options.preprocess === false
        ? { blob, width: 0, height: 0, scale: 1, durationMs: 0 }
        : (
            await tryPreprocessImageBlob(
              blob,
              options.preprocessOptions ?? DEFAULT_OCR_PREPROCESS,
            )
          ).result;

    const url = URL.createObjectURL(source.blob);
    try {
      const { data } = await worker.recognize(url);
      return (data.text ?? "").replace(/\r/g, "");
    } finally {
      URL.revokeObjectURL(url);
    }
  } finally {
    await worker.terminate();
  }
}

/**
 * Turn raw OCR text into a RecipeDraft by splitting it into ingredients and
 * steps heuristically. The parser is intentionally simple — it exists to
 * land the imported text in the review screen with sensible defaults. The
 * real review work happens in the UI.
 */
export function ocrTextToDraft(rawText: string): RecipeDraft {
  const lines = rawText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const ingredients: DraftIngredient[] = [];
  const steps: DraftStep[] = [];
  let mode: "ingredients" | "steps" | "unknown" = "unknown";

  for (const line of lines) {
    const lower = line.toLowerCase();
    const looksStep = /^\d+[\.\)]\s+/.test(line) || /^\bstep\b/i.test(line);
    const looksIngredient =
      mode === "ingredients" ||
      (!looksStep && /[a-zA-Z]/.test(line) && /[0-9¼½¾⅓⅔]/.test(line));

    if (/^\b(ingredients|you('| wi)ll need)\b/i.test(line)) {
      mode = "ingredients";
      continue;
    }
    if (/^\b(instructions|directions|method|steps?)\b/i.test(line)) {
      mode = "steps";
      continue;
    }
    if (line.length > 140) continue; // body paragraphs are noise

    if (mode === "ingredients" || (mode === "unknown" && looksIngredient)) {
      mode = "ingredients";
      ingredients.push(ingredientFromRawLine(line, "warn"));
    } else if (mode === "steps" || (mode === "unknown" && looksStep)) {
      mode = "steps";
      const text = line.replace(/^\d+[\.\)]\s+/, "").replace(/^step\s*\d*:?\s*/i, "");
      steps.push({ position: steps.length + 1, text: trimOnlyRequired(text) });
    }
  }

  // Best-effort title: first non-numeric, short line.
  let title = "";
  let titleConfidence: Confidence = "bad";
  for (const line of lines) {
    if (line.length < 4 || line.length > 80) continue;
    if (/^\d/.test(line)) continue;
    if (/ingredient|instruction|method|direction/i.test(line)) continue;
    title = line;
    titleConfidence = "warn";
    break;
  }

  const draft: RecipeDraft = {
    ...blankDraft(),
    title,
    titleConfidence,
    sourceType: "scan",
    sourceUrl: null,
    rawOcrText: rawText,
    ingredients,
    steps,
  };
  return draft;
}

function ingredientFromRawLine(
  text: string,
  confidence: Confidence,
): DraftIngredient {
  return {
    text,
    qty: "",
    unit: null,
    item: text,
    note: null,
    confidence,
  };
}

/** Best-effort category detection from the title or raw text. */
export function guessCategory(text: string): Category {
  const lower = text.toLowerCase();
  if (/\b(soup|stew|chili|broth)\b/.test(lower)) return "soup";
  if (/\b(salad|slaw)\b/.test(lower)) return "salad";
  if (/\b(bread|focaccia|baguette|bun|roll|sourdough)\b/.test(lower)) return "bread";
  if (/\b(cookies?|biscuit)\b/.test(lower)) return "cookies";
  if (/\b(cake|torte|gateau)\b/.test(lower)) return "cake";
  if (/\b(pie|tart|crumble)\b/.test(lower)) return "pie";
  if (/\b(dessert|pudding|custard|mousse)\b/.test(lower)) return "dessert";
  if (/\b(one[- ]pot|one[- ]dish|skillet|casserole|main)\b/.test(lower)) return "one-dish";
  if ((CATEGORIES as readonly string[]).includes(lower)) {
    return lower as Category;
  }
  return "other";
}
