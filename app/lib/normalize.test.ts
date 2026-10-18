/**
 * Normalizer tests — the trim-only rule (#3) is a hard contract.
 */
import { describe, expect, it } from "vitest";
import { trimOnly, trimOnlyRequired, normalizeTag } from "./normalize";

describe("trimOnly", () => {
  it("returns null for nullish input", () => {
    expect(trimOnly(null)).toBeNull();
    expect(trimOnly(undefined)).toBeNull();
  });

  it("returns null for empty/whitespace strings", () => {
    expect(trimOnly("")).toBeNull();
    expect(trimOnly("   ")).toBeNull();
    expect(trimOnly("\n\t  \n")).toBeNull();
  });

  it("trims outer whitespace", () => {
    expect(trimOnly("  hello  ")).toBe("hello");
  });

  it("collapses internal whitespace to single spaces", () => {
    expect(trimOnly("a   b\nc")).toBe("a b c");
    expect(trimOnly("  a\tb  c  ")).toBe("a b c");
  });

  it("never alters content (case, punctuation, ordering)", () => {
    expect(trimOnly("Hello, World!")).toBe("Hello, World!");
    expect(trimOnly("Cafe au lait")).toBe("Cafe au lait");
  });
});

describe("trimOnlyRequired", () => {
  it("returns empty string for nullish input", () => {
    expect(trimOnlyRequired(null)).toBe("");
    expect(trimOnlyRequired(undefined)).toBe("");
  });

  it("returns empty string for blank input", () => {
    expect(trimOnlyRequired("  ")).toBe("");
  });

  it("returns the trimmed value otherwise", () => {
    expect(trimOnlyRequired("  toast  ")).toBe("toast");
  });
});

describe("normalizeTag", () => {
  it("trims and lowercases", () => {
    expect(normalizeTag("  Quick  ")).toBe("quick");
    expect(normalizeTag("Family Favorite")).toBe("family favorite");
  });
});
