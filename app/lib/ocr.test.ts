/**
 * OCR text → draft parser tests.
 *
 * `recognizeText` itself is hard to unit-test (it would need a real
 * tesseract.js worker + WASM model). The text-to-draft split logic is what
 * the review screen actually depends on, so that's what we cover here — via
 * the scan adapter of the unified Draft factory (docs/adr/0002).
 */
import { describe, expect, it } from "vitest";
import { createDraft } from "./import";
import { guessCategory } from "./ocr";
import { trimOnly } from "./normalize";

function scan(text: string) {
  return createDraft({ kind: "scan", text });
}

describe("scan adapter (OCR text → draft)", () => {
  it("returns a scan-source draft", () => {
    const draft = scan("Anything");
    expect(draft.sourceType).toBe("scan");
    expect(draft.rawOcrText).toBe("Anything");
    expect(draft.sourceUrl).toBeNull();
  });

  it("captures the raw OCR text verbatim", () => {
    const text = "   weirdly\n\nspaced    text   ";
    const draft = scan(text);
    expect(draft.rawOcrText).toBe(text);
  });

  it("extracts ingredients under an Ingredients heading", () => {
    const text = [
      "Recipe Title",
      "Ingredients",
      "1 lb beef",
      "2 onions",
      "Instructions",
      "Brown the beef.",
    ].join("\n");
    const draft = scan(text);
    expect(draft.ingredients.length).toBe(2);
    expect(draft.ingredients[0]!.text).toBe("1 lb beef");
    expect(draft.steps.length).toBe(1);
    expect(draft.steps[0]!.text).toBe("Brown the beef.");
  });

  it("extracts numbered steps into DraftStep rows with positions", () => {
    const text = [
      "Title",
      "1. Heat oven to 350.",
      "2. Mix dry ingredients.",
    ].join("\n");
    const draft = scan(text);
    expect(draft.steps.length).toBe(2);
    expect(draft.steps[0]!.position).toBe(1);
    expect(draft.steps[1]!.position).toBe(2);
  });

  it("picks the first short non-numeric line as the title", () => {
    const text = "1 2 3\nApple Pie\nIngredients\nx";
    const draft = scan(text);
    expect(draft.title).toBe("Apple Pie");
    expect(draft.titleConfidence).toBe("warn");
  });

  it("always uses trim-only normalization on step text", () => {
    const text = "  Step  \n  Ingredients  \n   1 cup  flour   ";
    const draft = scan(text);
    for (const s of draft.steps) {
      expect(s.text).toBe(trimOnly(s.text));
    }
  });
});

describe("guessCategory", () => {
  it("maps common words to the MVP closed list", () => {
    expect(guessCategory("Chicken Soup")).toBe("soup");
    expect(guessCategory("Caesar Salad")).toBe("salad");
    expect(guessCategory("Sourdough Bread")).toBe("bread");
    expect(guessCategory("Chocolate Cake")).toBe("cake");
    expect(guessCategory("Apple Pie")).toBe("pie");
    expect(guessCategory("Sugar Cookies")).toBe("cookies");
    expect(guessCategory("Tiramisu Dessert")).toBe("dessert");
    expect(guessCategory("One-Pot Pasta")).toBe("one-dish");
  });
  it("falls back to 'other' for unknown text", () => {
    expect(guessCategory("Mystery Loaf")).toBe("other");
  });
});
