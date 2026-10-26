/**
 * Import seam — server half.
 *
 * `importUrl` is the authoritative URL import: the scraper fetches and parses
 * the page into plain scraper data (./recipe-scrapers.server.ts), and the url
 * adapter of the unified Draft factory (./import.ts, ADR-0002) turns that into
 * a RecipeDraft. This module only wires the two together; it does not stamp
 * provenance — the adapter owns that.
 *
 * The scan and manual halves live in ./import.ts because the browser runs them
 * (photo OCR); everything is re-exported here so server callers have a single
 * entry point for "give me a RecipeDraft from this import".
 */
import { createDraft, type ImportedDraft } from "./import";
import { importFromUrl } from "./recipe-scrapers.server";

export { createDraft } from "./import";
export type {
  DraftInput,
  ImportedDraft,
  ManualDraftInput,
  ScanDraftInput,
  ScrapedRecipeData,
  UrlDraftInput,
} from "./import";

/**
 * Fetch and parse a recipe page into a draft. Throws ImportError (from
 * ./recipe-scrapers.server) when the page cannot be fetched or parsed; the
 * route maps that to a 400 and anything else to a 500.
 */
export async function importUrl(url: string): Promise<ImportedDraft> {
  const { url: canonicalUrl, data, imageFilename } = await importFromUrl(url);
  return {
    draft: createDraft({
      kind: "url",
      url: canonicalUrl,
      data,
      imageFilename,
    }),
    imageFilename,
  };
}
