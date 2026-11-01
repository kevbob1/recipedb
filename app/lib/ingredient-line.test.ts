/**
 * Ingredient line module — text truth in, numeric view out.
 *
 * These cases absorb the former quantity-parse / units / scaled-rows suites and
 * hang them on the module's public interface. The point of the module is that
 * `qtyAmount` & friends are always derived from `(qty, unit)`: there is no
 * "trust the carried parse" seam any more.
 */
import { describe, expect, it } from "vitest";

import {
  CANONICAL_UNITS,
  display,
  formatAmount,
  fromText,
  normalizeUnit,
  scale,
  setQty,
  type ScaledIngredientSource,
} from "./ingredient-line";

const closeTo = (value: number | null, expected: number) => {
  expect(value).not.toBeNull();
  expect(Math.abs((value as number) - expected)).toBeLessThan(1e-9);
};

describe("fromText — simple values", () => {
  it("reads integers and decimals", () => {
    expect(fromText("2")).toMatchObject({ qtyAmount: 2, qtyAmount2: null, qtyParseStatus: "parsed" });
    expect(fromText("1.25")).toMatchObject({ qtyAmount: 1.25, qtyParseStatus: "parsed" });
    expect(fromText("0.5")).toMatchObject({ qtyAmount: 0.5, qtyParseStatus: "parsed" });
  });

  it("reads simple fractions and mixed numbers", () => {
    closeTo(fromText("1/2").qtyAmount, 0.5);
    closeTo(fromText("1 1/2").qtyAmount, 1.5);
    closeTo(fromText("2 3/4").qtyAmount, 2.75);
    expect(fromText("1/2").qtyParseStatus).toBe("parsed");
  });

  it("ignores a hedge word but keeps the number", () => {
    expect(fromText("about 2").qtyAmount).toBe(2);
    expect(fromText("approx. 1.5").qtyAmount).toBe(1.5);
  });

  it("keeps the text exactly as given", () => {
    expect(fromText(" 2 ", "cups")).toMatchObject({ qty: " 2 ", unit: "cups" });
  });
});

describe("fromText — unicode fractions", () => {
  it("expands vulgar fractions glued to a whole number", () => {
    closeTo(fromText("1\u00bd").qtyAmount, 1.5);
    closeTo(fromText("2\u00bc").qtyAmount, 2.25);
    closeTo(fromText("1\u2153").qtyAmount, 1 + 1 / 3);
    closeTo(fromText("3\u215b").qtyAmount, 3.125);
  });

  it("expands a bare vulgar fraction and the fraction slash", () => {
    closeTo(fromText("\u00bd").qtyAmount, 0.5);
    closeTo(fromText("\u00be").qtyAmount, 0.75);
    closeTo(fromText("\u215e").qtyAmount, 7 / 8);
    closeTo(fromText("1\u20442").qtyAmount, 0.5);
  });
});

describe("fromText — ranges", () => {
  it("splits hyphen, en dash, em dash and the word 'to'", () => {
    expect(fromText("2-3")).toMatchObject({ qtyAmount: 2, qtyAmount2: 3, qtyParseStatus: "range" });
    expect(fromText("2\u20133")).toMatchObject({ qtyAmount: 2, qtyAmount2: 3, qtyParseStatus: "range" });
    expect(fromText("2 \u2014 3")).toMatchObject({ qtyAmount: 2, qtyAmount2: 3, qtyParseStatus: "range" });
    expect(fromText("2 to 3")).toMatchObject({ qtyAmount: 2, qtyAmount2: 3, qtyParseStatus: "range" });
  });

  it("splits ranges of fractions", () => {
    const r = fromText("1/2 - 3/4");
    closeTo(r.qtyAmount, 0.5);
    closeTo(r.qtyAmount2, 0.75);
    expect(r.qtyParseStatus).toBe("range");
  });

  it("is unparseable when either end makes no sense", () => {
    expect(fromText("2-").qtyParseStatus).toBe("unparseable");
    expect(fromText("1/0").qtyParseStatus).toBe("unparseable");
  });
});

describe("fromText — units", () => {
  it("normalizes the unit column", () => {
    expect(fromText("2", "cups")).toMatchObject({
      qtyAmount: 2,
      qtyUnitNormalized: "cup",
      qtyParseStatus: "parsed",
    });
    expect(fromText("2-3", "cloves")).toMatchObject({
      qtyAmount: 2,
      qtyAmount2: 3,
      qtyUnitNormalized: "clove",
      qtyParseStatus: "range",
    });
  });

  it("keeps an unknown unit null without failing the number", () => {
    expect(fromText("2", "blorps")).toMatchObject({
      qtyAmount: 2,
      qtyUnitNormalized: null,
      qtyParseStatus: "parsed",
    });
  });

  it("recovers a unit glued into the qty field", () => {
    expect(fromText("2 cups")).toMatchObject({
      qtyAmount: 2,
      qtyUnitNormalized: "cup",
      qtyParseStatus: "parsed",
    });
    expect(fromText("2 cups", "cups")).toMatchObject({
      qtyAmount: 2,
      qtyUnitNormalized: "cup",
      qtyParseStatus: "parsed",
    });
    // Unknown trailing word: do not trust the number, mark the row.
    expect(fromText("2 blorps").qtyParseStatus).toBe("unparseable");
  });

  it("defaults a missing unit to null", () => {
    expect(fromText("2")).toMatchObject({ unit: null, qtyUnitNormalized: null });
  });
});

describe("fromText — unparseables", () => {
  it("marks words, empty and junk as unparseable and invents no number", () => {
    for (const text of ["a pinch", "to taste", "", "   ", "some", "a few", "1/0", "pinch"]) {
      const line = fromText(text);
      expect(line.qtyAmount).toBeNull();
      expect(line.qtyAmount2).toBeNull();
      expect(line.qtyParseStatus).toBe("unparseable");
    }
  });

  it("handles nullish input", () => {
    expect(fromText(null).qtyParseStatus).toBe("unparseable");
    expect(fromText(undefined).qtyParseStatus).toBe("unparseable");
  });

  it("returns null for a zero denominator", () => {
    expect(fromText("3/0").qtyAmount).toBeNull();
    closeTo(fromText("3/4").qtyAmount, 0.75);
  });
});

describe("setQty — derived numerics reset on any text change", () => {
  const line = fromText("2", "cups");
  // Pretend the line carries numbers from somewhere else (a stale draft, a
  // crafted payload). setQty must not trust them.
  const stale = {
    ...line,
    qtyAmount: 999,
    qtyAmount2: 999,
    qtyUnitNormalized: "bogus",
    qtyParseStatus: "range" as const,
  };

  it("re-derives when only the qty changes", () => {
    expect(setQty(stale, "3", "cups")).toMatchObject({
      qty: "3",
      unit: "cups",
      qtyAmount: 3,
      qtyAmount2: null,
      qtyUnitNormalized: "cup",
      qtyParseStatus: "parsed",
    });
  });

  it("re-derives when only the unit changes", () => {
    expect(setQty(stale, "2", "tbsp")).toMatchObject({
      qty: "2",
      unit: "tbsp",
      qtyAmount: 2,
      qtyAmount2: null,
      qtyUnitNormalized: "tbsp",
      qtyParseStatus: "parsed",
    });
  });

  it("clears the numbers when the new text has none", () => {
    expect(setQty(stale, "a pinch", null)).toMatchObject({
      qtyAmount: null,
      qtyAmount2: null,
      qtyUnitNormalized: null,
      qtyParseStatus: "unparseable",
    });
  });

  it("keeps the rest of a draft row untouched", () => {
    const draftRow = { ...stale, item: "flour", note: "sifted" as string | null };
    expect(setQty(draftRow, "1/2", null)).toMatchObject({
      item: "flour",
      note: "sifted",
      qtyAmount: 0.5,
      qtyParseStatus: "parsed",
    });
  });
});

describe("normalizeUnit", () => {
  it("maps aliases to canonical tokens", () => {
    expect(normalizeUnit("cups")).toBe("cup");
    expect(normalizeUnit("Cup")).toBe("cup");
    expect(normalizeUnit("tablespoons")).toBe("tbsp");
    expect(normalizeUnit("Tbsp.")).toBe("tbsp");
    expect(normalizeUnit("oz")).toBe("oz");
    expect(normalizeUnit("ounces")).toBe("oz");
    expect(normalizeUnit("cloves")).toBe("clove");
    expect(normalizeUnit("grams")).toBe("g");
  });

  it("returns null for unknown and empty units instead of guessing", () => {
    expect(normalizeUnit("  fluid   oz. ")).toBeNull(); // unknown alias, not guessed
    expect(normalizeUnit(" lbs ")).toBe("lb");
    expect(normalizeUnit(null)).toBeNull();
    expect(normalizeUnit(undefined)).toBeNull();
    expect(normalizeUnit("")).toBeNull();
    expect(normalizeUnit("   ")).toBeNull();
    expect(normalizeUnit("blorps")).toBeNull();
  });

  it("exposes every canonical token, deduplicated", () => {
    expect(CANONICAL_UNITS).toContain("tsp");
    expect(CANONICAL_UNITS).toContain("clove");
    expect(new Set(CANONICAL_UNITS).size).toBe(CANONICAL_UNITS.length);
  });
});

describe("formatAmount", () => {
  it("phrases kitchen-friendly fractions", () => {
    expect(formatAmount(0.5)).toBe("1/2");
    expect(formatAmount(1.25)).toBe("1 1/4");
    expect(formatAmount(3)).toBe("3");
    expect(formatAmount(1.5)).toBe("1 1/2");
    expect(formatAmount(1 / 3)).toBe("1/3");
    expect(formatAmount(2 / 3)).toBe("2/3");
    expect(formatAmount(0.375)).toBe("3/8");
  });

  it("falls back to a trimmed decimal when no nice fraction fits", () => {
    expect(formatAmount(2.4)).toBe("2.4");
    expect(formatAmount(0.7)).toBe("0.7");
  });
});

describe("scale", () => {
  const line = (qty: string, unit: string | null = null) => ({ qty, unit });

  it("multiplies a single value", () => {
    expect(scale(line("2"), 2)).toMatchObject({ display: "4", scaled: true });
    expect(scale(line("2 cups"), 0.5)).toMatchObject({ display: "1", scaled: true });
    expect(scale(line("1 1/2"), 2)).toMatchObject({ display: "3", scaled: true });
    expect(scale(line("1/4"), 2)).toMatchObject({ display: "1/2", scaled: true });
    expect(scale(line("0.5"), 3)).toMatchObject({ display: "1 1/2", scaled: true });
  });

  it("multiplies both ends of a range", () => {
    expect(scale(line("2-3"), 3)).toMatchObject({ display: "6\u20139", scaled: true });
    expect(scale(line("1/2-3/4"), 2)).toMatchObject({ display: "1\u20131 1/2", scaled: true });
  });

  it("shows the stored text verbatim at 1x", () => {
    expect(scale(line("1 1/2 cups"), 1)).toMatchObject({
      display: "1 1/2 cups",
      scaled: true,
    });
  });

  it("marks unparseable rows instead of inventing a number", () => {
    const scaled = scale(line("a pinch"), 2);
    expect(scaled.scaled).toBe(false);
    expect(scaled.display).toBe("a pinch");
    expect(scaled.mark).toBe("scaling not applied");
  });

  it("derives from the text even when the object carries a stale numeric view", () => {
    const stale = {
      qty: "2-3",
      unit: "cloves",
      qtyAmount: 999,
      qtyAmount2: 999,
      qtyUnitNormalized: "bogus",
      qtyParseStatus: "parsed" as const,
    };
    expect(scale(stale, 2).display).toBe("4\u20136");
  });
});

describe("display — the multiplier view", () => {
  /** Lasagne-ish rows: one with a derived view carried from loadDraft, one
   * only carrying text, one that cannot be scaled at all. */
  const lasagne: ScaledIngredientSource[] = [
    {
      qty: "1",
      unit: "tbsp",
      item: "olive oil",
      note: null,
    },
    {
      qty: "1/2",
      unit: "cup",
      item: "grated parmesan",
      note: "or pecorino",
    },
    {
      qty: "a pinch",
      unit: null,
      item: "nutmeg",
      note: null,
    },
  ];

  it("renders the stored qty verbatim at 1x", () => {
    expect(display(lasagne, 1).map((r) => r.display)).toEqual([
      "1",
      "1/2",
      "a pinch",
    ]);
  });

  it("doubles the rendered quantity at 2x (olive oil: 1 tbsp -> 2 tbsp)", () => {
    const rows = display(lasagne, 2);
    expect(rows[0]!.display).toBe("2");
    expect(rows[0]!.unit).toBe("tbsp");
    expect(rows[0]!.item).toBe("olive oil");
    expect(rows[0]!.scaled).toBe(true);
    expect(rows[1]!.display).toBe("1"); // 1/2 cup -> 1 cup
    expect(rows[1]!.note).toBe("or pecorino");
  });

  it("leaves an unscalable row verbatim and marks it", () => {
    const row = display(lasagne, 2)[2]!;
    expect(row.display).toBe("a pinch");
    expect(row.scaled).toBe(false);
    expect(row.mark).toBe("scaling not applied");
  });

  it("triples at 3x and halves at 1/2x", () => {
    expect(display(lasagne, 3)[0]!.display).toBe("3");
    expect(display(lasagne, 0.5)[1]!.display).toBe("1/4");
  });

  it("falls back to the unit recovered from the qty text", () => {
    const row = display([{ qty: "2 cups", unit: null, item: "flour", note: null }], 2)[0]!;
    expect(row.display).toBe("4");
    expect(row.unit).toBe("cup");
  });
});

describe("display — US ⇄ metric conversion", () => {
  it("defaults to US customary, matching an explicit 'us'", () => {
    const rows = [{ qty: "1", unit: "cup", item: "milk", note: null }];
    expect(display(rows, 2)).toEqual(display(rows, 2, "us"));
    expect(display(rows, 2)[0]).toMatchObject({ display: "2", unit: "cup" });
  });

  it("scales first, then converts (2 x 1 cup = 473.18 ml)", () => {
    const rows = display([{ qty: "1", unit: "cup", item: "milk", note: null }], 2, "metric");
    expect(rows[0]).toMatchObject({ display: "473.18", unit: "ml", scaled: true });
  });

  it("converts even at 1x, because the system is the only thing changing", () => {
    expect(display([{ qty: "1", unit: "cup" }], 1, "metric")[0]).toMatchObject({
      display: "236.59",
      unit: "ml",
    });
    expect(display([{ qty: "1", unit: "lb" }], 1, "metric")[0]).toMatchObject({
      display: "453.59",
      unit: "g",
    });
    // A unit already in the target system keeps its stored spelling at 1x.
    expect(display([{ qty: "500", unit: "ml" }], 1, "metric")[0]).toMatchObject({
      display: "500",
      unit: "ml",
    });
  });

  it("converts both ends of a range to one unit", () => {
    const row = display([{ qty: "1-2", unit: "cups" }], 1, "metric")[0]!;
    expect(row.display).toBe("236.59\u2013473.18");
    expect(row.unit).toBe("ml");
  });

  it("keeps US fractions through the existing formatAmount path", () => {
    expect(display([{ qty: "295.735", unit: "ml" }], 1, "us")[0]).toMatchObject({
      display: "1 1/4",
      unit: "cup",
    });
    expect(display([{ qty: "354.882", unit: "ml" }], 1, "us")[0]).toMatchObject({
      display: "1 1/2",
      unit: "cup",
    });
    // Below one cup the ladder steps down to spoons (118.294 ml = 8 tbsp).
    expect(display([{ qty: "118.294", unit: "ml" }], 1, "us")[0]).toMatchObject({
      display: "8",
      unit: "tbsp",
    });
    // Same-system rows still scale (and phrase) as before.
    expect(display([{ qty: "1/2", unit: "cup" }], 2, "us")[0]!.display).toBe("1");
  });

  it("leaves counts, cans, unknown units and unparseable text untouched", () => {
    const rows = [
      { qty: "2", unit: null, item: "eggs", note: null },
      { qty: "1", unit: "can", item: "tomatoes", note: null },
      { qty: "2", unit: "blorps", item: "mystery", note: null },
      { qty: "a pinch", unit: null, item: "nutmeg", note: null },
    ];
    for (const system of ["us", "metric"] as const) {
      const out = display(rows, 2, system);
      // Scaling still applies to counts (2 eggs x2 = 4); conversion does not.
      expect(out.map((row) => row.display)).toEqual(["4", "2", "4", "a pinch"]);
      expect(out.map((row) => row.unit)).toEqual(["", "can", "blorps", ""]);
      expect(out[3]!.scaled).toBe(false);
      expect(out[3]!.mark).toBe("scaling not applied");
    }
  });

  it("never mutates the input lines", () => {
    const rows = [
      { qty: "1", unit: "cup", item: "milk", note: null },
      { qty: "1/2-3/4", unit: "tbsp", item: "vanilla", note: "good stuff" },
      { qty: "a pinch", unit: null, item: "salt", note: null },
    ];
    const before = JSON.stringify(rows);
    display(rows, 2, "metric");
    display(rows, 2, "us");
    expect(JSON.stringify(rows)).toBe(before);
  });
});

