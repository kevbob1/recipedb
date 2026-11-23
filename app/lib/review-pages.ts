/**
 * Per-page review helpers (ADR-0004): the review editor's page section edits
 * each page's OCR text beside its raster, and can rebuild the structured
 * fields from the edited page texts. Pure, client-safe logic — handlers are
 * built here so the route JSX stays a render-time-only surface, and the rules
 * are testable without a browser.
 */
import type { DraftPage, RecipeDraft } from "./draft";
import { createDraft } from "./import";

/** The whole-document text the structured fields parse from. */
export function joinPageText(pages: readonly DraftPage[]): string {
  return pages.map((page) => page.text).join("\n\n");
}

/**
 * One page's text edited in review. Provenance follows the pages: the
 * recipe's rawOcrText is the concatenated page text, so the raw drawer and
 * the per-page editor can never disagree.
 */
export function withPageText(
  draft: RecipeDraft,
  pageNo: number,
  text: string,
): RecipeDraft {
  const pages = (draft.pages ?? []).map((page) =>
    page.pageNo === pageNo ? { ...page, text } : page,
  );
  return { ...draft, pages, rawOcrText: joinPageText(pages) };
}

/**
 * Rebuild the structured fields from the (edited) page texts, exactly like a
 * fresh OCR parse. Pages and retained-capture provenance are kept. The
 * re-parse is EXPLICIT — page edits never silently rewrite the fields a
 * person may have hand-corrected already.
 */
export function reparseFromPages(draft: RecipeDraft): RecipeDraft {
  const pages = draft.pages ?? [];
  const reparsed = createDraft({
    kind: "scan",
    text: joinPageText(pages),
    imageFilename: draft.imageFilename,
    pages,
  });
  return { ...reparsed, pages };
}

/** Build the callback that stores an edited page's text in the draft. */
export function pageTextSetter(
  draft: RecipeDraft,
  setDraft: (d: RecipeDraft) => void,
): (pageNo: number, text: string) => void {
  return (pageNo, text) => setDraft(withPageText(draft, pageNo, text));
}

/** Build the callback that explicitly reparses the edited page texts. */
export function reparseSetter(
  draft: RecipeDraft,
  setDraft: (d: RecipeDraft) => void,
): () => void {
  return () => setDraft(reparseFromPages(draft));
}

/** Bind a page number to the structural event shape used by a textarea. */
export function bindPageText(
  onPageText: (pageNo: number, text: string) => void,
  pageNo: number,
): (event: { target: { value: string } }) => void {
  return (event) => onPageText(pageNo, event.target.value);
}
