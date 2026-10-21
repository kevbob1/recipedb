/**
 * Drizzle schema for recipedb.
 *
 * Domain source of truth: ../GLOSSARY.md
 * - Recipe: a single stored dish, one import or manual entry. No merge in MVP.
 * - Draft: every imported recipe lands here awaiting review. Auto-normalization
 *   is trim-only.
 * - Provenance: sourceType (url|scan|manual), sourceUrl, rawOcrText.
 * - Ingredient line: qty STRING (preserves fractions/ranges, NO numeric coercion),
 *   unit (optional free-text), item, note.
 * - Step: position + text.
 * - Category: required, fixed list — one-dish|soup|salad|bread|dessert|
 *   cookies|cake|pie|other.
 * - Tag: free-text label.
 * - Favorite: boolean.
 */
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

import { CATEGORIES, type Category } from "../lib/categories";
import type { QtyParseStatus } from "../lib/ingredient-line";

export { CATEGORIES, type Category };

/** Closed set of import sources for provenance. */
export const SOURCE_TYPES = ["url", "scan", "manual"] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export const recipes = sqliteTable(
  "recipes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** Human title. Required, trimmed. */
    title: text("title").notNull(),
    /**
     * Every import is a draft; nothing publishes silently.
     * True = draft (awaiting review). False = kept.
     */
    isDraft: integer("is_draft", { mode: "boolean" }).notNull().default(true),
    /** Free-form serving/yield notes, optional. */
    yield: text("yield"),
    /** Fixed-list category; required. */
    category: text("category").notNull().$type<Category>(),
    favorite: integer("favorite", { mode: "boolean" }).notNull().default(false),
    /** Where the recipe came from. */
    sourceType: text("source_type").notNull().$type<SourceType>(),
    sourceUrl: text("source_url"),
    /** Raw OCR text captured at import. */
    rawOcrText: text("raw_ocr_text"),
    /**
     * Relative path under DATA_DIR/images/ of the retained source capture
     * (scan upload) or imported image (#28). Null when the recipe has no
     * stored image. Deleted with the recipe row.
     */
    imageFilename: text("image_filename"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    check("recipes_category_valid", sql`${table.category} IN (${sql.join(CATEGORIES.map((c) => sql`${c}`), sql`, `)})`),
    check("recipes_source_type_valid", sql`${table.sourceType} IN ('url', 'scan', 'manual')`),
    index("recipes_category_idx").on(table.category),
    index("recipes_is_draft_idx").on(table.isDraft),
  ],
);

/**
 * Ingredient line — the four parts the GLOSSARY specifies.
 * `qty` is a STRING and remains the DISPLAY source of truth, so "2-3 cloves"
 * and "a bunch" round-trip verbatim.
 *
 * The `qtyAmount`/`qtyAmount2`/`qtyUnitNormalized`/`qtyParseStatus` columns are
 * the derived numeric view (decision on #15, #16): additive, nullable, and
 * written by the parser in app/lib/ingredient-line.ts. A scaled view is always
 * derived (amount x factor) and never rewrites `qty`.
 */
export const ingredientLines = sqliteTable(
  "ingredient_lines",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    recipeId: integer("recipe_id")
      .notNull()
      .references(() => recipes.id, { onDelete: "cascade" }),
    /**
     * Preserved EXACTLY as the user (or OCR) wrote it. Never coerced to a
     * number: fractions, ranges, and words like "a pinch" must round-trip.
     */
    qty: text("qty").notNull(),
    /** Optional free-text unit. Null when omitted. */
    unit: text("unit"),
    item: text("item").notNull(),
    note: text("note"),
    /** Display order within the recipe. */
    position: integer("position").notNull(),
    /** Low end (or the single value) of the parsed quantity. Null when unparsed. */
    qtyAmount: real("qty_amount"),
    /** High end of a range ("2-3" -> 3). Null for single values. */
    qtyAmount2: real("qty_amount2"),
    /** Canonical unit token from app/lib/ingredient-line.ts; null when unknown/absent. */
    qtyUnitNormalized: text("qty_unit_normalized"),
    /**
     * parsed | range | unparseable | unparsed. `unparsed` is the column default
     * (never attempted) — the one-shot backfill looks for exactly that.
     */
    qtyParseStatus: text("qty_parse_status")
      .$type<QtyParseStatus>()
      .notNull()
      .default("unparsed"),
  },
  (table) => [
    index("ingredient_lines_recipe_idx").on(table.recipeId),
    uniqueIndex("ingredient_lines_recipe_pos_uq").on(
      table.recipeId,
      table.position,
    ),
  ],
);

/** Step — one numbered instruction. */
export const steps = sqliteTable(
  "steps",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    recipeId: integer("recipe_id")
      .notNull()
      .references(() => recipes.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    text: text("text").notNull(),
  },
  (table) => [
    index("steps_recipe_idx").on(table.recipeId),
    uniqueIndex("steps_recipe_pos_uq").on(table.recipeId, table.position),
  ],
);

/** Tags — free-text labels. Normalized lower-case on insert. */
export const tags = sqliteTable(
  "tags",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    recipeId: integer("recipe_id")
      .notNull()
      .references(() => recipes.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
  },
  (table) => [
    uniqueIndex("tags_recipe_label_uq").on(table.recipeId, table.label),
    index("tags_label_idx").on(table.label),
  ],
);

/** Useful composite types for code that reads from these tables. */
export type Recipe = typeof recipes.$inferSelect;
export type NewRecipe = typeof recipes.$inferInsert;
export type IngredientLine = typeof ingredientLines.$inferSelect;
export type NewIngredientLine = typeof ingredientLines.$inferInsert;
export type Step = typeof steps.$inferSelect;
export type NewStep = typeof steps.$inferInsert;
export type Tag = typeof tags.$inferSelect;
export type NewTag = typeof tags.$inferInsert;

// Re-export `primaryKey` so consumer code that composes composite keys doesn't
// have to import from drizzle-orm directly. (No current consumer, but keeps the
// schema module's surface self-contained.)
export { primaryKey };
