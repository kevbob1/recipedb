# ADR-0002: One Draft factory with per-input adapters

Date: 2026-10-25
Status: Accepted — supersedes ADR-0001

## Context

ADR-0001 deferred the Draft-import seam, leaving three ad-hoc Draft
constructors: the URL scraper (`app/lib/recipe-scrapers.server.ts`), OCR text
(`ocrTextToDraft` in `app/lib/ocr.ts`), and manual entry (`blankDraft` spread
in `app/routes/add.tsx`). Its stated reopen trigger was "a second import-path
bug shares a root cause with the first". That trigger fired, and the shared
cause turned out to be the constructor shape itself:

- The scraper stamped `sourceType: "url"` on the draft it built, and then
  `importUrl` re-stamped it: `{ ...result.draft, sourceType: "url" }`
  (`app/lib/import.server.ts:27`). Two layers decided the same fields.
- `ocrTextToDraft` stamped `sourceType: "scan"` and the scan baseline; the
  scan seam (`importScan`) re-stamped `sourceType` and `category`; the Add
  route and the review editor each called it from a different place.
- `blankDraft()` is already `sourceType: "manual"`, yet the Add route spread
  it and re-stamped `sourceType: "manual" | "url" | "scan"` in two branches.

Every path therefore built a draft, then had a caller partially rebuild it.
Provenance and confidence had no owner, so a change in the scraper or the OCR
parser could silently fight the stamp that a route applied afterwards — the
common root cause behind the URL, scan, and manual import bugs.

## Decision

There is exactly one Draft factory and it lives in the Import module:

```ts
createDraft(input: UrlDraftInput | ScanDraftInput | ManualDraftInput): RecipeDraft
```

`app/lib/import.ts` holds the factory and all three adapters (client-safe,
because photo OCR runs in the browser); `app/lib/import.server.ts` adds the
server-only URL entry point.

- **Adapters own provenance and initial confidence.** `sourceType`,
  `sourceUrl`, `rawOcrText`, `imageFilename`, and the title/category/yield
  confidence are stamped once, in the adapter for that input kind. Callers
  pass input only and never touch those fields.
- **URL adapter.** The scraper shrinks to data: `importFromUrl` returns
  `{ url, data: ScrapedRecipeData, imageFilename }`, where the data is title,
  category keywords, yield, tags, ingredient lines, step lines, and the raw
  source blob. `draftFromScraper` / `draftFromJsonLd` no longer exist as Draft
  constructors. `importUrl` is now only wiring: scraper data →
  `createDraft({ kind: "url", ... })`.
- **Scan adapter.** The OCR text parser moved out of `ocr.ts` into the scan
  adapter as a private `parseOcrText`; `ocr.ts` is recognition only and keeps
  `guessCategory`, which the adapter calls back into. No caller re-stamps a
  scan draft to switch its source.
- **Manual adapter.** `blankDraft()` remains the single definition of the
  empty manual draft, but it is the manual adapter's body — routes and
  components call `createDraft({ kind: "manual" })` instead.
- **Persistence stays a separate seam.** `app/lib/draft-store.server.ts` is
  untouched: it persists and decodes drafts, it does not construct them.

Per-ingredient `confidence` stays on the ingredient line as the parser's own
verdict (it is derived from how well the line split into qty/unit/item), not
as draft-level stamping.

## Consequences

- Adding an import path is one adapter plus one union case; routes never learn
  provenance rules, so they cannot double-stamp.
- The confidence policy for a path is editable in one function, and the
  scraper's output is a plain data contract that can be fetched/parsed in
  isolation.
- `ScrapedRecipeData` is the boundary type between scrape and draft: server
  parsing changes do not reach the Draft shape except deliberately.
- No view behavior change: the review editor and save transports still
  receive a complete `RecipeDraft`; only its constructor changed.
- Tests live in `app/lib/import.test.ts` and cover all three adapters'
  provenance completeness.

## Supersedes

ADR-0001 (`docs/adr/0001-deferred-draft-import-seam.md`),
Status: Superseded.
