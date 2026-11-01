# ADR-0003: Display-time unit conversion + ranked "cook now" ingredient filter

Date: 2026-11-01
Status: Accepted

## Context

A feature-gap review against similar products (Mealie, Tandoor, Paprika,
Mela, SuperCook, RecipeSage, Cooklang) found recipedb's scaling path
displays a multiplier over stored quantities but never converts between
measurement systems, and there is no way to ask "what can I cook with
what I have". Competitor research classified meal planning, shopping
lists, pantry inventory, nutrition, ratings, offline/PWA, and export
formats as either declined for this household or superseded by the
backup decision recorded in `docs/roadmap.md`. Two features were
accepted; this ADR fixes their design constraints so implementation
cannot quietly reopen them.

## Decision

### A. Unit conversion is display-time, same-dimension, explicit

- Conversion happens only at render time. Stored `qty` stays display
  truth and the additive parse fields from #16 are never rewritten; no
  migration.
- Same-dimension only: volume↔volume (cups↔ml, tsp↔ml), weight↔weight
  (oz↔g, lb↔kg). No volume↔weight conversion — it requires a
  per-ingredient density table, which is pantry-app scope in disguise.
  Counts ("2 eggs") and unparseable lines pass through unchanged.
- The recipe view has one explicit US ⇄ metric toggle; default is US
  customary. No automatic unit-switching when scaling — a surprising
  conversion erodes trust in the numbers.
- Converted US results render as fractions (1¼ cups) through the
  existing fraction.js path, never decimals.

### B. "What can I cook?" is a ranked home-page filter, not a page

- Ingredient chips on the home page filter the existing recipe grid;
  no separate route.
- Matching is plain-text substring match of chip terms against the
  ingredient `item` field. No canonical-food/alias ontology; the
  household knows its own recipes and imperfect matching is acceptable.
- Every recipe is shown, sorted by fewest missing ingredients, each
  card badged with its missing count and items. No hard cutoff — with
  a small library a cutoff only hides food.
- An ingredient line counts as missing unless its item text matches a
  chip or a staple (below). All lines are otherwise equal: "salt to
  taste" and "chicken thighs" weigh the same.
- No exclusion terms ("without X") in v1.

### C. Staples are a hard-coded list

- A fixed, code-owned list of universal staples (salt, pepper, oil,
  butter, flour, sugar, water, and similar preparation/garnish items)
  is exempt from the missing count. No settings UI, no per-recipe
  flags, no user-editable list: per-line flags re-introduce the
  curation burden the household rejected, and an editable list was
  declined in favour of the simpler fixed list.
- The list is a single exported constant so tests and future edits
  have one owner.

## Consequences

- Scaling and conversion stay read-only over stored data; the #16
  parse-on-write seam is untouched.
- The conversion toggle is the only new client state on the recipe
  view; the filter reuses the existing home-grid filter mechanism.
- The staple list will occasionally be wrong for this household
  ("we count butter"); accepted — editing the constant is a
  one-line follow-up.
- Substring matching will occasionally match the wrong ingredient
  ("ham" in "hamburger Helper" style false friends); accepted for v1.
- Deferred, explicitly rejected this round: shopping list, meal
  planner, pantry inventory, export formats, step timers, ratings,
  offline/PWA, nutrition, exclusion filters. See `docs/roadmap.md`.
