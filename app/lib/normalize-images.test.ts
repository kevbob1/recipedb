import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../db/migrate.server";
import { getDb, getImagesDir, getRawSqlite } from "../db/client.server";
import { recipes } from "../db/schema.server";
import { saveDraft } from "./draft-store.server";
import { createDraft } from "./import";
import { normalizeImages } from "./normalize-images.server";

let dataDir: string;
let previousDataDir: string | undefined;

beforeAll(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "recipedb-normalize-"));
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

function makeRecipe(): number {
  return saveDraft(createDraft({ kind: "scan", text: "Test recipe" })).recipeId;
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
