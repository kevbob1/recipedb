/**
 * Scan limits — the one definition of the upload ceiling.
 *
 * This lives outside ./storage.server.ts (which owns enforcement and re-exports
 * it as part of its public surface) because the Add flow's browser-side
 * pre-check and the server-side validator must agree on one number, and the
 * browser cannot import the fs/DB stack that storage.server.ts pulls in.
 * Import this module, never a literal: a second copy of the ceiling is exactly
 * the drift this module exists to prevent.
 */

/** Upload ceiling for a scan capture (~15MB). */
export const MAX_SCAN_UPLOAD_BYTES = 15 * 1024 * 1024;

/** The same ceiling in whole megabytes, for user-facing messages. */
export const MAX_SCAN_UPLOAD_MB = MAX_SCAN_UPLOAD_BYTES / (1024 * 1024);

/** Hard cap on pages per scanned PDF (ADR-0004). */
export const MAX_PDF_PAGES = 5;

/**
 * The clear refusal for a PDF over the cap: non-null when `pageCount` exceeds
 * MAX_PDF_PAGES, else null. Shared by the bulk runner and the pdf.js
 * rasterizer so both refuse with the same words.
 */
export function pdfPageLimitMessage(pageCount: number): string | null {
  return pageCount > MAX_PDF_PAGES
    ? `That PDF has ${pageCount} pages — PDFs are limited to ${MAX_PDF_PAGES} pages. Split it and import the parts.`
    : null;
}
