/**
 * Read-view regression tests (issue #25).
 *
 * /recipes/:id is the page the home list now links to, so its behaviour is
 * `requireAuth` (covered by auth.test.ts) plus `loadReadRecipe`. These
 * exercise that helper against a real better-sqlite3 database:
 *   - a missing or malformed id is a 400 and never reaches the database
 *   - an unknown id — never saved, or deleted after saving — is a 404
 *   - a stored recipe loads whole: title, category, tags, favorite, yield,
 *     ordered ingredients, ordered steps, source url
 *   - loading twice is identical (the read view is read-only)
 *
 * It also guards the two pieces of wiring the ticket asked for, since neither
 * is reachable from a loader test: the route table registers `recipes/:id`,
 * and the home list links to the read view rather than straight to review.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { runMigrations } from "../db/migrate.server";
import { ensureDataDirs, getDb, getRawSqlite } from "../db/client.server";
import { recipes } from "../db/schema.server";
import { blankDraft, type RecipeDraft } from "./draft";
import { deleteRecipe, saveDraft } from "./draft-store.server";
import { loadReadRecipe, type ReadLoad } from "./read.server";

let tmpDir: string;
let originalDataDir: string | undefined;
let seededId: number;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "recipedb-read-"));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tmpDir;
  ensureDataDirs();
  runMigrations();

  seededId = saveDraft(readDraft()).recipeId;
});

afterAll(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  getRawSqlite().close();
});

/** A fully-populated recipe — every field the read view renders. */
function readDraft(): RecipeDraft {
  return {
    ...blankDraft(),
    title: "Lemon Butter Cod",
    titleConfidence: "ok",
    category: "other",
    categoryConfidence: "ok",
    yield: "2 servings",
    yieldConfidence: "ok",
    favorite: true,
    tags: ["Weeknight", "Seafood"],
    sourceType: "url",
    sourceUrl: "https://example.test/lemon-butter-cod",
    ingredients: [
      { text: "2 fillets cod", qty: "2", unit: null, item: "cod fillets", note: null, confidence: "ok" },
      { text: "3 tbsp butter", qty: "3", unit: "tbsp", item: "butter", note: "unsalted", confidence: "ok" },
      { text: "1 lemon", qty: "1", unit: null, item: "lemon", note: "zest and juice", confidence: "ok" },
    ],
    steps: [
      { position: 1, text: "Melt the butter in a skillet." },
      { position: 2, text: "Cook the cod 3 minutes per side." },
      { position: 3, text: "Finish with lemon zest and juice." },
    ],
  };
}

function expectFailure(result: ReadLoad, status: 400 | 404, message: string) {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected loadReadRecipe to fail");
  expect(result.status).toBe(status);
  expect(result.message).toBe(message);
}

function expectLoaded(result: ReadLoad) {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("expected loadReadRecipe to succeed");
  return result;
}

/** Resolve a repo-relative path from this test file (app/lib/...). */
function repoFile(relative: string): string {
  return fileURLToPath(new URL(`../../${relative}`, import.meta.url));
}

describe("loadReadRecipe — bad ids", () => {
  it.each(["abc", "0", "-3", "1.5", "", "   ", "3px"])("400s on %j", (raw) => {
    expectFailure(loadReadRecipe(raw), 400, "Not a recipe id");
  });

  it("400s when the id is absent entirely", () => {
    expectFailure(loadReadRecipe(undefined), 400, "Not a recipe id");
    expectFailure(loadReadRecipe(null), 400, "Not a recipe id");
  });
});

describe("loadReadRecipe — unknown id", () => {
  it("404s when no recipe has that id", () => {
    expectFailure(loadReadRecipe("9999"), 404, "Not found");
  });

  it("404s for an id that was deleted after saving", () => {
    const doomed = saveDraft({ ...readDraft(), title: "Doomed Recipe" }).recipeId;
    expectLoaded(loadReadRecipe(String(doomed)));
    expect(deleteRecipe(doomed)).toBe(true);
    expectFailure(loadReadRecipe(String(doomed)), 404, "Not found");
  });
});

describe("loadReadRecipe — stored recipe", () => {
  it("loads the title, category, yield, favorite flag, and source url", () => {
    const result = expectLoaded(loadReadRecipe(String(seededId)));
    expect(result.recipeId).toBe(seededId);
    expect(result.draft.title).toBe("Lemon Butter Cod");
    expect(result.draft.category).toBe("other");
    expect(result.draft.yield).toBe("2 servings");
    expect(result.draft.favorite).toBe(true);
    expect(result.draft.sourceUrl).toBe("https://example.test/lemon-butter-cod");
  });

  it("loads the tags", () => {
    const result = expectLoaded(loadReadRecipe(String(seededId)));
    // normalizeTag lowercases on write (see normalize.ts).
    expect([...result.draft.tags].sort()).toEqual(["seafood", "weeknight"]);
  });

  it("loads the steps in position order", () => {
    const result = expectLoaded(loadReadRecipe(String(seededId)));
    expect(result.draft.steps.map((s) => s.text)).toEqual([
      "Melt the butter in a skillet.",
      "Cook the cod 3 minutes per side.",
      "Finish with lemon zest and juice.",
    ]);
  });

  it("loads the ingredient lines in position order", () => {
    const result = expectLoaded(loadReadRecipe(String(seededId)));
    expect(result.draft.ingredients.map((i) => i.item)).toEqual([
      "cod fillets",
      "butter",
      "lemon",
    ]);
    expect(result.draft.ingredients[1]?.note).toBe("unsalted");
  });

  it("is read-only: loading twice changes neither the result nor the row", () => {
    const before = getDb()
      .select()
      .from(recipes)
      .where(eq(recipes.id, seededId))
      .get();
    const first = expectLoaded(loadReadRecipe(String(seededId)));
    const second = expectLoaded(loadReadRecipe(String(seededId)));
    const after = getDb()
      .select()
      .from(recipes)
      .where(eq(recipes.id, seededId))
      .get();

    expect(second.draft).toEqual(first.draft);
    expect(after?.updatedAt.getTime()).toBe(before?.updatedAt.getTime());
  });
});

describe("read-view wiring (issue #25)", () => {
  it("registers the read view in the route table", () => {
    const src = fs.readFileSync(repoFile("app/routes.ts"), "utf8");
    expect(src).toMatch(
      /route\(\s*"recipes\/:id"\s*,\s*"routes\/recipes\.\$id\.tsx"\s*\)/,
    );
  });

  it("links the home list to the read view, not straight to review", () => {
    const src = fs.readFileSync(repoFile("app/routes/_index.tsx"), "utf8");
    const start = src.indexOf("function RecipeRow");
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf("\n}", start));
    expect(body).toContain("to={`/recipes/${hit.id}`}");
    expect(body).not.toContain("/review");
  });

  it("keeps the read route read-only: it loads a recipe but exports no action", () => {
    const src = fs.readFileSync(repoFile("app/routes/recipes.$id.tsx"), "utf8");
    expect(src).toContain("loadReadRecipe");
    expect(src).not.toMatch(/export\s+async\s+function\s+action/);
  });
});
