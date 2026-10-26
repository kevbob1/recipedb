# recipedb

Domain language for the single-household recipe organizer: what a Recipe is and what belongs to it.

## Language

### Recipe & import

**Recipe**:
A single stored dish, created by one import or one manual entry. Editing a recipe revises that stored row in place; imports never merge into an existing recipe.
_Avoid_: Dish, item, entry

**Draft**:
The editable state every imported recipe lands in, awaiting review. All imports become drafts; nothing publishes silently. Saving an edited draft revises it in place rather than creating a second recipe.
_Avoid_: Pending, staging

**Import**:
Turning an outside input (URL, scan text, manual entry) into a Draft, stamping source type and initial confidences. URL fetch, scan recognition, and manual blank are adapters behind its seam, not separate flows.
_Avoid_: Ingest

**Review**:
The pass over a draft where a person confirms or corrects it before it is a kept recipe. Auto-normalization at review is trim-only: whitespace, never content.
_Avoid_: Approval, QA

**Provenance**:
Where a recipe came from: source type (url, scan, manual), source URL, and the raw OCR text captured at import.
_Avoid_: Origin, metadata, attribution

**Duplicate**:
Two recipes describing the same dish. They coexist; merging is out of the MVP's scope.
_Avoid_: Conflict, collision

**Photo**:
A transient OCR input — read at import. Camera captures are discarded after recognition; retained scan images (see Scan) are the exception, kept as Provenance.
_Avoid_: Image attachment

**Scan**:
An import path where the Provenance is a retained photograph of a recipe (cookbook page, card) rather than a URL. The Scan module owns the whole path — capture storage, image preprocessing, text recognition — behind one interface; camera-decode and server-decode are adapters behind its seam, not separate modules.
_Avoid_: OCR pipeline, scanner service

### Recipe content

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
