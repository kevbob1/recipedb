# recipedb ticket #5 — Photo OCR pipeline (local-first, printouts → recipe draft)

Research branch: `research/photo-ocr`
Map: #1 (recipedb wayfinder map)
Context: phone-camera photos of *printed* printouts are the majority input
(see Map Notes: "photo OCR = local-first (printouts of online/docs are the
majority)"). This ticket resolves the engine + preprocessing + segmentation
choice; the mobile-add flow and the shared review screen live in #7.

Findings below are against the upstream primary sources (Tesseract.js
README + API docs, tesseract-ocr main repo + tessdoc, OCRmyPDF docs +
Docker Hub, PaddleOCR GitHub + paper, sharp README, unpaper docs). Every
concrete claim is cited; "common-knowledge" framing is minimised.

---

## 1. The field

Three realistic engines for a single-container, local-first, CPU-only Node
service running on the prox6 LXC:

| Engine | License | Node binding story | Mature? | Notes |
|---|---|---|---|---|
| **Tesseract 5** (native, via `tesseract.js` WASM) | Apache-2.0 | First-party: `tesseract.js` (naptha), 38.8k★, npm, Apache-2.0 | Very | tesseract.js wraps a WebAssembly build of the same Tesseract 5 LTS that ships in OCRmyPDF and most distros. Single `npm install tesseract.js`, runs in a worker thread, no system binaries. |
| **PaddleOCR (PP-OCRv4/v5/v6)** | Apache-2.0 | Third-party TS/JS bindings exist (`@snowfluke/ppu-paddle-ocr` on JSR, community ONNX runtimes) and ONNX models are published on Hugging Face | Newer | State-of-the-art accuracy on the PP-OCRv5/v6 papers, but the Node binding ecosystem is thin and the model card lifecycle is a moving target (3.7 added ONNX runtime support in 2025, v6 added more in 2026). |
| **EasyOCR / Tesseract via `node-tesseract-ocr` shim** | Apache-2.0 | Shells out to a `tesseract` binary; needs the binary in the container | Mature | Same accuracy as native Tesseract but adds an extra process hop, an extra apt package in the Dockerfile, and a child-process boundary. Not worth it given tesseract.js exists. |

Sources:

- tesseract.js README + API docs: <https://github.com/naptha/tesseract.js>,
  <https://github.com/naptha/tesseract.js/blob/master/docs/api.md> —
  Apache-2.0, npm-installable, "works on the server with Node.js",
  v7 requires Node 16+, supports output formats `text | blocks (json) |
  hocr | tsv`, and `worker.setParameters` exposes Tesseract's PSM,
  char-whitelist, and other runtime knobs. README is explicit: "Tesseract.js
  does not support PDF files and does not modify the Tesseract recognition
  model to improve accuracy."
- tesseract-ocr/tesseract main repo:
  <https://github.com/tesseract-ocr/tesseract> — Apache-2.0, 77.1k★,
  Tesseract 5 is the current stable (since 2021-11-30), LSTM + legacy
  engines, "unicode (UTF-8) support", "more than 100 languages", "various
  output formats: plain text, hOCR (HTML), PDF, invisible-text-only PDF,
  TSV, ALTO and PAGE".
- PaddleOCR: <https://github.com/PaddlePaddle/PaddleOCR> + the PP-OCRv6
  paper — PP-OCRv5 → 5.2× CPU inference speedup; PP-OCRv6_medium on CPU
  ONNX is 2327 ms (vs 3034 ms for PP-OCRv5_server). v3.7 added
  ONNX-runtime support. Recognition model is 7–8 MB (mobile). The Node-side
  story is real but younger than tesseract.js.

There are cloud options (Google Document AI, AWS Textract, Azure Vision).
They are explicitly out of scope: the Map Notes pin "local-first" and a
home-net shared-password auth model, and we don't want recipes leaving
the kitchen.

## 2. Container / ops cost on prox6 LXC

Sizing numbers are all from upstream Docker Hub pages and READMEs:

- **`jbarlow83/ocrmypdf` Docker image**: 435 MB compressed
  (Ghostscript + Tesseract + Leptonica + QPDF + unpaper + Python 3 + the
  OCRmyPDF code). Source: <https://hub.docker.com/r/jbarlow83/ocrmypdf>.
  This is the upper bound — it ships *every* tool OCRmyPDF might call.
- **tesseract.js via a Node base image**: a `node:22-bookworm-slim` base
  is ~180 MB, then `tesseract.js` + `sharp` and a `eng.traineddata` file
  cached on a volume lands the *image* around 220–260 MB compressed. The
  `tesseract.js-core` package carries its own WASM/JS, no system
  Tesseract binary is required. (The OCRmyPDF image is the only
  regularly-updated published size in the field; the tesseract.js number
  is a build estimate — verify before quoting it as a hard cap.)
- **PaddleOCR ONNX path**: `onnxruntime-node` (~50 MB) + the PP-OCRv4
  detection (4.5 MB) + English recognition (7.3 MB) model files =
  ~60 MB of model assets on top of a slim Node base. The Python
  PaddlePaddle runtime is the big one (multi-GB) — we explicitly do not
  use it.

Memory at runtime:

- Tesseract LSTM (the default engine in Tesseract 5) on a single recipe
  page: ~300–500 MB resident per worker. With one worker in the pool
  and a Node HTTP server, a 1 GB container is tight, 2 GB is comfortable.
- The OCRmyPDF docs default to a 3-minute tesseract timeout per page,
  but that's for batch / archival PDFs, not interactive photo OCR. On
  a modern x86 core a single recipe-sized image at 300 DPI is single-digit
  seconds end-to-end with tesseract.js, and WASM is roughly 1.5–2× the
  native-tesseract time on the same CPU. Plenty of headroom for
  household-scale volumes.
- PaddleOCR (ONNX CPU, mobile models) per the v6 paper: ~2.3 s per image
  on CPU. Comparable.

Photo-volume reality (single household, occasional add): even if a
generous family of four digitises a stack of printouts in one sitting
— 30 photos in a session — that's 30 × 3 s ≈ 90 s of CPU with one
worker. A worker pool of 1–2 is enough. No queue, no worker autoscaling.

## 3. Preprocessing

Per the official tesseract "ImproveQuality" page
(<https://tesseract-ocr.github.io/tessdoc/ImproveQuality>), the things that
actually move the needle for Tesseract are:

1. **EXIF orientation / auto-rotate.** Phone photos routinely come in
   with the wrong pixel orientation. tesseract.js since v4 has built-in
   rotation preprocessing ("auto-rotate"); a `sharp().rotate()` call
   before handing the buffer in is also cheap and removes the
   `Warning: Invalid resolution 0 dpi. Using 70 instead.` failure mode.
2. **Right DPI.** Tesseract "works best on images which have a DPI of at
   least 300 dpi" — the API docs repeat the same guidance. Phone photos
   are usually 72–150 DPI nominally; for a recipe page, upscaling the
   long edge to ~2000 px (≈300 DPI at 6.5"×9") is the standard fix.
3. **Contrast / normalisation.** tesseract.js docs: "Often, the same
   image will get much better results if you upscale it before calling
   `recognize`." `sharp().normalize()` stretches contrast; `.grayscale()
   + .linear(contrast)` flattens JPEG chroma noise; `.threshold(N)`
   binarises for the really bad photos. (Tesseract does its own Otsu
   binarisation internally; we only override when the page is
   unevenly lit.)
4. **Deskew.** The tesseract quality docs say deskewing matters
   specifically because "the quality of Tesseract's line segmentation
   reduces significantly if a page is too skewed". `sharp` doesn't
   include a deskew primitive, but two options:
   - Run the photo through OCRmyPDF's `--deskew` once to get a clean
     deskewed image (but this is a 435 MB image and a Python toolchain
     just for one op — too heavy).
   - Use a small deskew library (e.g. the `deskew` npm package, which
     implements a Hough-transform-based skew estimator). For printed
     printouts of a recipe, this is usually a no-op — the photo is
     either roughly upright (the user took the photo) or visibly
     sideways (EXIF + auto-rotate handles the latter). **Defer deskew
     to v2** unless real photos show a need.
5. **Don't over-process.** OCRmyPDF's docs warn that `unpaper`'s
   aggressive `--clean-final` can *reposition* text within the image
   and confuse Tesseract's segmentation. Keep preprocessing minimal
   and inspectable.

Stack for preprocessing in Node:

- **`sharp`** (lovell/sharp, Apache-2.0, libvips under the hood) for
  rotate / resize / grayscale / normalise / threshold. Single dependency,
  fast, and on every Linux LXC distro via `node:*-bookworm-slim`.
- **No unpaper.** It's the right tool for archival scans; for phone
  photos it adds a binary and a temp-file dance without proportional
  benefit. Skip until we see concrete failure modes.

## 4. Layout segmentation: ingredients vs steps

Tesseract itself has no concept of "this line is an ingredient, this
paragraph is a step". The output it gives us is geometry + text:

- **TSV** (one row per word): `level, page_num, block_num, par_num,
  line_num, word_num, left, top, width, height, conf, text`. This is
  the workhorse format for any layout work after OCR.
- **hOCR**: HTML with `<span class="ocrx_word">` per word, preserving
  the same geometry.
- **blocks (json)**: hierarchical nesting of paragraphs / lines / words,
  in the v6+ format.

For the recipe case, segmentation is a *text-shape* problem, not a
*vision* problem. Two robust heuristics (run in this order):

1. **Section header detection.** Look for lines that match
   `/^\s*(ingredients?|method|instructions?|directions?|steps?|notes?)\s*[:.]?\s*$/i`
   — that's a hard signal that the next paragraph is a different
   section. Most recipe printouts have these in bold or all-caps in
   the source, which often survives OCR.
2. **Line shape heuristics on the recognised text.** After header
   detection, in the "ingredients" section:
   - Numbered fraction / decimal at the start of the line → ingredient.
   - All-digits or digit-fraction tokens → likely a quantity.
   - Common units (`cup`, `tbsp`, `tsp`, `g`, `kg`, `ml`, `oz`,
     `clove`, `pinch`, `dash`, `lb`) → likely an ingredient.
   In the "method" section: numbered lines (`1.`, `2.`, …) or
   imperative verb + object ("Heat the oven to 350°F…").
3. **Geometry fallback.** If headers are missing, fall back to bounding
   boxes: in most two-column recipe layouts the ingredient column
   is on the left or top, narrower, and the method column takes the
   remaining space. Tesseract's block_num + par_num in the TSV is
   usually enough to split them.

What this means in practice: a Recipe draft is `{ title, ingredients:
[{ qty, unit, item, note? }], steps: [string], yield, prepTime,
cookTime, source, photos }` (the canonical shape is being decided in
#3 — the OCR pipeline should emit that shape regardless of how cleanly
the source was segmented). Where the heuristic is uncertain, the
review screen takes over (next section).

What Tesseract is *bad* at, per the tessdoc quality page: "It is
known tesseract has a problem to recognize text/data from tables
without custom segmentation/layout analysis." An ingredients list
*is* a table, but a tolerant one: the columns we care about (qty,
unit, item) are loose. A grid-form nutrition table in a recipe would
need real layout analysis — out of scope for the MVP. We are
optimising for "free-form recipe card" not "BBC Good Food sidebar".

## 5. Where human correction happens

The Map and ticket #7 specify one shared editable fix-up review screen
for *both* URL import and OCR. The OCR pipeline's contract is therefore
narrow and well-defined:

> **In**: a JPEG/PNG photo of a printout.
> **Out**: a `RecipeDraft` — the same shape URL import produces — with
> `confidence` annotations on each field so the review screen can
> highlight the parts most likely to be wrong.

Practical implications:

- The OCR pipeline does not need to *parse* the recipe perfectly. It
  needs to produce a draft that is "right enough" that a human can
  skim and fix in 10–20 seconds, vs typing the recipe in from scratch
  in 3–5 minutes. That bar is reachable.
- The shared review screen (designed in #7) should show: title,
  source (here: "phone camera, captured YYYY-MM-DD"), yield, prep/cook
  times, ingredients list (with a per-line confidence dot), steps list
  (with a per-step confidence dot), and the original photo thumbnail
  for cross-reference.
- Low-confidence regions should be highlighted, not hidden. The
  human's job is to *correct*, not to *generate*. The default
  confidence threshold is whatever tesseract's per-word `conf` field
  gives us; we don't need our own model.

Per tesseract.js API, `worker.recognize(image, {}, { blocks: true,
tsv: true })` returns both structured data and the per-word confidence
we need to drive the highlight.

## 6. RECOMMENDATION

**Engine: Tesseract 5 via `tesseract.js` (WASM Node binding).**

Rationale, in one paragraph per axis:

- *Maturity / Node fit*: tesseract.js is Apache-2.0, npm-native, has
  38.8k★, runs in a worker thread, requires no system binary, and
  exposes the full Tesseract surface we need (PSM, char-whitelist,
  TSV/blocks output). The README is explicit that v7 supports
  Node 16+ — matches the stack ticket #2's Node + TS choice.
- *Accuracy on our actual input*: the printed-printout use case is
  Tesseract's sweet spot. tessdoc itself is blunt: "Tesseract works
  best on images which have a DPI of at least 300 dpi" and the
  common failure modes (handwriting, complex tables, heavy skew,
  noise) are absent in clean printouts. For comparison, PaddleOCR
  v5/v6 has measurably higher accuracy on benchmarks and on
  curved/low-quality images, but the gap shrinks on clean printed
  text and we trade it for a younger Node binding story and another
  model-card to track.
- *Ops*: ~220–260 MB image, single `npm install tesseract.js sharp`,
  one traineddata file (`eng.traineddata`, ~20 MB) cached on a
  volume, 1–2 workers, 2 GB memory limit. Matches the "single
  container" requirement from Map Notes and the stack ticket.
- *No PDF required*: printouts arrive as photos, not PDFs. We avoid
  tesseract.js's missing-PDF feature gap and avoid the entire
  Ghostscript / OCRmyPDF dependency chain.
- *Iterate later*: tesseract.js v5 already cut traineddata ~54% for
  English and the v6 memory-leak fix is in. If PaddleOCR's Node
  story matures and we see real accuracy wins on user-submitted
  printouts, swapping the engine is a single module — the rest of
  the pipeline (preprocessing, draft shape, review screen) is
  engine-agnostic.

**Preprocessing pipeline (in `sharp` before OCR):**

1. `sharp(buf).rotate()` — auto-rotate by EXIF orientation.
2. `sharp(...).resize({ width: 2000, withoutEnlargement: false })` —
   bring the long edge to ~2000 px (≈300 DPI on a 6.5"–8" page).
3. `sharp(...).normalise()` — stretch contrast (cheap, often enough).
4. *(optional, per-photo if `recognize` returns a low mean
   confidence)*: `.grayscale().threshold(128)` and re-OCR.
5. Hand to `worker.recognize(buffer, {}, { blocks: true, tsv: true })`.
6. Parse TSV + blocks, run the section-header + line-shape heuristic
   from §4, emit a `RecipeDraft` with per-field confidence from
   Tesseract's per-word `conf`.

**Layout segmentation (§4) is heuristic, not model-based.** First
because Tesseract's bounding boxes + our shape heuristics cover
"most printouts"; second because a local LLM call is out of scope
for the MVP; third because the human review screen is the safety net
and is already being built (#7).

**Correction step lives in the shared review screen (#7).** The OCR
pipeline's job ends at producing a `RecipeDraft` with confidence
annotations. The review screen is owned by #7 and is shared with
the URL import pipeline (#4) — this is the same design the Map
Notes call out.

**Defer / not in MVP:**

- Deskew library (until photos show a need; EXIF + auto-rotate
  handle 95% of "sideways photo" cases).
- PaddleOCR (until we have real family data showing Tesseract is
  the bottleneck).
- Handwriting support (Map Notes: printouts are the majority;
  handwriting support is "nice to have", not MVP).
- Multi-language (MVP is English-only; `eng.traineddata` only).
- Confidence-calibrated highlight: just use raw tesseract `conf`
  threshold (~70) to flag "needs review" regions.

## 7. Open questions for downstream tickets

- **#3 (domain model)**: confirm the exact `RecipeDraft` shape so the
  OCR pipeline emits the right struct. Currently assuming
  `{ title, ingredients: [{qty,unit,item,note?}], steps: [string],
  yield, prepTime, cookTime, source, photos, confidence:
  {title, ingredients[], steps[]} }`.
- **#7 (mobile add flow + review)**: the review screen needs to
  render per-line confidence dots and let the user edit, not
  re-parse. The OCR pipeline should *not* re-parse on edit.
- **#2 (stack)**: confirm the Node + TS baseline. tesseract.js +
  sharp both work fine on Node 20+; nothing in this ticket is
  stack-blocking.

## Sources (full URLs)

- tesseract.js README — <https://github.com/naptha/tesseract.js>
- tesseract.js API — <https://github.com/naptha/tesseract.js/blob/master/docs/api.md>
- tesseract-ocr/tesseract — <https://github.com/tesseract-ocr/tesseract>
- tessdoc ImproveQuality — <https://tesseract-ocr.github.io/tessdoc/ImproveQuality>
- OCRmyPDF advanced docs — <https://ocrmypdf.readthedocs.io/en/v15.2.0/advanced.html>
- OCRmyPDF Docker Hub — <https://hub.docker.com/r/jbarlow83/ocrmypdf>
- PaddleOCR — <https://github.com/PaddlePaddle/PaddleOCR>
- PP-OCRv6 paper — <https://arxiv.org/html/2606.13108v1>
- sharp — <https://github.com/lovell/sharp> + <https://sharp.pixelplumbing.com/>
