# ADR-0004: Scanned-PDF ingestion doubles as OCR training capture

Date: 2026-11-22
Status: Accepted (amended 2026-11-23: first-persistence capture; amended 2026-11-23: current-page-set and image-layout semantics; amended 2026-11-27: backfill rasterization)

## Context

The scan import path (`app/lib/ocr.ts`, ADR-0002's scan adapter) accepts one
photo per import. A corpus of image-only Brother scanner PDFs
(`_pdf_scans/`, 45 files, ≈62 pages, mostly 1–2 pages each) needs a way in,
and multi-page documents cannot be entered as bulk separate images. The same
corpus is the seed of a longer-term goal: improving OCR accuracy by training
on this household's actual scans. Today review edits only structured fields —
raw OCR text and page boundaries are discarded at acceptance, so no
image↔text training pairs can ever be reconstructed after the fact.

## Decision

A scanned PDF is ingested through the existing scan import path with three
rules:

1. **One PDF is one Recipe, always.** Pages are a long document, never split
   into several recipes. Uploads cap at 5 pages per PDF.
2. **Ingestion rasterization is client-side** (pdf.js → per-page PNG) and the
   pages run through the existing browser OCR. For backfill only, the server
   may rasterize a retained source PDF with Poppler (`pdftoppm`) when the
   recipe has no page rows or legacy image filename. The original PDF bytes
   are stored untouched as Provenance at
   `images/<recipeId>/source.pdf` (not linked in the UI yet), alongside
   `page-<n>.<ext>` rasters; `image_filename` points at page 1.
3. **Per-page review is the training capture seam, but capture does not wait
   for acceptance.** PDF drafts get a per-page raw-text editor (page image
   beside that page's OCR text). One row per page is written into a new
   `ocr_training_samples` table (raw OCR text + corrected text) at the page's
   **first persistence** — a save from bulk import or the camera flow — with
   `corrected_text` initialised to the OCR text and `accepted_at` left NULL.
   The raw side is **write-once**: it is preserved across later saves by page
   number. Review/revise updates `corrected_text` to the edited per-page text
   and stamps `accepted_at` — a revise is the acceptance signal. Amended
   rationale: deferring the row to acceptance meant a bulk-imported recipe
   that was never revised contributed nothing at all; capturing at first
   persistence seeds the corpus with the raw pairs even for recipes nobody
   re-reviews.

The declared training goal is a tesstrain fine-tune of Tesseract's `eng`
model on the captured pairs; an offline export script emits tesstrain-ready
image/ground-truth files from a copy of `/data` so training can run locally.
Training never runs in the container.

**Backfill** of already-kept scan recipes runs them through re-OCR and
**hard-overwrites** their raw text and parsed fields; review afterwards is
optional. Fresher recognition on a small corpus beats preserving prior
corrections — and backfilled pairs make old camera scans trainable too.

## Considered Options

- **Server-side rasterization for initial ingestion** (poppler in the
  container): rejected — first-pass OCR already runs in the browser, and
  pdf.js keeps the container image unchanged; the stored page rasters are what
  re-OCR consumes anyway.
- **Reconstructing "corrected text" from accepted structured fields** instead
  of per-page review: rejected — normalized quantities and joined steps make
  noisy OCR ground truth, poisoning the dataset from day one.
- **Training table doubles as per-page draft store**: rejected — per-page
  draft text gets a recipe-side table; the training table is capture history
  (write-once raw, latest-save corrected), never the source a draft loads
  from, keeping the two lifecycles separate.
- **Backfill preserves prior corrections** (staging re-OCR for review):
  rejected for the stated priority — more accurate OCR and field mapping is
  worth the overwrite; the corpus is small.
- **Modern model fine-tune (PaddleOCR/TrOCR)**: deferred — ~62 pages cannot
  seed one; the capture format is trainer-agnostic and nothing is wasted if
  this changes.

## Consequences

- Review for multi-page drafts is a different (bigger) UI than the
  single-image review editor; the capture quality depends on it.
- `ocr_training_samples` has one row per currently persisted page across scan
  imports (camera and PDF alike). A revise replaces a recipe's rows with its
  current page set, retiring removed pages; raw OCR remains write-once per page
  number (`accepted_at` distinguishes reviewed from raw-only captures). Treat
  it as provenance, not derived data.
- The backfill overwrite is destructive by design: re-running it on a recipe
  replaces whatever fields the earlier acceptance wrote.

## Amendment (2026-11-23, second)

Phase 5 (Backfill) and image-layout normalization are in build. Revising
rewrites training rows to the Recipe's current Page set; pages removed during
review have their samples retired by design, so no training rows remain for
pages that no longer belong to the Recipe. Every stored image lives under its
recipe directory (`images/<recipeId>/…`). URL-import bytes stage at
`images/_staging/<uuid>.webp` and relocate at save; flat `images/<n>.webp`
paths are retired.

## Amendment (2026-11-27, third)

The first backfill pass now handles legacy PDF-only scan recipes (including
recipes imported by `scripts/upload-scans.mjs`) that have `source.pdf` but no
`recipe_pages` rows or legacy `image_filename`. It rasterizes the retained PDF
server-side with Poppler's `pdftoppm`, stores the results as
`images/<recipeId>/page-<n>.png`, persists their page rows through
`executeSave`, then runs the existing page recognizer and backfill save path.
Existing page rows and legacy single-image recipes keep their previous
resolution behavior. The runtime and development images include
`poppler-utils`. pdfjs + node-canvas was rejected because of native build
weight; Poppler avoids adding a native Node module while keeping rasterization
local to the container.
