/**
 * Per-page draft seam (ADR-0004, phases 1–2): RecipeDraft.pages round-trips
 * through the recipe_pages table. Confirms:
 *   - a multi-page draft saves one recipe_pages row per page and loads back
 *     with identical pages (save -> loadDraft is a fixed point)
 *   - a draft without pages behaves exactly as before — no rows, no pages on
 *     the loaded draft — so legacy recipes stay untouched
 *   - prepareDraft validates page identity (positive, unique pageNo) and
 *     trims like every other field
 *   - a revise replaces page rows wholesale, like the other child rows
 *   - saves capture OCR training samples; revisions preserve raw text and mark
 *     the reviewed page set accepted
 *   - createDraft stays the only constructor; pages come from the caller
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { runMigrations } from "../db/migrate.server";
import { ensureDataDirs, getDb, getRawSqlite } from "../db/client.server";
import { ocrTrainingSamples, recipePages } from "../db/schema.server";
import { blankDraft, type DraftPage, type RecipeDraft } from "./draft";
import { createDraft } from "./import";
import {
  composeDraft,
  executeSave,
  loadDraft,
  prepareDraft,
  SaveError,
} from "./draft-store.server";
import { validateSaveCommand } from "./save-command";
import { ScanImageError } from "./scan/index.server";
import { getImagesDir } from "../db/client.server";
import { recipes } from "../db/schema.server";

let tmpDir: string;
let originalDataDir: string | undefined;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "recipedb-pages-"));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tmpDir;
  ensureDataDirs();
  runMigrations();
});

afterAll(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  getRawSqlite().close();
});

const twoPages: DraftPage[] = [
  { pageNo: 1, imageFilename: "12/page-1.png", text: "1 cup flour" },
  { pageNo: 2, imageFilename: "12/page-2.png", text: "2 eggs" },
];

function scanDraftWithPages(pages?: DraftPage[]): RecipeDraft {
  return {
    ...blankDraft(),
    title: "Handwritten Cookies",
    category: "cookies",
    sourceType: "scan",
    rawOcrText: "1 cup flour\n2 eggs",
    ...(pages ? { pages } : {}),
  };
}

function pageRows(recipeId: number) {
  return getDb()
    .select()
    .from(recipePages)
    .where(eq(recipePages.recipeId, recipeId))
    .all();
}

function expectSaveError(
  fn: () => unknown,
  code: string,
  message: RegExp,
): void {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(SaveError);
  if (caught instanceof SaveError) {
    expect(caught.code).toBe(code);
    expect(caught.message).toMatch(message);
  }
}

// A valid PNG header is all the sniffer needs; the tail is ignored.
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48,
  0x44, 0x52,
]);
const PDF_BYTES = Buffer.from("%PDF-1.4\n%%EOF\n");

function recipeRow(recipeId: number) {
  return getDb().select().from(recipes).where(eq(recipes.id, recipeId)).get();
}

function recipeCount(): number {
  return getDb().select().from(recipes).all().length;
}

describe("retained scan bytes (ADR-0004 phase 3)", () => {
  it("moves a staged URL image into its recipe directory and updates the cover", () => {
    const stagedFilename = "_staging/url-import.webp";
    const stagedPath = path.join(getImagesDir(), stagedFilename);
    fs.mkdirSync(path.dirname(stagedPath), { recursive: true });
    fs.writeFileSync(stagedPath, PNG_BYTES);
    const draft = {
      ...blankDraft(),
      title: "Imported Cookies",
      category: "cookies" as const,
      sourceType: "url" as const,
      imageFilename: stagedFilename,
    };

    const { recipeId } = executeSave({ kind: "new", draft });
    const storedFilename = `${recipeId}/original.webp`;

    expect(recipeRow(recipeId)!.imageFilename).toBe(storedFilename);
    expect(fs.existsSync(path.join(getImagesDir(), storedFilename))).toBe(true);
    expect(fs.existsSync(stagedPath)).toBe(false);
  });

  it("leaves a non-staging recipe-relative image filename untouched", () => {
    const filename = "12/original.webp";
    const draft = {
      ...blankDraft(),
      title: "Existing image",
      imageFilename: filename,
    };

    const { recipeId } = executeSave({ kind: "new", draft });

    expect(recipeRow(recipeId)!.imageFilename).toBe(filename);
  });

  it("removes a recipe directory when relocating a missing staged image fails", () => {
    const beforeCount = recipeCount();
    const recipeDirectoriesBefore = fs
      .readdirSync(getImagesDir())
      .filter((entry) => entry !== "_staging");
    const draft = {
      ...blankDraft(),
      title: "Missing staged image",
      imageFilename: "_staging/missing.webp",
    };

    expect(() => executeSave({ kind: "new", draft })).toThrow(ScanImageError);
    expect(recipeCount()).toBe(beforeCount);
    expect(
      fs
        .readdirSync(getImagesDir())
        .filter((entry) => entry !== "_staging"),
    ).toEqual(recipeDirectoriesBefore);
  });

  it("camera save: one page row named after the retained original", () => {
    const draft = scanDraftWithPages([
      { pageNo: 1, imageFilename: "", text: "1 cup flour" },
    ]);
    const { recipeId } = executeSave({
      kind: "new",
      draft,
      imageBytes: PNG_BYTES,
    });

    // The recipe cover is the original capture; the page row points at it too.
    expect(recipeRow(recipeId)!.imageFilename).toBe(`${recipeId}/original.png`);
    expect(pageRows(recipeId)).toEqual([
      expect.objectContaining({
        pageNo: 1,
        imageFilename: `${recipeId}/original.png`,
        rawOcrText: "1 cup flour",
      }),
    ]);
    expect(
      getDb()
        .select()
        .from(ocrTrainingSamples)
        .where(eq(ocrTrainingSamples.recipeId, recipeId))
        .all(),
    ).toEqual([
      expect.objectContaining({
        pageNo: 1,
        imageFilename: `${recipeId}/original.png`,
        rawOcrText: "1 cup flour",
        correctedText: "1 cup flour",
        source: "scan",
        acceptedAt: null,
      }),
    ]);
    expect(
      fs.existsSync(path.join(getImagesDir(), String(recipeId), "original.png")),
    ).toBe(true);
  });

  it("page rasters win over draft filenames and the cover is page 1", () => {
    const draft = scanDraftWithPages([
      { pageNo: 1, imageFilename: "", text: "1 cup flour" },
      { pageNo: 2, imageFilename: "", text: "2 eggs" },
    ]);
    const { recipeId } = executeSave({
      kind: "new",
      draft,
      pageFiles: [
        { pageNo: 2, bytes: PNG_BYTES },
        { pageNo: 1, bytes: PNG_BYTES },
      ],
      pdfBytes: PDF_BYTES,
    });

    expect(pageRows(recipeId).map((r) => r.imageFilename)).toEqual([
      `${recipeId}/page-1.png`,
      `${recipeId}/page-2.png`,
    ]);
    expect(recipeRow(recipeId)!.imageFilename).toBe(`${recipeId}/page-1.png`);
    // The original PDF is stored byte-for-byte.
    expect(
      fs.readFileSync(path.join(getImagesDir(), String(recipeId), "source.pdf")),
    ).toEqual(PDF_BYTES);
    // No camera capture rides along on a PDF import.
    expect(
      fs.existsSync(path.join(getImagesDir(), String(recipeId), "original.png")),
    ).toBe(false);
  });

  it("a non-PDF pdf upload is refused before any recipe exists", () => {
    const before = recipeCount();
    const draft = scanDraftWithPages([
      { pageNo: 1, imageFilename: "", text: "1 cup flour" },
    ]);

    let caught: unknown;
    try {
      executeSave({ kind: "new", draft, pdfBytes: Buffer.from("not a pdf") });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ScanImageError);
    if (caught instanceof ScanImageError) expect(caught.code).toBe("bad-pdf");
    expect(recipeCount()).toBe(before);
    expect(pageRows(0)).toEqual([]);
  });

  it("rejects malformed page uploads structurally", () => {
    const draft = JSON.stringify(scanDraftWithPages());

    expectSaveError(
      () =>
        validateSaveCommand({
          kind: "new",
          draft,
          pageFiles: "nope" as unknown as never,
        }),
      "bad-draft",
      /must be an array/,
    );
    expectSaveError(
      () =>
        validateSaveCommand({
          kind: "new",
          draft,
          pageFiles: [{ pageNo: 0, bytes: PNG_BYTES }],
        }),
      "bad-draft",
      /positive integer/,
    );
    expectSaveError(
      () =>
        validateSaveCommand({
          kind: "new",
          draft,
          pageFiles: [
            { pageNo: 1, bytes: PNG_BYTES },
            { pageNo: 1, bytes: PNG_BYTES },
          ],
        }),
      "bad-draft",
      /Duplicate page upload 1/,
    );
  });

  it("prepareDraft maps an empty page filename to null", () => {
    const prepared = prepareDraft(
      scanDraftWithPages([{ pageNo: 1, imageFilename: "", text: "later" }]),
    );
    expect(prepared.pages).toEqual([
      { pageNo: 1, imageFilename: null, rawOcrText: "later" },
    ]);
  });
});

describe("recipe_pages persistence", () => {
  it("round-trips per-page text and filenames through recipe_pages", () => {
    const draft = scanDraftWithPages(twoPages);
    const { recipeId } = executeSave({ kind: "new", draft });

    const rows = pageRows(recipeId);
    expect(rows.map((r) => r.pageNo)).toEqual([1, 2]);
    expect(rows.map((r) => r.imageFilename)).toEqual([
      "12/page-1.png",
      "12/page-2.png",
    ]);
    expect(rows.map((r) => r.rawOcrText)).toEqual(["1 cup flour", "2 eggs"]);

    const loaded = loadDraft(recipeId);
    expect(loaded).not.toBeNull();
    expect(loaded!.pages).toEqual(twoPages);
  });

  it("keeps a draft without pages behaving exactly as before", () => {
    const { recipeId } = executeSave({ kind: "new", draft: scanDraftWithPages() });

    expect(pageRows(recipeId)).toEqual([]);
    const loaded = loadDraft(recipeId);
    expect(loaded).not.toBeNull();
    expect(loaded!.pages).toBeUndefined();
  });

  it("treats an empty pages array as no pages", () => {
    const { recipeId } = executeSave({ kind: "new", draft: scanDraftWithPages([]) });

    expect(pageRows(recipeId)).toEqual([]);
    expect(loadDraft(recipeId)!.pages).toBeUndefined();
  });

  it("replaces page rows wholesale on revise", () => {
    const { recipeId } = executeSave({ kind: "new", draft: scanDraftWithPages(twoPages) });

    const revised = scanDraftWithPages([
      {
        pageNo: 1,
        imageFilename: "12/page-1.png",
        text: "1 cup flour (corrected)",
      },
    ]);
    executeSave({ kind: "revise", recipeId, draft: revised });

    const rows = pageRows(recipeId);
    expect(rows.length).toBe(1);
    expect(rows[0]!.rawOcrText).toBe("1 cup flour (corrected)");
    expect(loadDraft(recipeId)!.pages).toEqual(revised.pages);
  });

  it("references page images that are not uploaded yet without breaking", () => {
    const futurePages: DraftPage[] = [
      { pageNo: 1, imageFilename: "99/page-1.png", text: "later" },
      { pageNo: 2, imageFilename: "99/page-2.png", text: "also later" },
    ];
    const { recipeId } = executeSave({ kind: "new", draft: scanDraftWithPages(futurePages) });
    expect(loadDraft(recipeId)!.pages).toEqual(futurePages);
  });
});

describe("prepareDraft pages", () => {
  it("normalizes pages into DB-ready rows and omits them when empty", () => {
    const prepared = prepareDraft(scanDraftWithPages(twoPages));
    expect(prepared.pages).toEqual([
      { pageNo: 1, imageFilename: "12/page-1.png", rawOcrText: "1 cup flour" },
      { pageNo: 2, imageFilename: "12/page-2.png", rawOcrText: "2 eggs" },
    ]);

    expect(prepareDraft(scanDraftWithPages()).pages).toBeUndefined();
    expect(prepareDraft(scanDraftWithPages([])).pages).toBeUndefined();
  });

  it("sorts pages by page number without renumbering them", () => {
    const prepared = prepareDraft(
      scanDraftWithPages([twoPages[1]!, twoPages[0]!]),
    );
    expect(prepared.pages!.map((p) => p.pageNo)).toEqual([1, 2]);
    expect(prepared.pages!.map((p) => p.rawOcrText)).toEqual([
      "1 cup flour",
      "2 eggs",
    ]);
  });

  it("trims page text and filenames like every other field", () => {
    const prepared = prepareDraft(
      scanDraftWithPages([
        { pageNo: 1, imageFilename: " 12/page-1.png ", text: "  1 cup flour  " },
      ]),
    );
    expect(prepared.pages).toEqual([
      { pageNo: 1, imageFilename: "12/page-1.png", rawOcrText: "1 cup flour" },
    ]);
  });

  it("rejects malformed pages with bad-draft", () => {
    const base = {
      title: "T",
      category: "cookies",
      sourceType: "scan",
      favorite: false,
      tags: [],
      ingredients: [],
      steps: [],
    };

    expectSaveError(
      () => validateSaveCommand({ kind: "new", draft: { ...base, pages: "nope" } }),
      "bad-draft",
      /must be an array/,
    );
    expectSaveError(
      () => validateSaveCommand({ kind: "new", draft: { ...base, pages: [null] } }),
      "bad-draft",
      /must be an object/,
    );
    expectSaveError(
      () =>
        validateSaveCommand({
          kind: "new",
          draft: {
            ...base,
            pages: [{ pageNo: 0, imageFilename: "", text: "" }],
          },
        }),
      "bad-draft",
      /positive integer/,
    );
    expectSaveError(
      () =>
        validateSaveCommand({
          kind: "new",
          draft: {
            ...base,
            pages: [{ pageNo: 1.5, imageFilename: "", text: "" }],
          },
        }),
      "bad-draft",
      /positive integer/,
    );
    expectSaveError(
      () =>
        validateSaveCommand({
          kind: "new",
          draft: {
            ...base,
            pages: [
              { pageNo: 1, imageFilename: "", text: "" },
              { pageNo: 1, imageFilename: "", text: "" },
            ],
          },
        }),
      "bad-draft",
      /Duplicate page number 1/,
    );
    expectSaveError(
      () =>
        validateSaveCommand({
          kind: "new",
          draft: {
            ...base,
            pages: [{ pageNo: 1, imageFilename: "", text: 42 }],
          },
        }),
      "bad-draft",
      /text must be a string/,
    );
    expectSaveError(
      () =>
        validateSaveCommand({
          kind: "new",
          draft: {
            ...base,
            pages: [{ pageNo: 1, imageFilename: 7, text: "" }],
          },
        }),
      "bad-draft",
      /image filename must be a string/,
    );
  });

  it("carries pages through validateSaveCommand and the JSON payload", () => {
    const validated = validateSaveCommand({
      kind: "new",
      draft: JSON.stringify(scanDraftWithPages(twoPages)),
    });
    expect(validated.kind).toBe("new");
    if (validated.kind === "new") {
      expect(validated.prepared.pages).toEqual([
        { pageNo: 1, imageFilename: "12/page-1.png", rawOcrText: "1 cup flour" },
        { pageNo: 2, imageFilename: "12/page-2.png", rawOcrText: "2 eggs" },
      ]);
    }
  });
});

describe("composeDraft pages", () => {
  it("composes stored page rows in page order", () => {
    const draft = composeDraft({
      fields: {
        title: "T",
        category: "cookies",
        yield: null,
        favorite: false,
        sourceType: "scan",
        sourceUrl: null,
        rawOcrText: null,
        imageFilename: null,
      },
      ingredients: [],
      steps: [],
      tags: [],
      pages: [
        { pageNo: 2, imageFilename: "12/page-2.png", rawOcrText: "two" },
        { pageNo: 1, imageFilename: "12/page-1.png", rawOcrText: "one" },
      ],
    });
    expect(draft.pages).toEqual([
      { pageNo: 1, imageFilename: "12/page-1.png", text: "one" },
      { pageNo: 2, imageFilename: "12/page-2.png", text: "two" },
    ]);
  });

  it("leaves pages absent when there are no rows", () => {
    const draft = composeDraft({
      fields: {
        title: "T",
        category: "cookies",
        yield: null,
        favorite: false,
        sourceType: "scan",
        sourceUrl: null,
        rawOcrText: null,
        imageFilename: null,
      },
      ingredients: [],
      steps: [],
      tags: [],
      pages: [],
    });
    expect(draft.pages).toBeUndefined();
  });
});

describe("ocr_training_samples capture", () => {
  it("captures one unaccepted training row per saved page", () => {
    const { recipeId } = executeSave({ kind: "new", draft: scanDraftWithPages(twoPages) });
    const rows = getDb()
      .select()
      .from(ocrTrainingSamples)
      .where(eq(ocrTrainingSamples.recipeId, recipeId))
      .all();
    expect(rows).toHaveLength(twoPages.length);
    expect(rows.map(({ pageNo }) => pageNo)).toEqual([1, 2]);
    expect(rows.map(({ rawOcrText }) => rawOcrText)).toEqual(
      twoPages.map(({ text }) => text),
    );
    expect(rows.map(({ correctedText }) => correctedText)).toEqual(
      twoPages.map(({ text }) => text),
    );
    expect(rows.map(({ acceptedAt }) => acceptedAt)).toEqual([null, null]);
    expect(rows.map(({ source }) => source)).toEqual(["scan", "scan"]);
    expect(rows.map(({ imageFilename }) => imageFilename)).toEqual(
      twoPages.map(({ imageFilename }) => imageFilename),
    );
  });

  it("preserves original OCR text and accepts revised pages", () => {
    const { recipeId } = executeSave({ kind: "new", draft: scanDraftWithPages(twoPages) });
    const correctedText = "Corrected page one";
    executeSave({
      kind: "revise",
      recipeId,
      draft: scanDraftWithPages([{ ...twoPages[0], text: correctedText }]),
    });

    const rows = getDb()
      .select()
      .from(ocrTrainingSamples)
      .where(eq(ocrTrainingSamples.recipeId, recipeId))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      pageNo: 1,
      rawOcrText: twoPages[0].text,
      correctedText,
      source: "scan",
      imageFilename: twoPages[0].imageFilename,
    });
    expect(rows[0].acceptedAt).toBeInstanceOf(Date);
  });

  it("captures no samples when saving or revising without pages", () => {
    const { recipeId: emptyRecipeId } = executeSave({ kind: "new", draft: scanDraftWithPages([]) });
    expect(
      getDb()
        .select()
        .from(ocrTrainingSamples)
        .where(eq(ocrTrainingSamples.recipeId, emptyRecipeId))
        .all(),
    ).toEqual([]);

    const { recipeId } = executeSave({ kind: "new", draft: scanDraftWithPages(twoPages) });
    executeSave({ kind: "revise", recipeId, draft: scanDraftWithPages([]) });
    const after = getDb()
      .select()
      .from(ocrTrainingSamples)
      .where(eq(ocrTrainingSamples.recipeId, recipeId))
      .all();
    expect(after).toEqual([]);
  });

  it("removes training rows when the recipe is deleted", () => {
    const { recipeId } = executeSave({ kind: "new", draft: scanDraftWithPages(twoPages) });
    getDb().delete(recipes).where(eq(recipes.id, recipeId)).run();

    const rows = getDb()
      .select()
      .from(ocrTrainingSamples)
      .where(eq(ocrTrainingSamples.recipeId, recipeId))
      .all();
    expect(rows).toEqual([]);
  });
});

describe("createDraft seam (ADR-0002)", () => {
  it("stays the only constructor and stamps provenance; pages come from the caller", () => {
    const draft = createDraft({
      kind: "scan",
      text: "Cookies\n1 cup flour",
      imageFilename: "12/original.png",
    });
    expect(draft.pages).toBeUndefined();
    expect(draft.sourceType).toBe("scan");
    expect(draft.rawOcrText).toBe("Cookies\n1 cup flour");

    const withPages = { ...draft, pages: twoPages };
    const { recipeId } = executeSave({ kind: "new", draft: withPages });
    expect(loadDraft(recipeId)!.pages).toEqual(twoPages);
  });
});
