# URL import pipeline — parser + editable fix-up review

Research for [issue #4](https://github.com/kevbob1/recipedb/issues/4). This is the
"AFK fact-finding" pass against primary sources (schema.org, npm package READMEs,
Google's structured-data docs, Wikimedia's html-metadata README, the Raymond Camden
JSON-LD walk-through, etc). It deliberately does **not** commit to a stack — that
is the job of #2. It commits to *what the URL pipeline must produce and how to get
there*.

The audience for the recommendation is the MVP on prox6: one household, one user
adding a few recipes a week, single Node/TS container, SQLite + photo volume on
the same LXC.

---

## 1. Recipe schema coverage in the wild

- **Schema.org/Recipe** is a `CreativeWork → HowTo → Recipe` subtype, with the
  obvious fields: `name`, `image`, `description`, `author`, `datePublished`,
  `prepTime`, `cookTime`, `totalTime`, `recipeYield`, `recipeCategory`,
  `recipeCuisine`, `recipeIngredient`, `recipeInstructions`, `nutrition`,
  `aggregateRating`, `keywords`, `suitableForDiet`. [schema.org/Recipe][1] lists
  the full type; [Google's Recipe structured-data doc][2] is the practical
  subset Google actually reads for rich results and the de-facto bar that
  food blogs target.
- **JSON-LD is dominant.** The WDC 2024 corpus (Common Crawl) reports JSON-LD
  is used by ~70% of sites that emit any structured data; microdata and RDFa
  together account for the rest. Recipe is in schema.org's "10K–100K Domains"
  band. The Raymond Camden walk-through ([raymondcamden.com][3]) — which
  actually tests on real food sites — finds JSON-LD blocks on every major
  food blog it tries (AllRecipes, BBC Good Food, etc.). His follow-up comment
  (and the [Hacker News thread on `recipe-scrapers`][4]) converges on:
  **"parse JSON-LD, fall back to microdata if you must."**
- **What the spec does not give you for free:**
  - `recipeIngredient` is most often an array of free-text strings ("1 cup
    sugar"), not a structured `PropertyValue`. Google's docs only *recommend*
    more structure; in practice almost nobody does.
  - `recipeInstructions` is a polyglot: a single string, an array of strings,
    an array of `HowToStep` objects (with `name`, `text`, `url`, `image`),
    or an array of `HowToSection` grouping. Real pages mix all four.
  - `image` is similarly a polyglot: a URL, an array of URLs (often sized
    1x1, 4x3, 16x9), or a full `ImageObject` with `width`/`height`/`url`.
  - Times are ISO 8601 durations (`PT15M`, `PT1H30M`) but plenty of sites
    also emit human strings ("15 minutes"). Don't trust them.
  - `@context` is sometimes a bare URL, sometimes `https://schema.org`,
    sometimes a custom inline context that re-aliases fields. All three
    appear in the wild.
  - The JSON-LD root is sometimes a top-level object, sometimes an array of
    objects, sometimes wrapped in `@graph: [...]`. The Camden snippet
    handles all three, which is the right minimum.
  - Google's [JSON-LD unescape change][5] in 2025 changed how `&amp;`/`&lt;`
    inside JSON-LD strings are decoded; tools that build their own
    JSON.parse path need to match the new behavior.

> **Net for the MVP:** JSON-LD is the de-facto signal. Microdata is a real
> fallback for older blogs (probably <10% of family-useful recipe sites).
> RDFa is rare enough to ignore. Hand-rolled HTML scraping is a last
> resort and we should not build it for the MVP.

[1]: https://schema.org/Recipe
[2]: https://developers.google.com/search/docs/appearance/structured-data/recipe
[3]: https://www.raymondcamden.com/2024/06/12/scraping-recipes-using-nodejs-pipedream-and-json-ld
[4]: https://news.ycombinator.com/item?id=23651921
[5]: https://launchcodex.com/blog/seo-geo-ai/google-json-ld-schema-markup-update/

---

## 2. Library options

### Parser libraries (Node/TS)

| Library | What it does | Maintenance | Verdict for MVP |
| --- | --- | --- | --- |
| **cheerio** | jQuery-style HTML parser; the de-facto standard. | Actively maintained, used everywhere. | **Use this.** |
| **html-metadata** ([wikimedia/html-metadata][6]) | One-call extractor: JSON-LD, microdata, OG, Twitter, Dublin Core, etc. | Last release 2023; stable but slow-moving. Maintained by Wikimedia. | Good "kitchen sink" if we want one call; we don't need most of it. |
| **jsonld** ([digitalbazaar/jsonld.js][7]) | Full W3C JSON-LD 1.0/1.1 processor: expand, compact, frame, canonize. | Very actively maintained by Digital Bazaar. | Overkill for recipe parsing — we don't need `@context` expansion, framing, or RDF canon. JSON.parse + a tolerant normalizer is enough. |
| **schema-dts** | TypeScript type definitions for schema.org JSON-LD. | Google-maintained. | Useful as the type we assert the parsed block against, not as a parser. |
| **microdata-node / microdata-js** | Microdata extractor. | Various forks, low maintenance. | Only needed if we add a microdata fallback path. |

[6]: https://github.com/wikimedia/html-metadata
[7]: https://github.com/digitalbazaar/jsonld.js/

### Recipe-specific libraries

| Library | Notes | Verdict |
| --- | --- | --- |
| **recipe-scrapers** (npm, TS, v3.2.0) | 742+ cooking sites supported. Auto-detects JSON-LD/microdata per site; cheerio + zod under the hood. Recently published, actively maintained, has TS types. | **Strong candidate for the "happy path."** Gives us 742+ sites for free. |
| **recipe-scrapers** (PyPI, Python) | The original, 742+ sites. The npm port wraps the same site-list philosophy. | Not used — we're Node/TS. |
| **@mediavine/recipe-ingredient-parser** (v2.0.1) | NLP-style ingredient line parser → `{quantity, unit, ingredient, minQty, maxQty}`. | **Last published ~6 years ago.** Do not adopt without forking. |
| **@mealprime/recipe-ingredient-parser** | A fork of an older Mediavine descendant. 3 stars, low activity. | Too small to trust. |
| **@magrinj/parse-ingredients** | Multi-language, handles ranges/Unicode fractions. | Worth a look if Mediavine's staleness matters; check the license + maintenance before adopting. |
| **zestful-data** (commercial) | Hosted API for ingredient parsing. | Not a fit — we want local-first. |

> **Recommendation on libraries:** `recipe-scrapers` (npm) as the primary
> happy-path extractor, `cheerio` as our escape-hatch HTML parser, and
> **write our own thin ingredient-line normalizer in ~150 lines** rather
> than depend on the stale Mediavine parser. We only need to extract
> quantity / unit / name for a single household — we don't need NLP-grade
> parsing, and owning the code means we can fix it when a family-favorite
> site breaks. Add a `zod` schema for the parsed Recipe shape so the fix-up
> screen always has typed values to render.

### HTTP fetching & image handling

- **HTTP client**: `undici` (built into modern Node, fast, supports
  timeouts/headers cleanly) or `got`. `node-fetch` is fine but adds a
  dep. Pick one and use it consistently.
- **Image processing**: `sharp` (libvips) is the de-facto standard.
  Read metadata, resize, re-encode to WebP/AVIF. Used by Next.js, Netlify
  image CDN, every Node image product.

---

## 3. Failure modes and what the review screen must therefore show

These are the *known* failure modes from the spec, the Camden walk-through,
the Hacker News thread, and the WDC 2024 corpus. The review screen must
make each one visible, because the user will hit all of them in a year
of family use.

| Failure | Frequency | What the screen must show |
| --- | --- | --- |
| No JSON-LD at all (older blog, JS-rendered SPA, paywalled page). | ~5–10% of family-useful URLs. | Big yellow banner: "No structured data found." Offer a "paste manually" path with our internal Recipe form pre-blank. |
| JSON-LD present but `@type` is wrong (e.g. `Article` with a recipe body, or a `@graph` where the `Recipe` is one of several entries). | Common on news sites that occasionally publish recipes. | "Found 1 recipe in 3 JSON-LD blocks." Link to the raw `<script type="application/ld+json">` source. |
| `image` is an `ImageObject` with `url`, or an array of 3 sized URLs, or a single string. | Always varying. | Render the chosen image. Show the dropdown of alternatives if it's an array, with the largest available selected by default. |
| `recipeIngredient` is a free-text list with embedded quantities ("1 cup sugar" vs `{@type: PropertyValue, value: 1, name: "egg"}`). | Universal. | Show every line verbatim. Run our normalizer and surface a per-line badge: ✓ "1 cup / sugar" (parsed), ⚠ "a pinch of salt" (no quantity detected). User can edit before save. |
| `recipeInstructions` is string / array-of-strings / array-of-HowToStep / array-of-HowToSection. | Universal. | Flatten to an ordered list of `{text, optional image?}` rows. If a step has a `name`, show it as a section header. If it has an image, render thumbnail. |
| `prepTime` / `cookTime` are ISO 8601 durations, or human strings, or absent, or inconsistent (prep + cook ≠ total). | Common. | Display each as a `number + unit` field. If `totalTime` is missing but `prep + cook` covers it, suggest a fill. Never silently coerce. |
| `recipeYield` is `"6"`, `"6 servings"`, or `{@type: QuantitativeValue, value: 6, unitText: "servings"}`. | Common. | Show as `count + unit` fields. |
| Author is `"Jane Smith"`, `{@type: Person, name: ...}`, or `{@type: Organization, name: ...}`. | Common. | Show the resolved name string. Don't try to differentiate Person/Org in the UI. |
| `nutrition` is a single `calories: "240 calories"` blob, a full `NutritionInformation` object, or absent. | Common. | If only `calories` is present, show a one-field form. If full, show the standard nutrition panel. |
| Aggregate rating present, with `reviewCount` that doesn't match `ratingCount`. | Common on review sites. | Show the rating + count, label "from source." |
| Page loads but is a 200 with a paywall or a "subscribe to read" placeholder. | Common on news-paper recipe sections. | Detect by absence of `Recipe` in JSON-LD + low body-text length. Show "looks paywalled" with a paste-manually path. |
| The page is JavaScript-rendered and our static fetch returns only a shell. | ~5% of sites, but includes some big ones (Tasty, NYT Cooking). | Detect by absence of any `application/ld+json` in the raw HTML but the URL looks like a recipe. Show a banner: "Needs JavaScript. Paste manually or try the import-by-share-link path (Tasty/NYT both expose a JSON-LD endpoint via their share URLs)." |
| Multiple recipes on one page (roundup, "best of" list). | Common. | Detect by `@graph` length > 1 with multiple `Recipe` types. List them, let user pick which to import. |
| `recipeIngredient` is a single newline-joined string. | Rare but happens. | Split on `\n` and show the resulting list. |

**Common UI affordances the review screen needs (shared with the OCR
review screen per #5 and the mobile add flow per #7):**

- A "confidence" badge per field: ✓ extracted directly, ⚠ inferred, ✗ missing.
- A "view source" link that opens the raw `<script type="application/ld+json">`
  block in a side panel for debugging.
- A "re-parse" button if the user wants to re-run after editing the source URL
  (e.g. they paste the share-URL instead of the canonical one).
- An "edit then save" workflow that never blocks on a missing field — the
  user can save a half-filled recipe and come back.

---

## 4. Image handling: hotlink vs download

**Default: download into our photo volume.** Reasoning:

- Family use is a small absolute number of fetches — bandwidth cost to the
  source is negligible on a per-recipe basis (1–3 MB per image, a few times
  a week).
- The source blog may rot: the page disappears, the image gets moved, the
  CDN goes down, the domain expires. A home cookbook needs to outlive any
  one of those events. A recipe you can't see the photo of is half a recipe.
- We control rendering performance and can resize to a sensible default
  (1200px wide WebP) with `sharp` at import time.
- We can generate a content hash and dedupe identical images across many
  recipes from the same blog.
- The original source URL is still kept as `source_image_url` on the
  Recipe row, so attribution is preserved and the user can re-fetch if
  they ever want a higher-resolution version.

**Hotlink is only acceptable as a fallback** when the source has a
hotlink-protection policy (referer check, signed URL, or the image is
behind a CDN that 403s on `Referer: null`). In that case: store the
remote URL, render through a server-side proxy that sets a UA, and
flag it in the review screen as "remote, may break."

**Image pipeline (concrete):**

1. After successful parse, take the resolved image URL(s).
2. Fetch with our normal UA. If 403/401, retry without `Referer`. If
   still 403, mark as remote-only.
3. Stream response through `sharp`:
   - read metadata to get real dimensions
   - rotate according to EXIF
   - resize to 1200px max on the long edge
   - re-encode to WebP (q=80) and AVIF (q=60) for serving flexibility
4. Write to `photos/{yyyy}/{mm}/{contenthash}.webp` (and `.avif`).
5. Store `{photo_path, content_hash, width, height, bytes, source_url,
   downloaded_at}` in the `photos` table.
6. Render the same hash at multiple sizes via `sharp().resize()` for
   thumbnails, list views, and detail pages.

This keeps the photo volume bounded (~1200px WebP is ~150 KB even for
a detailed shot) and trivially backup-able with the same homesync
mechanism as everything else.

---

## 5. Politeness / ToS posture

For a single-household home tool, the legal and ethical bar is much
lower than a public scraper, but the practical hygiene is the same:

- **Set a descriptive `User-Agent`** like
  `recipedb/0.1 (+https://github.com/kevbob1/recipedb; single-household
  home use; contact=kevbob1)`. This makes the request identifiable if
  a site owner wants to ask us to stop, and it differentiates us from
  bulk scrapers that masquerade as Chrome.
- **Respect `robots.txt`.** Use `robots-parser` (npm) at the URL's
  host before fetching. If the URL (or path) is disallowed, stop and
  show a banner. Even if a site does not enforce, the wire-protocol
  signal is the right thing to do.
- **Honor `Crawl-delay` if present.** Cap at 1 request per second per
  host. We never batch — recipes are added one at a time, by hand, by
  a human.
- **Set a real `Accept` header** and a `From`-style contact. Don't
  pretend to be a browser.
- **Single in-flight request per host.** No concurrency. We are a
  human-driven tool, not a crawler.
- **Don't bypass paywalls, logins, or anti-bot measures.** If the
  page is gated, the review screen falls back to "paste manually."
- **Keep `source_url` and `source_image_url` on every imported
  Recipe.** This is attribution; it's also the practical answer to
  any site that asks us to remove their content. We have a
  one-click "remove source link" but never delete the local copy.
- **No redistribution.** Recipedb never publishes imported recipes
  outside the home net. This is the position that takes us out of
  the "scraping for redistribution" case legally and ethically.

The Wikipedia [Robots.txt][8] and Google's [intro to structured data][9]
are the right primary references for the wire-protocol expectations; the
InMotionHosting and Crawlex write-ups are useful for the "why this
matters at any scale" framing.

[8]: https://en.wikipedia.org/wiki/Robots.txt
[9]: https://developers.google.com/search/docs/appearance/structured-data/intro-structured-data

---

## 6. End-to-end pipeline (proposed shape)

```
paste URL
  └─> validate URL, denylist obvious non-recipe hosts
      └─> fetch robots.txt (cached per host)
          └─> GET URL with our UA (timeout 10s, max 5 MB)
              └─> cheerio.parse(html)
                  ├─> extract all <script type="application/ld+json">
                  │     └─> JSON.parse each (tolerant: try/catch, log, skip)
                  │         └─> find @type === "Recipe" (or @graph[*].@type === "Recipe")
                  │             └─> normalize: array vs object, image polyglot, instructions polyglot
                  ├─> if no JSON-LD Recipe: extract microdata via itemtype="https://schema.org/Recipe"
                  │     └─> cheerio.find('[itemtype$="schema.org/Recipe"]')
                  ├─> if still nothing: try recipe-scrapers (npm) for known sites
                  └─> if still nothing: return "no recipe found" + paste-manually
                  └─> normalize to internal Recipe shape (zod-validated)
                      └─> fetch each image URL (with retries, UA, no Referer)
                          └─> sharp → 1200px WebP + AVIF → write to photo volume
                              └─> store Photo row
                      └─> persist Recipe + Source + Photos
                          └─> open editable fix-up review screen (shared with #5, #7)
```

The review screen is the human's job. The pipeline's job is to give
them a Recipe row that is *probably* right, with every field labeled
"extracted" / "inferred" / "missing," and a one-click "view source" for
the times it's wrong.

---

## 7. RECOMMENDATION

For the MVP, in priority order:

1. **Primary parser: `recipe-scrapers` (npm, TypeScript, v3.2.0+).**
   742+ sites supported, actively maintained, schema-aware, gives us
   cheerio + zod integration for free. Add it as a hard dep; pin to
   a minor.
2. **Escape hatch: a 100-line hand-rolled JSON-LD-extract-plus-normalize
   module using `cheerio` directly.** This is what we fall back to
   when recipe-scrapers doesn't recognize a URL. The Camden snippet
   is the right starting point; lift it and harden it.
3. **Microdata fallback: yes, but only if the JSON-LD path returns
   nothing.** Use cheerio's `[itemtype$="schema.org/Recipe"]` selector
   + the Wikimedia html-metadata microdata path. Do not add
   `jsonld` (digitalbazaar) — full JSON-LD processing is overkill.
4. **Ingredient normalization: write our own.** A 100–200 line module
   that splits `recipeIngredient` strings into
   `{quantity, unit, ingredient, group}`. The Mediavine parser is too
   stale; the mealprime fork is too small. For one household, "good
   enough 80% of the time" beats "occasionally wrong but NLP-flavored."
   Iterate as we hit failures on real family recipes.
5. **Image handling: download to the photo volume by default.** Resize
   with `sharp` to 1200px WebP + AVIF. Store the original source URL
   for attribution. Hotlink only as a flagged fallback.
6. **Politeness: descriptive UA + `robots-parser` + 1 req/sec/host
   cap + single in-flight per host + no bypass of paywalls or
   anti-bot measures.** This is the right hygiene at any scale and
   costs us nothing at home-tool scale.
7. **Review screen (shared with #5 and #7):** per-field confidence
   badges, "view source" side panel, "re-parse" button, never block
   on a missing field, save partial recipes. This is the screen that
   the OCR pipeline and the URL pipeline both feed into.
8. **Open dependencies we want to keep on the radar:**
   - `cheerio` — pinning candidate
   - `recipe-scrapers` (npm) — keep an eye on whether the site list
     covers our family's favorites; if it doesn't, contribute a site
     back upstream rather than forking
   - `zod` — for validating the internal Recipe shape
   - `sharp` — image pipeline
   - `robots-parser` — politeness
   - `undici` (built-in to modern Node) — HTTP client
9. **Dependencies to explicitly *avoid* for the MVP:**
   - `jsonld` (digitalbazaar) — full JSON-LD processing is overkill
   - `@mediavine/recipe-ingredient-parser` — 6 years stale
   - `@mealprime/recipe-ingredient-parser` — too small
   - Any commercial ingredient API — we are local-first
   - Headless-browser fetchers (Playwright/Puppeteer) — too heavy and
     the review-screen fallback ("paste manually") is the right
     behavior for the ~5% of JS-rendered sites
10. **Out of scope for #4 (and the right place to revisit when #1 is
    updated):** the specific stack choice (Node framework, SQLite
    driver) is #2's call. This ticket's job is to fix the *contract*
    between the URL pipeline and the rest of the system: a normalized
    Recipe shape, a typed review screen, an image pipeline, and a
    politeness posture.

The shape of the Recipe record we commit to at the end of this
pipeline is the input to #3 (the domain-model grilling). This document
does not pre-empt that ticket; the fields here are the
**schema.org/Recipe** field set, which is wider than our internal
Recipe will likely be. The pipeline normalizes *into* the internal
shape; the review screen is where the family-relevant fields get
edited before save.
