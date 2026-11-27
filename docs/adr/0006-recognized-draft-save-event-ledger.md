# ADR-0006: Recognized drafts and a save-event ledger

Date: 2026-11-26
Status: Accepted

## Context

Training on real human corrections requires preserving both what the machine
recognized and what was ultimately saved. Storing only the final Recipe loses
the correction signal, while writing granular adjustment rows at save time
would permanently encode today's diff heuristics.

## Decision

Every `executeSave` appends one lossless save-event row, inside the existing
transaction. Each row records the `recipe_id`, `capture_mode` (`save`, `revise`,
`backfill`, or `reparse`), recognized-draft JSON, saved-draft JSON, and
timestamp.

`SaveCommand` has an optional `recognized` draft. Browser add-flow saves echo
the pre-edit parser draft; review-page saves echo the draft as loaded.
Backfill and reparse stamp the recognized draft on the server. The echo is
deliberately self-reported and is not trusted as an authoritative claim.
Manual imports have no recognized draft.

Field- and line-level adjustment diffs are derived on read by the pure
`diffSnapshots()` library function; they are not stored. Rejected write-time
granular rows would freeze diff heuristics, including the ambiguity between an
edited line and a removed-and-replaced line, instead of allowing the diff to be
re-run retroactively.

Reparse knowingly overwrites human field fixes so the existing 239-recipe scan
corpus can regenerate genuine field-level pairs. Save-event exports exclude
machine-origin `backfill` and `reparse` events by default; `?include=machine`
includes them.

## Consequences

- The append-only snapshots preserve the inputs needed to derive and revise
  adjustment diffs without changing historical save events.
- Reparse is destructive to human field fixes, an accepted trade-off for
  regenerating the scan corpus's machine-to-saved comparisons.
- Machine-origin events remain available for analysis but do not contaminate
  human-adjustment exports unless explicitly included.
