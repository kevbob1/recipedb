import { describe, expect, it } from "vitest";
import {
  COOK_RESUME_TTL_MS,
  cookStorageKey,
  cookTabKey,
  describeSavedAge,
  parseCookState,
  serializeCookState,
} from "./cook-resume";

const NOW = 1_700_000_000_000;

describe("cook storage keys", () => {
  it("scopes both keys per recipe", () => {
    expect(cookStorageKey("42")).toBe("cook:42");
    expect(cookTabKey("42")).toBe("cook-tab:42");
    expect(cookStorageKey("42")).not.toBe(cookStorageKey("43"));
  });
});

describe("parseCookState", () => {
  it("round-trips a serialized session", () => {
    const raw = serializeCookState(
      { checked: { 0: true, 2: true }, index: 3 },
      NOW,
    );
    expect(parseCookState(raw, NOW + 1_000)).toEqual({
      checked: { 0: true, 2: true },
      index: 3,
      savedAt: NOW,
    });
  });

  it("treats absent and malformed payloads as nothing to restore", () => {
    expect(parseCookState(null, NOW)).toBeNull();
    expect(parseCookState("", NOW)).toBeNull();
    expect(parseCookState("not json", NOW)).toBeNull();
    expect(parseCookState("null", NOW)).toBeNull();
    expect(parseCookState("[]", NOW)).toBeNull();
    expect(parseCookState("{}", NOW)).toBeNull();
    expect(parseCookState(`{"savedAt":${NOW}}`, NOW)).toBeNull();
    expect(parseCookState(`{"index":1}`, NOW)).toBeNull();
    expect(
      parseCookState(`{"index":1,"savedAt":"yesterday"}`, NOW),
    ).toBeNull();
    expect(parseCookState(`{"index":-1,"savedAt":${NOW}}`, NOW)).toBeNull();
  });

  it("discards entries older than 24 hours", () => {
    expect(
      parseCookState(`{"index":2,"savedAt":${NOW}}`, NOW + COOK_RESUME_TTL_MS - 1),
    ).not.toBeNull();
    expect(
      parseCookState(`{"index":2,"savedAt":${NOW}}`, NOW + COOK_RESUME_TTL_MS + 1),
    ).toBeNull();
  });

  it("normalizes the checked map to true integer keys", () => {
    const parsed = parseCookState(
      JSON.stringify({
        checked: { 1: true, 2: false, 3: "yes", "-1": true, x: true },
        index: 0.8,
        savedAt: NOW,
      }),
      NOW,
    );
    expect(parsed).toEqual({
      checked: { 1: true },
      index: 0,
      savedAt: NOW,
    });
  });

  it("survives a non-object checked value", () => {
    const parsed = parseCookState(
      JSON.stringify({ checked: "nope", index: 1, savedAt: NOW }),
      NOW,
    );
    expect(parsed).toEqual({ checked: {}, index: 1, savedAt: NOW });
  });
});

describe("serializeCookState", () => {
  it("stamps savedAt from the supplied clock", () => {
    const raw = serializeCookState({ checked: { 4: true }, index: 4 }, NOW);
    expect(JSON.parse(raw)).toEqual({
      checked: { 4: true },
      index: 4,
      savedAt: NOW,
    });
  });
});

describe("describeSavedAge", () => {
  it("describes recent sessions in human terms", () => {
    expect(describeSavedAge(NOW, NOW + 10_000)).toBe("just now");
    expect(describeSavedAge(NOW, NOW + 12 * 60_000)).toBe("12 min ago");
    expect(describeSavedAge(NOW, NOW + 3 * 60 * 60_000)).toBe("3 h ago");
  });
});
