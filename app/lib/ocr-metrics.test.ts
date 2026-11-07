/**
 * OCR quality metrics — the shared scoring used by the tuning harness and the
 * fixture regression tests.
 *
 * Pure string work, so the whole module is directly testable; these cases pin
 * the three things the score claims to measure: character plausibility,
 * alphabetic content, and ingredient-row recovery (including tesseract's
 * bullet-glyph noise).
 */
import { describe, expect, it } from "vitest";

import { ingredientLikeLines, scoreOcrText } from "./ocr-metrics";

describe("scoreOcrText", () => {
  it("scores empty text as zero without dividing by zero", () => {
    expect(scoreOcrText("")).toEqual({
      chars: 0,
      alphaRatio: 0,
      garbageRatio: 1,
      words: 0,
      meanWordLength: 0,
      longTokenRatio: 0,
      ingredientLines: 0,
      score: 0,
    });
  });

  it("ignores whitespace when counting characters", () => {
    const quality = scoreOcrText("  a b\t c\n");
    expect(quality.chars).toBe(3);
    expect(quality.alphaRatio).toBe(1);
    expect(quality.garbageRatio).toBe(0);
    expect(quality.words).toBe(3);
    expect(quality.meanWordLength).toBe(1);
  });

  it("counts characters outside the recipe charset as garbage", () => {
    const quality = scoreOcrText("abc€\u0000");
    expect(quality.chars).toBe(5);
    expect(quality.garbageRatio).toBe(0.4);
    expect(quality.alphaRatio).toBe(0.6);
    // 0.4 * 0.6 + 0.3 * 0.6 + 0.3 * 0 = 0.42.
    expect(quality.score).toBe(0.42);
  });

  it("treats digits, fractions and punctuation as plausible characters", () => {
    const quality = scoreOcrText("½ cup (120 ml), 2-3 tbsp; 50% & salt.");
    expect(quality.garbageRatio).toBe(0);
  });

  it("flags long tokens as the garble signature", () => {
    const quality = scoreOcrText(
      "supercalifragilisticexpialidocious an extraordinarilylongtoken yes",
    );
    expect(quality.words).toBe(4);
    expect(quality.longTokenRatio).toBe(0.5);
    expect(quality.meanWordLength).toBe(15.75);
  });

  it("counts ingredient-shaped lines and saturates the coverage term at three", () => {
    const quality = scoreOcrText(
      ["1 onion", "2 tbsp oil", "½ tsp salt", "a pinch of pepper"].join("\n"),
    );
    expect(quality.ingredientLines).toBe(4);
    // ingredientLines / 3 is clamped to 1.
    expect(quality.score).toBeCloseTo(0.4 * 1 + 0.3 * quality.alphaRatio + 0.3, 3);
  });

  it("rounds derived ratios to three decimals", () => {
    const quality = scoreOcrText("aaa bb c");
    expect(quality.alphaRatio).toBe(1);
    // 6 chars / 3 words = 2.
    expect(quality.meanWordLength).toBe(2);
    expect(quality.score).toBe(0.7);
  });
});

describe("ingredientLikeLines", () => {
  it("recognizes numeric, fraction, article and bullet rows", () => {
    expect(
      ingredientLikeLines(
        ["2 onions", "½ tsp salt", "a pinch of pepper", "some butter", "• 3 eggs", "- flour", "* sugar"].join(
          "\n",
        ),
      ),
    ).toEqual([
      "2 onions",
      "½ tsp salt",
      "a pinch of pepper",
      "some butter",
      "3 eggs",
      // Only a stray glyph is stripped; a real bullet marker stays.
      "- flour",
      "* sugar",
    ]);
  });

  it("strips a stray tesseract glyph before a quantity", () => {
    expect(ingredientLikeLines("e 1 egg, well-beaten")).toEqual(["1 egg, well-beaten"]);
    expect(ingredientLikeLines("© 2 cups flour")).toEqual(["2 cups flour"]);
    expect(ingredientLikeLines("# ½ tsp salt")).toEqual(["½ tsp salt"]);
    expect(ingredientLikeLines("I 3 carrots")).toEqual(["3 carrots"]);
  });

  it("strips a stray glyph before an article", () => {
    expect(ingredientLikeLines("© a pinch of salt")).toEqual(["a pinch of salt"]);
  });

  it("keeps rows that start with a letter (they may be ingredients too)", () => {
    expect(ingredientLikeLines("flour, sifted")).toEqual([]);
  });

  it("drops rows with no letters, shorter than 3 or longer than 80 characters", () => {
    const tooLong = `1 ${"x".repeat(80)}`;
    expect(
      ingredientLikeLines(
        ["1 2 3", "a", "  ", tooLong, "2 eggs"].join("\n"),
      ),
    ).toEqual(["2 eggs"]);
  });

  it("handles CRLF line endings and trims rows", () => {
    expect(ingredientLikeLines("  2 eggs  \r\n1 cup milk\r\n")).toEqual([
      "2 eggs",
      "1 cup milk",
    ]);
  });
});
