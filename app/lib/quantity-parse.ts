/**
 * Quantity parser (decision on #15, implemented for #16).
 *
 * `ingredient_lines.qty` stays the display source of truth — fractions, ranges
 * and words round-trip verbatim. This module derives the *numeric* view:
 *
 *   qty_amount          REAL   low end / single value
 *   qty_amount2         REAL   high end of a range, else NULL
 *   qty_unit_normalized TEXT   canonical unit token (app/lib/units.ts), else NULL
 *   qty_parse_status    TEXT   parsed | range | unparseable | unparsed
 *
 * Fractions go through fraction.js (exact rational -> float); the wrapper below
 * is the unicode normalize + range/single/unit-glued recognition the decision
 * called for. It is isomorphic (no node imports) so the review UI can render a
 * scaled view client-side without a round-trip.
 *
 * Status semantics
 *  - `parsed`      a single numeric value was recognized
 *  - `range`       two numeric values joined by -/–/—/~/to
 *  - `unparseable` we looked and could not trust a number ("a pinch", "")
 *  - `unparsed`    never attempted (column default; the backfill looks for it)
 */
import { Fraction } from "fraction.js";

import { normalizeUnit } from "./units";

export const QTY_PARSE_STATUSES = [
  "parsed",
  "range",
  "unparseable",
  "unparsed",
] as const;
export type QtyParseStatus = (typeof QTY_PARSE_STATUSES)[number];

export interface ParsedQuantity {
  amount: number | null;
  amount2: number | null;
  unitNormalized: string | null;
  status: QtyParseStatus;
}

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
export function normalizeQuantityText(input: string): string {
  let out = input.replace(/\u2044/g, "/");
  for (const [glyph, expansion] of Object.entries(VULGAR_FRACTIONS)) {
    if (out.includes(glyph)) out = out.split(glyph).join(expansion);
  }
  return out.replace(/\s+/g, " ").trim();
}

/** Parse one numeric token (mixed, simple fraction, integer, decimal). */
export function parseNumericToken(token: string): number | null {
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
 * Parse a qty string (and optional unit column) into the numeric view.
 * Never throws; anything it cannot trust comes back `unparseable` with the
 * verbatim text left to the caller.
 */
export function parseQuantity(
  qtyText: string | null | undefined,
  unitText?: string | null,
): ParsedQuantity {
  let unitNormalized = normalizeUnit(unitText);
  const text = normalizeQuantityText(qtyText ?? "").replace(HEDGE_RE, "");
  if (text.length === 0) {
    return { amount: null, amount2: null, unitNormalized, status: "unparseable" };
  }

  const parts = text.split(RANGE_SPLIT_RE);
  if (parts.length === 2 && parts[0]!.length > 0 && parts[1]!.length > 0) {
    const low = parseNumericToken(parts[0]!);
    const high = parseNumericToken(parts[1]!);
    if (low !== null && high !== null) {
      return { amount: low, amount2: high, unitNormalized, status: "range" };
    }
    return { amount: null, amount2: null, unitNormalized, status: "unparseable" };
  }

  const single = parseNumericToken(text);
  if (single !== null) {
    return { amount: single, amount2: null, unitNormalized, status: "parsed" };
  }

  // "2 cups" typed into the qty field while `unit` is empty: recover both.
  const glued = VALUE_UNIT_RE.exec(text);
  if (glued) {
    const value = parseNumericToken(glued[1]!);
    const gluedUnit = normalizeUnit(glued[2]!);
    if (value !== null && gluedUnit !== null) {
      unitNormalized = unitNormalized ?? gluedUnit;
      return { amount: value, amount2: null, unitNormalized, status: "parsed" };
    }
  }

  return { amount: null, amount2: null, unitNormalized, status: "unparseable" };
}

/** Denominators we will phrase a scaled amount with. Anything else falls back to
 * a trimmed decimal — 2.4 should read "2.4", not "2 2/5".
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

/**
 * Anything that carries a qty plus an optional stored parse: a draft
 * ingredient, a DB row, a row being backfilled.
 */
export interface QuantityCarrier {
  qty?: string | null;
  unit?: string | null;
  qtyAmount?: number | null;
  qtyAmount2?: number | null;
  qtyUnitNormalized?: string | null;
  qtyParseStatus?: QtyParseStatus;
}

/**
 * The single seam the write path, the review UI and the backfill all go
 * through: trust an already-derived parse when it is present and complete,
 * otherwise (re-)parse the text. A hand edit of the qty field clears the
 * derived fields, which lands here as "parse me again" — that is what
 * "manual edit resets to unparsed" means in practice (decision on #15).
 */
export function resolveQuantity(carrier: QuantityCarrier): ParsedQuantity {
  const carried =
    carrier.qtyParseStatus === "parsed" || carrier.qtyParseStatus === "range";
  const complete =
    typeof carrier.qtyAmount === "number" &&
    (carrier.qtyParseStatus !== "range" || typeof carrier.qtyAmount2 === "number");
  if (carried && complete) {
    return {
      amount: carrier.qtyAmount as number,
      amount2: carrier.qtyAmount2 ?? null,
      unitNormalized:
        carrier.qtyUnitNormalized ?? normalizeUnit(carrier.unit ?? null),
      status: carrier.qtyParseStatus as QtyParseStatus,
    };
  }
  return parseQuantity(carrier.qty, carrier.unit ?? null);
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
export interface ScaledIngredientSource extends QuantityCarrier {
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

/**
 * Derived scaled view: amount x factor. Never mutates stored text.
 * Pass `parsed` when the row already carries a trusted parse (loadDraft does),
 * otherwise the qty text is parsed on the spot.
 */
export function scaleQuantity(
  qtyText: string,
  factor: number,
  parsed?: ParsedQuantity | null,
): ScaledQuantity {
  const verbatim = qtyText.trim();
  if (factor === 1) return { display: verbatim, scaled: true, mark: null };

  const p =
    parsed && parsed.status !== "unparsed"
      ? parsed
      : parseQuantity(qtyText, null);

  if (p.status === "unparseable" || p.amount === null) {
    return { display: verbatim, scaled: false, mark: "scaling not applied" };
  }
  const low = formatAmount(p.amount * factor);
  if (p.amount2 === null) return { display: low, scaled: true, mark: null };
  return {
    display: `${low}\u2013${formatAmount(p.amount2 * factor)}`,
    scaled: true,
    mark: null,
  };
}

/**
 * The review UI's pure render path: project a whole ingredient list at
 * `factor`. The multiplier buttons only own that one number, so this is what
 * a click on 2× has to reach — the stored `qty` is never rewritten.
 */
export function scaledIngredientRows(
  ingredients: ScaledIngredientSource[],
  factor: number,
): ScaledIngredientRow[] {
  return ingredients.map((ing) => {
    const parsed = resolveQuantity(ing);
    const scaled = scaleQuantity(ing.qty ?? "", factor, parsed);
    return {
      display: scaled.display,
      scaled: scaled.scaled,
      mark: scaled.mark,
      unit: ing.unit ?? parsed.unitNormalized ?? "",
      item: ing.item ?? "",
      note: ing.note ?? null,
    };
  });
}
