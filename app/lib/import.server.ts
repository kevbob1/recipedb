/**
 * Import seam — server half.
 *
 * `importUrl` is the authoritative URL import: it fetches and parses the page
 * (recipe-scrapers / JSON-LD) and stamps the draft's provenance, so the
 * endpoint that exposes it (app/routes/api.import-url.ts) only deals with HTTP
 * and the browser never learns the transport.
 *
 * The text -> draft half of the seam lives in ./import.ts because the browser
 * runs it for photo OCR; it is re-exported here so server callers have a single
 * entry point for "give me a RecipeDraft from this import".
 */
import type { ImportedDraft } from "./import";
import { importFromUrl } from "./recipe-scrapers.server";

export { importScan } from "./import";
export type { ImportedDraft, ScanMeta } from "./import";

/**
 * Fetch and parse a recipe page into a draft. Throws ImportError (from
 * ./recipe-scrapers.server) when the page cannot be fetched or parsed; the
 * route maps that to a 400 and anything else to a 500.
 */
export async function importUrl(url: string): Promise<ImportedDraft> {
  const result = await importFromUrl(url);
  return {
    draft: { ...result.draft, sourceType: "url" },
    imageFilename: result.imageFilename,
  };
}
