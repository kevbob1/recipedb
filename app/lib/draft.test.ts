/**
 * RecipeDraft tests — shape, confidence badges, and the trim-only rule.
 */
import { describe, expect, it } from "vitest";
import {
  blankDraft,
  countNeedEyes,
  ingredientConfidence,
  requiredFieldConfidence,
  optionalFieldConfidence,
  type RecipeDraft,
} from "./draft";
import { trimOnly, trimOnlyRequired } from "./normalize";

describe("blankDraft", () => {
  it("is a manual, untitled, other-category draft with no fields filled", () => {
    const d = blankDraft();
    expect(d.title).toBe("");
    expect(d.category).toBe("other");
    expect(d.sourceType).toBe("manual");
    expect(d.ingredients).toEqual([]);
    expect(d.steps).toEqual([]);
    expect(d.tags).toEqual([]);
  });
});

describe("confidence helpers", () => {
  it("required field is bad if empty, ok if present", () => {
    expect(requiredFieldConfidence("")).toBe("bad");
    expect(requiredFieldConfidence("   ")).toBe("bad");
    expect(requiredFieldConfidence("x")).toBe("ok");
  });
  it("optional field is bad if null, ok if present", () => {
    expect(optionalFieldConfidence(null)).toBe("bad");
    expect(optionalFieldConfidence("4 servings")).toBe("ok");
  });
});

describe("ingredientConfidence", () => {
  it("empty text -> bad", () => {
    expect(
      ingredientConfidence({
        text: "",
        qty: "",
        unit: null,
        item: "",
        note: null,
        confidence: "ok",
      }),
    ).toBe("bad");
  });
  it("text but no qty -> warn", () => {
    expect(
      ingredientConfidence({
        text: "garlic",
        qty: "",
        unit: null,
        item: "garlic",
        note: null,
        confidence: "ok",
      }),
    ).toBe("warn");
  });
  it("text and qty -> ok", () => {
    expect(
      ingredientConfidence({
        text: "2 cloves garlic",
        qty: "2",
        unit: "cloves",
        item: "garlic",
        note: null,
        confidence: "ok",
      }),
    ).toBe("ok");
  });
});

describe("countNeedEyes", () => {
  it("an empty draft has 0 ok fields and most need eyes", () => {
    const d = blankDraft();
    const { total, need } = countNeedEyes(d);
    expect(total).toBe(3); // title, category, yield
    expect(need).toBeGreaterThan(0);
  });
  it("counts ingredient warns", () => {
    const d: RecipeDraft = {
      ...blankDraft(),
      title: "Test",
      titleConfidence: "ok",
      yield: "4",
      yieldConfidence: "ok",
      ingredients: [
        { text: "salt", qty: "", unit: null, item: "salt", note: null, confidence: "warn" },
        { text: "2 onions", qty: "2", unit: null, item: "onions", note: null, confidence: "ok" },
      ],
    };
    const { need } = countNeedEyes(d);
    expect(need).toBeGreaterThanOrEqual(1);
  });
});

describe("trim-only contract", () => {
  it("never re-orders or re-cases text", () => {
    const raw = "  Café  au  Lait  ";
    expect(trimOnlyRequired(raw)).toBe("Café au Lait");
  });
  it("null in, null out", () => {
    expect(trimOnly(null)).toBeNull();
  });
});
