/**
 * Search + browse coverage.
 *
 * Confirms:
 *   - browse mode orders by updated_at DESC, then title ASC
 *   - category filter narrows browse
 *   - tag filter narrows browse (lowercased label, EXISTS)
 *   - favoriteOnly filter narrows browse
 *   - ingredientInclude substring filter narrows browse
 *   - FTS5 query returns hits across title, ingredient, and tag columns
 *   - FTS5 prefix search ("sour") matches "sourdough"
 *   - categoryCounts preserves the MVP closed list even at zero
 *   - suggestTags is case-insensitive prefix and ranks by usage
 *   - buildFtsQuery sanitizes FTS5 syntax characters
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runMigrations } from "../db/migrate.server";
import { ensureDataDirs, getDb, getRawSqlite } from "../db/client.server";
import {
  ingredientLines,
  recipes,
  steps,
  tags,
  type NewRecipe,
} from "../db/schema.server";
import {
  buildFtsQuery,
  categoryCounts,
  listRecipes,
  suggestTags,
} from "./search.server";

let tmpDir: string;
let originalDataDir: string | undefined;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "recipedb-search-"));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tmpDir;
  ensureDataDirs();
  runMigrations();
  seed();
});

afterAll(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  getRawSqlite().close();
});

function seed() {
  const db = getDb();
  // Three recipes with distinct categories, ingredients, and tags. Updated at
  // distinct times so recent-first ordering is deterministic.
  const mk = (
    title: string,
    category: "soup" | "bread" | "cookies",
    favorite: boolean,
    updatedAt: number,
    ings: Array<{ item: string; qty?: string }>,
    stepText: string,
    tagList: string[],
  ) => {
    const base: NewRecipe = {
      title,
      isDraft: true,
      category,
      favorite,
      sourceType: "manual",
      createdAt: new Date(updatedAt),
      updatedAt: new Date(updatedAt),
    };
    const [r] = db.insert(recipes).values(base).returning().all();
    if (!r) throw new Error("seed insert failed");
    db.insert(ingredientLines)
      .values(
        ings.map((ing, i) => ({
          recipeId: r.id,
          qty: ing.qty ?? "1",
          unit: null,
          item: ing.item,
          note: null,
          position: i + 1,
        })),
      )
      .run();
    db.insert(steps)
      .values({ recipeId: r.id, position: 1, text: stepText })
      .run();
    for (const label of tagList) {
      db.insert(tags).values({ recipeId: r.id, label: label.toLowerCase() }).run();
    }
    return r.id;
  };
  mk("Sourdough Pancakes", "bread", true, 1_700_000_000_000, [
    { item: "flour" },
    { item: "buttermilk" },
  ], "Whisk until smooth.", ["breakfast", "weekend"]);
  mk("Tomato Basil Soup", "soup", false, 1_700_001_000_000, [
    { item: "tomatoes" },
    { item: "basil" },
  ], "Simmer and blend.", ["weeknight"]);
  mk("Oatmeal Cookies", "cookies", true, 1_700_002_000_000, [
    { item: "oats" },
    { item: "butter" },
  ], "Bake at 350.", ["baking", "weekend"]);
}

describe("buildFtsQuery", () => {
  it("returns null on empty input", () => {
    expect(buildFtsQuery("")).toBeNull();
    expect(buildFtsQuery("   ")).toBeNull();
  });

  it("suffixes each token with * for prefix matching", () => {
    expect(buildFtsQuery("sour pan")).toBe("sour* pan*");
  });

  it("strips FTS5 syntax characters before suffixing", () => {
    // The double-quote, asterisk, and parens would otherwise alter the query
    // expression. They are removed and the surviving tokens get prefix-*.
    expect(buildFtsQuery('"cheese" (cake)')).toBe("cheese* cake*");
  });
});

describe("listRecipes (browse)", () => {
  it("returns every recipe with no filters, recent first", () => {
    const { hits, mode, total } = listRecipes({});
    expect(mode).toBe("browse");
    expect(total).toBe(3);
    // Most recent first: cookies, soup, bread.
    expect(hits.map((h) => h.title)).toEqual([
      "Oatmeal Cookies",
      "Tomato Basil Soup",
      "Sourdough Pancakes",
    ]);
  });

  it("narrowed by category", () => {
    const { hits, total } = listRecipes({ category: "bread" });
    expect(total).toBe(1);
    expect(hits[0]?.title).toBe("Sourdough Pancakes");
  });

  it("ignores an unknown category rather than throwing", () => {
    const { hits, total } = listRecipes({ category: "fusion" });
    expect(total).toBe(3);
    expect(hits.length).toBe(3);
  });

  it("narrowed by tag (case-insensitive, lower-cased)", () => {
    const { hits, total } = listRecipes({ tag: "WEEKEND" });
    expect(total).toBe(2);
    const titles = hits.map((h) => h.title).sort();
    expect(titles).toEqual(["Oatmeal Cookies", "Sourdough Pancakes"]);
  });

  it("narrowed by favoriteOnly", () => {
    const { hits, total } = listRecipes({ favoriteOnly: true });
    expect(total).toBe(2);
    expect(hits.every((h) => h.favorite)).toBe(true);
  });

  it("narrowed by ingredientInclude (case-insensitive substring on item)", () => {
    const { hits, total } = listRecipes({ ingredientInclude: "BAsil" });
    expect(total).toBe(1);
    expect(hits[0]?.title).toBe("Tomato Basil Soup");
  });

  it("composes multiple filters", () => {
    const { hits, total } = listRecipes({
      tag: "weekend",
      favoriteOnly: true,
    });
    expect(total).toBe(2);
    expect(hits.map((h) => h.title).sort()).toEqual([
      "Oatmeal Cookies",
      "Sourdough Pancakes",
    ]);
  });
});

describe("listRecipes (search / FTS5)", () => {
  it("matches a title term", () => {
    const { hits, mode, total } = listRecipes({ query: "sourdough" });
    expect(mode).toBe("search");
    expect(total).toBe(1);
    expect(hits[0]?.title).toBe("Sourdough Pancakes");
  });

  it("prefix-matches a partial word", () => {
    // "sour" should match "sourdough" via the token* prefix.
    const { hits, total } = listRecipes({ query: "sour" });
    expect(total).toBe(1);
    expect(hits[0]?.title).toBe("Sourdough Pancakes");
  });

  it("matches an ingredient term", () => {
    const { hits, total } = listRecipes({ query: "tomato" });
    expect(total).toBe(1);
    expect(hits[0]?.title).toBe("Tomato Basil Soup");
  });

  it("matches a tag term", () => {
    const { hits, total } = listRecipes({ query: "weekend" });
    expect(total).toBe(2);
  });

  it("matches a step term", () => {
    const { hits, total } = listRecipes({ query: "blend" });
    expect(total).toBe(1);
    expect(hits[0]?.title).toBe("Tomato Basil Soup");
  });

  it("applies filters on top of a search query", () => {
    const { hits, total } = listRecipes({
      query: "weekend",
      favoriteOnly: true,
    });
    expect(total).toBe(2);
    expect(hits.every((h) => h.favorite)).toBe(true);
  });

  it("returns zero hits on a non-matching query", () => {
    const { hits, total } = listRecipes({ query: "xyzzy" });
    expect(total).toBe(0);
    expect(hits).toEqual([]);
  });
});

describe("categoryCounts", () => {
  it("preserves the full MVP list, including empty categories", () => {
    const counts = categoryCounts();
    // The MVP closed list is always present, in order, even if zero.
    expect(counts.length).toBe(9);
    expect(counts.map((c) => c.category)).toEqual([
      "one-dish",
      "soup",
      "salad",
      "bread",
      "dessert",
      "cookies",
      "cake",
      "pie",
      "other",
    ]);
    // Seeded only soup, bread, and cookies.
    const byCat = Object.fromEntries(counts.map((c) => [c.category, c.count]));
    expect(byCat.soup).toBe(1);
    expect(byCat.bread).toBe(1);
    expect(byCat.cookies).toBe(1);
    expect(byCat.salad).toBe(0);
  });
});

describe("suggestTags", () => {
  it("returns a case-insensitive prefix list, ranked by usage", () => {
    const out = suggestTags("week");
    expect(out).toEqual(["weekend", "weeknight"]);
  });

  it("returns [] for empty input", () => {
    expect(suggestTags("")).toEqual([]);
    expect(suggestTags("   ")).toEqual([]);
  });
});
