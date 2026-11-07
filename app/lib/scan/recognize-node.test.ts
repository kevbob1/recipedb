/**
 * Node OCR engine: worker lifecycle, engine-parameter overrides, fixture path
 * discovery and the ingest entry point.
 *
 * tesseract.js is mocked (no WASM download) and so is sharp-backed
 * preprocessing; what is asserted is the contract the API route and the tuning
 * harness both depend on.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createWorker: vi.fn(),
  preprocessFixture: vi.fn(),
}));

vi.mock("tesseract.js", () => ({
  createWorker: mocks.createWorker,
  // The real enum values are irrelevant to this module; only pass-through.
  PSM: { AUTO: "3", SINGLE_BLOCK: "6", SINGLE_BLOCK_VERT_TEXT: "5" },
}));
vi.mock("./preprocess.server", () => ({
  preprocessFixture: mocks.preprocessFixture,
}));

import { OCR_WORKER_PARAMS } from "../ocr";
import {
  FIXTURE_DIR,
  collectImagePaths,
  createOcrSession,
  defaultCachePath,
  fixturePaths,
  ingest,
} from "./recognize-node.server";
import type { Photo } from "./storage.server";

let tmpDir: string;
const originalCache = process.env.OCR_TESSDATA_CACHE;
const originalLangPath = process.env.OCR_LANG_PATH;

function fakeWorker() {
  return {
    setParameters: vi.fn(async (_params: Record<string, unknown>) => {}),
    recognize: vi.fn<
      (image?: unknown) => Promise<{ data: { text?: string; confidence?: number } }>
    >(async () => ({
      data: { text: "1 cup flour\r\n2 eggs", confidence: 91.5 },
    })),
    terminate: vi.fn(async () => {}),
  };
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "recipedb-ocr-"));
});

beforeEach(() => {
  mocks.createWorker.mockReset();
  mocks.preprocessFixture.mockReset();
  delete process.env.OCR_TESSDATA_CACHE;
  delete process.env.OCR_LANG_PATH;
});

afterEach(() => {
  delete process.env.OCR_TESSDATA_CACHE;
  delete process.env.OCR_LANG_PATH;
});

afterAll(() => {
  if (originalCache === undefined) delete process.env.OCR_TESSDATA_CACHE;
  else process.env.OCR_TESSDATA_CACHE = originalCache;
  if (originalLangPath === undefined) delete process.env.OCR_LANG_PATH;
  else process.env.OCR_LANG_PATH = originalLangPath;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("path discovery", () => {
  it("returns no fixtures when the directory is missing", () => {
    expect(fixturePaths(path.join(tmpDir, "nope"))).toEqual([]);
    expect(collectImagePaths(path.join(tmpDir, "nope"))).toEqual([]);
  });

  it("lists only image fixtures, sorted", () => {
    const dir = path.join(tmpDir, "fixtures");
    fs.mkdirSync(dir, { recursive: true });
    for (const name of ["b.JPG", "a.png", "notes.txt", "d.jpeg"]) {
      fs.writeFileSync(path.join(dir, name), "x");
    }

    expect(fixturePaths(dir)).toEqual([
      path.join(dir, "a.png"),
      path.join(dir, "b.JPG"),
      path.join(dir, "d.jpeg"),
    ]);
  });

  it("collects stored captures recursively, including WebP", () => {
    const dir = path.join(tmpDir, "captures");
    fs.mkdirSync(path.join(dir, "12"), { recursive: true });
    fs.mkdirSync(path.join(dir, "13"), { recursive: true });
    fs.writeFileSync(path.join(dir, "12", "original.png"), "x");
    fs.writeFileSync(path.join(dir, "12", "notes.txt"), "x");
    fs.writeFileSync(path.join(dir, "13", "original.webp"), "x");

    expect(collectImagePaths(dir)).toEqual([
      path.join(dir, "12", "original.png"),
      path.join(dir, "13", "original.webp"),
    ]);
  });

  it("defaults the tesseract cache outside the repo", () => {
    expect(defaultCachePath()).toBe(
      path.join(os.tmpdir(), "opencode", "tesseract-cache"),
    );
    process.env.OCR_TESSDATA_CACHE = path.join(tmpDir, "cache");
    expect(defaultCachePath()).toBe(path.join(tmpDir, "cache"));
  });

  it("ships the printed-page fixture directory name", () => {
    expect(FIXTURE_DIR).toBe("tests/fixtures/ocr");
  });
});

describe("createOcrSession", () => {
  it("creates and configures one worker with the shipped parameters", async () => {
    const worker = fakeWorker();
    mocks.createWorker.mockResolvedValue(worker);
    const cachePath = path.join(tmpDir, "cache-default");

    const session = await createOcrSession({ cachePath });

    expect(fs.existsSync(cachePath)).toBe(true);
    expect(mocks.createWorker).toHaveBeenCalledWith("eng", undefined, {
      cachePath,
      logger: expect.any(Function),
    });
    // The default logger is quiet but callable.
    const options = mocks.createWorker.mock.calls[0]![2] as {
      logger: (message: { status: string; progress: number }) => void;
    };
    expect(() => options.logger({ status: "loading", progress: 0.1 })).not.toThrow();
    expect(worker.setParameters).toHaveBeenCalledWith(OCR_WORKER_PARAMS);

    await session.terminate();
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("forwards progress and honours the language option", async () => {
    const worker = fakeWorker();
    mocks.createWorker.mockResolvedValue(worker);
    const onProgress = vi.fn();

    await createOcrSession({
      lang: "deu",
      onProgress,
      cachePath: path.join(tmpDir, "cache-fr"),
    });

    expect(mocks.createWorker).toHaveBeenCalledWith(
      "deu",
      undefined,
      expect.objectContaining({ logger: expect.any(Function) }),
    );
    const options = mocks.createWorker.mock.calls[0]![2] as {
      logger: (message: { status: string; progress: number }) => void;
    };
    options.logger({ status: "recognizing text", progress: 0.5 });
    expect(onProgress).toHaveBeenCalledWith("recognizing text", 0.5);
  });

  it("adds langPath only when the directory exists", async () => {
    mocks.createWorker.mockResolvedValue(fakeWorker());
    const langDir = path.join(tmpDir, "traineddata");
    fs.mkdirSync(langDir, { recursive: true });

    process.env.OCR_LANG_PATH = langDir;
    await createOcrSession({ cachePath: path.join(tmpDir, "cache-lang") });
    expect(mocks.createWorker.mock.calls[0]![2]).toMatchObject({ langPath: langDir });

    mocks.createWorker.mockClear();
    process.env.OCR_LANG_PATH = path.join(tmpDir, "missing-traineddata");
    await createOcrSession({ cachePath: path.join(tmpDir, "cache-nolang") });
    expect(mocks.createWorker.mock.calls[0]![2]).not.toHaveProperty("langPath");
  });

  it("recognizes with the shipped parameters and normalizes line endings", async () => {
    const worker = fakeWorker();
    mocks.createWorker.mockResolvedValue(worker);
    const session = await createOcrSession({ cachePath: path.join(tmpDir, "c1") });

    const run = await session.recognize(Buffer.from("image"));

    expect(worker.recognize).toHaveBeenCalledWith(Buffer.from("image"));
    expect(worker.setParameters).toHaveBeenCalledTimes(1); // initial configuration only
    expect(run.text).toBe("1 cup flour\n2 eggs");
    expect(run.confidence).toBe(91.5);
    expect(run.ms).toBeGreaterThanOrEqual(0);
  });

  it("falls back for missing text and confidence", async () => {
    const worker = fakeWorker();
    worker.recognize.mockResolvedValue({ data: {} });
    mocks.createWorker.mockResolvedValue(worker);
    const session = await createOcrSession({ cachePath: path.join(tmpDir, "c2") });

    const run = await session.recognize("pixels");
    expect(run.text).toBe("");
    expect(run.confidence).toBe(0);
  });

  it("merges per-run overrides, including the PSM", async () => {
    const worker = fakeWorker();
    mocks.createWorker.mockResolvedValue(worker);
    const session = await createOcrSession({ cachePath: path.join(tmpDir, "c3") });

    await session.recognize("pixels", {
      psm: "6" as never,
      params: { user_defined_dpi: "200" },
    });

    expect(worker.setParameters).toHaveBeenLastCalledWith({
      ...OCR_WORKER_PARAMS,
      user_defined_dpi: "200",
      tessedit_pageseg_mode: "6",
    });
  });

  it("keeps the shipped PSM when only params are overridden", async () => {
    const worker = fakeWorker();
    mocks.createWorker.mockResolvedValue(worker);
    const session = await createOcrSession({ cachePath: path.join(tmpDir, "c4") });

    await session.recognize("pixels", { params: { preserve_interword_spaces: "0" } });

    expect(worker.setParameters).toHaveBeenLastCalledWith({
      ...OCR_WORKER_PARAMS,
      preserve_interword_spaces: "0",
    });
  });
});

describe("ingest", () => {
  it("preprocesses the capture, recognizes it and always terminates", async () => {
    const worker = fakeWorker();
    mocks.createWorker.mockResolvedValue(worker);
    mocks.preprocessFixture.mockResolvedValue({ png: Buffer.from("png") });

    const run = await ingest({
      bytes: Buffer.from("raw"),
      mime: "image/jpeg",
      width: 1,
      height: 1,
    } as unknown as Photo);

    expect(mocks.preprocessFixture).toHaveBeenCalledWith(Buffer.from("raw"));
    expect(worker.recognize).toHaveBeenCalledWith(Buffer.from("png"));
    expect(run.text).toContain("1 cup flour");
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("terminates the worker when recognition fails", async () => {
    const worker = fakeWorker();
    worker.recognize.mockRejectedValue(new Error("engine exploded"));
    mocks.createWorker.mockResolvedValue(worker);
    mocks.preprocessFixture.mockResolvedValue({ png: Buffer.from("png") });

    await expect(
      ingest({ bytes: Buffer.from("raw") } as unknown as Photo),
    ).rejects.toThrowError("engine exploded");
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });
});
