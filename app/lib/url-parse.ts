/**
 * URL import parsing — JSON-LD escape hatch.
 *
 * `recipe-scrapers` is the primary path. When it can't find a scraper for a
 * given URL, or the host isn't recognized, we fall back to extracting the
 * JSON-LD Recipe blocks out of the HTML directly. This is the "escape hatch"
 * called out in ticket #4 — it lets the import flow handle arbitrary
 * recipe-shaped pages even when no first-class scraper exists.
 *
 * All parsing here is server-side. The browser never sees the HTML.
 */

import * as cheerio from "cheerio";

export interface ParsedJsonLd {
  /** Whatever shape was in @graph (we flatten to a list of objects). */
  blocks: unknown[];
  /** The first JSON-LD Recipe-ish object, if any. */
  recipe: Record<string, unknown> | null;
}

/**
 * Extract JSON-LD blocks from raw HTML. Walks every <script type="application/ld+json">
 * and parses its body. Some pages embed an @graph array; we normalize that.
 */
export function extractJsonLd(html: string): ParsedJsonLd {
  const $ = cheerio.load(html);
  const blocks: unknown[] = [];

  $('script[type="application/ld+json"]').each((_i, el) => {
    const body = $(el).contents().text();
    if (!body) return;
    try {
      const parsed: unknown = JSON.parse(body);
      if (Array.isArray(parsed)) {
        for (const item of parsed) blocks.push(item);
      } else if (
        parsed &&
        typeof parsed === "object" &&
        "@graph" in parsed &&
        Array.isArray((parsed as { "@graph": unknown[] })["@graph"])
      ) {
        for (const item of (parsed as { "@graph": unknown[] })["@graph"]) {
          blocks.push(item);
        }
        // Keep the wrapper so the raw drawer shows it too.
        blocks.push(parsed);
      } else {
        blocks.push(parsed);
      }
    } catch {
      // ignore malformed JSON-LD; fall back to other blocks
    }
  });

  const recipe = findRecipeBlock(blocks);
  return { blocks, recipe };
}

function isRecipeObject(o: unknown): o is Record<string, unknown> {
  if (!o || typeof o !== "object") return false;
  const obj = o as Record<string, unknown>;
  // Schema.org allows @type as a string or an array.
  const t = obj["@type"];
  if (typeof t === "string") {
    return t.toLowerCase() === "recipe";
  }
  if (Array.isArray(t)) {
    return t.some((x) => typeof x === "string" && x.toLowerCase() === "recipe");
  }
  return false;
}

function findRecipeBlock(blocks: unknown[]): Record<string, unknown> | null {
  for (const b of blocks) {
    if (isRecipeObject(b)) return b;
  }
  return null;
}

/**
 * Pull a string out of a Schema.org value, which may be a string, an array of
 * strings, or an object with a @value (rare for recipes but allowed by the
 * spec). Returns null if the field is missing or empty.
 */
export function pickString(
  value: unknown,
): string | null {
  if (typeof value === "string") {
    const t = value.trim();
    return t.length === 0 ? null : t;
  }
  if (Array.isArray(value)) {
    for (const v of value) {
      const s = pickString(v);
      if (s) return s;
    }
    return null;
  }
  return null;
}

/** Pick an array of strings (e.g. recipeCategory, recipeCuisine). */
export function pickStringArray(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (typeof value === "string") {
    const t = value.trim();
    return t.length === 0 ? [] : [t];
  }
  if (Array.isArray(value)) {
    const out: string[] = [];
    for (const v of value) {
      const s = pickString(v);
      if (s) out.push(s);
    }
    return out;
  }
  return [];
}

/**
 * recipeInstructions is the messiest field in the spec: a plain string, an
 * array of strings, `HowToStep` objects (`{ text }`), or `HowToSection`
 * objects that nest their steps under `itemListElement`. Flatten every shape
 * into ordered step strings.
 */
export function pickInstructionTexts(value: unknown): string[] {
  if (typeof value === "string") {
    const t = value.trim();
    return t.length === 0 ? [] : [t];
  }
  if (Array.isArray(value)) {
    return value.flatMap((v) => pickInstructionTexts(v));
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (obj["itemListElement"] !== undefined) {
      return pickInstructionTexts(obj["itemListElement"]);
    }
    const text = pickString(obj["text"]) ?? pickString(obj["name"]);
    return text ? [text] : [];
  }
  return [];
}

/**
 * `keywords` is a comma-separated string on most sites and an array of
 * strings on some. Return one entry per keyword, trimmed and non-empty.
 */
export function pickKeywords(value: unknown): string[] {
  return pickStringArray(value)
    .flatMap((entry) => entry.split(","))
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** Pick an image URL out of the various shapes JSON-LD allows. */
export function pickImage(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value || null;
  if (Array.isArray(value)) {
    for (const v of value) {
      const s = pickImage(v);
      if (s) return s;
    }
    return null;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const url = obj["url"];
    if (typeof url === "string" && url) return url;
  }
  return null;
}

/** Pull an ISO 8601 duration (PT15M) and turn it into "15 min". */
export function pickDurationMin(value: unknown): string | null {
  const s = pickString(value);
  if (!s) return null;
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?$/.exec(s);
  if (!m) return s; // fall back to the raw text
  const h = m[1] ? `${m[1]} hr` : null;
  const mins = m[2] ? `${m[2]} min` : null;
  if (h && mins) return `${h} ${mins}`;
  return h ?? mins ?? null;
}
