import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../db/migrate.server";
import { getDb, getImagesDir, getRawSqlite } from "../db/client.server";
import {
  ocrTrainingSamples,
  recipePages,
  recipes,
} from "../db/schema.server";
import { saveDraft, updateDraft } from "./draft-store.server";
import { backfillRecipe, listBackfillTargets } from "./backfill.server";
import { createDraft } from "./import";

let dataDir: string;
let previousDataDir: string | undefined;

beforeAll(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "recipedb-backfill-"));
  previousDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dataDir;
  runMigrations();
});

afterAll(() => {
  getRawSqlite().close();
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  getRawSqlite().exec(
    "DELETE FROM ocr_training_samples; DELETE FROM recipe_pages; DELETE FROM ingredient_lines; DELETE FROM steps; DELETE FROM tags; DELETE FROM recipes;",
  );
  fs.rmSync(getImagesDir(), { recursive: true, force: true });
  fs.mkdirSync(getImagesDir(), { recursive: true });
});

function makeRecipe(sourceType: "scan" | "manual" = "scan"): number {
  const draft = createDraft({ kind: "scan", text: "Legacy Recipe\n1 cup flour" });
  draft.sourceType = sourceType;
  return saveDraft(draft).recipeId;
}

function storeImage(recipeId: number, filename: string, content: string): string {
  const directory = path.join(getImagesDir(), String(recipeId));
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, filename.split("/").at(-1) ?? filename), content);
  return `${recipeId}/${filename.split("/").at(-1) ?? filename}`;
}

function setCover(recipeId: number, filename: string): void {
  getDb()
    .update(recipes)
    .set({ imageFilename: filename })
    .where(eq(recipes.id, recipeId))
    .run();
}

function recognized(textByImage: Record<string, string>, confidence = 0.8) {
  return async ({ bytes }: { bytes: Buffer }) => ({
    text: textByImage[bytes.toString()] ?? "",
    confidence,
    ms: 1,
  });
}

describe("backfillRecipe", () => {
  it("rebuilds a single-page camera scan and captures fresh accepted OCR", async () => {
    const recipeId = makeRecipe();
    const filename = storeImage(recipeId, "original.webp", "camera");
    updateDraft(
      recipeId,
      createDraft({ kind: "scan", text: "Old title\n1 cup old flour" }),
    );
    setCover(recipeId, filename);
    const acceptedAt = new Date("2026-01-01T00:00:00.000Z");

    const result = await backfillRecipe(
      recipeId,
      {
        recognize: recognized({
          camera: "Chocolate Cake\n2 cups flour\n1 cup sugar\n1. Mix ingredients",
        }),
        clock: () => acceptedAt,
      },
    );

    expect(result).toEqual({
      recipeId,
      status: "backfilled",
      pageCount: 1,
      confidence: 0.8,
    });
    const recipe = getDb()
      .select()
      .from(recipes)
      .where(eq(recipes.id, recipeId))
      .get();
    expect(recipe?.title).toBe("Chocolate Cake");
    expect(recipe?.rawOcrText).toContain("2 cups flour");
    const pages = getDb()
      .select()
      .from(recipePages)
      .where(eq(recipePages.recipeId, recipeId))
      .all();
    expect(pages).toEqual([
      expect.objectContaining({
        pageNo: 1,
        imageFilename: filename,
        rawOcrText: "Chocolate Cake 2 cups flour 1 cup sugar 1. Mix ingredients",
      }),
    ]);
    const samples = getDb()
      .select()
      .from(ocrTrainingSamples)
      .where(eq(ocrTrainingSamples.recipeId, recipeId))
      .all();
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({
      rawOcrText: pages[0].rawOcrText,
      correctedText: pages[0].rawOcrText,
      acceptedAt,
    });
  });

  it("re-OCRs multiple pages in page order and aggregates confidence", async () => {
    const recipeId = makeRecipe();
    const first = storeImage(recipeId, "page-1.png", "page-one");
    const second = storeImage(recipeId, "page-2.png", "page-two");
    getDb()
      .insert(recipePages)
      .values([
        { recipeId, pageNo: 1, imageFilename: first, rawOcrText: "old one" },
        { recipeId, pageNo: 2, imageFilename: second, rawOcrText: "old two" },
      ])
      .run();
    const seen: string[] = [];
    const result = await backfillRecipe(recipeId, {
      recognize: async ({ bytes }) => {
        seen.push(bytes.toString());
        return {
          text: bytes.toString() === "page-one" ? "Fresh title" : "2 cups rice",
          confidence: bytes.toString() === "page-one" ? 0.6 : 1,
          ms: 1,
        };
      },
      clock: () => new Date("2026-02-01T00:00:00.000Z"),
    });
    expect(seen).toEqual(["page-one", "page-two"]);
    expect(result).toMatchObject({
      status: "backfilled",
      pageCount: 2,
      confidence: 0.8,
    });
    expect(
      getDb()
        .select({ pageNo: recipePages.pageNo, rawOcrText: recipePages.rawOcrText })
        .from(recipePages)
        .where(eq(recipePages.recipeId, recipeId))
        .all(),
    ).toEqual([
      { pageNo: 1, rawOcrText: "Fresh title" },
      { pageNo: 2, rawOcrText: "2 cups rice" },
    ]);
  });

  it("skips non-scans, reviewed recipes, and empty OCR without writes", async () => {
    const manualId = makeRecipe("manual");
    const reviewedId = makeRecipe();
    const reviewedImage = storeImage(reviewedId, "original.png", "reviewed");
    setCover(reviewedId, reviewedImage);
    updateDraft(
      reviewedId,
      createDraft({
        kind: "scan",
        text: "Old reviewed",
        pages: [{ pageNo: 1, imageFilename: reviewedImage, text: "Old reviewed" }],
      }),
    );
    const emptyId = makeRecipe();
    const emptyImage = storeImage(emptyId, "original.png", "empty");
    setCover(emptyId, emptyImage);
    getDb()
      .insert(recipePages)
      .values({
        recipeId: emptyId,
        pageNo: 1,
        imageFilename: emptyImage,
        rawOcrText: "Old OCR",
      })
      .run();
    const previousText = getDb()
      .select({ rawOcrText: recipes.rawOcrText })
      .from(recipes)
      .where(eq(recipes.id, emptyId))
      .get()?.rawOcrText;
    const recognize = recognized({ empty: " \n\t" });
    expect((await backfillRecipe(manualId, { recognize, clock: () => new Date() })).status)
      .toBe("skipped-not-scan");
    expect((await backfillRecipe(reviewedId, { recognize, clock: () => new Date() })).status)
      .toBe("skipped-reviewed");
    expect((await backfillRecipe(emptyId, { recognize, clock: () => new Date() })).status)
      .toBe("skipped-empty-ocr");
    expect(
      getDb()
        .select({ rawOcrText: recipes.rawOcrText })
        .from(recipes)
        .where(eq(recipes.id, emptyId))
        .get()?.rawOcrText,
    ).toBe(previousText);
    expect(listBackfillTargets().skipped.map((row) => row.id)).toContain(reviewedId);
  });

  it("force replaces reviewed raw OCR, while OCR and missing-image failures write nothing", async () => {
    const reviewedId = makeRecipe();
    const filename = storeImage(reviewedId, "original.png", "force");
    setCover(reviewedId, filename);
    updateDraft(
      reviewedId,
      createDraft({
        kind: "scan",
        text: "Old OCR",
        pages: [{ pageNo: 1, imageFilename: filename, text: "Old OCR" }],
      }),
    );
    const forced = await backfillRecipe(
      reviewedId,
      {
        recognize: recognized({ force: "Fresh forced OCR" }),
        clock: () => new Date("2026-03-01T00:00:00.000Z"),
      },
      { force: true },
    );
    expect(forced.status).toBe("backfilled");
    expect(
      getDb()
        .select()
        .from(ocrTrainingSamples)
        .where(eq(ocrTrainingSamples.recipeId, reviewedId))
        .all(),
    ).toEqual([
      expect.objectContaining({
        rawOcrText: "Fresh forced OCR",
        correctedText: "Fresh forced OCR",
        acceptedAt: new Date("2026-03-01T00:00:00.000Z"),
      }),
    ]);

    const failedId = makeRecipe();
    const failedImage = storeImage(failedId, "original.png", "throws");
    setCover(failedId, failedImage);
    const oldText = getDb()
      .select({ rawOcrText: recipes.rawOcrText })
      .from(recipes)
      .where(eq(recipes.id, failedId))
      .get()?.rawOcrText;
    const failed = await backfillRecipe(failedId, {
      recognize: async () => {
        throw new Error("OCR crashed");
      },
      clock: () => new Date(),
    });
    expect(failed).toMatchObject({ status: "failed", error: "OCR crashed" });
    expect(
      getDb()
        .select({ rawOcrText: recipes.rawOcrText })
        .from(recipes)
        .where(eq(recipes.id, failedId))
        .get()?.rawOcrText,
    ).toBe(oldText);

    const missingId = makeRecipe();
    setCover(missingId, `${missingId}/missing.webp`);
    expect(
      await backfillRecipe(missingId, {
        recognize: recognized({}),
        clock: () => new Date(),
      }),
    ).toMatchObject({ status: "failed" });
    expect(listBackfillTargets().targets.map((row) => row.id)).toContain(missingId);
  });

  it("ordinary revise preserves first-persisted raw OCR by page number", () => {
    const recipeId = makeRecipe();
    updateDraft(
      recipeId,
      createDraft({
        kind: "scan",
        text: "Original page one\nOriginal page two",
        pages: [
          { pageNo: 1, imageFilename: "1/page-1.png", text: "Original page one" },
          { pageNo: 2, imageFilename: "1/page-2.png", text: "Original page two" },
        ],
      }),
    );
    updateDraft(
      recipeId,
      createDraft({
        kind: "scan",
        text: "Corrected page one\nCorrected page two",
        pages: [
          { pageNo: 1, imageFilename: "1/page-1.png", text: "Corrected page one" },
          { pageNo: 2, imageFilename: "1/page-2.png", text: "Corrected page two" },
        ],
      }),
    );
    const samples = getDb()
      .select()
      .from(ocrTrainingSamples)
      .where(eq(ocrTrainingSamples.recipeId, recipeId))
      .all();
    expect(samples.map((row) => [row.pageNo, row.rawOcrText, row.correctedText])).toEqual([
      [1, "Original page one", "Corrected page one"],
      [2, "Original page two", "Corrected page two"],
    ]);
    expect(samples.every((row) => row.acceptedAt !== null)).toBe(true);
  });
});
