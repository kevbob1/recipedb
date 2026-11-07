/**
 * Browser OCR preprocessing (canvas path).
 *
 * Node has no canvas, so the DOM surface is faked: `createImageBitmap`,
 * `OffscreenCanvas`/`document.createElement("canvas")`, `Image` and the object
 * URL functions. The pixel pipeline itself is the real shared one from
 * image-ops, and the encoded output is the real Blob.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_OCR_PREPROCESS } from "./image-ops";
import { preprocessImageBlob, tryPreprocessImageBlob } from "./image-preprocess";

const OPTIONS = {
  ...DEFAULT_OCR_PREPROCESS,
  targetShortSide: 8,
  maxLongSide: 16,
  normalize: 0,
  contrast: 1,
  sharpen: 0,
  threshold: "none" as const,
};

interface FakeBitmap {
  width: number;
  height: number;
  close: ReturnType<typeof vi.fn>;
}

function bitmap(width: number, height: number): FakeBitmap {
  return { width, height, close: vi.fn() };
}

interface FakeContext {
  imageSmoothingEnabled: boolean;
  imageSmoothingQuality: string;
  drawImage: ReturnType<typeof vi.fn>;
  getImageData: ReturnType<typeof vi.fn>;
  putImageData: ReturnType<typeof vi.fn>;
}

function fakeContext(): FakeContext {
  return {
    imageSmoothingEnabled: false,
    imageSmoothingQuality: "low",
    drawImage: vi.fn(),
    getImageData: vi.fn((_x: number, _y: number, w: number, h: number) => {
      const data = new Uint8ClampedArray(w * h * 4);
      for (let i = 0; i < data.length; i++) data[i] = (i * 37) % 256;
      return { data, width: w, height: h };
    }),
    putImageData: vi.fn(),
  };
}

interface FakeCanvas {
  width: number;
  height: number;
  ctx: FakeContext | null;
  getContext: ReturnType<typeof vi.fn>;
  convertToBlob?: ReturnType<typeof vi.fn>;
}

/** A constructible OffscreenCanvas stand-in (the module calls `new`). */
function offscreenCanvasClass(
  created: FakeCanvas[],
  ctx: FakeContext | null = fakeContext(),
) {
  return class FakeOffscreenCanvas implements FakeCanvas {
    width: number;
    height: number;
    ctx: FakeContext | null;
    getContext: ReturnType<typeof vi.fn>;
    convertToBlob: ReturnType<typeof vi.fn>;

    constructor(width: number, height: number) {
      this.width = width;
      this.height = height;
      this.ctx = ctx;
      this.getContext = vi.fn(() => this.ctx);
      this.convertToBlob = vi.fn(async (opts: { type: string }) => {
        return new Blob(["png"], { type: opts.type });
      });
      created.push(this);
    }
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("preprocessImageBlob", () => {
  it("decodes, rescales, runs the shared pixel pipeline and encodes a PNG", async () => {
    const source = bitmap(4, 2);
    const createImageBitmap = vi.fn(async () => source);
    const created: FakeCanvas[] = [];
    vi.stubGlobal("createImageBitmap", createImageBitmap);
    vi.stubGlobal("OffscreenCanvas", offscreenCanvasClass(created));

    const result = await preprocessImageBlob(new Blob(["x"]), OPTIONS);

    expect(createImageBitmap).toHaveBeenCalledWith(expect.any(Blob), {
      imageOrientation: "from-image",
    });
    // 4x2 with an 8px short side -> 16x8 (long side cap 16).
    expect(result.width).toBe(16);
    expect(result.height).toBe(8);
    expect(result.scale).toBe(4);
    expect(result.blob.type).toBe("image/png");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(source.close).toHaveBeenCalledTimes(1);

    const canvas = created[0]!;
    expect(canvas.ctx?.drawImage).toHaveBeenCalledWith(source, 0, 0, 16, 8);
    expect(canvas.ctx?.putImageData).toHaveBeenCalledTimes(1);
    expect(canvas.convertToBlob).toHaveBeenCalledWith({ type: "image/png" });
  });

  it("rejects a decoded image with no pixels and closes the bitmap", async () => {
    const source = bitmap(0, 10);
    vi.stubGlobal("createImageBitmap", vi.fn(async () => source));
    vi.stubGlobal("OffscreenCanvas", offscreenCanvasClass([], null));

    await expect(preprocessImageBlob(new Blob(["x"]), OPTIONS)).rejects.toThrowError(
      "image-preprocess: decoded image has no pixels",
    );
    expect(source.close).toHaveBeenCalled();
  });

  it("rejects when the canvas cannot give a 2d context", async () => {
    const source = bitmap(4, 4);
    vi.stubGlobal("createImageBitmap", vi.fn(async () => source));
    vi.stubGlobal("OffscreenCanvas", offscreenCanvasClass([], null));

    await expect(preprocessImageBlob(new Blob(["x"]), OPTIONS)).rejects.toThrowError(
      "image-preprocess: 2d canvas context unavailable",
    );
    expect(source.close).toHaveBeenCalled();
  });

  it("falls back to an <img> when createImageBitmap cannot decode", async () => {
    const source = bitmap(4, 4);
    const createImageBitmap = vi
      .fn()
      .mockRejectedValueOnce(new Error("unsupported"))
      .mockResolvedValueOnce(source);
    vi.stubGlobal("createImageBitmap", createImageBitmap);

    class FakeImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) {
        queueMicrotask(() => this.onload?.());
      }
    }
    vi.stubGlobal("Image", FakeImage);
    const createObjectURL = vi.fn(() => "blob:fake");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    const created: FakeCanvas[] = [];
    vi.stubGlobal("OffscreenCanvas", offscreenCanvasClass(created));

    const result = await preprocessImageBlob(new Blob(["x"]), OPTIONS);

    expect(createObjectURL).toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalledWith(
      createObjectURL.mock.results[0]!.value,
    );
    expect(createImageBitmap).toHaveBeenLastCalledWith(expect.any(FakeImage));
    expect(result.width).toBe(8);
  });

  it("reports an <img> decode failure to the caller", async () => {
    const createImageBitmap = vi.fn().mockRejectedValue(new Error("unsupported"));
    vi.stubGlobal("createImageBitmap", createImageBitmap);
    class BrokenImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) {
        queueMicrotask(() => this.onerror?.());
      }
    }
    vi.stubGlobal("Image", BrokenImage);
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => "blob:fake"),
      revokeObjectURL: vi.fn(),
    });

    await expect(preprocessImageBlob(new Blob(["x"]), OPTIONS)).rejects.toThrowError(
      "image-preprocess: image decode failed",
    );
  });

  it("uses a document canvas when OffscreenCanvas is missing", async () => {
    const source = bitmap(2, 2);
    vi.stubGlobal("createImageBitmap", vi.fn(async () => source));
    vi.stubGlobal("OffscreenCanvas", undefined);

    const ctx = fakeContext();
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => ctx),
      toBlob: vi.fn((cb: (blob: Blob | null) => void) => {
        cb(new Blob(["png"], { type: "image/png" }));
      }),
    };
    vi.stubGlobal("document", { createElement: vi.fn(() => canvas) });

    const result = await preprocessImageBlob(new Blob(["x"]), OPTIONS);
    expect(canvas.width).toBe(8);
    expect(canvas.height).toBe(8);
    expect(canvas.toBlob).toHaveBeenCalledWith(expect.any(Function), "image/png");
    expect(result.blob.type).toBe("image/png");
  });

  it("rejects when the document canvas cannot encode", async () => {
    const source = bitmap(2, 2);
    vi.stubGlobal("createImageBitmap", vi.fn(async () => source));
    vi.stubGlobal("OffscreenCanvas", undefined);
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => fakeContext()),
      toBlob: vi.fn((cb: (blob: Blob | null) => void) => cb(null)),
    };
    vi.stubGlobal("document", { createElement: vi.fn(() => canvas) });

    await expect(preprocessImageBlob(new Blob(["x"]), OPTIONS)).rejects.toThrowError(
      "image-preprocess: canvas encode failed",
    );
  });

  it("rejects when there is no canvas implementation at all", async () => {
    const source = bitmap(2, 2);
    vi.stubGlobal("createImageBitmap", vi.fn(async () => source));
    vi.stubGlobal("OffscreenCanvas", undefined);
    vi.stubGlobal("document", undefined);

    await expect(preprocessImageBlob(new Blob(["x"]), OPTIONS)).rejects.toThrowError(
      "image-preprocess: no canvas implementation available",
    );
  });
});

describe("tryPreprocessImageBlob", () => {
  it("returns the preprocessed result and reports the path taken", async () => {
    const source = bitmap(4, 4);
    vi.stubGlobal("createImageBitmap", vi.fn(async () => source));
    vi.stubGlobal("OffscreenCanvas", offscreenCanvasClass([]));

    const outcome = await tryPreprocessImageBlob(new Blob(["x"]), OPTIONS);
    expect(outcome.preprocessed).toBe(true);
    expect(outcome.error).toBeUndefined();
    expect(outcome.result.blob.type).toBe("image/png");
  });

  it("falls back to the raw bytes instead of failing the import", async () => {
    vi.stubGlobal("createImageBitmap", vi.fn(async () => bitmap(0, 0)));
    vi.stubGlobal("OffscreenCanvas", offscreenCanvasClass([], null));
    const blob = new Blob(["raw-bytes"]);

    const outcome = await tryPreprocessImageBlob(blob, OPTIONS);
    expect(outcome.preprocessed).toBe(false);
    expect(outcome.result.blob).toBe(blob);
    expect(outcome.result.width).toBe(0);
    expect(outcome.result.scale).toBe(1);
    expect(outcome.error).toBeInstanceOf(Error);
  });

  it("wraps a non-Error rejection", async () => {
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => {
        throw "boom";
      }),
    );
    class ThrowingImage {
      constructor() {
        throw "boom";
      }
    }
    vi.stubGlobal("Image", ThrowingImage);
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => "blob:fake"),
      revokeObjectURL: vi.fn(),
    });

    const outcome = await tryPreprocessImageBlob(new Blob(["x"]), OPTIONS);
    expect(outcome.preprocessed).toBe(false);
    expect(outcome.error?.message).toBe("boom");
  });
});
