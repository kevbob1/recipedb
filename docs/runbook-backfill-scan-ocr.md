# Runbook — Backfill scanned-PDF/camera recipes (Phase 5)

Prerequisite: the image containing ADR-0004 phases 1–4 + 5 and `poppler-utils`
deployed (`deploy/k8s/deploy.sh`), app serving as the single replica with the
`recipedb-data` PVC. The runtime image must include Poppler (`pdftoppm`) for
source-PDF-only legacy scans.

## What this does

Backfill re-OCRs every kept `scan` recipe with the server-side recognizer (sharp
preprocessing + tesseract, same params as the browser path) and **hard-overwrites**
its raw text, parsed fields, page rows and OCR training samples (ADR-0004 §Decision,
Q15=b). Review afterwards is optional; fresher recognition wins over preserving prior
corrections. It also converts every retained scan into the page model
(`recipe_pages`), so old single-photo scans gain per-page review and become
exportable training pairs.

Target set: recipes with `sourceType='scan'` that have **no accepted training
rows** — a recipe whose pages a human reviewed (or that was already backfilled) is
skipped. Recipes imported as PDFs but never reviewed are IN the target set by
design: running backfill over them is how an unreviewed corpus becomes accepted
training data without per-page review.

PDF recipes imported by `scripts/upload-scans.mjs` with only `source.pdf` and
no page rows are rasterized automatically on their first backfill pass. Deploy
an image containing `poppler-utils` before running backfill; it retains
`page-<n>.png` rasters and continues through the normal per-page OCR path.

## Risks — read before Step 4

- **No backup is taken before this run** (household decision, 2026-11-23). The
  nightly backup CronJob is disabled. The irrecoverable loss is bounded to
  *prior manual field corrections* on the scan recipes being overwritten:
  images are never touched, so everything else is re-derivable by re-OCR +
  re-review from the retained rasters.
- Backfill writes while the app serves normally (same-process SQLite,
  one recipe per transaction; a failed recipe rolls back whole and the run
  continues).
- An empty OCR result never overwrites: that recipe is skipped-and-reported and
  stays in the target list for a later retry.

## Steps

### 1. Port-forward

```bash
kubectl port-forward deploy/recipedb 3000:3000
```

(Leave running in its own terminal.)

### 2. Normalize image layout (once, after the Phase 5 deploy)

Moves any remaining flat `images/<n>.webp` files into `images/<recipeId>/original.webp`,
updates `recipes.image_filename`, and deletes orphan files not referenced by any
recipe — **eyeball the printed orphan list first**; pass `{"keepOrphans": true}` to
only report them.

```bash
# login to get a session cookie
curl -s -c /tmp/recipedb-cookies.txt -o /dev/null -X POST \
  --data-urlencode 'password=<FAMILY_PASSWORD>' --data 'next=/' \
  http://localhost:3000/login

# run normalization
curl -s -b /tmp/recipedb-cookies.txt -X POST \
  -H 'content-type: application/json' -d '{}' \
  http://localhost:3000/api/backfill/normalize-images
```

### 3. Preview targets (no mutations)

The backfill and upload scripts now use a minted bearer token: set `RECIPEDB_TOKEN` to the one-time secret from `curl -b <browser-session-cookie> -H 'content-type: application/json' -d '{"name":"scan backfill"}' http://localhost:3000/api/tokens` using a browser-authenticated session.

```bash
RECIPEDB_TOKEN=<API_TOKEN> npm run backfill:scan -- --dry-run
```

Lists targets (id + title) and skipped recipes (reason). Expected first run on
prod: one old camera-scan recipe; after bulk-importing PDF corpora without review,
one entry per unreviewed scan recipe.

### 4. Backfill

```bash
RECIPEDB_TOKEN=<API_TOKEN> npm run backfill:scan
```

One POST per target; each line reports `backfilled / skipped / failed`. Nonzero
exit iff any recipe failed — a rerun skips everything already accepted, so reruns
are safe and cheap.

Manual retry of one recipe (bypasses the reviewed-skip check — destructive,
replaces whatever earlier acceptance wrote):

```bash
RECIPEDB_TOKEN=<API_TOKEN> npm run backfill:scan -- --force <recipeId>
```

### 5. Spot-check

Open one backfilled recipe in the review editor: the "Scanned pages" section
should show its pages with the fresh OCR text. Confirm in the DB (read-only):

```bash
kubectl exec deploy/recipedb -- node --input-type=module -e \
  'import Database from "better-sqlite3";const d=new Database("/data/recipes.db",{readonly:true});
   console.log(d.prepare("select count(*) n, sum(accepted_at is not null) a from ocr_training_samples").get())'
```

Accepted count should equal the rows of every backfilled/reviewed recipe's pages.

### 6. Optional — export training data (Phase 6)

Never against the live PVC. Copy the data down, unpack, export:

```bash
kubectl cp default/<pod>:/data/recipes.db ~/recipedb-training/<stamp>/recipes.db
kubectl cp default/<pod>:/data/images     ~/recipedb-training/<stamp>/images
DATA_DIR=~/recipedb-training/<stamp> npm run ocr:export -- ~/recipedb-training/<stamp>/tesstrain
```

The summary lists per-recipe **unreviewed** sample counts — the work list for
Review (or another backfill) before the next export. Training itself (tesstrain)
runs on the host, never in the container.

### 7. Done

Close the port-forward. Nothing to disarm — the backfill endpoints are
session-authed and the routes mutate only on explicit POSTs.
