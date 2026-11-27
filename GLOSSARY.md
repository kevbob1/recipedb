# recipedb

Domain language for the single-household recipe organizer: what a Recipe is and what belongs to it.

## Language

### Recipe & import

**Add flow**:
The intake path from choosing an entry method through import or recognition and review to saving a Draft.
_Avoid_: Intake workflow

**Backfill**:
Server-side re-recognition of retained Originals for already-stored Recipes. It is an explicit machine-origin rewrite and is destructive by design.
_Avoid_: Migration, re-import

**Draft**:
The editable state every imported recipe lands in, awaiting review. All imports become drafts; nothing publishes silently. Saving an edited draft revises it in place rather than creating a second recipe.
_Avoid_: Pending, staging

**Duplicate**:
Two recipes describing the same dish. They coexist; merging is out of the MVP's scope.
_Avoid_: Conflict, collision

**Import**:
Turning an outside input (URL, scan text, manual entry) into a Draft, stamping source type and initial confidences. URL fetch, scan recognition, and manual blank are adapters behind its seam, not separate flows.
_Avoid_: Ingest

**Original**:
The byte-for-byte retained upload behind a Scan: one image per Page, plus the whole source PDF when the Scan came from one. Kept untouched so it can be re-read or re-OCR'd later; not surfaced in the UI yet.
_Avoid_: Source file, attachment, raw file

**Page**:
One rasterized image of a scanned document. A scanned PDF becomes one Page per document page, all belonging to a single Recipe — a multi-page Scan is one long document, never several Recipes.
_Avoid_: Sheet, image file, attachment

**Provenance**:
Where a recipe came from: source type (url, scan, manual), source URL, and the raw OCR text captured at import.
_Avoid_: Origin, metadata, attribution

**Recipe**:
A single stored dish, created by one import or one manual entry. Editing a recipe revises that stored row in place; imports never merge into an existing recipe.
_Avoid_: Dish, item, entry

**Recognized draft**:
The machine's answer: the parser's pre-edit field values as captured when a Recipe is persisted. Manual imports have no recognized draft.
_Avoid_: Parsed result, machine draft

**Review**:
The pass over a draft where a person confirms or corrects it before it is a kept recipe. Auto-normalization at review is trim-only: whitespace, never content.
_Avoid_: Approval, QA

**Scan**:
An import path where the Provenance is a retained photograph of a recipe (cookbook page, card) rather than a URL. The Scan module owns the whole path — capture storage, image preprocessing, text recognition — behind one interface; camera-decode and server-decode are adapters behind its seam, not separate modules.
_Avoid_: OCR pipeline, scanner service

**Training sample**:
A per-Page pair of raw OCR text and corrected text, captured to improve OCR models. A person confirms the correction for the pair to be accepted.
_Avoid_: Dataset row, ground truth, training data

### Recipe content

**Adjustment**:
A human correction to a machine-produced field value or Page text, whether made during import review or by revising a saved Recipe. Adjustments, not the Recipe itself, are the training signal.
_Avoid_: Edit, change

**Ingredient line**:
One ingredient as the four parts: quantity (a string preserving fractions and ranges like "2-3 cloves", "a bunch"), unit (optional, free-text), item, and note. A quantity may also carry a derived numeric reading — a low and optional high amount, a normalized unit, and a parse status saying whether a number was read — which is used only to scale a displayed recipe; the written quantity remains the source of truth and is never rewritten.
_Avoid_: Ingredient entry, component

**Step**:
One numbered instruction — a position plus text.
_Avoid_: Direction, action

### Recipe attributes

**Category**:
The single required grouping of a recipe, drawn from a fixed MVP list: one-dish, soup, salad, bread, dessert, cookies, cake, pie, other.
_Avoid_: Cuisine, type, kind

**Tag**:
A free-text label added by a person.
_Avoid_: Keyword, label

**Favorite**:
Whether a person has marked a recipe as a favorite.
_Avoid_: Star, liked
