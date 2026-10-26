/**
 * Import seam — turning an outside artifact (a URL, raw OCR text, or nothing
 * at all) into a RecipeDraft.
 *
 * ADR-0002 (docs/adr/0002-unified-draft-factory.md): there is exactly one
 * place that builds a draft, `createDraft(input)`, and exactly one place that
 * stamps provenance and initial confidence — the adapter for the input kind.
 * Callers describe where the recipe came from and hand over the data; they
 * never spread `blankDraft()` and never set `sourceType` themselves. Before
 * this, every path re-stamped a draft another module had already stamped
 * (URL: scraper + importUrl; scan: ocrTextToDraft + importScan + the Add
 * route; manual: blankDraft + the Add route), and the double stamping was the
 * common cause of import-path bugs.
 *
 * This half is client-safe on purpose: the Add flow recognizes photos in the
 * browser, so the scan adapter (and the shared category mapping) must ship to
 * the client. The server half (fetching and parsing the page) is
 * ./import.server.ts, which feeds the url adapter with scraper data.
 */
import {
  CATEGORIES,
  type Category,
  type Confidence,
  type DraftIngredient,
  type DraftStep,
  type RecipeDraft,
  blankDraft,
  optionalFieldConfidence,
  requiredFieldConfidence,
} from "./draft";
import { guessCategory } from "./ocr";
import { trimOnly, trimOnlyRequired } from "./normalize";

/** A draft imported from a URL, plus the capture the server retained (if any). */
export interface ImportedDraft {
  draft: RecipeDraft;
  imageFilename: string | null;
}

/** Import failed at the seam. `message` is safe to show to the person. */
export class ImportSeamError extends Error {
  constructor(
    message: string,
    public code: string = "import-failed",
  ) {
    super(message);
    this.name = "ImportSeamError";
  }
}

/**
 * What the URL scraper knows about a page, stripped of provenance and of the
 * draft-level confidence it must not decide on its own.
 *
 * `ingredients` keeps its per-line confidence: that value is the ingredient
 * parser's own verdict on how well it split a raw line, not a draft-level
 * stamp. Everything else is raw page data; the url adapter turns it into a
 * draft.
 */
export interface ScrapedRecipeData {
  /** Page title, untrimmed. */
  title: string;
  /** Category/cuisine strings from the page, used for the MVP category guess. */
  categoryKeywords: string[];
  /** Yield/serving note from the page, or null. */
  yields: string | null;
  /** Keyword/tag strings from the page, untrimmed and unsliced. */
  tags: string[];
  ingredients: DraftIngredient[];
  steps: DraftStep[];
  /** Raw source blob for the review drawer (scraper JSON or JSON-LD blocks). */
  raw?: string;
}

/** Import a recipe the server already fetched: the scraper's data, plus its URL. */
export interface UrlDraftInput {
  kind: "url";
  /** Canonical URL the data came from; becomes `sourceUrl`. */
  url: string;
  data: ScrapedRecipeData;
  /** Retained capture to point the draft at (#28), if the import downloaded one. */
  imageFilename?: string | null;
}

/** Import a recipe from text already recognized on this device. */
export interface ScanDraftInput {
  kind: "scan";
  /** Raw OCR text, verbatim. Becomes `rawOcrText`. */
  text: string;
  /**
   * Retained capture this text came from (#28). Omitted -> null. Re-OCR on an
   * existing recipe passes the recipe's own capture so the pointer survives.
   */
  imageFilename?: string | null;
}

/** Start a recipe by hand: no outside artifact at all. */
export interface ManualDraftInput {
  kind: "manual";
}

export type DraftInput = UrlDraftInput | ScanDraftInput | ManualDraftInput;

/**
 * The one Draft factory. Each adapter below owns provenance and initial
 * confidence for its path; callers pass input only.
 */
export function createDraft(input: DraftInput): RecipeDraft {
  switch (input.kind) {
    case "url":
      return draftFromUrl(input);
    case "scan":
      return draftFromScan(input);
    case "manual":
      return draftFromManual();
  }
}

/** URL adapter: scraper data in, url-provenance draft out. */
function draftFromUrl(input: UrlDraftInput): RecipeDraft {
  const title = trimOnlyRequired(input.data.title);
  const yields = trimOnly(input.data.yields);
  return {
    ...blankDraft(),
    title,
    titleConfidence: requiredFieldConfidence(title),
    category: categoryFromKeywords(input.data.categoryKeywords),
    categoryConfidence: input.data.categoryKeywords.length > 0 ? "ok" : "warn",
    yield: yields,
    yieldConfidence: optionalFieldConfidence(yields),
    // Slicing after de-duplication matches the pre-factory behavior exactly.
    tags: uniqueLower(input.data.tags.slice(0, 8)),
    sourceType: "url",
    sourceUrl: input.url,
    imageFilename: input.imageFilename ?? null,
    ingredients: input.data.ingredients,
    steps: input.data.steps,
    ...(input.data.raw === undefined ? {} : { raw: input.data.raw }),
  };
}

/** Scan adapter: raw OCR text in, scan-provenance draft out. */
function draftFromScan(input: ScanDraftInput): RecipeDraft {
  const parsed = parseOcrText(input.text);
  return {
    ...blankDraft(),
    title: parsed.title,
    titleConfidence: parsed.titleConfidence,
    category: guessCategory(parsed.title || input.text),
    categoryConfidence: "ok",
    sourceType: "scan",
    sourceUrl: null,
    rawOcrText: input.text,
    imageFilename: input.imageFilename ?? null,
    ingredients: parsed.ingredients,
    steps: parsed.steps,
  };
}

/** Manual adapter: the empty draft the "Type it in" path starts from. */
function draftFromManual(): RecipeDraft {
  return blankDraft();
}

/** The pieces the scan adapter extracts from raw OCR text. */
interface ParsedOcrText {
  title: string;
  titleConfidence: Confidence;
  ingredients: DraftIngredient[];
  steps: DraftStep[];
}

/**
 * Split raw OCR text into ingredients, steps, and a best-effort title. The
 * parser is intentionally simple — it exists to land the imported text in the
 * review screen with sensible defaults. The real review work happens in the
 * UI. Kept private to this module: structuring OCR text into a RecipeDraft is
 * this seam's job, not the recognition module's (see the SEAM note in
 * ./ocr.ts).
 */
function parseOcrText(rawText: string): ParsedOcrText {
  const lines = rawText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const ingredients: DraftIngredient[] = [];
  const steps: DraftStep[] = [];
  let mode: "ingredients" | "steps" | "unknown" = "unknown";

  for (const line of lines) {
    const looksStep = /^\d+[\.\)]\s+/.test(line) || /^\bstep\b/i.test(line);
    const looksIngredient =
      mode === "ingredients" ||
      (!looksStep && /[a-zA-Z]/.test(line) && /[0-9¼½¾⅓⅔]/.test(line));

    if (/^\b(ingredients|you('| wi)ll need)\b/i.test(line)) {
      mode = "ingredients";
      continue;
    }
    if (/^\b(instructions|directions|method|steps?)\b/i.test(line)) {
      mode = "steps";
      continue;
    }
    if (line.length > 140) continue; // body paragraphs are noise

    if (mode === "ingredients" || (mode === "unknown" && looksIngredient)) {
      mode = "ingredients";
      ingredients.push(ingredientFromRawLine(line, "warn"));
    } else if (mode === "steps" || (mode === "unknown" && looksStep)) {
      mode = "steps";
      const text = line.replace(/^\d+[\.\)]\s+/, "").replace(/^step\s*\d*:?\s*/i, "");
      steps.push({ position: steps.length + 1, text: trimOnlyRequired(text) });
    }
  }

  // Best-effort title: first non-numeric, short line.
  let title = "";
  let titleConfidence: Confidence = "bad";
  for (const line of lines) {
    if (line.length < 4 || line.length > 80) continue;
    if (/^\d/.test(line)) continue;
    if (/ingredient|instruction|method|direction/i.test(line)) continue;
    title = line;
    titleConfidence = "warn";
    break;
  }

  return { title, titleConfidence, ingredients, steps };
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

/** Best-effort category mapping from a URL page's category/cuisine strings. */
function categoryFromKeywords(words: string[]): Category {
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
  if ((CATEGORIES as readonly string[]).includes(lower)) {
    return lower as Category;
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
 * Ask the server to fetch and parse a recipe page. Hides the endpoint's body
 * shape and turns both transport and application failures into one error with
 * a displayable message.
 */
export async function requestUrlImport(url: string): Promise<ImportedDraft> {
  const res = await fetch("/api/import-url", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url }),
  });
  const json = (await res.json()) as
    | ImportedDraft
    | { error: string; message?: string };
  if (!res.ok || "error" in json) {
    const message =
      "message" in json && json.message
        ? json.message
        : "Couldn't import that URL.";
    throw new ImportSeamError(
      message,
      "error" in json ? json.error : "import-failed",
    );
  }
  return { draft: json.draft, imageFilename: json.imageFilename };
}
