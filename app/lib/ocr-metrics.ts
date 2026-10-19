/**
 * Heuristic quality metrics for raw OCR text.
 *
 * These exist to make "did preprocessing help?" a number instead of an
 * opinion. They are diagnostics only — nothing in the app's review flow
 * depends on them — but both `scripts/ocr-tune.ts` (Kevin's tuning loop) and
 * `app/lib/ocr.fixtures.test.ts` (regression guard on real fixture photos)
 * score text through this one module, so the two can never disagree.
 *
 * Browser-safe: pure string work, no imports.
 */

export interface OcrQuality {
  chars: number;
  /** Fraction of non-space characters that are letters. */
  alphaRatio: number;
  /** Fraction of non-space characters outside the plausible recipe charset. */
  garbageRatio: number;
  words: number;
  meanWordLength: number;
  /** Fraction of words longer than 14 characters — the usual garble signature. */
  longTokenRatio: number;
  /** Lines that look like ingredient rows (`2 onions`, `½ tsp salt`, `- flour`). */
  ingredientLines: number;
  /** Composite 0..1 score, higher is better. See `scoreOcrText` for weights. */
  score: number;
}

const ALLOWED = /[A-Za-z0-9 .,;:!'"()[\]/&%*°#½¼¾⅓⅔⅛⅜⅝⅞-]/;
const LETTER = /[A-Za-z]/;
const DIGIT = /[0-9]/;

/** Lines that plausibly start an ingredient row. */
const INGREDIENT_LINE =
  /^(?:\d|½|¼|¾|⅓|⅔|⅛|⅜|⅝|⅞|a |an |some |[•*-]\s)/i;

/**
 * tesseract routinely prefixes a bullet glyph that it reads as a stray
 * character: `e 1 egg, well-beaten`, `© 2 cups flour`, `# 1 tsp salt`. The row
 * is a perfectly good ingredient; only the prefix is noise. Strip it before
 * deciding, otherwise the metric tracks tesseract's bullet handling instead of
 * whether the ingredient was recovered.
 */
function stripBulletJunk(line: string): string {
  const strayBeforeQuantity = /^(?:[^\w\s]{1,3}|[A-Za-z])\s+(?=\d|[½¼¾⅓⅔⅛⅜⅝⅞])/.exec(line);
  if (strayBeforeQuantity) return line.slice(strayBeforeQuantity[0].length);
  const strayBeforeWord = /^[^\w\s]{1,3}\s+(?=(?:a|an|some)\s)/i.exec(line);
  if (strayBeforeWord) return line.slice(strayBeforeWord[0].length);
  return line;
}

export function ingredientLikeLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => stripBulletJunk(line.trim()))
    .filter((line) => line.length >= 3 && line.length <= 80)
    .filter((line) => INGREDIENT_LINE.test(line) && LETTER.test(line));
}

export function scoreOcrText(text: string): OcrQuality {
  const compact = text.replace(/\s+/g, "");
  const chars = compact.length;

  let letters = 0;
  let digits = 0;
  let garbage = 0;
  for (const ch of compact) {
    if (LETTER.test(ch)) letters++;
    else if (DIGIT.test(ch)) digits++;
    if (!ALLOWED.test(ch)) garbage++;
  }

  const tokens = text
    .split(/\s+/)
    .filter((token) => LETTER.test(token));
  const words = tokens.length;
  const meanWordLength =
    words === 0 ? 0 : tokens.reduce((acc, t) => acc + t.length, 0) / words;
  const longTokenRatio =
    words === 0
      ? 0
      : tokens.filter((t) => t.length > 14).length / words;

  const ingredientLines = ingredientLikeLines(text).length;
  const alphaRatio = chars === 0 ? 0 : letters / chars;
  const garbageRatio = chars === 0 ? 1 : garbage / chars;

  // Weights: overall character plausibility dominates; ingredient-row coverage
  // matters because that is what the import flow actually consumes.
  const score =
    chars === 0
      ? 0
      : 0.4 * (1 - garbageRatio) +
        0.3 * alphaRatio +
        0.3 * Math.min(1, ingredientLines / 3);

  return {
    chars,
    alphaRatio: round3(alphaRatio),
    garbageRatio: round3(garbageRatio),
    words,
    meanWordLength: round3(meanWordLength),
    longTokenRatio: round3(longTokenRatio),
    ingredientLines,
    score: round3(score),
  };
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
