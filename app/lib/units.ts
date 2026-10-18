/**
 * Static unit alias table (decision on #15, implemented for #16).
 *
 * Units stay free text in the `ingredient_lines.unit` column — this table only
 * maps the many spellings of a unit onto one canonical token so a scaled view
 * can be phrased consistently and so the backfill can recognize a unit that was
 * typed into the qty field.
 *
 * Deliberately NOT a DB enum/CHECK: aliases change without a migration. An
 * unknown unit normalizes to `null` and the original text is kept verbatim by
 * the caller (we never rewrite what the person typed).
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
 * callers keep the original text as display source of truth.
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

/**
 * Case-preserving check used when a unit word is glued to the qty field
 * ("2 cups" written into the qty column while `unit` is empty).
 */
export function canonicalUnitFromWord(word: string): string | null {
  return normalizeUnit(word);
}

/** Every canonical token, for tests and UI hints. */
export const CANONICAL_UNITS: readonly string[] = Object.freeze(
  Array.from(new Set(Object.values(UNIT_ALIASES))).sort(),
);
