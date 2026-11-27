import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getDb, getImagesDir } from "../../db/client.server";
import {
  ocrTrainingSamples,
  recipePages,
  recipes,
} from "../../db/schema.server";
import { executeSave } from "../draft-store.server";
import { listSaveEvents } from "../save-events.server";
import { createDraft } from "../import";
import { withDb } from "../testing/with-db";
import { reparseRecipe } from "./reparse.server";

withDb();

function makeRecipe(acceptedAt: Date | null = null): number {
  const recipeId = executeSave({
    kind: "new",
    draft: createDraft({ kind: "scan", text: "Old stew\n1 cup old beans" }),
  }).recipeId;
  const imageFilename = `${recipeId}/original.png`;
  const directory = path.join(getImagesDir(), String(recipeId));
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "original.png"), "capture");
  getDb()
    .update(recipes)
    .set({ imageFilename })
    .where(eq(recipes.id, recipeId))
    .run();
  getDb()
    .insert(recipePages)
    .values({
      recipeId,
      pageNo: 1,
      imageFilename,
      rawOcrText: "Old stew 1 cup old beans",
    })
    .run();
  getDb()
    .insert(ocrTrainingSamples)
    .values({
      recipeId,
      pageNo: 1,
      imageFilename,
      rawOcrText: "First captured OCR",
      correctedText: "First corrected text",
      acceptedAt,
    })
    .run();
  return recipeId;
}

function recognized(text: string) {
  return async () => ({ text, confidence: 0.9, ms: 1 });
}

describe("reparseRecipe", () => {
  it("skips recipes that are not scans", async () => {
    const draft = createDraft({ kind: "manual" });
    draft.title = "Manual recipe";
    const recipeId = executeSave({
      kind: "new",
      draft,
    }).recipeId;
    expect(await reparseRecipe(recipeId, { recognize: recognized("Unused") }))
      .toEqual({ recipeId, status: "skipped", reason: "not-scan" });
  });

  it("re-OCRs retained originals, saves parsed fields, and records a server snapshot", async () => {
    const recipeId = makeRecipe();
    const result = await reparseRecipe(
      recipeId,
      {
        recognize: recognized(
          "Fresh stew\nIngredients\n2 cups lentils\nInstructions\n1. Simmer",
        ),
      },
    );

    expect(result).toEqual({
      recipeId,
      status: "reparsed",
      fieldsParsed: { title: "Fresh stew", ingredientCount: 1, stepCount: 1 },
    });
    const recipe = getDb()
      .select()
      .from(recipes)
      .where(eq(recipes.id, recipeId))
      .get();
    expect(recipe).toMatchObject({ title: "Fresh stew", rawOcrText: expect.stringContaining("2 cups lentils") });
    const events = listSaveEvents(recipeId);
    expect(events.at(-1)).toMatchObject({
      captureMode: "reparse",
      recognized: { title: "Fresh stew", rawOcrText: expect.stringContaining("2 cups lentils") },
      saved: { title: "Fresh stew", rawOcrText: expect.stringContaining("2 cups lentils") },
    });
  });

  it("does not overwrite the recipe or append an event for empty OCR", async () => {
    const recipeId = makeRecipe();
    const beforeEvents = listSaveEvents(recipeId);
    const result = await reparseRecipe(recipeId, { recognize: recognized(" \n\t") });

    expect(result).toEqual({ recipeId, status: "skipped", reason: "empty-ocr" });
    expect(
      getDb().select({ title: recipes.title }).from(recipes)
        .where(eq(recipes.id, recipeId)).get()?.title,
    ).toBe("Old stew");
    expect(listSaveEvents(recipeId)).toHaveLength(beforeEvents.length);
  });

  it("reports a missing retained page image and OCR failures without saving", async () => {
    const missingPageId = makeRecipe();
    getDb()
      .update(recipePages)
      .set({ imageFilename: null })
      .where(eq(recipePages.recipeId, missingPageId))
      .run();
    expect(await reparseRecipe(missingPageId, { recognize: recognized("Unused") }))
      .toMatchObject({
        recipeId: missingPageId,
        status: "error",
        error: "missing-image:page-1",
      });

    const failedOcrId = makeRecipe();
    expect(
      await reparseRecipe(failedOcrId, {
        recognize: async () => {
          throw new Error("OCR unavailable");
        },
      }),
    ).toMatchObject({
      recipeId: failedOcrId,
      status: "error",
      error: "OCR unavailable",
    });
  });

  it("skips reviewed recipes unless forced, preserving write-once raw OCR and review state", async () => {
    const acceptedAt = new Date("2026-02-01T00:00:00.000Z");
    const recipeId = makeRecipe(acceptedAt);
    const text = "Forced stew\nIngredients\n3 cups beans";
    const deps = { recognize: recognized(text) };

    expect(await reparseRecipe(recipeId, deps)).toEqual({
      recipeId,
      status: "skipped",
      reason: "reviewed",
    });
    expect((await reparseRecipe(recipeId, deps, { force: true })).status)
      .toBe("reparsed");
    const [sample] = getDb()
      .select()
      .from(ocrTrainingSamples)
      .where(eq(ocrTrainingSamples.recipeId, recipeId))
      .all();
    expect(sample).toMatchObject({
      rawOcrText: "First captured OCR",
      correctedText: "Forced stew Ingredients 3 cups beans",
      acceptedAt,
    });
  });

  it("appends each reparse event without recapturing raw OCR or marking review accepted", async () => {
    const recipeId = makeRecipe();
    const first = await reparseRecipe(recipeId, {
      recognize: recognized("First reparse\nIngredients\n1 cup rice"),
    });
    const second = await reparseRecipe(recipeId, {
      recognize: recognized("Second reparse\nIngredients\n2 cups rice"),
    });

    expect(first.status).toBe("reparsed");
    expect(second.status).toBe("reparsed");
    const samples = getDb()
      .select()
      .from(ocrTrainingSamples)
      .where(eq(ocrTrainingSamples.recipeId, recipeId))
      .all();
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({
      rawOcrText: "First captured OCR",
      correctedText: "Second reparse Ingredients 2 cups rice",
      acceptedAt: null,
    });
    expect(listSaveEvents(recipeId).filter((event) => event.captureMode === "reparse"))
      .toHaveLength(2);
  });
});
