# Research: Scaling Quantity Model + Parser Choice

Ticket: #15 (child of Wayfinder map #14) — branch `research/scaling-model`

## Question

Decide numeric columns (qty_text preserved + qty_amount/amount2 + normalized unit), fraction/range/unicode-fraction parsing lib options for TS, unit normalization table approach, unparseable marking.

---

## 1. Current Model (source of truth)

- `app/db/schema.server.ts` — `ingredient_lines` table today:
  - `qty TEXT NOT NULL` — verbatim string, never coerced (fractions, ranges, "a bunch" round-trip)
  - `unit TEXT` (nullable, free-text)
  - `item TEXT NOT NULL`, `note TEXT`, `position INTEGER`
- `GLOSSARY.md` — Ingredient line = four parts: quantity string + unit (optional free-text) + item + note
- Implication: any numeric columns are **additive**, not replacements.

Sources:
- `app/db/schema.server.ts: ingredientLines` definition
- `GLOSSARY.md` Ingredient line section
- Issue #15 body: "qty_text preserved + qty_amount/amount2 + normalized unit"

## 2. Proposed Numeric Columns (recommended migration)

Add to `ingredient_lines`, nullable so every existing row remains valid:

| Column | Type | Purpose |
|---|---|---|
| `qty_text` | TEXT NOT NULL (rename of current `qty`, or keep `qty` as alias) | Display string — source of truth for rendering |
| `qty_amount` | REAL (SQLite NUMERIC) nullable | Primary parsed quantity as decimal (e.g. `1.5` for "1 1/2", `0.5` for "½") |
| `qty_amount2` | REAL nullable | Second bound for ranges ("2-3" → 2, 3; single value → NULL) |
| `qty_unit_normalized` | TEXT nullable | Canonical unit key (see §4) |
| `qty_parse_status` | TEXT NOT NULL DEFAULT 'unparsed' CHECK in ('parsed','range','unparseable','unparsed') | Marks whether row scaled |

Alternative naming `amount`/`amount2` vs `qty_amount`/`qty_amount2`: prefer `qty_amount*` to avoid collision with other domain "amount" meanings; either is fine if consistent. Keep `unit` (free-text) alongside `qty_unit_normalized`.

**Scaling rule:** `scaled = qty_amount * factor` (and `qty_amount2 * factor` when not null). Rendering re-formats the scaled decimal to a human fraction string; `qty_text` is never mutated by scaling — scaled view is derived. Unparseable rows are excluded from scaling (shown with original `qty_text`).

**Migration notes (Drizzle + SQLite):**
- Use `drizzle-kit generate` to emit `drizzle/00xx_*.sql` + update `drizzle/meta/_journal.json`; runtime applies via `app/db/migrate.server.ts` (`migrations-applied.json` journal at `DATA_DIR`).
- SQLite `ALTER TABLE ADD COLUMN` is sufficient (no table rebuild) for nullable adds; backfill is a separate data migration (parse existing `qty` values, update new columns) — safe to run post-migration.

Sources:
- `app/db/migrate.server.ts` — journal + `--> statement-breakpoint` splitting, checksum guard
- `app/db/client.server.ts` — WAL + FK pragmas, `DATA_DIR` layout
- Drizzle docs: `sqliteTable`, `real()` maps to REAL; `drizzle-kit` journal at `drizzle/meta/_journal.json` (observed in repo)

## 3. Fraction / Range / Unicode-Fraction Parsing — Library Options (TS)

Evaluated against primary sources (npm registry + GitHub READMEs + bundle size). No lib handles "a pinch" / "to taste" — those are intentionally unparseable.

### A. `fraction.js` (infusion/Fraction.js) — RECOMMENDED as core converter
- **What:** Exact rational arithmetic; parses strings like `"1/2"`, `"1 1/2"`, constructs from numerator/denominator.
- **Source:** https://github.com/infusion/Fraction.js , npm `fraction.js` (~2k weekly dependents, ESM+CJS, ~8 kB gz).
- **Pros:** Correct fraction math, no float drift for display; good for decimal→fraction re-formatting after scaling.
- **Cons:** Does NOT parse ranges, unicode fractions, or mixed "1 1/2 cups" lines by itself — needs a thin wrapper.
- **Use:** `new Fraction("1/2").valueOf() === 0.5`; after scaling, `new Fraction(scaled).toFraction(true)` for display.

### B. `recipe-ingredient-parser` / `parse-ingredient` family — ingredient-line parsers
- **Candidates:**
  - `parse-ingredient` (npm) — parses full lines like "1 1/2 cups flour, sifted" into `{ quantity, unit, ingredient }`; handles mixed fractions and unicode via normalization.
  - `recipe-ingredient-parser` (similar scope)
  - `ingredient-parser` (various forks)
- **Source:** npmjs.com/package/parse-ingredient ; GitHub repos for each (MIT).
- **Pros:** Closer to end-to-end "qty + unit + item" extraction; some handle unicode fractions.
- **Cons:** Heavier, opinionated tokenization that conflicts with our four-part model (we already split qty/unit/item/note separately); unit lists are baked in and may not match our normalization table; less maintained than Fraction.js.
- **Verdict:** Useful as **reference for regex patterns**, not as a runtime dependency — we only need to parse the `qty` field, not the whole line.

### C. `convert-units` / `js-quantities` — unit conversion (post-parse, optional for scaling v1.1)
- **Source:** https://github.com/convert-units/convert-units , https://github.com/gentooboontoo/js-quantities
- **Use:** Only if v1.1 wants cross-unit scaling (e.g. cups→ml). Out of scope for the ticket's "normalized unit" (which is canonicalization, not conversion). Defer.

### D. No-dependency wrapper — RECOMMENDED for parsing
Implement a ~40-line parser around `Fraction.js`:
1. **Normalize unicode fractions** via a lookup table before parsing (see §3.1).
2. **Range regex:** `^\s*(.+?)\s*[-–—to]+\s*(.+?)\s*$` → parse each side as a single quantity.
3. **Single quantity regex:** mixed `(\d+)\s+(\d+/\d+)` → `int + frac`; simple `(\d+/\d+)` → Fraction; decimal `(\d*\.?\d+)`.
4. On failure → mark `unparseable`, leave `qty_amount` NULL.

This avoids a heavy dependency, keeps behavior auditable, and matches the repo's trim-only philosophy.

#### 3.1 Unicode fraction table (normalize before parsing)

| Char | ASCII | Char | ASCII |
|---|---|---|---|
| ½ | 1/2 | ⅓ | 1/3 |
| ¼ | 1/4 | ⅔ | 2/3 |
| ¾ | 3/4 | ⅕ | 1/5 |
| ⅛ | 1/8 | ⅖ | 2/5 |
| ⅜ | 3/8 | ⅗ | 3/5 |
| ⅝ | 5/8 | ⅘ | 4/5 |
| ⅞ | 7/8 | ⅙ | 1/6 |
| ⅚ | 5/6 | ⅐ | 1/7 (rare) |
| ⅑ | 1/9 | ⅒ | 1/10 |

Source: Unicode block U+2150–U+215E (Number Forms). Implement as `String.replace` with a map; also handle the common OCR artifact `1/2` vs `½` equivalence.

## 4. Unit Normalization Table Approach

**Goal:** `qty_unit_normalized` is a canonical key; original `unit` (free-text) is preserved.

**Approach:** Static lookup table in code (e.g. `app/lib/units.ts`), not a DB table — units are a closed-ish set and code review is the right gate.

```ts
// Canonical keys (lowercase, singular)
type NormalizedUnit = "cup" | "tbsp" | "tsp" | "oz" | "lb" | "g" | "kg" | "ml" | "l" | "piece" | "clove" | "bunch" | "pinch" | ...;

const UNIT_ALIASES: Record<string, NormalizedUnit> = {
  "cups": "cup", "cup": "cup", "c": "cup",
  "tablespoons": "tbsp", "tablespoon": "tbsp", "tbsp": "tbsp", "tbs": "tbsp", "T": "tbsp",
  "teaspoons": "tsp", "teaspoon": "tsp", "tsp": "tsp", "t": "tsp",
  "ounces": "oz", "ounce": "oz", "oz": "oz",
  "pounds": "lb", "pound": "lb", "lbs": "lb", "lb": "lb",
  "grams": "g", "gram": "g", "g": "g",
  "kilograms": "kg", "kilogram": "kg", "kg": "kg",
  "milliliters": "ml", "milliliter": "ml", "ml": "ml",
  "liters": "l", "liter": "l", "l": "l",
  "cloves": "clove", "clove": "clove",
  // ... extend as encountered
};
function normalizeUnit(raw: string | null): string | null {
  if (!raw) return null;
  const key = raw.trim().toLowerCase();
  return UNIT_ALIASES[key] ?? null; // null = unknown, keep original `unit` as-is
}
```

**Why not a DB enum/check constraint for normalized units:** SQLite `CHECK` would need a migration on every new alias; code table is cheaper. If a DB constraint is desired, add a loose `CHECK` or omit it and validate in the parser.

**Storage:** `qty_unit_normalized TEXT` nullable (NULL = unknown/unparseable unit). No FK — units are not entities.

## 5. Unparseable Marking Strategy

**Column:** `qty_parse_status TEXT NOT NULL DEFAULT 'unparsed'` with values:
- `parsed` — single quantity parsed (`qty_amount` non-null, `qty_amount2` null)
- `range` — range parsed (`qty_amount` and `qty_amount2` non-null)
- `unparseable` — parser attempted and failed (e.g. "a pinch", "to taste", "a bunch", "some")
- `unparsed` — not yet attempted (initial state for backfill)

**Behavior:**
- Scaling UI multiplies only `parsed`/`range` rows; `unparseable`/`unparsed` rows render `qty_text` verbatim and are shown with a subtle indicator (e.g. "× scaling not applied").
- Parser is idempotent: re-running on a row updates `qty_amount*` + `qty_parse_status`; manual edit of `qty_text` resets status to `unparsed` so next save re-parses.
- Bulk backfill: after migration, run a one-shot script that iterates `ingredient_lines` where `qty_parse_status='unparsed'`, applies the parser, updates in a transaction.

**Alternative considered:** Boolean `is_parseable` — rejected; loses the `unparsed` vs `unparseable` distinction needed for backfill progress.

## 6. Implementation Sketch (next steps, not in this research branch)

1. Migration: `ALTER TABLE ingredient_lines ADD COLUMN qty_amount REAL`, etc. (Drizzle generate).
2. New module `app/lib/quantity-parse.ts` — unicode normalize + range/single parse via `fraction.js` + unit normalize lookup; unit tests covering fractions, ranges, unicode, decimals, unparseables.
3. Call parser on ingredient-line create/update (in `app/lib/save-draft.server.ts` or ingredient-line write path).
4. Scaling UI: `scaled = qty_amount * factor` (and `qty_amount2`); format via `Fraction` back to "1 1/2" style; skip `unparseable`.
5. Backfill script for existing rows.

## 7. Sources

- Repo: `app/db/schema.server.ts`, `app/db/migrate.server.ts`, `app/db/client.server.ts`, `GLOSSARY.md`, issue #15
- Drizzle ORM docs: `sqliteTable`, `real`, `drizzle-kit` journal (https://orm.drizzle.team/docs/overview)
- Fraction.js: https://github.com/infusion/Fraction.js (MIT, npm `fraction.js`)
- parse-ingredient: https://www.npmjs.com/package/parse-ingredient (MIT)
- convert-units: https://github.com/convert-units/convert-units
- Unicode Number Forms U+2150–U+215E: https://unicode.org/charts/PDF/U2150.pdf
- SQLite ALTER TABLE: https://www.sqlite.org/lang_altertable.html

---

*Notes file: `research-notes/scaling-model.md` on branch `research/scaling-model`.*
