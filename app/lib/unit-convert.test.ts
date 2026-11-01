/**
 * Unit conversion table — the display-time US ⇄ metric seam (ADR-0003 §A).
 *
 * These cases pin the factors, the fixed output-unit policy, the rounding
 * rules and every fallback the review screen relies on. Anything convertible
 * must stay same-dimension: a count, an unknown token or a cross-dimension
 * guess comes back null so the caller renders the stored text verbatim.
 */
import { describe, expect, it } from "vitest";

import {
  convert,
  convertRange,
  isConvertibleUnit,
  unitSystem,
} from "./unit-convert";

describe("factors — US to metric", () => {
  it("converts volume through ml", () => {
    expect(convert(1, "tsp", "metric")).toEqual({ amount: 4.93, unit: "ml" });
    expect(convert(1, "tbsp", "metric")).toEqual({ amount: 14.79, unit: "ml" });
    expect(convert(1, "cup", "metric")).toEqual({ amount: 236.59, unit: "ml" });
    expect(convert(1, "pint", "metric")).toEqual({ amount: 473.18, unit: "ml" });
    expect(convert(1, "quart", "metric")).toEqual({ amount: 946.35, unit: "ml" });
    expect(convert(1, "gallon", "metric")).toEqual({ amount: 3785.41, unit: "ml" });
  });

  it("converts weight through g", () => {
    expect(convert(1, "oz", "metric")).toEqual({ amount: 28.35, unit: "g" });
    expect(convert(1, "lb", "metric")).toEqual({ amount: 453.59, unit: "g" });
  });

  it("scales an amount before choosing the unit", () => {
    expect(convert(2, "cup", "metric")).toEqual({ amount: 473.18, unit: "ml" });
    expect(convert(3, "tsp", "metric")).toEqual({ amount: 14.79, unit: "ml" });
    expect(convert(0.5, "tsp", "metric")).toEqual({ amount: 2.46, unit: "ml" });
  });
});

describe("output unit policy", () => {
  it("keeps metric output fixed at ml / g", () => {
    // 1000 ml does NOT flip to 1 l: the number only moves when the system does.
    expect(convert(1000, "ml", "metric")).toEqual({ amount: 1000, unit: "ml" });
    expect(convert(1, "l", "metric")).toEqual({ amount: 1, unit: "l" });
    expect(convert(1, "kg", "metric")).toEqual({ amount: 1, unit: "kg" });
  });

  it("picks the largest US unit that keeps the value at or above 1", () => {
    expect(convert(500, "ml", "us")?.unit).toBe("cup");
    expect(convert(500, "ml", "us")?.amount).toBeCloseTo(2.1134, 3);
    expect(convert(15, "ml", "us")?.unit).toBe("tbsp");
    expect(convert(15, "ml", "us")?.amount).toBeCloseTo(1.0144, 3);
    expect(convert(5, "ml", "us")?.unit).toBe("tsp");
    expect(convert(5, "ml", "us")?.amount).toBeCloseTo(1.0144, 3);
    // Too small for tsp: stay on the ladder's smallest unit.
    expect(convert(2, "ml", "us")?.unit).toBe("tsp");
    expect(convert(2, "ml", "us")?.amount).toBeCloseTo(0.4058, 3);
    // Large enough for gallon; pint/quart are input-only units.
    expect(convert(4000, "ml", "us")?.unit).toBe("gallon");
    expect(convert(1000, "ml", "us")?.unit).toBe("cup");
  });

  it("converts weight to lb when it reaches a pound, else oz", () => {
    expect(convert(453.592, "g", "us")).toEqual({ amount: 1, unit: "lb" });
    expect(convert(100, "g", "us")?.unit).toBe("oz");
    expect(convert(100, "g", "us")?.amount).toBeCloseTo(3.5274, 3);
  });

  it("returns a same-system unit untouched", () => {
    expect(convert(2, "cup", "us")).toEqual({ amount: 2, unit: "cup" });
    expect(convert(2.5, "oz", "us")).toEqual({ amount: 2.5, unit: "oz" });
    expect(convert(750, "ml", "metric")).toEqual({ amount: 750, unit: "ml" });
  });
});

describe("non-convertible units", () => {
  it("returns null for counts, unknown tokens and a missing unit", () => {
    expect(convert(2, "clove", "metric")).toBeNull();
    expect(convert(1, "can", "metric")).toBeNull();
    expect(convert(3, "slice", "us")).toBeNull();
    expect(convert(2, "blorps", "metric")).toBeNull();
    expect(convert(2, null, "metric")).toBeNull();
    expect(convert(2, undefined, "metric")).toBeNull();
  });

  it("never bridges volume and weight", () => {
    const volumeTargets = new Set([
      "tsp",
      "tbsp",
      "cup",
      "pint",
      "quart",
      "gallon",
      "ml",
      "cl",
      "dl",
      "l",
    ]);
    const weightTargets = new Set(["oz", "lb", "mg", "g", "kg"]);
    for (const unit of ["cup", "tsp", "gallon", "ml", "l"]) {
      const out = convert(1, unit, unitSystem(unit) === "us" ? "metric" : "us");
      expect(volumeTargets.has(out?.unit ?? "")).toBe(true);
    }
    for (const unit of ["oz", "lb", "g", "kg"]) {
      const out = convert(1, unit, unitSystem(unit) === "us" ? "metric" : "us");
      expect(weightTargets.has(out?.unit ?? "")).toBe(true);
    }
  });

  it("guards non-finite amounts", () => {
    expect(convert(Number.NaN, "cup", "metric")).toBeNull();
    expect(convert(Number.POSITIVE_INFINITY, "cup", "metric")).toBeNull();
  });

  it("reports unit systems and convertibility", () => {
    expect(unitSystem("cup")).toBe("us");
    expect(unitSystem("ml")).toBe("metric");
    expect(unitSystem("clove")).toBeNull();
    expect(unitSystem(null)).toBeNull();
    expect(isConvertibleUnit("kg")).toBe(true);
    expect(isConvertibleUnit("bunch")).toBe(false);
    expect(isConvertibleUnit("blorps")).toBe(false);
  });
});

describe("convertRange", () => {
  it("converts both bounds to the same target unit", () => {
    expect(convertRange(1, 2, "cup", "metric")).toEqual({
      low: 236.59,
      high: 473.18,
      unit: "ml",
      converted: true,
    });
  });

  it("chooses the unit from the largest bound", () => {
    const converted = convertRange(0.2, 2, "cup", "us");
    // Same-system: untouched.
    expect(converted).toEqual({ low: 0.2, high: 2, unit: "cup", converted: false });
    const reverse = convertRange(1, 2, "ml", "us");
    expect(reverse?.unit).toBe("tsp");
    expect(reverse?.converted).toBe(true);
  });

  it("flags a same-system result so callers keep verbatim text", () => {
    expect(convertRange(1, 3, "ml", "metric")).toEqual({
      low: 1,
      high: 3,
      unit: "ml",
      converted: false,
    });
  });

  it("returns null for a non-convertible unit", () => {
    expect(convertRange(1, 2, "clove", "metric")).toBeNull();
    expect(convertRange(1, 2, null, "metric")).toBeNull();
    expect(convertRange(Number.NaN, null, "cup", "metric")).toBeNull();
  });
});
