/**
 * "What can I cook?" coverage (ADR-0003 §B/§C).
 *
 * Confirms:
 *   - the hard-coded STAPLES list is matched as a case-insensitive substring
 *   - chips match ingredient items as case-insensitive substrings
 *   - a line is missing only when no chip and no staple covers it
 *   - ranking is ascending by missing count, stable on ties
 *   - empty chips pass the input order through unchanged
 *   - `parseChips`/`serializeChips` round-trip the URL param
 *   - `summarizeMissing` truncates badges after three items
 *
 * Pure-module tests only; the DB-backed seam lives in `search.test.ts`.
 */
import { describe, expect, it } from "vitest";
import {
  STAPLES,
  isStaple,
  matchesChip,
  missingItemsFor,
  parseChips,
  rankByMissing,
  serializeChips,
  summarizeMissing,
} from "./cook-now";

describe("STAPLES", () => {
  it("is a non-empty list of lowercase substring terms", () => {
    expect(STAPLES.length).toBeGreaterThan(20);
    expect(STAPLES.every((s) => s === s.toLowerCase())).toBe(true);
  });

  it("exempts common staple phrasings via substring", () => {
    expect(isStaple("salt")).toBe(true);
    expect(isStaple("Salt to taste")).toBe(true);
    expect(isStaple("olive oil")).toBe(true);
    expect(isStaple("2 large eggs")).toBe(true);
    expect(isStaple("chicken stock")).toBe(true);
    expect(isStaple("all-purpose flour")).toBe(true);
    expect(isStaple("baking powder")).toBe(true);
  });

  it("does not exempt a real shopping item", () => {
    expect(isStaple("chicken thighs")).toBe(false);
    expect(isStaple("basil")).toBe(false);
    expect(isStaple("lemons")).toBe(false);
  });
});

describe("matchesChip", () => {
  it("matches case-insensitive substrings", () => {
    expect(matchesChip("Chicken Thighs", "chicken")).toBe(true);
    expect(matchesChip("chicken thighs", "THIGH")).toBe(true);
    expect(matchesChip("rices", "rice")).toBe(true);
  });

  it("does not match unrelated text or a blank chip", () => {
    expect(matchesChip("chicken thighs", "beef")).toBe(false);
    expect(matchesChip("chicken thighs", "   ")).toBe(false);
  });
});

describe("missingItemsFor", () => {
  it("returns items covered by neither a chip nor a staple", () => {
    const missing = missingItemsFor(
      ["chicken thighs", "rice", "salt", "butter", "lemons"],
      ["chicken", "rice"],
    );
    expect(missing).toEqual(["lemons"]);
  });

  it("treats staples as never missing even with no matching chip", () => {
    expect(missingItemsFor(["olive oil", "salt", "black pepper"], ["x"])).toEqual(
      [],
    );
  });

  it("returns [] when no chips are active", () => {
    expect(missingItemsFor(["chicken thighs", "lemons"], [])).toEqual([]);
  });

  it("ignores blank item lines and trims output", () => {
    expect(missingItemsFor(["  ", "  lemons  "], ["garlic"])).toEqual([
      "lemons",
    ]);
  });
});

describe("rankByMissing", () => {
  const recipes = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];
  const items = new Map<number, string[]>([
    [1, ["salt", "lemons"]], // 1 missing
    [2, ["salt", "butter"]], // 0 missing
    [3, ["beef", "onions", "tomatoes"]], // 2 missing (onion is a staple)
    [4, ["flour", "water"]], // 0 missing
  ]);

  it("sorts ascending by missing count, preserving input order on ties", () => {
    const ranked = rankByMissing(recipes, items, ["rice"]);
    expect(ranked.map((r) => r.recipe.id)).toEqual([2, 4, 1, 3]);
    expect(ranked.map((r) => r.missingCount)).toEqual([0, 0, 1, 2]);
  });

  it("reports the missing item list for each recipe", () => {
    const ranked = rankByMissing(recipes, items, ["rice"]);
    const byId = new Map(ranked.map((r) => [r.recipe.id, r]));
    expect(byId.get(1)?.missingItems).toEqual(["lemons"]);
    expect(byId.get(3)?.missingItems).toEqual(["beef", "tomatoes"]);
    expect(byId.get(2)?.missingItems).toEqual([]);
  });

  it("passes the input order through unchanged with no chips", () => {
    const ranked = rankByMissing(recipes, items, []);
    expect(ranked.map((r) => r.recipe.id)).toEqual([1, 2, 3, 4]);
    expect(ranked.every((r) => r.missingCount === 0)).toBe(true);
    expect(ranked.every((r) => r.missingItems.length === 0)).toBe(true);
  });

  it("treats a recipe with no loaded items as complete", () => {
    const ranked = rankByMissing([{ id: 99 }], new Map(), ["lemons"]);
    expect(ranked[0]?.missingCount).toBe(0);
  });
});

describe("parseChips / serializeChips", () => {
  it("splits, trims, lower-cases, de-duplicates and drops blanks", () => {
    expect(parseChips(" Chicken , rice,,CHICKEN , ")).toEqual([
      "chicken",
      "rice",
    ]);
  });

  it("returns [] for null/undefined/empty", () => {
    expect(parseChips(null)).toEqual([]);
    expect(parseChips(undefined)).toEqual([]);
    expect(parseChips("")).toEqual([]);
  });

  it("round-trips through the URL param form", () => {
    const chips = parseChips("lemon, garlic");
    expect(chips).toEqual(["lemon", "garlic"]);
    expect(parseChips(serializeChips(chips))).toEqual(chips);
    expect(serializeChips([])).toBe("");
  });
});

describe("summarizeMissing", () => {
  it("shows everything when at most three items are missing", () => {
    expect(summarizeMissing(["a", "b"])).toEqual({
      shown: ["a", "b"],
      more: 0,
    });
  });

  it("truncates to the first three and counts the rest", () => {
    expect(summarizeMissing(["a", "b", "c", "d", "e"])).toEqual({
      shown: ["a", "b", "c"],
      more: 2,
    });
  });

  it("honours a custom max", () => {
    expect(summarizeMissing(["a", "b", "c"], 1)).toEqual({
      shown: ["a"],
      more: 2,
    });
  });
});
