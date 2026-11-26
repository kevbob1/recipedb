import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../../db/client.server";
import { ocrTrainingSamples } from "../../db/schema.server";
import { executeSave } from "../draft-store.server";
import { createDraft } from "../import";
import { withDb } from "../testing/with-db";
import {
  captureTrainingSamples,
  isAccepted,
  isRecipeReviewed,
  reviewedRecipeIds,
  verifyBackfilledSamples,
} from "./training-samples.server";

withDb();

afterEach(() => {
  vi.useRealTimers();
});

function makeRecipe(): number {
  return executeSave({
    kind: "new",
    draft: createDraft({
      kind: "scan",
      text: "First page\nSecond page",
      pages: [
        { pageNo: 1, imageFilename: "1/page-1.png", text: "First page" },
        { pageNo: 2, imageFilename: "1/page-2.png", text: "Second page" },
      ],
    }),
  }).recipeId;
}

function samplesFor(recipeId: number) {
  return getDb()
    .select()
    .from(ocrTrainingSamples)
    .where(eq(ocrTrainingSamples.recipeId, recipeId))
    .all();
}

describe("OCR training sample lifecycle", () => {
  it("preserves raw OCR on acceptance, writes current corrections, and retires removed pages", () => {
    const recipeId = makeRecipe();
    const acceptedAt = new Date("2026-04-05T06:07:08.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(acceptedAt);

    captureTrainingSamples(
      getDb(),
      recipeId,
      [{ pageNo: 1, imageFilename: "1/page-1.png", rawOcrText: "Current edit" }],
      { mode: "accept" },
    );

    expect(samplesFor(recipeId)).toEqual([
      expect.objectContaining({
        pageNo: 1,
        rawOcrText: "First page",
        correctedText: "Current edit",
        acceptedAt,
      }),
    ]);
  });

  it("sets acceptance timestamps according to initial, accept, and backfill modes", () => {
    const recipeId = makeRecipe();
    const page = [{ pageNo: 1, imageFilename: null, rawOcrText: "OCR" }];
    const acceptedAt = new Date("2026-04-05T06:07:08.000Z");

    captureTrainingSamples(getDb(), recipeId, page, { mode: "initial" });
    expect(samplesFor(recipeId)[0]?.acceptedAt).toBeNull();

    vi.useFakeTimers();
    vi.setSystemTime(acceptedAt);
    captureTrainingSamples(getDb(), recipeId, page, { mode: "accept" });
    expect(samplesFor(recipeId)[0]?.acceptedAt).toEqual(acceptedAt);

    const commandClock = new Date("2026-05-06T07:08:09.000Z");
    captureTrainingSamples(getDb(), recipeId, page, {
      mode: "backfill",
      acceptedAt: commandClock,
    });
    expect(samplesFor(recipeId)[0]?.acceptedAt).toEqual(commandClock);
  });

  it("backfill deliberately overwrites previously captured raw OCR", () => {
    const recipeId = makeRecipe();

    captureTrainingSamples(
      getDb(),
      recipeId,
      [{ pageNo: 1, imageFilename: "1/page-1.png", rawOcrText: "Re-OCR" }],
      { mode: "backfill", acceptedAt: new Date("2026-01-02T00:00:00.000Z") },
    );

    expect(samplesFor(recipeId)[0]).toMatchObject({
      rawOcrText: "Re-OCR",
      correctedText: "Re-OCR",
      acceptedAt: new Date("2026-01-02T00:00:00.000Z"),
    });
  });

  it("shares accepted and reviewed-set policy for single and bulk lookups", () => {
    const firstId = makeRecipe();
    const secondId = makeRecipe();
    expect(isAccepted({ acceptedAt: null })).toBe(false);
    expect(isAccepted({ acceptedAt: new Date() })).toBe(true);
    expect(isRecipeReviewed(getDb(), firstId)).toBe(false);

    captureTrainingSamples(
      getDb(),
      firstId,
      [{ pageNo: 1, imageFilename: null, rawOcrText: "accepted" }],
      { mode: "accept" },
    );
    expect(isRecipeReviewed(getDb(), firstId)).toBe(true);
    expect(isRecipeReviewed(getDb(), secondId)).toBe(false);
    expect(reviewedRecipeIds(getDb())).toEqual(new Set([firstId]));
  });

  it("verifies complete accepted backfills and rejects missing or unaccepted samples", () => {
    const recipeId = makeRecipe();
    captureTrainingSamples(
      getDb(),
      recipeId,
      [
        { pageNo: 1, imageFilename: null, rawOcrText: "first" },
        { pageNo: 2, imageFilename: null, rawOcrText: "second" },
      ],
      { mode: "backfill", acceptedAt: new Date("2026-01-02T00:00:00.000Z") },
    );
    expect(() => verifyBackfilledSamples(getDb(), recipeId, 2)).not.toThrow();

    expect(() => verifyBackfilledSamples(getDb(), recipeId, 1)).toThrow(
      "training-sample-verification-failed",
    );
    captureTrainingSamples(
      getDb(),
      recipeId,
      [{ pageNo: 1, imageFilename: null, rawOcrText: "not accepted" }],
      { mode: "initial" },
    );
    expect(() => verifyBackfilledSamples(getDb(), recipeId, 1)).toThrow(
      "training-sample-verification-failed",
    );
  });
});
