/**
 * Import seam — turning an outside artifact (a URL, or raw OCR text) into a
 * RecipeDraft.
 *
 * Before this module the knowledge of *how* an import arrives lived in two
 * places: the Add route knew the POST /api/import-url body/response shape, and
 * both the Add route and the review editor re-stamped an OCR draft with
 * `sourceType: "scan"` and a `guessCategory(...)` call. Callers now ask the
 * seam for a draft and get one back; nothing outside cares which field carries
 * the guess or which HTTP verb the URL path uses.
 *
 * This half is client-safe on purpose: the Add flow recognizes photos in the
 * browser, so `importScan` must ship to the client. The server half (fetching
 * and parsing the page) is ./import.server.ts.
 */
import type { RecipeDraft } from "./draft";
import { guessCategory, ocrTextToDraft } from "./ocr";

/** A draft imported from a URL, plus the capture the server retained (if any). */
export interface ImportedDraft {
  draft: RecipeDraft;
  imageFilename: string | null;
}

/** Import failed at the seam. `message` is safe to show to the person. */
export class ImportSeamError extends Error {
  constructor(
    message: string,
    public code: string = "import-failed",
  ) {
    super(message);
    this.name = "ImportSeamError";
  }
}

/** Context an OCR pass carries into the draft it produces. */
export interface ScanMeta {
  /**
   * Retained capture this text came from (#28). Omitted -> the draft keeps the
   * blank default; pass `null` explicitly to clear it.
   */
  imageFilename?: string | null;
}

/**
 * Raw OCR text -> RecipeDraft, with the scan provenance stamped in one place:
 * `sourceType: "scan"`, a best-effort category guess from the title/text, and
 * the retained capture path when there is one.
 */
export function importScan(text: string, meta: ScanMeta = {}): RecipeDraft {
  const draft = ocrTextToDraft(text);
  draft.sourceType = "scan";
  draft.category = guessCategory(draft.title || text);
  if (meta.imageFilename !== undefined) {
    draft.imageFilename = meta.imageFilename;
  }
  return draft;
}

/**
 * Ask the server to fetch and parse a recipe page. Hides the endpoint's body
 * shape and turns both transport and application failures into one error with
 * a displayable message.
 */
export async function requestUrlImport(url: string): Promise<ImportedDraft> {
  const res = await fetch("/api/import-url", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url }),
  });
  const json = (await res.json()) as
    | ImportedDraft
    | { error: string; message?: string };
  if (!res.ok || "error" in json) {
    const message =
      "message" in json && json.message
        ? json.message
        : "Couldn't import that URL.";
    throw new ImportSeamError(
      message,
      "error" in json ? json.error : "import-failed",
    );
  }
  return { draft: json.draft, imageFilename: json.imageFilename };
}
