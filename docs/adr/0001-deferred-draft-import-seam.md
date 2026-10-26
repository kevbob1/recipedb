# ADR-0001: Defer the Draft-import seam

Date: 2026-10-21
Status: Superseded by [ADR-0002](./0002-unified-draft-factory.md)

> Editor's note: the "ADR-0002 direction" mentioned below was realized as
> the Scan module (`app/lib/scan`) without its own ADR. ADR-0002 is the
> unified Draft factory that replaces this deferral.

## Context

Architecture review (2026-10-21) identified candidate 5: the Draft
construction paths — URL scraper (`app/lib/recipe-scrapers.server.ts`),
OCR text (`ocrTextToDraft` in `app/lib/ocr.ts`), manual entry
(`blankDraft` in `app/routes/add.tsx`) — each build `RecipeDraft`
ad-hoc. No module owns the import → Draft transition; transient
`raw` and persisted `rawOcrText`/`imageFilename` cohabit one shape;
`isDraft` is vestigial (always true).

## Decision

Defer. The Scan collapse (ADR-0002 direction, implemented first) and
the Ingredient line deepening subsume the highest-friction parts.
`ocrTextToDraft` / `guessCategory` stay where they are; the Scan
module returns raw text + confidence and does not learn Recipe
structure.

## Consequences

- Three ad-hoc Draft constructors remain; a future change touching
  all importers still bounces across `recipe-scrapers.server.ts`,
  `ocr.ts`, and `add.tsx`.
- `isDraft` stays vestigial until a publish flow reifies it.

## Reopen when

Revisit when a second import-path bug shares a root cause with the
first (i.e. the seam stops being hypothetical), or when a publish /
un-draft flow forces the Draft lifecycle to be modeled explicitly.
