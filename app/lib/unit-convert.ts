/**
 * Unit conversion — the display-time US ⇄ metric table (ADR-0003 §A).
 *
 * This module owns ONE question: given a canonical unit from
 * `ingredient-line.ts` and a numeric amount, what does that amount read as in
 * the other measurement system? It is pure and isomorphic (no node imports),
 * so the review screen can convert in the browser without a round-trip.
 *
 * Hard boundaries, fixed by the ADR:
 *  - Same-dimension only. Volume converts through ml, weight through g; there
 *    is no volume↔weight bridge (that needs a per-ingredient density table).
 *  - Countable units ("clove", "can", "slice", …), unknown units and a null
 *    unit are NOT convertible and return null. Callers keep the stored text.
 *  - Conversion is display-time. Nothing here mutates a line, and no caller
 *    writes the result back to the database.
 *
 * The module deliberately does not import `ingredient-line.ts` (that module
 * imports this one, and a cycle would make the seam guard unhappy). Inputs are
 * already-canonical tokens; `normalizeUnit` in the sibling module is the only
 * alias table in the repo.
 */

/** The two measurement systems the toggle offers. */
export type UnitSystem = "us" | "metric";

/** A dimension convertible through a single base unit. */
type Dimension = "volume" | "weight";

interface UnitDefinition {
  /** volume -> ml, weight -> g */
  dimension: Dimension;
  system: UnitSystem;
  /** Multiplier into the dimension's base unit. */
  toBase: number;
}

/**
 * Conversion factors. US volume factors are the customary spoon/cup values the
 * household already scales with (tsp 4.92892 ml, tbsp 14.7868 ml,
 * cup 236.588 ml); metric volume and weight are exact decimal multiples.
 *
 * pint/quart/gallon are accepted as INPUT units so a recipe that stored them
 * still converts, but they are not offered as OUTPUT units — cooks measure
 * ingredient amounts in cups and spoons, not quarts (see OUTPUT_LADDERS).
 */
const UNITS: Record<string, UnitDefinition> = {
  // volume — US customary
  tsp: { dimension: "volume", system: "us", toBase: 4.92892 },
  tbsp: { dimension: "volume", system: "us", toBase: 14.7868 },
  cup: { dimension: "volume", system: "us", toBase: 236.588 },
  pint: { dimension: "volume", system: "us", toBase: 473.176 },
  quart: { dimension: "volume", system: "us", toBase: 946.353 },
  gallon: { dimension: "volume", system: "us", toBase: 3785.41 },
  // volume — metric
  ml: { dimension: "volume", system: "metric", toBase: 1 },
  cl: { dimension: "volume", system: "metric", toBase: 10 },
  dl: { dimension: "volume", system: "metric", toBase: 100 },
  l: { dimension: "volume", system: "metric", toBase: 1000 },
  // weight — US customary
  oz: { dimension: "weight", system: "us", toBase: 28.3495 },
  lb: { dimension: "weight", system: "us", toBase: 453.592 },
  // weight — metric
  mg: { dimension: "weight", system: "metric", toBase: 0.001 },
  g: { dimension: "weight", system: "metric", toBase: 1 },
  kg: { dimension: "weight", system: "metric", toBase: 1000 },
};

/**
 * Output units, largest first, per dimension/system.
 *
 * Metric output is deliberately FIXED: ml for volume, g for weight. "1000 ml"
 * staying "1000 ml" instead of flipping to "1 l" is the predictable choice —
 * the number moves only because the system changed, never because a threshold
 * was crossed. A recipe stored in l/kg already reads in l/kg, because a
 * same-system conversion returns the line untouched.
 *
 * US output is the largest customary unit that keeps the value at or above 1
 * (idle to tsp), skipping pint/quart/gallon: 3785 ml reads "1 gallon", 500 ml
 * reads "2.11 cup", 15 ml reads "1 tbsp". Rounding then goes through
 * `formatAmount`, so nice fractions stay fractions.
 */
const OUTPUT_LADDERS: Record<Dimension, Record<UnitSystem, readonly string[]>> = {
  volume: {
    us: ["gallon", "cup", "tbsp", "tsp"],
    metric: ["ml"],
  },
  weight: {
    us: ["lb", "oz"],
    metric: ["g"],
  },
};

/** Rounding tolerance for "this already is an integer". */
const INTEGER_EPSILON = 1e-9;

/** US results are kept at 6dp so fraction matching is not lost to float noise. */
const US_PRECISION = 1e6;

/** The system a canonical unit belongs to, or null when it is not convertible. */
export function unitSystem(unit: string | null | undefined): UnitSystem | null {
  if (unit === null || unit === undefined) return null;
  return UNITS[unit]?.system ?? null;
}

/** True for canonical volume/weight tokens; false for counts and unknowns. */
export function isConvertibleUnit(unit: string | null | undefined): boolean {
  return unitSystem(unit) !== null;
}

export interface ConvertedRange {
  /** Low end (or the single value) in `unit`. */
  low: number;
  /** High end of a range, else null. */
  high: number | null;
  /** The target system's display unit. */
  unit: string;
  /**
   * False when the source unit already belonged to the target system and the
   * numbers came back untouched. Callers that render verbatim text at 1× use
   * this to keep the stored spelling.
   */
  converted: boolean;
}

/**
 * Round a metric result: integers when the value is one, otherwise at most two
 * decimals. Two decimals is enough for kitchen amounts (236.59 ml) and never
 * shows float noise.
 */
function roundMetric(value: number): number {
  const rounded = Math.round(value * 100) / 100;
  return Math.abs(rounded - Math.round(rounded)) <= INTEGER_EPSILON
    ? Math.round(rounded)
    : rounded;
}

/** Trim float noise from a US amount without disturbing exact fractions. */
function roundUs(value: number): number {
  return Math.round(value * US_PRECISION) / US_PRECISION;
}

/**
 * Pick the target display unit for a whole range: the largest ladder unit the
 * LARGEST bound reaches (so both bounds share one unit), else the ladder's
 * smallest unit.
 */
function pickOutputUnit(
  dimension: Dimension,
  system: UnitSystem,
  largestBase: number,
): string {
  const ladder = OUTPUT_LADDERS[dimension][system];
  for (const unit of ladder) {
    const definition = UNITS[unit];
    if (definition !== undefined && largestBase >= definition.toBase) return unit;
  }
  return ladder[ladder.length - 1]!;
}

/**
 * Convert one amount, or a whole range, into `toSystem`.
 *
 * Returns null when conversion does not apply: null/unknown unit, a countable
 * unit, or a non-finite amount. When the unit already belongs to `toSystem` the
 * numbers are returned unchanged with `converted: false`, so the caller can
 * keep rendering the stored text verbatim.
 *
 * The target unit is chosen from the LARGEST bound, so `1–2 cup` becomes
 * `236.59–473.18 ml` (one unit, not one unit per bound).
 */
export function convertRange(
  low: number,
  high: number | null,
  unit: string | null | undefined,
  toSystem: UnitSystem,
): ConvertedRange | null {
  if (unit === null || unit === undefined) return null;
  const definition = UNITS[unit];
  if (definition === undefined) return null;
  if (!Number.isFinite(low)) return null;
  if (high !== null && !Number.isFinite(high)) return null;

  if (definition.system === toSystem) {
    return { low, high, unit, converted: false };
  }

  const values = high === null ? [low] : [low, high];
  const largestBase =
    Math.max(...values.map((value) => Math.abs(value))) * definition.toBase;
  const targetUnit = pickOutputUnit(definition.dimension, toSystem, largestBase);
  const targetFactor = UNITS[targetUnit]!.toBase;

  const convertOne = (value: number): number => {
    const raw = (value * definition.toBase) / targetFactor;
    return toSystem === "metric" ? roundMetric(raw) : roundUs(raw);
  };

  return {
    low: convertOne(low),
    high: high === null ? null : convertOne(high),
    unit: targetUnit,
    converted: true,
  };
}

/**
 * Single-value convenience wrapper over `convertRange`. Null when the unit is
 * not convertible; `{amount, unit}` otherwise — unchanged when the unit already
 * belongs to the target system.
 */
export function convert(
  amount: number,
  unit: string | null | undefined,
  toSystem: UnitSystem,
): { amount: number; unit: string } | null {
  const converted = convertRange(amount, null, unit, toSystem);
  if (converted === null) return null;
  return { amount: converted.low, unit: converted.unit };
}
