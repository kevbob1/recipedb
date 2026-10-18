import { describe, expect, it } from "vitest";
import {
  formatAmount,
  normalizeQuantityText,
  parseNumericToken,
  parseQuantity,
  resolveQuantity,
  scaleQuantity,
} from "./quantity-parse";

const closeTo = (value: number | null, expected: number) => {
  expect(value).not.toBeNull();
  expect(Math.abs((value as number) - expected)).toBeLessThan(1e-9);
};

describe("parseQuantity — simple values", () => {
  it("reads integers and decimals", () => {
    expect(parseQuantity("2")).toMatchObject({ amount: 2, amount2: null, status: "parsed" });
    expect(parseQuantity("1.25")).toMatchObject({ amount: 1.25, status: "parsed" });
    expect(parseQuantity("0.5")).toMatchObject({ amount: 0.5, status: "parsed" });
  });

  it("reads simple fractions and mixed numbers", () => {
    closeTo(parseQuantity("1/2").amount, 0.5);
    closeTo(parseQuantity("1 1/2").amount, 1.5);
    closeTo(parseQuantity("2 3/4").amount, 2.75);
    expect(parseQuantity("1/2").status).toBe("parsed");
  });

  it("ignores a hedge word but keeps the number", () => {
    expect(parseQuantity("about 2").amount).toBe(2);
    expect(parseQuantity("approx. 1.5").amount).toBe(1.5);
  });
});

describe("parseQuantity — unicode fractions", () => {
  it("expands vulgar fractions glued to a whole number", () => {
    closeTo(parseQuantity("1\u00bd").amount, 1.5);
    closeTo(parseQuantity("2\u00bc").amount, 2.25);
    closeTo(parseQuantity("1\u2153").amount, 1 + 1 / 3);
    closeTo(parseQuantity("3\u215b").amount, 3.125);
  });

  it("expands a bare vulgar fraction", () => {
    closeTo(parseQuantity("\u00bd").amount, 0.5);
    closeTo(parseQuantity("\u00be").amount, 0.75);
    closeTo(parseQuantity("\u215e").amount, 7 / 8);
    expect(normalizeQuantityText("\u00bd")).toBe("1/2");
    expect(normalizeQuantityText("1\u20442")).toBe("1/2");
  });
});

describe("parseQuantity — ranges", () => {
  it("splits hyphen, en dash, em dash and the word 'to'", () => {
    expect(parseQuantity("2-3")).toMatchObject({ amount: 2, amount2: 3, status: "range" });
    expect(parseQuantity("2\u20133")).toMatchObject({ amount: 2, amount2: 3, status: "range" });
    expect(parseQuantity("2 \u2014 3")).toMatchObject({ amount: 2, amount2: 3, status: "range" });
    expect(parseQuantity("2 to 3")).toMatchObject({ amount: 2, amount2: 3, status: "range" });
  });

  it("splits ranges of fractions", () => {
    const r = parseQuantity("1/2 - 3/4");
    closeTo(r.amount, 0.5);
    closeTo(r.amount2, 0.75);
    expect(r.status).toBe("range");
  });

  it("is unparseable when either end makes no sense", () => {
    expect(parseQuantity("2-").status).toBe("unparseable");
    expect(parseQuantity("1/0").status).toBe("unparseable");
  });
});

describe("parseQuantity — units", () => {
  it("normalizes the unit column", () => {
    expect(parseQuantity("2", "cups")).toMatchObject({
      amount: 2,
      unitNormalized: "cup",
      status: "parsed",
    });
    expect(parseQuantity("2-3", "cloves")).toMatchObject({
      amount: 2,
      amount2: 3,
      unitNormalized: "clove",
      status: "range",
    });
  });

  it("keeps an unknown unit null without failing the number", () => {
    expect(parseQuantity("2", "blorps")).toMatchObject({
      amount: 2,
      unitNormalized: null,
      status: "parsed",
    });
  });

  it("recovers a unit glued into the qty field", () => {
    expect(parseQuantity("2 cups")).toMatchObject({
      amount: 2,
      unitNormalized: "cup",
      status: "parsed",
    });
    expect(parseQuantity("2 cups", "cups")).toMatchObject({
      amount: 2,
      unitNormalized: "cup",
      status: "parsed",
    });
    // Unknown trailing word: do not trust the number, mark the row.
    expect(parseQuantity("2 blorps").status).toBe("unparseable");
  });
});

describe("parseQuantity — unparseables", () => {
  it("marks words, empty and junk as unparseable and invents no number", () => {
    for (const text of ["a pinch", "to taste", "", "   ", "some", "a few", "1/0", "pinch"]) {
      const p = parseQuantity(text);
      expect(p.amount).toBeNull();
      expect(p.amount2).toBeNull();
      expect(p.status).toBe("unparseable");
    }
  });

  it("handles nullish input", () => {
    expect(parseQuantity(null).status).toBe("unparseable");
    expect(parseQuantity(undefined).status).toBe("unparseable");
  });

  it("parseNumericToken returns null for junk and zero denominators", () => {
    expect(parseNumericToken("1/0")).toBeNull();
    expect(parseNumericToken("a pinch")).toBeNull();
    closeTo(parseNumericToken("3/4"), 0.75);
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

describe("scaleQuantity", () => {
  it("multiplies a single value", () => {
    expect(scaleQuantity("2", 2)).toMatchObject({ display: "4", scaled: true });
    expect(scaleQuantity("2 cups", 0.5)).toMatchObject({ display: "1", scaled: true });
    expect(scaleQuantity("1 1/2", 2)).toMatchObject({ display: "3", scaled: true });
    expect(scaleQuantity("1/4", 2)).toMatchObject({ display: "1/2", scaled: true });
    expect(scaleQuantity("0.5", 3)).toMatchObject({ display: "1 1/2", scaled: true });
  });

  it("multiplies both ends of a range", () => {
    expect(scaleQuantity("2-3", 3)).toMatchObject({ display: "6\u20139", scaled: true });
    expect(scaleQuantity("1/2-3/4", 2)).toMatchObject({ display: "1\u20131 1/2", scaled: true });
  });

  it("shows the stored text verbatim at 1x", () => {
    expect(scaleQuantity("1 1/2 cups", 1)).toMatchObject({
      display: "1 1/2 cups",
      scaled: true,
    });
  });

  it("marks unparseable rows instead of inventing a number", () => {
    const scaled = scaleQuantity("a pinch", 2);
    expect(scaled.scaled).toBe(false);
    expect(scaled.display).toBe("a pinch");
    expect(scaled.mark).toBe("scaling not applied");
  });

  it("uses a carried parse when the row already has one", () => {
    const carried = resolveQuantity({
      qty: "2-3",
      qtyAmount: 2,
      qtyAmount2: 3,
      qtyUnitNormalized: "clove",
      qtyParseStatus: "range",
    });
    expect(carried).toMatchObject({ amount: 2, amount2: 3, unitNormalized: "clove", status: "range" });
    expect(scaleQuantity("2-3", 2, carried).display).toBe("4\u20136");
  });
});

describe("resolveQuantity — the write-path seam", () => {
  it("trusts a complete stored parse", () => {
    expect(
      resolveQuantity({ qty: "2", qtyAmount: 2, qtyParseStatus: "parsed", unit: "cups" }),
    ).toMatchObject({ amount: 2, unitNormalized: "cup", status: "parsed" });
  });

  it("re-parses a row reset by a manual qty edit (status unparsed)", () => {
    expect(resolveQuantity({ qty: "3", qtyParseStatus: "unparsed", qtyAmount: null })).toMatchObject({
      amount: 3,
      status: "parsed",
    });
  });

  it("re-parses when a carried range is incomplete", () => {
    expect(
      resolveQuantity({ qty: "2-3", qtyAmount: 2, qtyAmount2: null, qtyParseStatus: "range" }),
    ).toMatchObject({ amount: 2, amount2: 3, status: "range" });
  });

  it("re-parses rows with no stored status at all", () => {
    expect(resolveQuantity({ qty: "1/2", unit: "cup" })).toMatchObject({
      amount: 0.5,
      unitNormalized: "cup",
      status: "parsed",
    });
  });
});
