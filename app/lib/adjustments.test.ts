import { describe, expect, it } from "vitest";

import { blankDraft, type DraftIngredient, type RecipeDraft } from "./draft";
import {
  deriveRecipeAdjustments,
  diffDrafts,
  pageTextChanges,
  type SaveEventRow,
} from "./adjustments";

function draft(overrides: Partial<RecipeDraft> = {}): RecipeDraft {
  return { ...blankDraft(), ...overrides };
}

function ingredient(text: string, overrides: Partial<DraftIngredient> = {}): DraftIngredient {
  return {
    text,
    qty: "1",
    unit: "cup",
    item: text,
    note: null,
    confidence: "ok",
    ...overrides,
  };
}

function event(
  id: number,
  captureMode: SaveEventRow["captureMode"],
  saved: RecipeDraft,
  recognized: RecipeDraft | null = null,
): SaveEventRow {
  return {
    id,
    recipeId: 7,
    captureMode,
    recognizedJson: recognized === null ? null : JSON.stringify(recognized),
    savedJson: JSON.stringify(saved),
    createdAt: new Date(`2026-11-26T00:00:0${id}.000Z`),
  };
}

describe("diffDrafts", () => {
  it("reports every configured scalar field", () => {
    const before = draft({
      title: "Soup",
      category: "other",
      yield: null,
      favorite: false,
      sourceUrl: null,
      imageFilename: null,
    });
    const after = draft({
      title: "Tomato soup",
      category: "soup",
      yield: "4 servings",
      favorite: true,
      sourceUrl: "https://example.test/soup",
      imageFilename: "7/original.png",
    });
    expect(diffDrafts(before, after)).toEqual([
      { kind: "field", action: "modify", field: "title", before: "Soup", after: "Tomato soup" },
      { kind: "field", action: "modify", field: "category", before: "other", after: "soup" },
      { kind: "field", action: "modify", field: "yieldText", before: null, after: "4 servings" },
      { kind: "field", action: "modify", field: "favorite", before: false, after: true },
      {
        kind: "field",
        action: "modify",
        field: "sourceUrl",
        before: null,
        after: "https://example.test/soup",
      },
      {
        kind: "field",
        action: "modify",
        field: "imageFilename",
        before: null,
        after: "7/original.png",
      },
    ]);
  });

  it("keeps the complete ingredient sides for modifications and handles add/remove", () => {
    const original = ingredient("1 cup flour");
    const corrected = ingredient("1 cup oat flour", {
      qty: "2",
      unit: "tbsp",
      item: "oat flour",
      note: "sifted",
      confidence: "warn",
    });
    expect(
      diffDrafts(
        draft({ ingredients: [original, ingredient("2 eggs")] }),
        draft({ ingredients: [corrected] }),
      ),
    ).toEqual([
      {
        kind: "ingredient",
        action: "modify",
        before: original,
        after: corrected,
        beforeIndex: 0,
        afterIndex: 0,
      },
      {
        kind: "ingredient",
        action: "remove",
        before: ingredient("2 eggs"),
        after: null,
        beforeIndex: 1,
        afterIndex: null,
      },
    ]);
    expect(
      diffDrafts(draft(), draft({ ingredients: [ingredient("pinch salt")] })),
    ).toEqual([
      {
        kind: "ingredient",
        action: "add",
        before: null,
        after: ingredient("pinch salt"),
        beforeIndex: null,
        afterIndex: 0,
      },
    ]);
  });

  it("matches shifted ingredient lines by normalized-text similarity in either direction", () => {
    const flour = ingredient("1 cup flour");
    const eggs = ingredient("2 eggs");
    const oil = ingredient("1 tbsp oil");
    expect(
      diffDrafts(
        draft({ ingredients: [flour, eggs] }),
        draft({ ingredients: [oil, flour, eggs] }),
      ),
    ).toEqual([
      {
        kind: "ingredient",
        action: "add",
        before: null,
        after: oil,
        beforeIndex: null,
        afterIndex: 0,
      },
    ]);
    expect(
      diffDrafts(
        draft({ ingredients: [oil, flour, eggs] }),
        draft({ ingredients: [flour, eggs] }),
      ),
    ).toEqual([
      {
        kind: "ingredient",
        action: "remove",
        before: oil,
        after: null,
        beforeIndex: 0,
        afterIndex: null,
      },
    ]);
    expect(
      diffDrafts(
        draft({ ingredients: [ingredient("1 cup flour")] }),
        draft({ ingredients: [ingredient("1 cup flour, sifted"), eggs] }),
      )[0],
    ).toMatchObject({
      kind: "ingredient",
      action: "modify",
      before: ingredient("1 cup flour"),
      after: ingredient("1 cup flour, sifted"),
      beforeIndex: 0,
      afterIndex: 0,
    });
    expect(
      diffDrafts(
        draft({ ingredients: [ingredient("2 cups flour")] }),
        draft({ ingredients: [ingredient("2 cups flour", { qty: "3" })] }),
      ),
    ).toMatchObject([
      { kind: "ingredient", action: "modify", before: { qty: "1" }, after: { qty: "3" } },
    ]);
    expect(
      diffDrafts(
        draft({ ingredients: [ingredient("beef")] }),
        draft({ ingredients: [ingredient("salt")] }),
      ),
    ).toMatchObject([{ kind: "ingredient", action: "modify" }]);
    expect(
      diffDrafts(
        draft({ ingredients: [ingredient("flour sugar"), ingredient("flour spice")] }),
        draft({ ingredients: [ingredient("flour")] }),
      ),
    ).toMatchObject([
      { kind: "ingredient", action: "modify", beforeIndex: 0, afterIndex: 0 },
      { kind: "ingredient", action: "remove", beforeIndex: 1, afterIndex: null },
    ]);
  });

  it("reports step modifications, additions, removals, and moved-position similarity", () => {
    const first = { position: 1, text: "Mix dry ingredients" };
    const changed = { position: 1, text: "Mix all dry ingredients" };
    const removed = { position: 2, text: "Set aside" };
    const added = { position: 3, text: "Bake until golden" };
    expect(
      diffDrafts(
        draft({ steps: [first, removed] }),
        draft({ steps: [changed, added] }),
      ),
    ).toEqual([
      {
        kind: "step",
        action: "modify",
        before: first,
        after: changed,
        beforeIndex: 0,
        afterIndex: 0,
      },
      {
        kind: "step",
        action: "remove",
        before: removed,
        after: null,
        beforeIndex: 1,
        afterIndex: null,
      },
      {
        kind: "step",
        action: "add",
        before: null,
        after: added,
        beforeIndex: null,
        afterIndex: 1,
      },
    ]);
    expect(
      diffDrafts(
        draft({ steps: [{ position: 1, text: "Whisk flour and sugar" }] }),
        draft({ steps: [{ position: 4, text: "Whisk flour and sugar together" }] }),
      ),
    ).toMatchObject([
      { kind: "step", action: "modify", beforeIndex: 0, afterIndex: 0 },
    ]);
  });

  it("reports sorted tag additions and removals and ignores tag ordering", () => {
    expect(
      diffDrafts(draft({ tags: ["dinner", "quick"] }), draft({ tags: ["quick", "vegan"] })),
    ).toEqual([
      { kind: "tag", action: "add", before: null, after: "vegan" },
      { kind: "tag", action: "remove", before: "dinner", after: null },
    ]);
    expect(diffDrafts(draft({ tags: ["a", "b"] }), draft({ tags: ["b", "a"] }))).toEqual([]);
  });
});

describe("pageTextChanges", () => {
  it("sorts pages and identifies unchanged, edited, added, and removed text", () => {
    expect(
      pageTextChanges(
        [
          { pageNo: 3, imageFilename: null, text: "old third" },
          { pageNo: 1, imageFilename: null, text: "same" },
          { pageNo: 2, imageFilename: null, text: "removed" },
        ],
        [
          { pageNo: 4, imageFilename: null, text: "added" },
          { pageNo: 1, imageFilename: "1.png", text: "same" },
          { pageNo: 3, imageFilename: null, text: "new third" },
        ],
      ),
    ).toEqual([
      { pageNo: 1, before: "same", after: "same", changed: false },
      { pageNo: 2, before: "removed", after: null, changed: true },
      { pageNo: 3, before: "old third", after: "new third", changed: true },
      { pageNo: 4, before: null, after: "added", changed: true },
    ]);
    expect(pageTextChanges(undefined, undefined)).toEqual([]);
  });
});

describe("deriveRecipeAdjustments", () => {
  it("returns ordered human and machine groups, carrying the saved-draft chain", () => {
    const recognized = draft({ title: "OCR title" });
    const firstSaved = draft({ title: "Human title" });
    const machineSaved = draft({ title: "Machine title" });
    const lastSaved = draft({ title: "Final title" });
    const result = deriveRecipeAdjustments([
      event(1, "save", firstSaved, recognized),
      event(2, "reparse", machineSaved, draft({ title: "Ignored machine recognition" })),
      event(3, "revise", lastSaved, draft({ title: "Ignored human recognition" })),
    ]);
    expect(result.adjustments).toHaveLength(2);
    expect(result.adjustments.map(({ eventId, origin, timestamp, captureMode }) => ({
      eventId,
      origin,
      timestamp,
      captureMode,
    }))).toEqual([
      { eventId: 1, origin: "import", timestamp: new Date("2026-11-26T00:00:01.000Z"), captureMode: "save" },
      { eventId: 3, origin: "human", timestamp: new Date("2026-11-26T00:00:03.000Z"), captureMode: "revise" },
    ]);
    expect(result.adjustments[1]?.adjustments).toEqual([
      {
        kind: "field",
        action: "modify",
        field: "title",
        before: "Machine title",
        after: "Final title",
      },
    ]);
    expect(result.machineAdjustments).toHaveLength(1);
    expect(result.machineAdjustments[0]).toMatchObject({
      eventId: 2,
      origin: "machine",
      captureMode: "reparse",
      adjustments: [
        {
          kind: "field",
          field: "title",
          before: "Human title",
          after: "Machine title",
        },
      ],
    });
  });

  it("skips the initial pair without recognized data but uses its saved draft as chain state", () => {
    const firstSaved = draft({ title: "Old" });
    const secondSaved = draft({ title: "New" });
    const result = deriveRecipeAdjustments([
      event(1, "save", firstSaved, null),
      event(2, "revise", secondSaved, draft({ title: "Untrusted" })),
    ]);
    expect(result.adjustments).toHaveLength(1);
    expect(result.adjustments[0]?.origin).toBe("human");
    expect(result.adjustments[0]?.adjustments).toEqual([
      {
        kind: "field",
        action: "modify",
        field: "title",
        before: "Old",
        after: "New",
      },
    ]);
    expect(deriveRecipeAdjustments([])).toEqual({
      adjustments: [],
      machineAdjustments: [],
    });
  });

  it("uses a first machine recognition when it has no preceding saved state", () => {
    const result = deriveRecipeAdjustments([
      event(1, "backfill", draft({ title: "Saved" }), draft({ title: "Recognized" })),
    ]);
    expect(result.adjustments).toEqual([]);
    expect(result.machineAdjustments[0]).toMatchObject({
      origin: "machine",
      adjustments: [
        {
          kind: "field",
          field: "title",
          before: "Recognized",
          after: "Saved",
        },
      ],
    });
  });

  it("sorts out-of-order events by timestamp and id, omitting unchanged groups", () => {
    const original = draft({ title: "Original" });
    const firstEdit = draft({ title: "First edit" });
    const secondEdit = draft({ title: "Second edit" });
    const result = deriveRecipeAdjustments([
      event(3, "revise", secondEdit),
      event(2, "revise", firstEdit),
      event(1, "save", original, original),
    ]);
    expect(result.adjustments.map(({ eventId }) => eventId)).toEqual([2, 3]);
    expect(result.adjustments[0]?.origin).toBe("human");
    expect(result.adjustments[1]?.adjustments).toEqual([
      {
        kind: "field",
        action: "modify",
        field: "title",
        before: "First edit",
        after: "Second edit",
      },
    ]);
  });
});
