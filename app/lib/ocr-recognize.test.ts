/**
 * recognizeText — the browser OCR entry point.
 *
 * The tesseract worker and canvas preprocessing are mocked; asserted here are
 * the engine parameters, the preprocess/no-preprocess switch, the object-URL
 * lifecycle and guaranteed termination.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createWorker: vi.fn(),
  tryPreprocess: vi.fn(),
}));

vi.mock("tesseract.js", () => ({
  createWorker: mocks.createWorker,
  PSM: { AUTO: "3", SINGLE_BLOCK: "6" },
}));
vi.mock("./image-preprocess", () => ({
  tryPreprocessImageBlob: mocks.tryPreprocess,
}));

import { DEFAULT_OCR_PREPROCESS } from "./image-ops";
import { OCR_WORKER_PARAMS, recognizeText } from "./ocr";

function fakeWorker(text = "1 cup flour\r\n2 eggs") {
  return {
    setParameters: vi.fn(async () => {}),
    recognize: vi.fn(async () => ({ data: { text } })),
    terminate: vi.fn(async () => {}),
  };
}

let createObjectURL: ReturnType<typeof vi.fn>;
let revokeObjectURL: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mocks.createWorker.mockReset();
  mocks.tryPreprocess.mockReset();
  createObjectURL = vi.fn(() => "blob:preprocessed");
  revokeObjectURL = vi.fn();
  vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("recognizeText", () => {
  it("preprocesses by default, runs the shipped parameters and cleans up", async () => {
    const worker = fakeWorker();
    mocks.createWorker.mockResolvedValue(worker);
    const blob = new Blob(["raw"]);
    const processed = new Blob(["preprocessed"]);
    mocks.tryPreprocess.mockResolvedValue({
      result: { blob: processed, width: 10, height: 4, scale: 2, durationMs: 3 },
      preprocessed: true,
    });

    const text = await recognizeText(blob);

    expect(text).toBe("1 cup flour\n2 eggs");
    expect(mocks.tryPreprocess).toHaveBeenCalledWith(blob, DEFAULT_OCR_PREPROCESS);
    expect(mocks.createWorker).toHaveBeenCalledWith("eng", undefined, {
      logger: expect.any(Function),
    });
    expect(worker.setParameters).toHaveBeenCalledWith(OCR_WORKER_PARAMS);
    expect(createObjectURL).toHaveBeenCalledWith(processed);
    expect(worker.recognize).toHaveBeenCalledWith("blob:preprocessed");
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:preprocessed");
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("skips preprocessing and forwards options when asked", async () => {
    const worker = fakeWorker();
    mocks.createWorker.mockResolvedValue(worker);
    const onProgress = vi.fn();
    const blob = new Blob(["raw"]);
    const custom = { ...DEFAULT_OCR_PREPROCESS, targetShortSide: 1200 };

    const text = await recognizeText(blob, {
      preprocess: false,
      preprocessOptions: custom,
      psm: "6" as never,
      lang: "deu",
      onProgress,
    });

    expect(text).toBe("1 cup flour\n2 eggs");
    expect(mocks.tryPreprocess).not.toHaveBeenCalled();
    expect(mocks.createWorker).toHaveBeenCalledWith("deu", undefined, {
      logger: expect.any(Function),
    });
    const logger = (mocks.createWorker.mock.calls[0]![2] as {
      logger: (message: { status: string; progress: number }) => void;
    }).logger;
    logger({ status: "recognizing text", progress: 0.4 });
    expect(onProgress).toHaveBeenCalledWith("recognizing text", 0.4);

    expect(worker.setParameters).toHaveBeenCalledWith({
      ...OCR_WORKER_PARAMS,
      tessedit_pageseg_mode: "6",
    });
    expect(createObjectURL).toHaveBeenCalledWith(blob);
  });

  it("passes custom preprocessing options through", async () => {
    const worker = fakeWorker();
    mocks.createWorker.mockResolvedValue(worker);
    mocks.tryPreprocess.mockResolvedValue({
      result: { blob: new Blob(["p"]), width: 1, height: 1, scale: 1, durationMs: 0 },
      preprocessed: true,
    });
    const custom = { ...DEFAULT_OCR_PREPROCESS, targetShortSide: 1200 };

    await recognizeText(new Blob(["raw"]), { preprocessOptions: custom });
    expect(mocks.tryPreprocess).toHaveBeenCalledWith(expect.any(Blob), custom);
  });

  it("terminates the worker when recognition fails", async () => {
    const worker = fakeWorker();
    worker.recognize.mockRejectedValue(new Error("wasm crashed"));
    mocks.createWorker.mockResolvedValue(worker);
    mocks.tryPreprocess.mockResolvedValue({
      result: { blob: new Blob(["p"]), width: 1, height: 1, scale: 1, durationMs: 0 },
      preprocessed: true,
    });

    await expect(recognizeText(new Blob(["raw"]))).rejects.toThrowError("wasm crashed");
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalled();
  });

  it("uses the raw bytes when preprocessing was unavailable", async () => {
    const worker = fakeWorker("");
    mocks.createWorker.mockResolvedValue(worker);
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => "blob:raw"),
      revokeObjectURL: vi.fn(),
    });
    const fallback = new Blob(["raw"]);
    mocks.tryPreprocess.mockResolvedValue({
      result: { blob: fallback, width: 0, height: 0, scale: 1, durationMs: 0 },
      preprocessed: false,
      error: new Error("no canvas"),
    });

    expect(await recognizeText(new Blob(["raw"]))).toBe("");
  });
});
