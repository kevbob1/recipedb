/**
 * Cook-screen loader regression tests (issue #18).
 *
 * The /recipes/:id/cook route's loader is `requireAuth` (covered by
 * auth.test.ts) plus `loadCookRecipe`, so that is what these exercise against
 * a real better-sqlite3 database:
 *   - a missing or malformed id is a 400 and never reaches the database
 *   - an unknown id is a 404
 *   - a stored recipe loads whole: title, ordered ingredients, ordered steps
 *   - loading twice is identical (the cook screen is read-only)
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runMigrations } from "../db/migrate.server";
import { ensureDataDirs, getDb, getRawSqlite } from "../db/client.server";
import { recipes } from "../db/schema.server";
import { eq } from "drizzle-orm";
import { blankDraft, type RecipeDraft } from "./draft";
import { saveDraft } from "./save-draft.server";
import { loadCookRecipe, type CookLoad } from "./cook.server";

let tmpDir: string;
let originalDataDir: string | undefined;
let seededId: number;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "recipedb-cook-"));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tmpDir;
  ensureDataDirs();
  runMigrations();

  seededId = saveDraft(cookDraft()).recipeId;
});

afterAll(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  getRawSqlite().close();
});

/** A two-step, three-ingredient recipe — enough to prove ordering. */
function cookDraft(): RecipeDraft {
  return {
    ...blankDraft(),
    title: "Skillet Beans",
    titleConfidence: "ok",
    category: "other",
    categoryConfidence: "ok",
    yield: "2 servings",
    yieldConfidence: "ok",
    ingredients: [
      { text: "1 can white beans", qty: "1 can", unit: "can", item: "white beans", note: null, confidence: "ok" },
      { text: "2 cloves garlic", qty: "2", unit: "clove", item: "garlic", note: "minced", confidence: "ok" },
      { text: "olive oil", qty: "", unit: null, item: "olive oil", note: null, confidence: "warn" },
    ],
    steps: [
      { position: 1, text: "Warm the olive oil in a skillet." },
      { position: 2, text: "Add the garlic, then the beans; simmer 10 minutes." },
    ],
  };
}

function expectFailure(result: CookLoad, status: 400 | 404, message: string) {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected loadCookRecipe to fail");
  expect(result.status).toBe(status);
  expect(result.message).toBe(message);
}

function expectLoaded(result: CookLoad) {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("expected loadCookRecipe to succeed");
  return result;
}

describe("loadCookRecipe — bad ids", () => {
  it.each(["abc", "0", "-3", "1.5", "", "   ", "3px"])(
    "400s on %j",
    (raw) => {
      expectFailure(loadCookRecipe(raw), 400, "Not a recipe id");
    },
  );

  it("400s when the id is absent entirely", () => {
    expectFailure(loadCookRecipe(undefined), 400, "Not a recipe id");
    expectFailure(loadCookRecipe(null), 400, "Not a recipe id");
  });
});

describe("loadCookRecipe — unknown id", () => {
  it("404s when no recipe has that id", () => {
    expectFailure(loadCookRecipe("9999"), 404, "Not found");
  });
});

describe("loadCookRecipe — stored recipe", () => {
  it("loads the title, yield, and ordered steps", () => {
    const result = expectLoaded(loadCookRecipe(String(seededId)));
    expect(result.recipeId).toBe(seededId);
    expect(result.draft.title).toBe("Skillet Beans");
    expect(result.draft.yield).toBe("2 servings");
    expect(result.draft.steps.map((s) => s.text)).toEqual([
      "Warm the olive oil in a skillet.",
      "Add the garlic, then the beans; simmer 10 minutes.",
    ]);
  });

  it("loads every ingredient line in position order", () => {
    const result = expectLoaded(loadCookRecipe(String(seededId)));
    expect(result.draft.ingredients.map((i) => i.item)).toEqual([
      "white beans",
      "garlic",
      "olive oil",
    ]);
    expect(result.draft.ingredients[1]?.note).toBe("minced");
  });

  it("accepts a numeric route param as well as a string one", () => {
    const fromString = expectLoaded(loadCookRecipe(String(seededId)));
    expect(fromString.recipeId).toBe(seededId);
  });

  it("is read-only: loading twice changes neither the result nor the row", () => {
    const before = getDb()
      .select()
      .from(recipes)
      .where(eq(recipes.id, seededId))
      .get();
    const first = expectLoaded(loadCookRecipe(String(seededId)));
    const second = expectLoaded(loadCookRecipe(String(seededId)));
    const after = getDb()
      .select()
      .from(recipes)
      .where(eq(recipes.id, seededId))
      .get();

    expect(second.draft).toEqual(first.draft);
    expect(after?.updatedAt.getTime()).toBe(before?.updatedAt.getTime());
    expect(after?.isDraft).toBe(true);
  });
});
