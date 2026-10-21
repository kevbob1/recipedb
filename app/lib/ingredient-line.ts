/**
 * Ingredient line — the one module that owns the (qty, unit) truth.
 *
 * `ingredient_lines.qty` stays the DISPLAY source of truth: fractions, ranges
 * and words round-trip verbatim. This module derives the numeric view:
 *
 *   qtyAmount          REAL   low end / single value
 *   qtyAmount2         REAL   high end of a range, else NULL
 *   qtyUnitNormalized  TEXT   canonical unit token, else NULL
 *   qtyParseStatus     TEXT   parsed | range | unparseable | unparsed
 *
 * The numeric view is DERIVED, never carried: `fromText` always parses, and
 * `setQty` re-parses both fields whenever qty OR unit changes. There is no
 * "trust the stored parse" branch — a hand-edited qty cannot leave stale
 * numbers behind, because the only way to build a line is from its text.
 * (`unparsed` survives in the union only as the column default the one-shot
 * backfill looks for.)
 *
 * Isomorphic (no node imports): the Add flow and the review screen run this in
 * the browser to render a scaled view without a round-trip.
 *
 * Status semantics
 *  - `parsed`      a single numeric value was recognized
 *  - `range`       two numeric values joined by -/–/—/~/to
 *  - `unparseable` we looked and could not trust a number ("a pinch", "")
 *  - `unparsed`    never attempted (column default; the backfill looks for it)
 */
import { Fraction } from "fraction.js";

export const QTY_PARSE_STATUSES = [
  "parsed",
  "range",
  "unparseable",
  "unparsed",
] as const;
export type QtyParseStatus = (typeof QTY_PARSE_STATUSES)[number];

/** The numeric view derived from the qty text. */
export interface DerivedQuantity {
  qtyAmount: number | null;
  qtyAmount2: number | null;
  qtyUnitNormalized: string | null;
  qtyParseStatus: QtyParseStatus;
}

/** The text truth of a line: what a person typed into qty and unit. */
export interface IngredientQty {
  qty: string;
  unit: string | null;
}

/** A line built from text: the text plus its derived numeric view. */
export type IngredientLine = IngredientQty & DerivedQuantity;

// ---------------------------------------------------------------------------
// Unit aliases
// ---------------------------------------------------------------------------

/**
 * Units stay free text in the `unit` column — this table only maps the many
 * spellings onto one canonical token so a scaled view is phrased consistently
 * and a unit typed into the qty field can be recognized.
 *
 * Deliberately NOT a DB enum/CHECK: aliases change without a migration. An
 * unknown unit normalizes to `null` and the caller keeps the original text
 * verbatim (we never rewrite what the person typed).
 *
 * Canonical tokens are singular and lower-case ("cup", "clove", "tbsp").
 */

/** alias (lower-case, no trailing period) -> canonical token */
const UNIT_ALIASES: Record<string, string> = {
  // volume — spoon family
  tsp: "tsp",
  tsps: "tsp",
  teaspoon: "tsp",
  teaspoons: "tsp",
  t: "tsp",
  tbsp: "tbsp",
  tbsps: "tbsp",
  tbs: "tbsp",
  tbl: "tbsp",
  tablespoon: "tbsp",
  tablespoons: "tbsp",
  tb: "tbsp",
  // volume — cups and larger
  c: "cup",
  cup: "cup",
  cups: "cup",
  pint: "pint",
  pints: "pint",
  pt: "pint",
  quart: "quart",
  quarts: "quart",
  qt: "quart",
  gallon: "gallon",
  gallons: "gallon",
  gal: "gallon",
  // volume — metric
  ml: "ml",
  milliliter: "ml",
  milliliters: "ml",
  millilitre: "ml",
  millilitres: "ml",
  cl: "cl",
  l: "l",
  liter: "l",
  liters: "l",
  litre: "l",
  litres: "l",
  dl: "dl",
  // weight
  g: "g",
  gram: "g",
  grams: "g",
  gr: "g",
  kg: "kg",
  kilo: "kg",
  kilos: "kg",
  kilogram: "kg",
  kilograms: "kg",
  mg: "mg",
  milligram: "mg",
  milligrams: "mg",
  oz: "oz",
  ounce: "oz",
  ounces: "oz",
  lb: "lb",
  lbs: "lb",
  pound: "lb",
  pounds: "lb",
  // countable
  clove: "clove",
  cloves: "clove",
  can: "can",
  cans: "can",
  tin: "can",
  tins: "can",
  jar: "jar",
  jars: "jar",
  package: "package",
  packages: "package",
  pkg: "package",
  pkgs: "package",
  packet: "package",
  packets: "package",
  slice: "slice",
  slices: "slice",
  sprig: "sprig",
  sprigs: "sprig",
  stalk: "stalk",
  stalks: "stalk",
  stick: "stick",
  sticks: "stick",
  head: "head",
  heads: "head",
  bunch: "bunch",
  bunches: "bunch",
  pinch: "pinch",
  pinches: "pinch",
  dash: "dash",
  dashes: "dash",
  handful: "handful",
  handfuls: "handful",
  bulb: "bulb",
  bulbs: "bulb",
  ear: "ear",
  ears: "ear",
  leaf: "leaf",
  leaves: "leaf",
  sheet: "sheet",
  sheets: "sheet",
  scoop: "scoop",
  scoops: "scoop",
  drop: "drop",
  drops: "drop",
};

/**
 * Canonicalize a free-text unit. Returns null for empty/unknown units —
 * callers keep the original text as the display source of truth.
 */
export function normalizeUnit(unit: string | null | undefined): string | null {
  if (unit === null || unit === undefined) return null;
  const key = unit
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/^\.+|\.+$/g, "");
  if (key.length === 0) return null;
  return UNIT_ALIASES[key] ?? null;
}

/** Every canonical token, for tests and UI hints. */
export const CANONICAL_UNITS: readonly string[] = Object.freeze(
  Array.from(new Set(Object.values(UNIT_ALIASES))).sort(),
);

// ---------------------------------------------------------------------------
// Quantity parsing
// ---------------------------------------------------------------------------

/**
 * Vulgar fractions (U+00BC-00BE, U+2150-215E) -> " n/d " so a glued mixed
 * number ("1½") becomes "1 1/2" and parses as a mixed number.
 */
const VULGAR_FRACTIONS: Record<string, string> = {
  "\u00bd": " 1/2 ",
  "\u00bc": " 1/4 ",
  "\u00be": " 3/4 ",
  "\u2150": " 1/7 ",
  "\u2151": " 1/9 ",
  "\u2152": " 1/10 ",
  "\u2153": " 1/3 ",
  "\u2154": " 2/3 ",
  "\u2155": " 1/5 ",
  "\u2156": " 2/5 ",
  "\u2157": " 3/5 ",
  "\u2158": " 4/5 ",
  "\u2159": " 1/6 ",
  "\u215a": " 5/6 ",
  "\u215b": " 1/8 ",
  "\u215c": " 3/8 ",
  "\u215d": " 5/8 ",
  "\u215e": " 7/8 ",
};

const NUMBER = String.raw`\d+(?:\.\d+)?`;
const MIXED_RE = new RegExp(String.raw`^(${NUMBER})\s+(\d+)\s*/\s*(\d+)$`);
const FRACTION_RE = new RegExp(String.raw`^(\d+)\s*/\s*(\d+)$`);
const DECIMAL_RE = new RegExp(String.raw`^(${NUMBER})$`);
/** "2 cups" — a unit word glued into the qty field. */
const VALUE_UNIT_RE = new RegExp(
  String.raw`^(${NUMBER}(?:\s+\d+\s*/\s*\d+)?(?:\s*/\s*\d+)?)\s+([A-Za-z.]+)$`,
);
/** -/–/—/~/to join a range, with optional surrounding spaces. */
const RANGE_SPLIT_RE = /\s*(?:-|\u2013|\u2014|~|to)\s*/i;
/** Leading hedges that carry no number. */
const HEDGE_RE = /^(?:about|approx\.?|approximately|around|roughly|~)\s+/i;

/** Lower-case, collapse whitespace, expand unicode fractions. */
function normalizeQuantityText(input: string): string {
  let out = input.replace(/\u2044/g, "/");
  for (const [glyph, expansion] of Object.entries(VULGAR_FRACTIONS)) {
    if (out.includes(glyph)) out = out.split(glyph).join(expansion);
  }
  return out.replace(/\s+/g, " ").trim();
}

/** Parse one numeric token (mixed, simple fraction, integer, decimal). */
function parseNumericToken(token: string): number | null {
  const t = token.trim();
  const mixed = MIXED_RE.exec(t);
  if (mixed) {
    const den = Number(mixed[3]);
    if (den === 0) return null;
    return new Fraction(Number(mixed[1]))
      .add(new Fraction(Number(mixed[2]), den))
      .valueOf();
  }
  const fraction = FRACTION_RE.exec(t);
  if (fraction) {
    const den = Number(fraction[2]);
    if (den === 0) return null;
    return new Fraction(Number(fraction[1]), den).valueOf();
  }
  if (DECIMAL_RE.test(t)) {
    const value = Number(t);
    return Number.isFinite(value) ? value : null;
  }
  return null;
}

/**
 * Derive the numeric view from text. Never throws; anything it cannot trust
 * comes back `unparseable` with no amount, so the caller renders the text
 * verbatim.
 */
function derive(
  qtyText: string | null | undefined,
  unitText: string | null | undefined,
): DerivedQuantity {
  let qtyUnitNormalized = normalizeUnit(unitText);
  const text = normalizeQuantityText(qtyText ?? "").replace(HEDGE_RE, "");
  if (text.length === 0) {
    return {
      qtyAmount: null,
      qtyAmount2: null,
      qtyUnitNormalized,
      qtyParseStatus: "unparseable",
    };
  }

  const parts = text.split(RANGE_SPLIT_RE);
  if (parts.length === 2 && parts[0]!.length > 0 && parts[1]!.length > 0) {
    const low = parseNumericToken(parts[0]!);
    const high = parseNumericToken(parts[1]!);
    if (low !== null && high !== null) {
      return {
        qtyAmount: low,
        qtyAmount2: high,
        qtyUnitNormalized,
        qtyParseStatus: "range",
      };
    }
    return {
      qtyAmount: null,
      qtyAmount2: null,
      qtyUnitNormalized,
      qtyParseStatus: "unparseable",
    };
  }

  const single = parseNumericToken(text);
  if (single !== null) {
    return {
      qtyAmount: single,
      qtyAmount2: null,
      qtyUnitNormalized,
      qtyParseStatus: "parsed",
    };
  }

  // "2 cups" typed into the qty field while `unit` is empty: recover both.
  const glued = VALUE_UNIT_RE.exec(text);
  if (glued) {
    const value = parseNumericToken(glued[1]!);
    const gluedUnit = normalizeUnit(glued[2]!);
    if (value !== null && gluedUnit !== null) {
      qtyUnitNormalized = qtyUnitNormalized ?? gluedUnit;
      return {
        qtyAmount: value,
        qtyAmount2: null,
        qtyUnitNormalized,
        qtyParseStatus: "parsed",
      };
    }
  }

  return {
    qtyAmount: null,
    qtyAmount2: null,
    qtyUnitNormalized,
    qtyParseStatus: "unparseable",
  };
}

/**
 * Build a line from its text. Always parses — there is no other constructor,
 * so a numeric view can never outlive the text it was derived from.
 */
export function fromText(
  qty: string | null | undefined,
  unit: string | null | undefined = null,
): IngredientLine {
  const qtyText = qty ?? "";
  const unitText = unit ?? null;
  return { qty: qtyText, unit: unitText, ...derive(qtyText, unitText) };
}

/**
 * Set the whole (qty, unit) pair on a line, re-deriving the numeric view.
 *
 * Both fields are required on purpose: editing the unit invalidates numbers
 * derived from the old text just as surely as editing the qty does. Extra
 * fields (item, note, confidence) ride along untouched.
 */
export function setQty<T extends IngredientQty>(
  line: T,
  qty: string,
  unit: string | null,
): T & IngredientLine {
  return { ...line, ...fromText(qty, unit) };
}

// ---------------------------------------------------------------------------
// Scaled view
// ---------------------------------------------------------------------------

/** Denominators we will phrase a scaled amount with. Anything else falls back
 * to a trimmed decimal — 2.4 should read "2.4", not "2 2/5".
 */
const NICE_DENOMINATORS = [1, 2, 3, 4, 6, 8];

/**
 * Float tolerance for "is this an exact multiple of 1/den?". Kept tighter than
 * the 1e-6 output rounding on purpose: pre-rounding 1/3 to 0.333333 made it
 * stop matching 3/3.
 */
const RATIONAL_EPSILON = 1e-9;

/** Number -> kitchen-friendly text ("0.5" -> "1/2", "1.25" -> "1 1/4"). */
export function formatAmount(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  for (const den of NICE_DENOMINATORS) {
    const scaled = value * den;
    if (Math.abs(scaled - Math.round(scaled)) <= RATIONAL_EPSILON) {
      const num = Math.round(scaled);
      const whole = Math.trunc(num / den);
      const remainder = num - whole * den;
      if (remainder === 0) return String(whole);
      if (whole === 0) return `${remainder}/${den}`;
      return `${whole} ${remainder}/${den}`;
    }
  }
  return String(Math.round(value * 100) / 100);
}

export interface ScaledQuantity {
  /** Text to render. At 1x this is the verbatim stored qty. */
  display: string;
  /** False when no number could be trusted, so the caller marks the row. */
  scaled: boolean;
  /** Human-readable reason when `scaled` is false. */
  mark: string | null;
}

/** A draft ingredient (or DB row) with the text the review list renders. */
export interface ScaledIngredientSource extends IngredientQty {
  item?: string | null;
  note?: string | null;
}

/** One rendered line of the review UI's scaled view. */
export interface ScaledIngredientRow extends ScaledQuantity {
  /** Unit printed next to the amount; falls back to the parsed unit. */
  unit: string;
  item: string;
  note: string | null;
}

function scaleDerived(
  parsed: DerivedQuantity,
  qtyText: string,
  factor: number,
): ScaledQuantity {
  const verbatim = qtyText.trim();
  if (parsed.qtyParseStatus === "unparseable" || parsed.qtyAmount === null) {
    return { display: verbatim, scaled: false, mark: "scaling not applied" };
  }
  const low = formatAmount(parsed.qtyAmount * factor);
  if (parsed.qtyAmount2 === null) return { display: low, scaled: true, mark: null };
  return {
    display: `${low}\u2013${formatAmount(parsed.qtyAmount2 * factor)}`,
    scaled: true,
    mark: null,
  };
}

/**
 * Derived scaled view of one line: amount x factor. Never mutates stored text;
 * at 1x the qty is rendered verbatim.
 */
export function scale(line: IngredientQty, factor: number): ScaledQuantity {
  if (factor === 1) return { display: line.qty.trim(), scaled: true, mark: null };
  return scaleDerived(derive(line.qty, line.unit), line.qty, factor);
}

/**
 * The review UI's pure render path: project a whole ingredient list at
 * `factor`. The multiplier buttons only own that one number, so this is what
 * a click on 2× has to reach — the stored `qty` is never rewritten.
 */
export function display(
  lines: readonly ScaledIngredientSource[],
  factor: number,
): ScaledIngredientRow[] {
  return lines.map((line) => {
    const parsed = derive(line.qty, line.unit);
    const scaled =
      factor === 1
        ? { display: line.qty.trim(), scaled: true, mark: null }
        : scaleDerived(parsed, line.qty, factor);
    return {
      ...scaled,
      unit: line.unit ?? parsed.qtyUnitNormalized ?? "",
      item: line.item ?? "",
      note: line.note ?? null,
    };
  });
}
