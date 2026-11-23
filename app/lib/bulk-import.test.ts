import { describe, expect, it, vi } from "vitest";
import {
  MAX_BULK_FILES,
  appBulkSeams,
  bulkProgress,
  fallbackTitleFromName,
  formatBulkHeadline,
  formatFileSize,
  planBulkBatch,
  runBulkImport,
  summarizeBulkBatch,
  toBulkInputs,
  updateBulkFile,
  type BulkFileInput,
  type BulkFileState,
  type BulkPdfPage,
} from "./bulk-import";
import { MAX_SCAN_UPLOAD_BYTES } from "./scan/limits";
import type { RecipeDraft } from "./draft";

vi.mock("./pdf", () => ({
  ingestPdfBlob: async (
    file: File,
    recognize: (blob: Blob) => Promise<string>,
  ) => [
    {
      pageNo: 1,
      text: await recognize(new Blob(["raster"])),
      blob: new Blob(["raster"]),
    },
  ],
}));

function input(
  name: string,
  overrides: Partial<BulkFileInput> = {},
): BulkFileInput {
  return { name, size: 1024, type: "image/jpeg", ...overrides };
}

const PDF_HEAD = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF-

function pdfPage(pageNo: number, text: string): BulkPdfPage {
  return { pageNo, text, blob: new Blob([`page-${pageNo}`], { type: "image/png" }) };
}

describe("planBulkBatch", () => {
  it("queues every valid image in pick order with stable ids", () => {
    const files = [input("a.jpg"), input("b.png", { type: "image/png" })];
    const plan = planBulkBatch(files);

    expect(plan.states).toEqual([
      { id: "bulk-0", name: "a.jpg", status: "queued" },
      { id: "bulk-1", name: "b.png", status: "queued" },
    ]);
    // The caller maps id -> file to run OCR and upload the original bytes;
    // kind is decided at plan time and never re-guessed at run.
    expect(plan.accepted).toEqual([
      { id: "bulk-0", file: files[0], kind: "image" },
      { id: "bulk-1", file: files[1], kind: "image" },
    ]);
    expect(plan.rejected).toEqual([]);
  });

  it("rejects non-image files but keeps the rest of the batch", () => {
    const plan = planBulkBatch([
      input("notes.txt", { type: "text/plain" }),
      input("a.jpg"),
    ]);

    expect(plan.states.map((state) => state.name)).toEqual(["a.jpg"]);
    expect(plan.rejected).toEqual([
      {
        name: "notes.txt",
        code: "not-image",
        message: "notes.txt isn't an image or PDF file.",
      },
    ]);
  });

  it("accepts a scanned PDF by its mime type", () => {
    const plan = planBulkBatch([input("scan.pdf", { type: "application/pdf" })]);
    expect(plan.accepted).toEqual([
      { id: "bulk-0", file: plan.accepted[0].file, kind: "pdf" },
    ]);
    expect(plan.rejected).toEqual([]);
  });

  it("sniffs an untyped pick's head bytes for the PDF magic", () => {
    const untypedPdf = input("untyped.pdf", { type: "", head: PDF_HEAD });
    const untypedImage = input("IMG_0042", { type: "" });

    const plan = planBulkBatch([untypedPdf, untypedImage]);
    expect(plan.accepted.map((file) => file.kind)).toEqual(["pdf", "image"]);
    expect(plan.rejected).toEqual([]);
  });

  it("trusts a pick when the browser reports no mime type", () => {
    const plan = planBulkBatch([input("IMG_0042.HEIC", { type: "" })]);
    expect(plan.states).toHaveLength(1);
    expect(plan.rejected).toEqual([]);
  });

  it("rejects an image over the scan upload ceiling", () => {
    const plan = planBulkBatch([
      input("huge.jpg", { size: MAX_SCAN_UPLOAD_BYTES + 1 }),
      input("fits.jpg", { size: MAX_SCAN_UPLOAD_BYTES }),
    ]);

    expect(plan.states.map((state) => state.name)).toEqual(["fits.jpg"]);
    expect(plan.rejected[0].code).toBe("too-large");
    expect(plan.rejected[0].message).toContain("15MB");
  });

  it("caps the batch and reports the extras as over-limit", () => {
    const files = Array.from({ length: MAX_BULK_FILES + 3 }, (_, i) =>
      input(`photo-${i}.jpg`),
    );
    const plan = planBulkBatch(files);

    expect(plan.states).toHaveLength(MAX_BULK_FILES);
    expect(plan.accepted).toHaveLength(MAX_BULK_FILES);
    expect(plan.rejected.map((file) => file.code)).toEqual([
      "over-limit",
      "over-limit",
      "over-limit",
    ]);
    expect(plan.rejected[0].message).toContain(String(MAX_BULK_FILES));
  });

  it("labels an unnamed pick instead of leaving a blank row", () => {
    const plan = planBulkBatch([input("  ")]);
    expect(plan.states[0].name).toBe("Unnamed image");
  });
});

describe("updateBulkFile", () => {
  const states: BulkFileState[] = [
    { id: "bulk-0", name: "a.jpg", status: "queued" },
    { id: "bulk-1", name: "b.jpg", status: "queued" },
  ];

  it("replaces only the matching file, in place", () => {
    const next = updateBulkFile(states, "bulk-1", { status: "ocr" });

    expect(next.map((state) => state.id)).toEqual(["bulk-0", "bulk-1"]);
    expect(next[0]).toBe(states[0]);
    expect(next[1].status).toBe("ocr");
    // The input is never mutated: React state compares by identity.
    expect(states[1].status).toBe("queued");
  });

  it("keeps the recipe id only while done and the error only while failed", () => {
    const done = updateBulkFile(states, "bulk-0", {
      status: "done",
      recipeId: 42,
      error: "stale",
    });
    expect(done[0]).toEqual({
      id: "bulk-0",
      name: "a.jpg",
      status: "done",
      recipeId: 42,
    });

    const failed = updateBulkFile(done, "bulk-0", {
      status: "error",
      error: "OCR failed.",
    });
    expect(failed[0]).toEqual({
      id: "bulk-0",
      name: "a.jpg",
      status: "error",
      error: "OCR failed.",
    });
  });

  it("ignores an id that isn't in the batch", () => {
    expect(updateBulkFile(states, "nope", { status: "ocr" })).toEqual(states);
  });
});

describe("bulkProgress", () => {
  it("counts only finished files", () => {
    const states: BulkFileState[] = [
      { id: "bulk-0", name: "a.jpg", status: "queued" },
      { id: "bulk-1", name: "b.jpg", status: "ocr" },
      { id: "bulk-2", name: "c.jpg", status: "saving" },
      { id: "bulk-3", name: "d.jpg", status: "done", recipeId: 1 },
      { id: "bulk-4", name: "e.jpg", status: "error", error: "boom" },
    ];

    expect(bulkProgress(states)).toEqual({ total: 5, finished: 2 });
  });
});

describe("summarizeBulkBatch", () => {
  it("reports saved recipes with ids and every failure by name", () => {
    const states: BulkFileState[] = [
      { id: "bulk-0", name: "a.jpg", status: "done", recipeId: 7 },
      { id: "bulk-1", name: "b.jpg", status: "error", error: "OCR failed." },
    ];
    const rejected = [
      {
        name: "notes.pdf",
        code: "not-image" as const,
        message: "notes.pdf isn't an image file.",
      },
    ];

    const summary = summarizeBulkBatch(states, rejected);

    expect(summary).toEqual({
      total: 3,
      saved: 1,
      failed: 2,
      savedRecipes: [{ name: "a.jpg", recipeId: 7 }],
      failures: [
        { name: "notes.pdf", error: "notes.pdf isn't an image file." },
        { name: "b.jpg", error: "OCR failed." },
      ],
    });
    expect(formatBulkHeadline(summary)).toBe("1 saved, 2 failed");
  });

  it("falls back to a generic failure message", () => {
    const summary = summarizeBulkBatch([
      { id: "bulk-0", name: "a.jpg", status: "error" },
    ]);
    expect(summary.failures).toEqual([
      { name: "a.jpg", error: "Import failed." },
    ]);
    expect(formatBulkHeadline(summary)).toBe("0 saved, 1 failed");
  });
});

describe("formatFileSize", () => {
  it("scales bytes to KB and MB", () => {
    expect(formatFileSize(900)).toBe("900 B");
    expect(formatFileSize(2048)).toBe("2 KB");
    expect(formatFileSize(1.5 * 1024 * 1024)).toBe("1.5 MB");
  });
});

describe("fallbackTitleFromName", () => {  it("turns a filename stem into a readable title", () => {
    expect(fallbackTitleFromName("grandma_apple-pie.jpg")).toBe(
      "grandma apple pie",
    );
    expect(fallbackTitleFromName("/tmp/batch/IMG_0042.HEIC")).toBe("IMG 0042");
    expect(fallbackTitleFromName("scan.tar.gz")).toBe("scan.tar");
  });

  it("never returns an empty title", () => {
    expect(fallbackTitleFromName(".jpg")).toBe("Untitled recipe");
    expect(fallbackTitleFromName("")).toBe("Untitled recipe");
  });
});

describe("runBulkImport", () => {
  const files = [input("one.jpg"), input("two.jpg"), input("three.jpg")];

  function makePlan() {
    return planBulkBatch(files);
  }

  it("recognizes and saves sequentially, emitting every transition", async () => {
    const plan = makePlan();
    const events: string[] = [];
    const texts = ["Chocolate cake", "Sourdough bread", "Tomato soup"];
    let nextId = 100;

    const result = await runBulkImport({
      plan,
      recognize: async (file) => {
        events.push(`ocr:${file.name}`);
        return texts[files.indexOf(file)];
      },
      save: async (draft) => {
        events.push(`save:${draft.title}`);
        return nextId++;
      },
      onChange: (states) =>
        events.push(
          states.map((state) => `${state.name}:${state.status}`).join("|"),
        ),
    });

    // Work interleaves with state updates: no file's save starts before the
    // previous file finishes.
    expect(events.filter((event) => !event.includes("|"))).toEqual([
      "ocr:one.jpg",
      "save:Chocolate cake",
      "ocr:two.jpg",
      "save:Sourdough bread",
      "ocr:three.jpg",
      "save:Tomato soup",
    ]);
    expect(result.states.map((state) => state.status)).toEqual([
      "done",
      "done",
      "done",
    ]);
    expect(result.states.map((state) => state.recipeId)).toEqual([
      100, 101, 102,
    ]);
    expect(result.summary).toEqual({
      total: 3,
      saved: 3,
      failed: 0,
      savedRecipes: [
        { name: "one.jpg", recipeId: 100 },
        { name: "two.jpg", recipeId: 101 },
        { name: "three.jpg", recipeId: 102 },
      ],
      failures: [],
    });
  });

  it("records a failure and keeps going with the rest of the batch", async () => {
    const plan = makePlan();
    const saved: string[] = [];

    const result = await runBulkImport({
      plan,
      recognize: async (file) => {
        if (file.name === "two.jpg") throw new Error("OCR engine exploded");
        return `Recipe ${file.name}`;
      },
      save: async (draft) => {
        saved.push(draft.title);
        return saved.length;
      },
    });

    expect(saved).toEqual(["Recipe one.jpg", "Recipe three.jpg"]);
    expect(result.states[1]).toEqual({
      id: "bulk-1",
      name: "two.jpg",
      status: "error",
      error: "OCR engine exploded",
    });
    expect(result.summary.saved).toBe(2);
    expect(result.summary.failed).toBe(1);
    expect(result.summary.failures).toEqual([
      { name: "two.jpg", error: "OCR engine exploded" },
    ]);
  });

  it("does not save a draft when OCR failed", async () => {
    const plan = planBulkBatch([input("broken.jpg")]);
    let saveCalls = 0;

    const result = await runBulkImport({
      plan,
      recognize: async () => {
        throw new Error("no text");
      },
      save: async () => {
        saveCalls += 1;
        return 1;
      },
    });

    expect(saveCalls).toBe(0);
    expect(result.states[0].status).toBe("error");
  });

  it("treats a save failure as that file's failure", async () => {
    const plan = planBulkBatch([input("a.jpg"), input("b.jpg")]);

    const result = await runBulkImport({
      plan,
      recognize: async (file) => `Recipe ${file.name}`,
      save: async (_draft, file) => {
        if (file.name === "a.jpg") throw new Error("Couldn't save.");
        return 9;
      },
    });

    expect(result.states.map((state) => state.status)).toEqual([
      "error",
      "done",
    ]);
    expect(result.summary.failures).toEqual([
      { name: "a.jpg", error: "Couldn't save." },
    ]);
  });

  it("keeps a scan draft with a filename title when OCR finds nothing", async () => {
    const plan = planBulkBatch([input("family_lasagna.png")]);
    let captured: {
      title: string;
      sourceType: string;
      rawOcrText: string | null;
    } | null = null;

    const result = await runBulkImport({
      plan,
      recognize: async () => "",
      save: async (draft) => {
        captured = {
          title: draft.title,
          sourceType: draft.sourceType,
          rawOcrText: draft.rawOcrText,
        };
        return 3;
      },
    });

    expect(captured).toEqual({
      title: "family lasagna",
      sourceType: "scan",
      rawOcrText: "",
    });
    expect(result.states[0].status).toBe("done");
  });

  it("keeps OCR'd titles and scan provenance untouched", async () => {
    const plan = planBulkBatch([input("scan.jpg")]);
    let title = "";
    let confidence: string | null = "";

    await runBulkImport({
      plan,
      recognize: async () => "Lemon drizzle cake\n2 eggs",
      save: async (draft) => {
        title = draft.title;
        confidence = draft.titleConfidence;
        return 5;
      },
    });

    expect(title).toBe("Lemon drizzle cake");
    expect(confidence).toBe("warn");
  });

  it("reports up-front rejections in the summary without running them", async () => {
    const plan = planBulkBatch([
      input("ok.jpg"),
      input("bad.txt", { type: "text/plain" }),
    ]);
    const recognized: string[] = [];

    const result = await runBulkImport({
      plan,
      recognize: async (file) => {
        recognized.push(file.name);
        return "Something";
      },
      save: async () => 1,
    });

    expect(recognized).toEqual(["ok.jpg"]);
    expect(result.summary).toEqual({
      total: 2,
      saved: 1,
      failed: 1,
      savedRecipes: [{ name: "ok.jpg", recipeId: 1 }],
      failures: [{ name: "bad.txt", error: "bad.txt isn't an image or PDF file." }],
    });
  });

  it("does nothing for an empty plan", async () => {
    const result = await runBulkImport({
      plan: planBulkBatch([]),
      recognize: async () => "never",
      save: async () => 1,
    });

    expect(result.states).toEqual([]);
    expect(result.summary.saved).toBe(0);
  });

  it("reports a non-Error rejection with a generic message", async () => {
    const plan = planBulkBatch([input("a.jpg")]);
    const result = await runBulkImport({
      plan,
      recognize: async () => {
        throw "nope";
      },
      save: async () => 1,
    });

    expect(result.states[0].error).toBe("Import failed.");
  });
});

describe("runBulkImport PDFs (ADR-0004)", () => {
  function pdfPlan(name = "scan.pdf"): ReturnType<typeof planBulkBatch> {
    return planBulkBatch([input(name, { type: "application/pdf" })]);
  }

  it("turns one PDF into ONE draft with per-page text and a pdf upload", async () => {
    const plan = pdfPlan();
    let savedDraft: RecipeDraft | null = null;
    let savedUpload: unknown = null;
    let savedFile: unknown = null;

    const result = await runBulkImport({
      plan,
      recognize: async () => "never",
      ingestPdf: async () => [
        pdfPage(1, "Grandma's pie\n2 cups flour"),
        pdfPage(2, "Mix and bake"),
      ],
      save: async (draft, file, upload) => {
        savedDraft = draft;
        savedFile = file;
        savedUpload = upload;
        return 1;
      },
    });

    expect(result.states[0]).toMatchObject({ name: "scan.pdf", status: "done", recipeId: 1 });
    expect(savedDraft).toMatchObject({
      sourceType: "scan",
      rawOcrText: "Grandma's pie\n2 cups flour\n\nMix and bake",
      pages: [
        { pageNo: 1, text: "Grandma's pie\n2 cups flour" },
        { pageNo: 2, text: "Mix and bake" },
      ],
    });
    expect(savedUpload).toMatchObject({ kind: "pdf" });
    expect(
      (savedUpload as { pages: BulkPdfPage[] }).pages.map((p) => p.pageNo),
    ).toEqual([1, 2]);
    expect(savedFile).toMatchObject({ name: "scan.pdf" });
  });

  it("refuses a PDF over the 5-page cap", async () => {
    const plan = pdfPlan();
    let saveCalls = 0;

    const result = await runBulkImport({
      plan,
      recognize: async () => "never",
      ingestPdf: async () =>
        Array.from({ length: 6 }, (_, i) => pdfPage(i + 1, `page ${i + 1}`)),
      save: async () => {
        saveCalls += 1;
        return 1;
      },
    });

    expect(result.states[0]).toMatchObject({
      status: "error",
      error: "That PDF has 6 pages — PDFs are limited to 5 pages. Split it and import the parts.",
    });
    expect(saveCalls).toBe(0);
  });

  it("refuses a PDF with no readable pages", async () => {
    const plan = pdfPlan();

    const result = await runBulkImport({
      plan,
      recognize: async () => "never",
      ingestPdf: async () => [],
      save: async () => 1,
    });

    expect(result.states[0]).toMatchObject({
      status: "error",
      error: "That PDF has no pages to read.",
    });
  });

  it("reports a clear failure when no PDF seam is wired", async () => {
    const plan = pdfPlan();

    const result = await runBulkImport({
      plan,
      recognize: async () => "never",
      save: async () => 1,
    });

    expect(result.states[0]).toMatchObject({
      status: "error",
      error: "This importer can't read PDFs — pick images instead.",
    });
  });
});

describe("toBulkInputs", () => {
  it("sniffs head bytes only for untyped picks", async () => {
    const typed = new File([PDF_HEAD], "scan.pdf", { type: "application/pdf" });
    const untyped = new File([PDF_HEAD], "IMG_0042", { type: "" });

    const inputs = await toBulkInputs([typed, untyped]);

    expect(inputs).toHaveLength(2);
    expect(inputs[0]).toMatchObject({ name: "scan.pdf", type: "application/pdf" });
    expect(inputs[0].head).toBeUndefined();
    expect(inputs[1].head).toEqual(PDF_HEAD);
  });
});

describe("appBulkSeams", () => {
  it("maps an image upload to the plain save call", async () => {
    const file = new File(["jpeg-bytes"], "a.jpg", { type: "image/jpeg" });
    const save = vi.fn(async () => 7);
    const seams = appBulkSeams(vi.fn(async () => "text"), save);

    await seams.save({} as RecipeDraft, { file } as never, { kind: "image" });
    expect(save).toHaveBeenCalledWith(expect.anything(), file);
  });

  it("maps a pdf upload to page rasters plus the original PDF", async () => {
    const file = new File(["%PDF-1.4"], "scan.pdf", { type: "application/pdf" });
    const page = pdfPage(1, "text");
    const save = vi.fn(async () => 7);
    const seams = appBulkSeams(vi.fn(async () => "text"), save);

    await seams.save({} as RecipeDraft, { file } as never, {
      kind: "pdf",
      pages: [page],
    });
    expect(save).toHaveBeenCalledWith(expect.anything(), null, {
      pageBlobs: [page.blob],
      pdfBlob: file,
    });
  });

  it("routes PDF ingestion through the lazy pdf seam and the same OCR", async () => {
    const recognize = vi.fn(async () => "page text");
    const seams = appBulkSeams(
      recognize,
      vi.fn(async () => 7),
    );
    const file = new File(["%PDF-1.4"], "scan.pdf", { type: "application/pdf" });

    const pages = await seams.ingestPdf?.({ file } as never);
    expect(pages).toEqual([
      { pageNo: 1, text: "page text", blob: expect.any(Blob) },
    ]);
    // The injected recognizer receives the rendered page raster, not the PDF.
    expect(recognize).toHaveBeenCalledWith(expect.any(Blob));
  });
});
