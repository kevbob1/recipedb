/**
 * Search + browse the recipe store.
 *
 * Single home surface (#11) — the same list shows browse-by-category and
 * search-narrowed results. The on-disk pieces we touch:
 *   - recipes (the source of truth)
 *   - recipe_fts (FTS5 virtual table from drizzle/0000_init.sql)
 *   - tags, ingredient_lines (filter dimensions)
 *
 * Modes:
 *   - Browse (no query): SQL with filters, ordered by updated_at DESC, then
 *     title ASC. Stable, predictable, recent-first.
 *   - Search (query present): FTS5 MATCH on title/ingredients/steps/tags,
 *     ordered by bm25 (relevance). Prefix-match each token so partial words
 *     work ("sour" finds "sourdough").
 *
 * Filters compose across both modes:
 *   - category        exact match on recipes.category (closed MVP list)
 *   - tag             exact match on tags.label (already lower-cased)
 *   - favoriteOnly    recipes.favorite = 1
 *   - ingredientInclude   case-insensitive substring on ingredient_lines.item
 *   - cook            "What can I cook?" chips (ADR-0003 §B): filter first,
 *                     then rank rows by fewest missing ingredient lines. No
 *                     recipe is excluded — only re-ordered.
 *
 * Phone-friendly ergonomics live in the route; this module returns rows and
 * counts and is safe to unit-test in isolation.
 */
import { like, sql } from "drizzle-orm";
import { getDb, getRawSqlite } from "../db/client.server";
import {
  CATEGORIES,
  type Category,
  recipes,
  tags,
} from "../db/schema.server";
import { parseChips, rankByMissing } from "./cook-now";

export type { Category };
export { CATEGORIES };

/** Inputs the home page collects from the URL. All optional. */
export interface SearchInput {
  /** Free-text query, matched against title/ingredients/steps/tags via FTS5. */
  query?: string | null;
  /** Exact category from the MVP closed list. Empty/undefined = no filter. */
  category?: string | null;
  /** Exact tag label, lower-cased. Empty/undefined = no filter. */
  tag?: string | null;
  /** When true, only recipes marked favorite are returned. */
  favoriteOnly?: boolean | null;
  /** Case-insensitive substring match on any ingredient item. */
  ingredientInclude?: string | null;
  /**
   * "What can I cook?" chips, comma-separated (`cook` URL param). When
   * present, recipes are ranked by fewest missing ingredient lines; nobody is
   * filtered out.
   */
  cook?: string | null;
}

/** A row in the home list. Trimmed to what the UI needs. */
export interface SearchHit {
  id: number;
  title: string;
  category: Category;
  favorite: boolean;
  /** ms-since-epoch; used for "recent" ordering and timestamps. */
  updatedAt: number;
  /**
   * Only set when cook chips are active: how many ingredient lines match no
   * chip and are not a staple (ADR-0003 §B).
   */
  missingCount?: number;
  /** The missing line items themselves, in stored position order. */
  missingItems?: string[];
}

export interface SearchResult {
  hits: SearchHit[];
  /** Total rows the query matched, before the page limit. */
  total: number;
  /** Which mode was used; the route uses it to pick the heading. */
  mode: "browse" | "search";
}

/** Per-category counts, used to label the home category cards. */
export interface CategoryCount {
  category: Category;
  count: number;
}

/** Default page size for the home list. Tuned for phone, single screen. */
const DEFAULT_LIMIT = 50;

/**
 * Cap on candidates fetched before cook-now ranking. The ranking has to see
 * the whole (already-filtered) library to promise "every recipe stays
 * visible", and 200 matches the global page ceiling. A single-household
 * library is far below it.
 */
const COOK_NOW_CANDIDATES = 200;

/**
 * Sanitize a free-text query into a safe FTS5 MATCH expression.
 *
 * - Tokenizes on whitespace
 * - Drops FTS5 syntax characters (`"`, `*`, `(`, `)`, `:`, `^`, …) so user
 *   input cannot break out of the literal context
 * - Suffixes each surviving token with `*` so partial words match prefixes
 *   ("sour" → matches "sourdough")
 * - Empty input returns null (caller falls back to browse mode)
 */
export function buildFtsQuery(input: string): string | null {
  const cleaned = input
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0);
  if (cleaned.length === 0) return null;
  // Prefix match each token. FTS5 also supports phrase queries, but the
  // MVP "find a recipe in seconds" goal is served better by token prefixes.
  return cleaned.map((t) => `${t}*`).join(" ");
}

/**
 * Internal: collect the non-FTS filter clauses as a raw SQL fragment plus
 * the bound values to pair with its `?` placeholders.
 *
 * We return a string (not a drizzle SQL object) because the FTS branch needs
 * to splice the fragment into a larger raw statement. Column references
 * like `recipes.category` are written as their SQL identifier; the bound
 * `?` markers cover the actual values.
 */
function filtersFragment(
  input: SearchInput,
): { sql: string; params: unknown[] } | null {
  const parts: string[] = [];
  const params: unknown[] = [];

  const category = (input.category ?? "").trim();
  if (category && (CATEGORIES as readonly string[]).includes(category)) {
    parts.push(`recipes.category = ?`);
    params.push(category);
  }

  if (input.favoriteOnly) {
    parts.push(`recipes.favorite = 1`);
  }

  const tag = (input.tag ?? "").trim().toLowerCase();
  if (tag) {
    parts.push(
      `EXISTS (SELECT 1 FROM tags t WHERE t.recipe_id = recipes.id AND t.label = ?)`,
    );
    params.push(tag);
  }

  const ing = (input.ingredientInclude ?? "").trim();
  if (ing) {
    const pattern = `%${ing.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    parts.push(
      `EXISTS (SELECT 1 FROM ingredient_lines il WHERE il.recipe_id = recipes.id AND il.item LIKE ? ESCAPE '\\')`,
    );
    params.push(pattern);
  }

  if (parts.length === 0) return null;
  return { sql: parts.join(" AND "), params };
}

/**
 * Bulk id→item projection for the cook-now ranking. One raw query for the
 * whole candidate page instead of a per-recipe round-trip; rows come back in
 * stored line order so a card's missing list reads like the recipe.
 */
function ingredientItemsByRecipeId(
  ids: readonly number[],
): Map<number, string[]> {
  const out = new Map<number, string[]>();
  if (ids.length === 0) return out;
  const placeholders = ids.map(() => "?").join(", ");
  const rows = getRawSqlite()
    .prepare(
      `SELECT recipe_id AS recipeId, item
         FROM ingredient_lines
        WHERE recipe_id IN (${placeholders})
        ORDER BY recipe_id ASC, position ASC`,
    )
    .all(...ids) as Array<{ recipeId: number; item: string }>;
  for (const row of rows) {
    const list = out.get(row.recipeId);
    if (list) list.push(row.item);
    else out.set(row.recipeId, [row.item]);
  }
  return out;
}

/**
 * Apply the cook-now ranking to an already-filtered page (ADR-0003 §B).
 *
 * Chips only re-order: the SQL window fetched every candidate, so slicing here
 * is what preserves the page contract. Empty chips return the page untouched,
 * which keeps browse/relevance order byte-for-byte as before.
 */
function applyCookNow(
  hits: SearchHit[],
  chips: readonly string[],
  limit: number,
  offset: number,
): SearchHit[] {
  if (chips.length === 0) return hits;
  const ranked = rankByMissing(
    hits,
    ingredientItemsByRecipeId(hits.map((h) => h.id)),
    chips,
  );
  return ranked.slice(offset, offset + limit).map((row) => ({
    ...row.recipe,
    missingCount: row.missingCount,
    missingItems: row.missingItems,
  }));
}

/**
 * List recipes for the home page.
 *
 * - When `input.query` is non-empty, runs an FTS5 MATCH and orders by bm25
 *   (relevance).
 * - Otherwise orders by updated_at DESC then title ASC.
 *
 * All other filters compose in either mode.
 */
export function listRecipes(
  input: SearchInput,
  options: { limit?: number; offset?: number } = {},
): SearchResult {
  const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_LIMIT, 200));
  const offset = Math.max(0, options.offset ?? 0);
  const filters = filtersFragment(input);
  const ftsQuery = (input.query ?? "").trim()
    ? buildFtsQuery(input.query ?? "")
    : null;
  const cookChips = parseChips(input.cook);
  // With chips active the page must be ranked before the limit is applied, so
  // fetch the full candidate set (capped) and slice in `applyCookNow`.
  const windowLimit = cookChips.length > 0 ? COOK_NOW_CANDIDATES : limit;
  const windowOffset = cookChips.length > 0 ? 0 : offset;

  const sqlite = getRawSqlite();

  if (ftsQuery) {
    // FTS5 relevance branch. The recipes table is joined on rowid == id;
    // a recipe without an FTS row (shouldn't happen, but defensive) is just
    // excluded by the INNER JOIN.
    //
    // The MATCH expression itself cannot be a bound parameter — FTS5 parses
    // it as a query language. We inline `ftsQuery` instead; buildFtsQuery
    // already strips every character that has FTS5 syntax meaning, so the
    // remaining content is a literal prefix-term expression. Doubling any
    // embedded single quotes is the only escaping the SQL layer needs.
    const escapedFts = ftsQuery.replace(/'/g, "''");
    const filterSql = filters ? filters.sql : "1 = 1";
    const filterParams = filters ? filters.params : [];

    const whereSql = `recipe_fts MATCH '${escapedFts}' AND (${filterSql})`;

    const hits = sqlite
      .prepare(
        `SELECT recipes.id AS id,
                recipes.title AS title,
                recipes.category AS category,
                recipes.favorite AS favorite,
                CAST(recipes.updated_at AS INTEGER) AS updatedAt
         FROM recipe_fts
         JOIN recipes ON recipes.id = recipe_fts.rowid
         WHERE ${whereSql}
         ORDER BY bm25(recipe_fts)
         LIMIT ? OFFSET ?`,
      )
      .all(...filterParams, windowLimit, windowOffset) as Array<{
        id: number;
        title: string;
        category: string;
        favorite: number;
        updatedAt: number;
      }>;

    const totalRow = sqlite
      .prepare(
        `SELECT COUNT(*) AS n
         FROM recipe_fts
         JOIN recipes ON recipes.id = recipe_fts.rowid
         WHERE ${whereSql}`,
      )
      .get(...filterParams) as { n: number };

    const mapped: SearchHit[] = hits.map((h) => ({
      id: h.id,
      title: h.title,
      category: h.category as Category,
      favorite: Boolean(h.favorite),
      updatedAt: Number(h.updatedAt),
    }));

    return {
      hits: applyCookNow(mapped, cookChips, limit, offset),
      total: totalRow.n,
      mode: "search",
    };
  }

  // Browse branch — Drizzle for readability, with a hand-built WHERE that
  // mirrors the FTS branch's filter fragment so both paths share one
  // definition of "what counts as a filter".
  const db = getDb();
  const whereSql = filters ? filters.sql : "1 = 1";
  const whereParams = filters ? filters.params : [];

  const rowsRaw = sqlite
    .prepare(
      `SELECT id, title, category, favorite, updated_at AS updatedAt
         FROM recipes
        WHERE ${whereSql}
        ORDER BY updated_at DESC, title ASC
        LIMIT ? OFFSET ?`,
    )
    .all(...whereParams, windowLimit, windowOffset) as Array<{
      id: number;
      title: string;
      category: string;
      favorite: number;
      updatedAt: number;
    }>;

  const totalRow = sqlite
    .prepare(`SELECT COUNT(*) AS n FROM recipes WHERE ${whereSql}`)
    .get(...whereParams) as { n: number };

  // Silence unused warnings: drizzle is still imported for the browse
  // query API; keep db available for the count branch callers.
  void db;

  const mapped: SearchHit[] = rowsRaw.map((r) => ({
    id: r.id,
    title: r.title,
    category: r.category as Category,
    favorite: Boolean(r.favorite),
    updatedAt: Number(r.updatedAt),
  }));

  return {
    hits: applyCookNow(mapped, cookChips, limit, offset),
    total: totalRow.n,
    mode: "browse",
  };
}

/**
 * Count recipes per category, ignoring all other filters.
 *
 * Used by the home page to show category cards with live counts. The MVP
 * closed list is preserved even when a category has zero recipes, so the
 * home grid never reshuffles.
 */
export function categoryCounts(): CategoryCount[] {
  const db = getDb();
  const rows = db
    .select({
      category: recipes.category,
      n: sql<number>`COUNT(*)`,
    })
    .from(recipes)
    .groupBy(recipes.category)
    .all();

  const byCategory = new Map<Category, number>(
    rows.map((r) => [r.category as Category, Number(r.n)]),
  );
  return CATEGORIES.map((c) => ({
    category: c,
    count: byCategory.get(c) ?? 0,
  }));
}

/**
 * Tag suggestions for the autocomplete. Case-insensitive prefix match on the
 * stored (lower-cased) label. Sorted by usage count so the family's most-used
 * tags surface first.
 */
export function suggestTags(
  prefix: string,
  options: { limit?: number } = {},
): string[] {
  const limit = Math.max(1, Math.min(options.limit ?? 8, 25));
  const p = prefix.trim().toLowerCase();
  if (p.length === 0) return [];
  // Escape LIKE wildcards in the user input so they don't act as patterns.
  const pattern = `${p.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const db = getDb();
  const rows = db
    .select({ label: tags.label, n: sql<number>`COUNT(*)` })
    .from(tags)
    .where(like(tags.label, pattern))
    .groupBy(tags.label)
    .orderBy(sql`COUNT(*) DESC`, sql`${tags.label} ASC`)
    .limit(limit)
    .all();
  return rows.map((r) => r.label);
}

/** Distinct categories present in the data (subset of CATEGORIES). */
export function availableCategories(): Category[] {
  const db = getDb();
  const rows = db
    .selectDistinct({ category: recipes.category })
    .from(recipes)
    .all();
  return rows.map((r) => r.category as Category);
}
