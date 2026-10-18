import { describe, expect, it } from "vitest";
import { CANONICAL_UNITS, canonicalUnitFromWord, normalizeUnit } from "./units";

describe("unit normalization", () => {
  it("maps plural and full-word spellings to one canonical token", () => {
    expect(normalizeUnit("cups")).toBe("cup");
    expect(normalizeUnit("Cup")).toBe("cup");
    expect(normalizeUnit("tablespoons")).toBe("tbsp");
    expect(normalizeUnit("Tbsp.")).toBe("tbsp");
    expect(normalizeUnit("oz")).toBe("oz");
    expect(normalizeUnit("ounces")).toBe("oz");
    expect(normalizeUnit("cloves")).toBe("clove");
    expect(normalizeUnit("grams")).toBe("g");
  });

  it("collapses whitespace and strips stray periods", () => {
    expect(normalizeUnit("  fluid   oz. ")).toBeNull(); // unknown alias, not guessed
    expect(normalizeUnit(" lbs ")).toBe("lb");
  });

  it("returns null for empty and unknown units (never invents a unit)", () => {
    expect(normalizeUnit(null)).toBeNull();
    expect(normalizeUnit(undefined)).toBeNull();
    expect(normalizeUnit("")).toBeNull();
    expect(normalizeUnit("   ")).toBeNull();
    expect(normalizeUnit("blorps")).toBeNull();
  });

  it("canonicalUnitFromWord is the same lookup (for units glued into qty)", () => {
    expect(canonicalUnitFromWord("cups")).toBe("cup");
    expect(canonicalUnitFromWord("sprockets")).toBeNull();
  });

  it("exposes the canonical vocabulary", () => {
    expect(CANONICAL_UNITS).toContain("tsp");
    expect(CANONICAL_UNITS).toContain("clove");
    expect(new Set(CANONICAL_UNITS).size).toBe(CANONICAL_UNITS.length);
  });
});
