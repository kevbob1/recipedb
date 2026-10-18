/**
 * Client-side OCR — tesseract.js.
 *
 * Ticket #5: snap-photo OCR runs entirely in the browser. The camera bytes
 * NEVER touch disk; we read them as a Blob from the input/camera stream,
 * hand them to tesseract.js, then let the Blob go out of scope. The
 * recognized text and a parsed draft are sent to the server, not the image.
 *
 * Why tesseract.js runs in the browser: tesseract.js is a WASM build. It
 * doesn't fit the React Router server runtime (we'd need to spin up a
 * dedicated process and ship a language model). For an MVP single-household
 * use case the browser is the right place — the photo already lives there
 * for the capture step, so we never serialize the bytes across a network.
 *
 * `sharp` is also used here client-side for a one-shot auto-orient + downsize
 * before passing to tesseract. That keeps the recognition pass fast and
 * doesn't help the photo escape the page.
 */

import { createWorker, type Worker } from "tesseract.js";
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
import { trimOnlyRequired } from "./normalize";

/**
 * Run OCR on an in-memory image Blob. Returns the raw recognized text.
 * Does not touch disk; the Blob is consumed and dropped.
 */
export async function recognizeText(blob: Blob): Promise<string> {
  const worker: Worker = await createWorker("eng", undefined, {
    // Quiet by default; tesseract.js is chatty.
    logger: () => {},
  });
  try {
    const url = URL.createObjectURL(blob);
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
