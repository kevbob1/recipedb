import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getDb, getImagesDir } from "../db/client.server";
import { recipes } from "../db/schema.server";
import { executeSave } from "./draft-store.server";
import { createDraft } from "./import";
import { normalizeImages } from "./normalize-images.server";
import { withDb } from "./testing/with-db";

withDb();

function makeRecipe(): number {
  return executeSave({
    kind: "new",
    draft: createDraft({ kind: "scan", text: "Test recipe" }),
  }).recipeId;
}

describe("normalizeImages", () => {
  it("moves flat cover names and deletes unreferenced files", () => {
    const recipeId = makeRecipe();
    fs.writeFileSync(path.join(getImagesDir(), "legacy.png"), "cover");
    getDb()
      .update(recipes)
      .set({ imageFilename: "legacy.png" })
      .where(eq(recipes.id, recipeId))
      .run();
    fs.mkdirSync(path.join(getImagesDir(), "_staging"), { recursive: true });
    fs.writeFileSync(path.join(getImagesDir(), "_staging", "orphan.webp"), "orphan");
    fs.writeFileSync(path.join(getImagesDir(), "unused.jpg"), "unused");

    const result = normalizeImages();
    expect(result).toEqual({
      moved: [{ recipeId, from: "legacy.png", to: `${recipeId}/original.png` }],
      failed: [],
      orphans: { deleted: ["_staging/orphan.webp", "unused.jpg"] },
    });
    expect(
      getDb()
        .select({ imageFilename: recipes.imageFilename })
        .from(recipes)
        .where(eq(recipes.id, recipeId))
        .get()?.imageFilename,
    ).toBe(`${recipeId}/original.png`);
    expect(fs.readFileSync(path.join(getImagesDir(), String(recipeId), "original.png"), "utf8"))
      .toBe("cover");
  });

  it("previews moves and orphans without changing files or database rows", () => {
    const recipeId = makeRecipe();
    fs.writeFileSync(path.join(getImagesDir(), "legacy.webp"), "cover");
    fs.writeFileSync(path.join(getImagesDir(), "orphan.png"), "orphan");
    getDb()
      .update(recipes)
      .set({ imageFilename: "legacy.webp" })
      .where(eq(recipes.id, recipeId))
      .run();

    const result = normalizeImages({ dryRun: true });
    expect(result).toMatchObject({
      moved: [{ recipeId, from: "legacy.webp", to: `${recipeId}/original.webp` }],
      failed: [],
      orphans: { reported: ["orphan.png"] },
    });
    expect(fs.existsSync(path.join(getImagesDir(), "legacy.webp"))).toBe(true);
    expect(fs.existsSync(path.join(getImagesDir(), "orphan.png"))).toBe(true);
    expect(
      getDb()
        .select({ imageFilename: recipes.imageFilename })
        .from(recipes)
        .where(eq(recipes.id, recipeId))
        .get()?.imageFilename,
    ).toBe("legacy.webp");
  });

  it("reports missing flat images and preserves orphans when requested", () => {
    const recipeId = makeRecipe();
    getDb()
      .update(recipes)
      .set({ imageFilename: "missing.jpeg" })
      .where(eq(recipes.id, recipeId))
      .run();
    fs.writeFileSync(path.join(getImagesDir(), "stray.jpeg"), "stray");

    const result = normalizeImages({ keepOrphans: true });
    expect(result.failed).toEqual([
      { recipeId, from: "missing.jpeg", reason: "source-missing" },
    ]);
    expect(result.orphans).toEqual({ reported: ["stray.jpeg"] });
    expect(fs.existsSync(path.join(getImagesDir(), "stray.jpeg"))).toBe(true);
    expect(
      getDb()
        .select({ imageFilename: recipes.imageFilename })
        .from(recipes)
        .where(eq(recipes.id, recipeId))
        .get()?.imageFilename,
    ).toBe("missing.jpeg");
  });
});
