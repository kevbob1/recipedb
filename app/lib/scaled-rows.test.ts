/**
 * The review UI's scaled rows — the pure render path the multiplier buttons
 * feed. Regression guard for #26: tapping 2× must change the *rendered*
 * quantity of every row that carries a number.
 */
import { describe, expect, it } from "vitest";

import { scaledIngredientRows, type ScaledIngredientSource } from "./quantity-parse";

/** Lasagne-ish rows: one with the derived parse already stored (as loadDraft
 * serves it), one only carrying text, one that cannot be scaled at all. */
const lasagne: ScaledIngredientSource[] = [
  {
    qty: "1",
    unit: "tbsp",
    item: "olive oil",
    note: null,
    qtyAmount: 1,
    qtyAmount2: null,
    qtyUnitNormalized: "tbsp",
    qtyParseStatus: "parsed",
  },
  {
    qty: "1/2",
    unit: "cup",
    item: "grated parmesan",
    note: "or pecorino",
    qtyParseStatus: "unparsed",
  },
  {
    qty: "a pinch",
    unit: null,
    item: "nutmeg",
    note: null,
    qtyParseStatus: "unparseable",
  },
];

describe("scaledIngredientRows", () => {
  it("renders the stored qty verbatim at 1x", () => {
    expect(scaledIngredientRows(lasagne, 1).map((r) => r.display)).toEqual([
      "1",
      "1/2",
      "a pinch",
    ]);
  });

  it("doubles the rendered quantity at 2x (olive oil: 1 tbsp -> 2 tbsp)", () => {
    const rows = scaledIngredientRows(lasagne, 2);
    expect(rows[0]!.display).toBe("2");
    expect(rows[0]!.unit).toBe("tbsp");
    expect(rows[0]!.item).toBe("olive oil");
    expect(rows[0]!.scaled).toBe(true);

    // Parsed on the spot from text, because this row carries no derived parse.
    expect(rows[1]!.display).toBe("1"); // 1/2 cup -> 1 cup
    expect(rows[1]!.note).toBe("or pecorino");
  });

  it("leaves an unscalable row verbatim and marks it", () => {
    const row = scaledIngredientRows(lasagne, 2)[2]!;
    expect(row.display).toBe("a pinch");
    expect(row.scaled).toBe(false);
    expect(row.mark).toBe("scaling not applied");
  });

  it("triples at 3x and halves at 1/2x", () => {
    expect(scaledIngredientRows(lasagne, 3)[0]!.display).toBe("3");
    expect(scaledIngredientRows(lasagne, 0.5)[1]!.display).toBe("1/4");
  });
});
