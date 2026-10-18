/**
 * Server-side URL import — ticket #4.
 *
 * Primary path: `recipe-scrapers` (site-specific scrapers, then a generic
 * fallback). When no scraper matches a URL we fall back to extracting the
 * JSON-LD Recipe block directly from the HTML (the "escape hatch" called
 * out in the ticket). The browser never sees the HTML.
 *
 * Image download: sharp on the server, WebP or AVIF depending on the
 * Accept header. The downloaded image is written to DATA_DIR/images/ and
 * the public path is returned for the draft.
 *
 * Politeness: a single User-Agent string, no retries, and a 12s server-side
 * fetch timeout.
 */

import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import {
  type IngredientItem,
  type InstructionItem,
  scrapeRecipe,
} from "recipe-scrapers";
import { getImagesDir, getRawSqlite } from "../db/client.server";
import {
  type Confidence,
  type DraftIngredient,
  type DraftStep,
  type RecipeDraft,
} from "./draft";
import { trimOnly, trimOnlyRequired } from "./normalize";
import {
  extractJsonLd,
  pickImage,
  pickString,
  pickStringArray,
  pickInstructionTexts,
  pickKeywords,
} from "./url-parse";

/** Politeness: identify ourselves and time out aggressively. */
const USER_AGENT = "recipedb/0.1 (+https://github.com/kevbob1/recipedb)";
const FETCH_TIMEOUT_MS = 12_000;

/** What we accept as a category from the page. */
const CATEGORIES_SET = new Set([
  "one-dish",
  "soup",
  "salad",
  "bread",
  "dessert",
  "cookies",
  "cake",
  "pie",
  "other",
] as const);

export interface ImportUrlResult {
  draft: RecipeDraft;
  /** The image filename under DATA_DIR/images/ if we downloaded one. */
  imageFilename: string | null;
}

/**
 * Fetch a URL's HTML and turn it into a RecipeDraft.
 *
 * Tries `recipe-scrapers` first; if that throws or returns nothing useful
 * (no title, no ingredients), falls back to JSON-LD extraction.
 */
export async function importFromUrl(rawUrl: string): Promise<ImportUrlResult> {
  const url = normalizeUrl(rawUrl);
  if (!url) {
    throw new ImportError("invalid-url", "That doesn't look like an http(s) URL.");
  }

  const html = await fetchHtml(url);

  // Primary: recipe-scrapers (with a generic fallback inside the library).
  let primaryDraft: RecipeDraft | null = null;
  try {
    const parsed = await scrapeRecipe(html, url, { parseIngredients: true });
    primaryDraft = draftFromScraper(parsed, url);
  } catch (err) {
    // recipe-scrapers throws when the URL is unknown to it; that's the
    // expected signal to fall back.
    primaryDraft = null;
    if (process.env.NODE_ENV !== "production") {
      console.warn("[import-url] recipe-scrapers failed:", (err as Error).message);
    }
  }

  // Fallback: JSON-LD.
  let fallbackDraft: RecipeDraft | null = null;
  let fallbackImageUrl: string | null = null;
  if (!primaryDraft || !primaryDraft.title.trim()) {
    const { recipe, blocks } = extractJsonLd(html);
    if (recipe) {
      fallbackDraft = draftFromJsonLd(recipe, url);
      fallbackDraft.raw = JSON.stringify(blocks, null, 2);
      fallbackImageUrl = pickImage(recipe["image"]);
    }
  }

  const draft = primaryDraft && primaryDraft.title.trim() ? primaryDraft : fallbackDraft;
  if (!draft) {
    throw new ImportError(
      "no-recipe-found",
      "Couldn't find a recipe on that page. Try a different URL or pick 'Type it in'.",
    );
  }

  // Image download (sharp → WebP or AVIF, saved under images/).
  let imageFilename: string | null = null;
  if (draft.sourceUrl) {
    // recipe-scrapers keeps its image inside the raw JSON; the JSON-LD
    // fallback hands it over directly because its raw is the whole block
    // list, not a single recipe object (#13 smoke test).
    const imageUrl =
      draft === primaryDraft
        ? extractImageFromDraft(draft, html)
        : fallbackImageUrl;
    if (imageUrl) {
      try {
        imageFilename = await downloadRecipeImage(imageUrl);
        // Stash the local-served path in raw as a hint for the UI.
        draft.raw = (draft.raw ?? "") +
          `\n\n# local image: /images/${imageFilename}`;
      } catch (err) {
        // Image download is best-effort; never fail the import.
        if (process.env.NODE_ENV !== "production") {
          console.warn("[import-url] image download failed:", (err as Error).message);
        }
      }
    }
  }

  return { draft, imageFilename };
}

class ImportError extends Error {
  constructor(
    public code: "invalid-url" | "no-recipe-found" | "fetch-failed",
    message: string,
  ) {
    super(message);
  }
}
export { ImportError };

/** Normalize a user-pasted URL: trim, prepend https:// if no scheme. */
export function normalizeUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let candidate = trimmed;
  if (!/^https?:\/\//i.test(candidate)) {
    candidate = "https://" + candidate;
  }
  try {
    const u = new URL(candidate);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

async function fetchHtml(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        "user-agent": USER_AGENT,
        accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new ImportError(
        "fetch-failed",
        `Fetch returned HTTP ${res.status}.`,
      );
    }
    return await res.text();
  } catch (err) {
    if (err instanceof ImportError) throw err;
    if ((err as Error).name === "AbortError") {
      throw new ImportError("fetch-failed", "Fetch timed out after 12s.");
    }
    throw new ImportError("fetch-failed", (err as Error).message);
  } finally {
    clearTimeout(timer);
  }
}

function draftFromScraper(
  parsed: Awaited<ReturnType<typeof scrapeRecipe>>,
  url: string,
): RecipeDraft {
  const title = trimOnlyRequired(parsed.title);
  const ingredients: DraftIngredient[] = flattenIngredients(parsed.ingredients);
  const steps: DraftStep[] = flattenInstructions(parsed.instructions);
  return {
    title,
    titleConfidence: title ? "ok" : "bad",
    category: categoryFromKeywords([
      ...(parsed.category ?? []),
      ...(parsed.cuisine ?? []),
    ]),
    categoryConfidence:
      (parsed.category?.length ?? 0) + (parsed.cuisine?.length ?? 0) > 0
        ? "ok"
        : "warn",
    yield: trimOnly(parsed.yields ?? null),
    yieldConfidence: parsed.yields ? "ok" : "bad",
    tags: uniqueLower((parsed.keywords ?? []).slice(0, 8)),
    sourceType: "url",
    sourceUrl: url,
    rawOcrText: null,
    favorite: false,
    ingredients,
    steps,
    raw: JSON.stringify(parsed, null, 2),
  };
}

function draftFromJsonLd(
  recipe: Record<string, unknown>,
  url: string,
): RecipeDraft {
  const title = trimOnlyRequired(pickString(recipe["name"]));
  const ingredients: DraftIngredient[] = pickStringArray(
    recipe["recipeIngredient"],
  ).map((line) => ingredientFromRawLine(line, "ok"));
  const steps: DraftStep[] = pickInstructionTexts(
    recipe["recipeInstructions"],
  ).map((text, i) => ({ position: i + 1, text: trimOnlyRequired(text) }));
  const yields = pickString(recipe["recipeYield"]);
  const categoryKeywords = [
    ...pickStringArray(recipe["recipeCategory"]),
    ...pickStringArray(recipe["recipeCuisine"]),
  ];
  const tags = pickKeywords(recipe["keywords"]);
  return {
    title,
    titleConfidence: title ? "ok" : "bad",
    category: categoryFromKeywords(categoryKeywords),
    categoryConfidence: categoryKeywords.length > 0 ? "ok" : "warn",
    yield: trimOnly(yields),
    yieldConfidence: yields ? "ok" : "bad",
    tags: uniqueLower(tags.slice(0, 8)),
    sourceType: "url",
    sourceUrl: url,
    rawOcrText: null,
    favorite: false,
    ingredients,
    steps,
  };
}

/**
 * Try to find an image URL for the page — either from the recipe-scrapers
 * result or from the JSON-LD we already extracted. The HTML is only used as a
 * last-resort hint.
 */
function extractImageFromDraft(draft: RecipeDraft, _html: string): string | null {
  // draft.raw holds the JSON of the scraper result. Cheap to fish the image
  // out of there for a single page.
  if (!draft.raw) return null;
  try {
    const parsed = JSON.parse(draft.raw) as Record<string, unknown>;
    return pickImage(parsed["image"]);
  } catch {
    return null;
  }
}

/**
 * Flatten the grouped-ingredient output of recipe-scrapers into the
 * per-line shape the review screen uses. We use the parsed qty/unit/desc
 * when available; otherwise we fall back to a single line per raw item.
 */
function flattenIngredients(
  groups: Awaited<ReturnType<typeof scrapeRecipe>>["ingredients"],
): DraftIngredient[] {
  const out: DraftIngredient[] = [];
  for (const group of groups) {
    for (const item of group.items) {
      out.push(ingredientFromScraperItem(item));
    }
  }
  return out;
}

function ingredientFromScraperItem(item: IngredientItem): DraftIngredient {
  const text = trimOnlyRequired(item.value);
  const parsed = item.parsed;
  if (parsed) {
    const qty = formatQty(parsed.quantity, parsed.quantity2);
    const unit = trimOnly(parsed.unitOfMeasure ?? null);
    const itemName = trimOnlyRequired(parsed.description || text);
    const note = null; // parsed.description is the whole item line; no separate note.
    return {
      text,
      qty,
      unit,
      item: itemName,
      note,
      confidence: qty ? "ok" : "warn",
    };
  }
  return ingredientFromRawLine(text, "warn");
}

function ingredientFromRawLine(
  text: string,
  confidence: Confidence,
): DraftIngredient {
  return {
    text,
    qty: "",
    unit: null,
    item: text,
    note: null,
    confidence,
  };
}

/** Render "2" or "1-2" or "" depending on whether the second quantity is set. */
function formatQty(a: number | null, b: number | null): string {
  if (a === null || a === undefined) return "";
  if (b === null || b === undefined) return String(a);
  if (a === b) return String(a);
  return `${a}-${b}`;
}

function flattenInstructions(
  groups: Awaited<ReturnType<typeof scrapeRecipe>>["instructions"],
): DraftStep[] {
  const out: DraftStep[] = [];
  let pos = 1;
  for (const group of groups) {
    for (const item of group.items) {
      out.push({
        position: pos++,
        text: trimOnlyRequired((item as InstructionItem).value),
      });
    }
  }
  return out;
}

function categoryFromKeywords(words: string[]): RecipeDraft["category"] {
  const lower = words.map((w) => w.toLowerCase()).join(" ");
  // Best-effort mapping from food-blog category strings to the MVP fixed list.
  if (/\b(soup|stew|chili|broth)\b/.test(lower)) return "soup";
  if (/\b(salad|slaw)\b/.test(lower)) return "salad";
  if (/\b(bread|loaf|focaccia|baguette|bun|roll|sourdough)\b/.test(lower)) return "bread";
  if (/\b(cookie|biscuit)\b/.test(lower)) return "cookies";
  if (/\b(cake|torte|gateau)\b/.test(lower)) return "cake";
  if (/\b(pie|tart|crumble)\b/.test(lower)) return "pie";
  if (/\b(dessert|pudding|custard|mousse)\b/.test(lower)) return "dessert";
  if (/\b(one[- ]pot|one[- ]dish|skillet|casserole|main)\b/.test(lower)) return "one-dish";
  if (CATEGORIES_SET.has(lower as RecipeDraft["category"])) {
    return lower as RecipeDraft["category"];
  }
  return "other";
}

function uniqueLower(words: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of words) {
    const t = w.trim().toLowerCase();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/**
 * Download an image, normalize it with sharp (WebP or AVIF), and write to
 * DATA_DIR/images/. Returns the filename. Best-effort: callers swallow
 * download failures because a missing image must never break an import.
 */
async function downloadRecipeImage(imageUrl: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(imageUrl, {
      headers: { "user-agent": USER_AGENT, accept: "image/*" },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength === 0) return null;
    return writeImage(buf);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function writeImage(buf: Buffer): Promise<string> {
  const dir = getImagesDir();
  fs.mkdirSync(dir, { recursive: true });
  const id = nextImageId();
  const filename = `${id}.webp`;
  const out = path.join(dir, filename);
  await sharp(buf)
    .rotate() // honor EXIF orientation
    .resize({ width: 1600, withoutEnlargement: true })
    .webp({ quality: 82 })
    .toFile(out);
  return filename;
}

function nextImageId(): number {
  // Monotonic IDs in the same table the FTS5 bookkeeping uses; no separate
  // image table exists in the MVP, so we track a tiny counter alongside the
  // recipe id.
  const row = getRawSqlite()
    .prepare("SELECT COALESCE(MAX(id), 0) AS m FROM recipes")
    .get() as { m: number };
  return row.m + 1;
}
