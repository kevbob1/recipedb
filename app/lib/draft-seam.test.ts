/**
 * Seam guard — the Draft + Ingredient-line interface has one doorway.
 *
 * Two regressions are silent until something breaks in the browser:
 *  1. a route reaching past app/lib/draft.ts into the ingredient-line
 *     implementation, so the text-truth invariant loses its single doorway;
 *  2. a numeric field creeping onto DraftIngredient, so a stale parse could
 *     outlive the qty text it was derived from.
 *
 * The first is a static scan of the two browser callers, the second is both a
 * compile-time assertion (below) and a runtime check.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as draft from "./draft";
import * as implementation from "./ingredient-line";
import {
  trimOnly as trimOnlyFromOwner,
  trimOnlyRequired as trimOnlyRequiredFromOwner,
} from "./normalize";
import { type DraftIngredient, fromText, setQty } from "./draft";

const routeSource = (file: string) =>
  readFileSync(new URL(`../routes/${file}`, import.meta.url), "utf8");
const draftSource = readFileSync(
  new URL("./draft.ts", import.meta.url),
  "utf8",
);

/** Fails to compile if a numeric view ever appears on the draft shape. */
type NumericField =
  | "qtyAmount"
  | "qtyAmount2"
  | "qtyUnitNormalized"
  | "qtyParseStatus";
type NumericOnDraft = Extract<keyof DraftIngredient, NumericField>;
const draftCarriesNoNumerics: [NumericOnDraft] extends [never] ? true : false =
  true;

describe("draft seam", () => {
  it("routes import ingredient-line helpers from lib/draft only", () => {
    for (const file of ["review-editor.tsx", "add.tsx"]) {
      const source = routeSource(file);
      expect(source).not.toMatch(/from\s+["'][^"']*ingredient-line["']/);
      expect(source).toMatch(/from\s+["']\.\.\/lib\/draft["']/);
    }

    // The editor really does use the seam (not just: "it compiles").
    const editor = routeSource("review-editor.tsx");
    for (const helper of ["display", "formatAmount", "fromText", "setQty"]) {
      expect(editor).toMatch(new RegExp(`\\b${helper}\\b`));
    }
  });

  it("draft.ts re-exports the ingredient-line interface, not a copy", () => {
    expect(draft.fromText).toBe(implementation.fromText);
    expect(draft.setQty).toBe(implementation.setQty);
    expect(draft.scale).toBe(implementation.scale);
    expect(draft.display).toBe(implementation.display);
    expect(draft.formatAmount).toBe(implementation.formatAmount);
    expect(draft.normalizeUnit).toBe(implementation.normalizeUnit);
    expect(draft.QTY_PARSE_STATUSES).toBe(implementation.QTY_PARSE_STATUSES);
  });

  it("trimOnly has one owner — normalize.ts — and draft.ts just re-exports it", () => {
    expect(draft.trimOnly).toBe(trimOnlyFromOwner);
    expect(draft.trimOnlyRequired).toBe(trimOnlyRequiredFromOwner);
    expect(draftSource).not.toMatch(/function\s+trimOnly/);
  });

  it("a direct spread edit cannot desync numerics — the draft carries text only", () => {
    expect(draftCarriesNoNumerics).toBe(true);

    const ingredient: DraftIngredient = {
      text: "2 cups flour",
      qty: "2",
      unit: "cup",
      item: "flour",
      note: null,
      confidence: "ok",
    };

    // Naive edit: spread the draft line and change the text.
    const edited = { ...ingredient, qty: "3" };
    expect("qtyAmount" in edited).toBe(false);
    expect("qtyParseStatus" in edited).toBe(false);

    // The numeric view is re-derived at the point of use, never carried.
    expect(fromText(ingredient.qty, ingredient.unit).qtyAmount).toBe(2);
    expect(fromText(edited.qty, edited.unit).qtyAmount).toBe(3);

    // Extra fields ride along the edit path untouched.
    const line = setQty(edited, "1 1/2", "cup");
    expect(line.qtyAmount).toBe(1.5);
    expect(line.item).toBe("flour");
  });

  it("spreading a derived line and editing qty is re-derived by setQty", () => {
    // Spreading an IngredientLine copies its numeric view, so editing the text
    // there WOULD go stale — which is exactly why setQty exists.
    const stale = { ...fromText("2", "cup"), qty: "4" };
    expect(stale.qtyAmount).toBe(2);
    expect(setQty(stale, "4", "cup").qtyAmount).toBe(4);
  });
});
