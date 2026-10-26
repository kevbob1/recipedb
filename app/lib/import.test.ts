/**
 * Unified Draft factory tests (docs/adr/0002).
 *
 * One seam, three adapters. Each test asserts that the adapter — not its
 * caller — stamps provenance and initial confidence, so a route can never
 * double-stamp a draft that already carries them.
 */
import { describe, expect, it } from "vitest";
import { createDraft, type ScrapedRecipeData } from "./import";

const scraperData: ScrapedRecipeData = {
  title: "  Chicken Soup  ",
  categoryKeywords: ["Soup", "Dinner"],
  yields: "  4 servings ",
  tags: ["Soup", "dinner", "soup", "Quick"],
  ingredients: [
    {
      text: "1 lb chicken",
      qty: "1",
      unit: "lb",
      item: "chicken",
      note: null,
      confidence: "ok",
    },
  ],
  steps: [{ position: 1, text: "Simmer everything." }],
  raw: '{"title":"Chicken Soup"}',
};

describe("createDraft — url adapter", () => {
  it("stamps url provenance and normalizes scraper data", () => {
    const draft = createDraft({
      kind: "url",
      url: "https://example.test/soup",
      data: scraperData,
      imageFilename: "42/original.webp",
    });

    expect(draft.sourceType).toBe("url");
    expect(draft.sourceUrl).toBe("https://example.test/soup");
    expect(draft.rawOcrText).toBeNull();
    expect(draft.imageFilename).toBe("42/original.webp");
    expect(draft.title).toBe("Chicken Soup");
    expect(draft.titleConfidence).toBe("ok");
    expect(draft.category).toBe("soup");
    expect(draft.categoryConfidence).toBe("ok");
    expect(draft.yield).toBe("4 servings");
    expect(draft.yieldConfidence).toBe("ok");
    expect(draft.tags).toEqual(["soup", "dinner", "quick"]);
    expect(draft.ingredients).toEqual(scraperData.ingredients);
    expect(draft.steps).toEqual(scraperData.steps);
    expect(draft.raw).toBe(scraperData.raw);
    expect(draft.favorite).toBe(false);
  });

  it("keeps an empty page untrusted instead of guessing", () => {
    const draft = createDraft({
      kind: "url",
      url: "https://example.test/empty",
      data: {
        title: "",
        categoryKeywords: [],
        yields: null,
        tags: [],
        ingredients: [],
        steps: [],
      },
    });

    expect(draft.titleConfidence).toBe("bad");
    expect(draft.category).toBe("other");
    expect(draft.categoryConfidence).toBe("warn");
    expect(draft.yield).toBeNull();
    expect(draft.yieldConfidence).toBe("bad");
    expect(draft.imageFilename).toBeNull();
    expect(draft.raw).toBeUndefined();
  });

  it("ignores caller-supplied provenance: input carries data only", () => {
    // A structural proxy for the double-stamp bug: UrlDraftInput has no
    // sourceType field, so nothing a caller passes can overwrite the stamp.
    const input = {
      kind: "url" as const,
      url: "https://example.test/soup",
      data: scraperData,
    };
    expect(createDraft(input).sourceType).toBe("url");
    expect(Object.keys(input)).not.toContain("sourceType");
  });
});

describe("createDraft — scan adapter", () => {
  it("stamps scan provenance, raw text, and the category guess", () => {
    const text = [
      "Chicken Soup",
      "Ingredients",
      "1 lb chicken",
      "Instructions",
      "Simmer everything.",
    ].join("\n");
    const draft = createDraft({
      kind: "scan",
      text,
      imageFilename: "42/original.png",
    });

    expect(draft.sourceType).toBe("scan");
    expect(draft.sourceUrl).toBeNull();
    expect(draft.rawOcrText).toBe(text);
    expect(draft.imageFilename).toBe("42/original.png");
    expect(draft.title).toBe("Chicken Soup");
    expect(draft.titleConfidence).toBe("warn");
    expect(draft.category).toBe("soup");
    expect(draft.categoryConfidence).toBe("ok");
    expect(draft.ingredients).toHaveLength(1);
    expect(draft.steps).toHaveLength(1);
  });

  it("defaults the retained capture to null", () => {
    const draft = createDraft({ kind: "scan", text: "Anything" });
    expect(draft.imageFilename).toBeNull();
    expect(draft.rawOcrText).toBe("Anything");
  });
});

describe("createDraft — manual adapter", () => {
  it("produces a provenance-complete blank manual draft", () => {
    const draft = createDraft({ kind: "manual" });

    expect(draft.sourceType).toBe("manual");
    expect(draft.sourceUrl).toBeNull();
    expect(draft.rawOcrText).toBeNull();
    expect(draft.imageFilename).toBeNull();
    expect(draft.title).toBe("");
    expect(draft.titleConfidence).toBe("bad");
    expect(draft.category).toBe("other");
    expect(draft.categoryConfidence).toBe("ok");
    expect(draft.yield).toBeNull();
    expect(draft.yieldConfidence).toBe("bad");
    expect(draft.tags).toEqual([]);
    expect(draft.ingredients).toEqual([]);
    expect(draft.steps).toEqual([]);
    expect(draft.favorite).toBe(false);
  });

  it("returns a fresh object per call", () => {
    const a = createDraft({ kind: "manual" });
    const b = createDraft({ kind: "manual" });
    a.tags.push("mutated");
    expect(b.tags).toEqual([]);
  });
});
