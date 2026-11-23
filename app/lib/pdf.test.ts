/**
 * pdf.ts tests — rasterization wiring with pdf.js mocked out.
 *
 * The real pdfjs worker is never loaded here: getDocument/getPage/render are
 * faked, and the DOM is stubbed with a minimal canvas so `ingestPdfBlob`'s
 * contract (page order, 300 DPI scale, cap refusal, error surfaces) is tested
 * without a browser or WASM.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("pdfjs-dist/build/pdf.worker.mjs?url", () => ({
  default: "/build/_assets/pdf.worker.mjs",
}));

const pdfjs = vi.hoisted(() => ({
  GlobalWorkerOptions: { workerSrc: "" },
  getDocument: vi.fn(),
}));

vi.mock("pdfjs-dist", () => pdfjs);

interface FakeCanvas {
  width: number;
  height: number;
  getContext: () => unknown;
  toBlob: (cb: (blob: Blob | null) => void, type?: string) => void;
}

let createdCanvases: FakeCanvas[] = [];
let blobQueue: Array<Blob | null> = [];

function stubDocument() {
  vi.stubGlobal("document", {
    createElement: (tag: string) => {
      if (tag !== "canvas") throw new Error(`unexpected element ${tag}`);
      const canvas: FakeCanvas = {
        width: 0,
        height: 0,
        getContext: () => ({ drawImage: vi.fn() }),
        toBlob: (cb) => {
          cb(blobQueue.shift() ?? null);
        },
      };
      createdCanvases.push(canvas);
      return canvas;
    },
  });
}

// Letter-size page: 612x792pt. At the 300/72 render scale: 2550x3300 px.
function fakePage() {
  return {
    getViewport: ({ scale }: { scale: number }) => ({
      width: 612 * scale,
      height: 792 * scale,
    }),
    render: () => ({ promise: Promise.resolve() }),
  };
}

async function importIngest() {
  return (await import("./pdf")).ingestPdfBlob;
}

beforeEach(() => {
  createdCanvases = [];
  blobQueue = [];
  pdfjs.getDocument.mockReset();
  pdfjs.GlobalWorkerOptions.workerSrc = "";
  pdfjs.getDocument.mockReturnValue({
    promise: Promise.resolve({ numPages: 2, getPage: vi.fn(async () => fakePage()) }),
  });
  stubDocument();
});

describe("ingestPdfBlob", () => {
  it("renders every page at ~300 DPI and OCRs the rasters in page order", async () => {
    const ingestPdfBlob = await importIngest();
    const png1 = new Blob(["png-1"], { type: "image/png" });
    const png2 = new Blob(["png-2"], { type: "image/png" });
    blobQueue = [png1, png2];
    const recognized: Blob[] = [];

    const pages = await ingestPdfBlob(new Blob(["%PDF-1.4"]), async (blob) => {
      recognized.push(blob);
      return `text ${recognized.length}`;
    });

    expect(pdfjs.GlobalWorkerOptions.workerSrc).toBe(
      "/build/_assets/pdf.worker.mjs",
    );
    expect(createdCanvases.map((c) => [c.width, c.height])).toEqual([
      [2550, 3300],
      [2550, 3300],
    ]);
    expect(pages.map((page) => page.pageNo)).toEqual([1, 2]);
    expect(pages.map((page) => page.text)).toEqual(["text 1", "text 2"]);
    // The OCR'd raster is the retained blob, in page order.
    expect(pages.map((page) => page.blob)).toEqual([png1, png2]);
    expect(recognized).toEqual([png1, png2]);
  });

  it("refuses a PDF over the page cap before rendering anything", async () => {
    const ingestPdfBlob = await importIngest();
    pdfjs.getDocument.mockReturnValue({
      promise: Promise.resolve({ numPages: 6, getPage: vi.fn(async () => fakePage()) }),
    });

    await expect(
      ingestPdfBlob(new Blob(["%PDF-1.4"]), async () => "never"),
    ).rejects.toThrow(
      "That PDF has 6 pages — PDFs are limited to 5 pages. Split it and import the parts.",
    );
    expect(createdCanvases).toHaveLength(0);
  });

  it("throws a clear error when the canvas cannot encode a PNG", async () => {
    const ingestPdfBlob = await importIngest();
    blobQueue = [null];

    await expect(
      ingestPdfBlob(new Blob(["%PDF-1.4"]), async () => "text"),
    ).rejects.toThrow("Could not render page 1 as a PNG.");
  });

  it("throws a clear error when a 2d context is unavailable", async () => {
    const ingestPdfBlob = await importIngest();
    vi.stubGlobal("document", {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => null,
        toBlob: () => {},
      }),
    });

    await expect(
      ingestPdfBlob(new Blob(["%PDF-1.4"]), async () => "text"),
    ).rejects.toThrow("Could not start a canvas for page 1.");
  });
});
