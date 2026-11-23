/**
 * Client-side scanned-PDF rasterization — pdf.js in the browser (ADR-0004).
 *
 * A scanned PDF is a stack of page images with no text layer. Per the ADR the
 * rasterization happens CLIENT-side: each page is rendered to a PNG canvas at
 * ~300 DPI (the same resolution the OCR engine is tuned for — see
 * `user_defined_dpi` in ./ocr.ts) and run through the same browser OCR the
 * photo path uses. The server never opens the PDF; it only stores the
 * original bytes and the page rasters that come out of here.
 *
 * This module is loaded lazily (`await import("../lib/pdf")` from the Add
 * flow's bulk handler) so pdf.js and its worker never enter the SSR/server
 * graph: it is only needed when a PDF actually runs. It is recognition-free by
 * construction — the recognizer is injected — so tests never load tesseract.
 */
import { MAX_PDF_PAGES, pdfPageLimitMessage } from "./scan/limits";

/**
 * The pdf.js worker URL. `?url` makes Vite emit the worker as a build asset
 * and hand back its URL as a string; under Vitest it resolves to a plain
 * string path. Set on GlobalWorkerOptions before the first getDocument.
 */
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";

/** One rasterized page: its OCR text and the PNG to retain with the recipe. */
export interface PdfPage {
  /** 1-based page number within the PDF. */
  pageNo: number;
  /** Raw OCR text read from this page, verbatim. */
  text: string;
  /** The rendered page raster (PNG), uploaded and retained with the recipe. */
  blob: Blob;
}

/** OCR one rendered page raster. In the app: `recognizeText`. */
export type PdfPageRecognizer = (blob: Blob) => Promise<string>;

/**
 * Render scale that puts a PDF page at ~300 DPI: pdf.js viewports are
 * specified at 72 DPI per CSS pixel.
 */
const RENDER_SCALE = 300 / 72;

/** Load pdf.js and point its worker at the emitted asset. */
async function loadPdfJs() {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  return pdfjs;
}

/** Render a canvas region to a PNG blob, or null when it cannot be encoded. */
function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob(resolve, "image/png");
  });
}

/**
 * Rasterize + OCR one scanned PDF: one entry per page, in page order.
 *
 * Refuses over the ADR-0004 cap (MAX_PDF_PAGES) with the same words the bulk
 * runner uses. Throws for anything pdf.js cannot open or render; callers show
 * the message on that file's row. An empty PDF produces `[]` — the caller
 * reports "no pages to read".
 */
export async function ingestPdfBlob(
  blob: Blob,
  recognize: PdfPageRecognizer,
): Promise<PdfPage[]> {
  const pdfjs = await loadPdfJs();
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(await blob.arrayBuffer()),
  }).promise;

  const overCap = pdfPageLimitMessage(doc.numPages);
  if (overCap) throw new Error(overCap);

  const pages: PdfPage[] = [];
  for (let pageNo = 1; pageNo <= doc.numPages; pageNo += 1) {
    const page = await doc.getPage(pageNo);
    const viewport = page.getViewport({ scale: RENDER_SCALE });
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const context = canvas.getContext("2d");
    if (context === null) {
      throw new Error(`Could not start a canvas for page ${pageNo}.`);
    }
    await page.render({ canvasContext: context, viewport }).promise;

    const png = await canvasToPng(canvas);
    if (png === null) {
      throw new Error(`Could not render page ${pageNo} as a PNG.`);
    }
    pages.push({ pageNo, text: await recognize(png), blob: png });
  }
  return pages;
}
