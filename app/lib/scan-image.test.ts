/**
 * Retained scan captures (#28): upload validation, per-recipe storage, the
 * image_filename column/migration, re-OCR (with an injected recognizer), and
 * the two HTTP transports.
 *
 * The recognizer is mocked: these tests must never load a tesseract worker.
 */
import { vi } from "vitest";

vi.mock("./scan/recognize-node.server", () => ({
  FIXTURE_DIR: "tests/fixtures/ocr",
  fixturePaths: () => [],
  collectImagePaths: () => [],
  defaultCachePath: () => "",
  createOcrSession: async () => ({
    recognize: async () => ({ text: "", confidence: 0, ms: 0 }),
    terminate: async () => {},
  }),
  ingest: async () => ({
    text: "1 cup flour\n2 eggs\n\n1. Mix.\n2. Bake.",
    confidence: 88.5,
    ms: 7,
  }),
}));

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runMigrations } from "../db/migrate.server";
import { ensureDataDirs, getImagesDir, getRawSqlite } from "../db/client.server";
import { blankDraft, type RecipeDraft } from "./draft";
import { deleteRecipe, executeSave, loadDraft } from "./draft-store.server";
import {
  MAX_SCAN_UPLOAD_BYTES,
  ScanImageError,
  attachImageFilename,
  handleReOcrRequest,
  handleScanImageRequest,
  reocrRecipe,
  resolveStoredImagePath,
  saveOriginalScanImage,
  savePageScanImage,
  saveSourcePdf,
  validatePdfUpload,
  validateScanUpload,
} from "./scan/index.server";
import { buildSessionCookie } from "./session.server";
import { action as saveDraftAction } from "../routes/api.save-draft";
import type { Route } from "../routes/+types/api.save-draft";
import {
  action as scanImagesAction,
  loader as scanImagesLoader,
} from "../routes/api.scan-images.$";
import type { Route as ScanImagesRoute } from "../routes/+types/api.scan-images.$";

/** Drive the real route action; parsing/dispatch live below it now. */
const handleSaveDraftRequest = (request: Request) =>
  saveDraftAction({ request } as unknown as Route.ActionArgs);

let tmpDir: string;
let originalDataDir: string | undefined;
let originalSecret: string | undefined;
let authCookie: string;
let migrations: { applied: string[]; skipped: string[] };

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "recipedb-scan-"));
  originalDataDir = process.env.DATA_DIR;
  originalSecret = process.env.SESSION_SECRET;
  process.env.DATA_DIR = tmpDir;
  process.env.SESSION_SECRET = "scan-image-test-secret";
  ensureDataDirs();
  migrations = runMigrations();
  authCookie = buildSessionCookie().split(";")[0]!;
});

afterAll(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  if (originalSecret === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = originalSecret;
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  getRawSqlite().close();
});

function pngBytes(extra = 8): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(extra, 0x42),
  ]);
}

function jpegBytes(): Buffer {
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
}

function webpBytes(): Buffer {
  return Buffer.concat([
    Buffer.from("RIFF", "ascii"),
    Buffer.from([0x1a, 0x00, 0x00, 0x00]),
    Buffer.from("WEBP", "ascii"),
    Buffer.from([0x56, 0x50, 0x38, 0x20]),
  ]);
}

function scanDraft(title = "Scan test"): RecipeDraft {
  return {
    ...blankDraft(),
    title,
    category: "other",
    sourceType: "scan",
    rawOcrText: "1 cup flour",
  };
}

function authedRequest(url: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("cookie", authCookie);
  return new Request(url, { ...init, headers });
}

function multipartRequest(
  draft: RecipeDraft,
  file: File | null,
  authenticated = true,
): Request {
  const form = new FormData();
  form.set("draft", JSON.stringify(draft));
  if (file) form.set("image", file);
  return new Request("http://localhost/api/save-draft", {
    method: "POST",
    headers: authenticated ? { cookie: authCookie } : {},
    body: form,
  });
}

/** Free-form multipart request for page rasters, PDFs, and malformed cases. */
function formRequest(form: FormData, authenticated = true): Request {
  return new Request("http://localhost/api/save-draft", {
    method: "POST",
    headers: authenticated ? { cookie: authCookie } : {},
    body: form,
  });
}

function pdfBytes(): Buffer {
  return Buffer.from("%PDF-1.4\n1 0 obj\nendobj\n%%EOF\n");
}

function pageDraft(): RecipeDraft {
  return {
    ...blankDraft(),
    title: "Scanned PDF",
    category: "other",
    sourceType: "scan",
    rawOcrText: "page one\n\npage two",
    pages: [
      { pageNo: 1, imageFilename: "", text: "page one" },
      { pageNo: 2, imageFilename: "", text: "page two" },
    ],
  };
}

function pageFile(pageNo: number): File {
  return new File([new Uint8Array(pngBytes(4 + pageNo))], `page-${pageNo}.png`, {
    type: "image/png",
  });
}

function recipeCount(): number {
  const row = getRawSqlite()
    .prepare("SELECT COUNT(*) AS n FROM recipes")
    .get() as { n: number };
  return row.n;
}

describe("0002_scan_image migration", () => {
  it("is applied by the runner", () => {
    expect(migrations.applied).toContain("0002_scan_image");
  });

  it("adds the nullable recipes.image_filename column", () => {
    const cols = getRawSqlite()
      .prepare("PRAGMA table_info('recipes')")
      .all() as Array<{ name: string; notnull: number }>;
    const col = cols.find((c) => c.name === "image_filename");
    expect(col).toBeDefined();
    // Nullable: manual entries and pre-#28 imports have no capture.
    expect(col?.notnull).toBe(0);
  });

  it("is idempotent on a second run", () => {
    const again = runMigrations();
    expect(again.applied).not.toContain("0002_scan_image");
    expect(again.skipped).toContain("0002_scan_image");
  });
});

describe("validateScanUpload", () => {
  it("accepts JPEG, PNG, and WebP by magic bytes", () => {
    expect(validateScanUpload(jpegBytes()).ext).toBe("jpg");
    expect(validateScanUpload(pngBytes()).ext).toBe("png");
    expect(validateScanUpload(webpBytes()).ext).toBe("webp");
  });

  it("rejects empty uploads", () => {
    expect(() => validateScanUpload(Buffer.alloc(0))).toThrowError(ScanImageError);
  });

  it("rejects bytes that are not an image", () => {
    try {
      validateScanUpload(Buffer.from("not an image at all"));
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ScanImageError);
      expect((err as ScanImageError).code).toBe("bad-image");
    }
  });

  it("rejects uploads over the ~15MB ceiling before sniffing", () => {
    try {
      validateScanUpload(Buffer.alloc(MAX_SCAN_UPLOAD_BYTES + 1));
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ScanImageError);
      expect((err as ScanImageError).code).toBe("image-too-large");
    }
  });

  it("refuses paths that escape the images directory", () => {
    expect(resolveStoredImagePath("../recipes.db")).toBeNull();
    expect(resolveStoredImagePath("12/original.png")).toBe(
      path.join(getImagesDir(), "12", "original.png"),
    );
  });
});

describe("retention lifecycle", () => {
  it("writes the original bytes untouched and records loadDraft().imageFilename", () => {
    const bytes = pngBytes(64);
    const { recipeId } = executeSave({ kind: "new", draft: scanDraft("Retained scan") });
    const rel = saveOriginalScanImage(recipeId, bytes);

    expect(rel).toBe(`${recipeId}/original.png`);
    const onDisk = fs.readFileSync(path.join(getImagesDir(), rel));
    expect(onDisk.equals(bytes)).toBe(true);

    attachImageFilename(recipeId, rel);
    expect(loadDraft(recipeId)?.imageFilename).toBe(rel);
  });

  it("overwrites the capture on re-upload instead of accumulating files", () => {
    const { recipeId } = executeSave({ kind: "new", draft: scanDraft("Re-upload") });
    saveOriginalScanImage(recipeId, pngBytes(4));
    const rel = saveOriginalScanImage(recipeId, pngBytes(8));
    const files = fs.readdirSync(path.join(getImagesDir(), String(recipeId)));
    expect(files).toEqual([path.basename(rel)]);
  });

  it("deletes the capture only when the recipe is deleted", () => {
    const { recipeId } = executeSave({ kind: "new", draft: scanDraft("Delete me") });
    const rel = saveOriginalScanImage(recipeId, pngBytes());
    attachImageFilename(recipeId, rel);
    const artifact = path.join(getImagesDir(), rel);
    expect(fs.existsSync(artifact)).toBe(true);

    expect(deleteRecipe(recipeId)).toBe(true);
    expect(fs.existsSync(artifact)).toBe(false);
    expect(fs.existsSync(path.dirname(artifact))).toBe(false);
    expect(loadDraft(recipeId)).toBeNull();
  });

  it("returns false and leaves artifacts alone for an unknown recipe", () => {
    expect(deleteRecipe(987654)).toBe(false);
  });
});

describe("reocrRecipe", () => {
  it("recognizes the stored capture and returns fresh text without writing", async () => {
    const { recipeId } = executeSave({ kind: "new", draft: scanDraft("Re-OCR me") });
    const rel = saveOriginalScanImage(recipeId, pngBytes());
    attachImageFilename(recipeId, rel);
    const before = loadDraft(recipeId);

    let seen: Buffer[] = [];
    const result = await reocrRecipe(recipeId, async (photo) => {
      seen = [photo.bytes];
      return { text: "FRESH TEXT", confidence: 91.2, ms: 12 };
    });

    expect(seen[0]?.equals(fs.readFileSync(path.join(getImagesDir(), rel)))).toBe(
      true,
    );
    expect(result).toEqual({
      recipeId,
      text: "FRESH TEXT",
      confidence: 91.2,
      ms: 12,
    });
    // Never auto-overwrites the human-edited draft.
    expect(loadDraft(recipeId)).toEqual(before);
  });

  it("throws no-image for a recipe without a capture", async () => {
    const { recipeId } = executeSave({ kind: "new", draft: scanDraft("No image") });
    await expect(
      reocrRecipe(recipeId, async () => ({ text: "", confidence: 0, ms: 0 })),
    ).rejects.toMatchObject({ code: "no-image" });
  });

  it("throws not-found for an unknown recipe", async () => {
    await expect(
      reocrRecipe(987654, async () => ({ text: "", confidence: 0, ms: 0 })),
    ).rejects.toMatchObject({ code: "not-found" });
  });

  it("throws image-missing when the row points at a deleted file", async () => {
    const { recipeId } = executeSave({ kind: "new", draft: scanDraft("Missing capture") });
    attachImageFilename(recipeId, `${recipeId}/original.png`);
    await expect(
      reocrRecipe(recipeId, async () => ({ text: "", confidence: 0, ms: 0 })),
    ).rejects.toMatchObject({ code: "image-missing" });
  });
});

describe("POST /api/save-draft (multipart transport)", () => {
  it("persists the recipe and the original capture", async () => {
    const bytes = pngBytes(32);
    const file = new File([new Uint8Array(bytes)], "capture.png", {
      type: "image/png",
    });
    const res = await handleSaveDraftRequest(
      multipartRequest(scanDraft("Multipart scan"), file),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { recipeId: number };

    const draft = loadDraft(json.recipeId);
    expect(draft?.imageFilename).toBe(`${json.recipeId}/original.png`);
    const onDisk = fs.readFileSync(
      path.join(getImagesDir(), String(json.recipeId), "original.png"),
    );
    expect(onDisk.equals(bytes)).toBe(true);
  });

  it("keeps the JSON transport working with no capture", async () => {
    const res = await handleSaveDraftRequest(
      authedRequest("http://localhost/api/save-draft", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(scanDraft("JSON scan")),
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { recipeId: number };
    expect(loadDraft(json.recipeId)?.imageFilename).toBeNull();
  });

  it("rejects a non-image upload without creating a recipe", async () => {
    const before = recipeCount();
    const file = new File([new Uint8Array(Buffer.from("definitely not an image"))], "x.txt", {
      type: "text/plain",
    });
    const res = await handleSaveDraftRequest(
      multipartRequest(scanDraft("Junk upload"), file),
    );
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: "bad-image",
    });
    expect(recipeCount()).toBe(before);
  });

  it("rejects an oversize upload without creating a recipe", async () => {
    const before = recipeCount();
    const file = new File(
      [new Uint8Array(Buffer.alloc(MAX_SCAN_UPLOAD_BYTES + 1))],
      "huge.png",
      { type: "image/png" },
    );
    const res = await handleSaveDraftRequest(
      multipartRequest(scanDraft("Huge upload"), file),
    );
    expect(res.status).toBe(413);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: "image-too-large",
    });
    expect(recipeCount()).toBe(before);
  });

  it("requires a session", async () => {
    const thrown = await handleSaveDraftRequest(
      multipartRequest(scanDraft("Unauthorized"), null, false),
    ).catch((err: unknown) => err);
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(401);
  });
});

describe("validatePdfUpload + page/PDF storage (ADR-0004)", () => {
  function expectPdfError(fn: () => unknown, code: string): void {
    try {
      fn();
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ScanImageError);
      expect((err as ScanImageError).code).toBe(code);
    }
  }

  it("accepts a PDF by its magic and rejects empty, oversize, and non-PDF bytes", () => {
    expect(validatePdfUpload(pdfBytes()).bytes).toBe(pdfBytes().byteLength);

    expectPdfError(() => validatePdfUpload(Buffer.alloc(0)), "bad-pdf");
    expectPdfError(
      () => validatePdfUpload(Buffer.alloc(MAX_SCAN_UPLOAD_BYTES + 1)),
      "pdf-too-large",
    );
    expectPdfError(
      () => validatePdfUpload(Buffer.from("plain text")),
      "bad-pdf",
    );
  });

  it("stores page rasters as page-<n>.<ext> and the PDF byte-for-byte", () => {
    const { recipeId } = executeSave({ kind: "new", draft: scanDraft("Page storage") });

    expect(savePageScanImage(recipeId, 2, pngBytes(8))).toBe(
      `${recipeId}/page-2.png`,
    );
    expect(
      fs.readFileSync(path.join(getImagesDir(), String(recipeId), "page-2.png")),
    ).toEqual(pngBytes(8));

    const pdf = pdfBytes();
    expect(saveSourcePdf(recipeId, pdf)).toBe(`${recipeId}/source.pdf`);
    expect(
      fs.readFileSync(path.join(getImagesDir(), String(recipeId), "source.pdf")),
    ).toEqual(pdf);
  });
});

describe("POST /api/save-draft multipart page rasters + source PDF", () => {
  it("persists pages with server-assigned filenames and the original PDF", async () => {
    const pdf = pdfBytes();
    const form = new FormData();
    form.set("draft", JSON.stringify(pageDraft()));
    form.set("page-1", pageFile(1));
    form.set("page-2", pageFile(2));
    form.set("pdf", new File([new Uint8Array(pdf)], "source.pdf"));

    const res = await handleSaveDraftRequest(formRequest(form));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { recipeId: number };

    const draft = loadDraft(json.recipeId);
    expect(draft?.imageFilename).toBe(`${json.recipeId}/page-1.png`);
    expect(draft?.pages?.map((page) => page.imageFilename)).toEqual([
      `${json.recipeId}/page-1.png`,
      `${json.recipeId}/page-2.png`,
    ]);
    expect(draft?.pages?.map((page) => page.text)).toEqual([
      "page one",
      "page two",
    ]);
    expect(
      fs.readFileSync(
        path.join(getImagesDir(), String(json.recipeId), "source.pdf"),
      ),
    ).toEqual(pdf);
  });

  it("rejects a page field that is not a file", async () => {
    const form = new FormData();
    form.set("draft", JSON.stringify(pageDraft()));
    form.set("page-1", "oops");
    const res = await handleSaveDraftRequest(formRequest(form));
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: "bad-page",
    });
  });

  it("rejects a duplicate page upload", async () => {
    const form = new FormData();
    form.set("draft", JSON.stringify(pageDraft()));
    form.append("page-1", pageFile(1));
    form.append("page-1", pageFile(1));
    const res = await handleSaveDraftRequest(formRequest(form));
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: "bad-page",
    });
  });

  it("rejects page zero", async () => {
    const form = new FormData();
    form.set("draft", JSON.stringify(pageDraft()));
    form.set("page-0", pageFile(0));
    const res = await handleSaveDraftRequest(formRequest(form));
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: "bad-page",
    });
  });

  it("rejects a PDF field that is not a file", async () => {
    const form = new FormData();
    form.set("draft", JSON.stringify(pageDraft()));
    form.set("pdf", "not-a-file");
    const res = await handleSaveDraftRequest(formRequest(form));
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: "bad-pdf",
    });
  });

  it("reports a page raster write failure", () => {
    const recipeId = 987651;
    const blockedPath = path.join(getImagesDir(), String(recipeId));
    fs.mkdirSync(getImagesDir(), { recursive: true });
    fs.writeFileSync(blockedPath, "not a directory");

    let error: unknown;
    try {
      savePageScanImage(recipeId, 1, pngBytes());
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ScanImageError);
    expect(error).toMatchObject({
      code: "image-write-failed",
      message: expect.stringContaining("Could not store scan page 1:"),
    });
  });

  it("reports a source PDF write failure", () => {
    const recipeId = 987652;
    const blockedPath = path.join(getImagesDir(), String(recipeId));
    fs.mkdirSync(getImagesDir(), { recursive: true });
    fs.writeFileSync(blockedPath, "not a directory");

    let error: unknown;
    try {
      saveSourcePdf(recipeId, pdfBytes());
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ScanImageError);
    expect(error).toMatchObject({
      code: "image-write-failed",
      message: expect.stringContaining("Could not store the source PDF:"),
    });
  });

  it("rejects an oversize page raster with 413", async () => {
    const form = new FormData();
    form.set("draft", JSON.stringify(pageDraft()));
    form.set(
      "page-1",
      new File(
        [new Uint8Array(Buffer.alloc(MAX_SCAN_UPLOAD_BYTES + 1))],
        "page-1.png",
        { type: "image/png" },
      ),
    );
    const res = await handleSaveDraftRequest(formRequest(form));
    expect(res.status).toBe(413);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: "image-too-large",
    });
  });

  it("rejects an oversize PDF with 413 and a non-PDF with 400", async () => {
    const oversize = new FormData();
    oversize.set("draft", JSON.stringify(pageDraft()));
    oversize.set("page-1", pageFile(1));
    oversize.set(
      "pdf",
      new File([new Uint8Array(Buffer.alloc(MAX_SCAN_UPLOAD_BYTES + 1))], "big.pdf"),
    );
    const bigRes = await handleSaveDraftRequest(formRequest(oversize));
    expect(bigRes.status).toBe(413);
    expect((await bigRes.json()) as { error: string }).toMatchObject({
      error: "pdf-too-large",
    });

    const junk = new FormData();
    junk.set("draft", JSON.stringify(pageDraft()));
    junk.set("page-1", pageFile(1));
    junk.set("pdf", new File([new Uint8Array(Buffer.from("plain"))], "x.pdf"));
    const junkRes = await handleSaveDraftRequest(formRequest(junk));
    expect(junkRes.status).toBe(400);
    expect((await junkRes.json()) as { error: string }).toMatchObject({
      error: "bad-pdf",
    });
  });

  it("drops checked page/PDF bytes on a revise without writing them", async () => {
    const { recipeId } = executeSave({ kind: "new", draft: scanDraft("Revise with bytes") });
    const form = new FormData();
    form.set("draft", JSON.stringify({ ...pageDraft() }));
    form.set("recipeId", String(recipeId));
    form.set("page-1", pageFile(1));
    form.set("pdf", new File([new Uint8Array(pdfBytes())], "source.pdf"));

    const res = await handleSaveDraftRequest(formRequest(form));
    expect(res.status).toBe(200);

    // The revise validates the bytes (so junk would still 4xx) but the
    // recipe keeps its own capture story: no page dir, no cover change.
    const saved = loadDraft(recipeId);
    expect(saved?.pages?.map((page) => page.imageFilename)).toEqual([
      null,
      null,
    ]);
    expect(saved?.imageFilename).toBeNull();
    expect(
      fs.existsSync(path.join(getImagesDir(), String(recipeId))),
    ).toBe(false);
  });
});

describe("POST /api/re-ocr (multipart-free transport)", () => {
  it("returns fresh OCR text for the stored capture", async () => {
    const { recipeId } = executeSave({ kind: "new", draft: scanDraft("Endpoint re-ocr") });
    const rel = saveOriginalScanImage(recipeId, pngBytes());
    attachImageFilename(recipeId, rel);

    const res = await handleReOcrRequest(
      authedRequest("http://localhost/api/re-ocr", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: recipeId }),
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      recipeId: number;
      text: string;
      confidence: number;
    };
    expect(json.recipeId).toBe(recipeId);
    expect(json.text).toContain("1 cup flour");
    expect(json.confidence).toBe(88.5);
    // Approval is a UI action; the endpoint does not touch the draft.
    expect(loadDraft(recipeId)?.rawOcrText).toBe("1 cup flour");
  });

  it("returns 404 for a recipe with no retained capture", async () => {
    const { recipeId } = executeSave({ kind: "new", draft: scanDraft("No capture endpoint") });
    const res = await handleReOcrRequest(
      authedRequest("http://localhost/api/re-ocr", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: recipeId }),
      }),
    );
    expect(res.status).toBe(404);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: "no-image",
    });
  });

  it("rejects a non-numeric id", async () => {
    const res = await handleReOcrRequest(
      authedRequest("http://localhost/api/re-ocr", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "nope" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("requires a session", async () => {
    const thrown = await handleReOcrRequest(
      new Request("http://localhost/api/re-ocr", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: 1 }),
      }),
    ).catch((err: unknown) => err);
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(401);
  });
});

describe("GET /api/scan-images (ADR-0004 serving)", () => {
  it("serves stored bytes through the route adapter and rejects its action", async () => {
    const bytes = pngBytes(32);
    const filename = savePageScanImage(12346, 1, bytes);
    const directResponse = handleScanImageRequest(
      authedRequest(`http://localhost/api/scan-images/${filename}`),
      filename,
    );
    const routeResponse = await scanImagesLoader({
      request: authedRequest(`http://localhost/api/scan-images/${filename}`),
      params: { "*": filename },
    } as unknown as ScanImagesRoute.LoaderArgs);

    expect(directResponse.status).toBe(200);
    expect(routeResponse.status).toBe(200);
    expect(routeResponse.headers.get("content-type")).toBe(
      directResponse.headers.get("content-type"),
    );
    const directBytes = Buffer.from(await directResponse.arrayBuffer());
    expect(Buffer.from(await routeResponse.arrayBuffer())).toEqual(directBytes);
    expect(directBytes).toEqual(bytes);

    const actionResponse = await scanImagesAction();
    expect(actionResponse.status).toBe(405);
    expect(await actionResponse.json()).toMatchObject({
      error: "method-not-allowed",
    });
  });

  it("serves the exact stored bytes with the mapped content type and cache policy", async () => {
    const bytes = pngBytes(32);
    const filename = savePageScanImage(12345, 1, bytes);
    const res = handleScanImageRequest(
      authedRequest(`http://localhost/api/scan-images/${filename}`),
      filename,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("private, max-age=300");
    expect(Buffer.from(await res.arrayBuffer()).equals(bytes)).toBe(true);
  });

  it("returns 404 JSON for a missing file", async () => {
    const res = handleScanImageRequest(
      authedRequest("http://localhost/api/scan-images/12345/missing.png"),
      "12345/missing.png",
    );

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not-found" });
  });

  it.each(["../secret.png", "12/../../etc/passwd"])(
    "returns 404 JSON for traversal filename %s",
    async (filename) => {
      const res = handleScanImageRequest(
        authedRequest(`http://localhost/api/scan-images/${filename}`),
        filename,
      );

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not-found" });
    },
  );

  it("returns 405 JSON for an authenticated non-GET request", async () => {
    const res = handleScanImageRequest(
      authedRequest("http://localhost/api/scan-images/12345/page-1.png", {
        method: "POST",
      }),
      "12345/page-1.png",
    );

    expect(res.status).toBe(405);
    expect(await res.json()).toEqual({ error: "method-not-allowed" });
  });

  it("throws a 401 Response without a valid session cookie", async () => {
    const url = "http://localhost/api/scan-images/12345/page-1.png";
    await expect(
      Promise.resolve().then(() =>
        handleScanImageRequest(new Request(url), "12345/page-1.png"),
      ),
    ).rejects.toMatchObject({ status: 401 });

    const invalidCookie = authCookie.replace(/=.*/, "=invalid");
    await expect(
      Promise.resolve().then(() =>
        handleScanImageRequest(
          new Request(url, { headers: { cookie: invalidCookie } }),
          "12345/page-1.png",
        ),
      ),
    ).rejects.toMatchObject({ status: 401 });
  });
});
