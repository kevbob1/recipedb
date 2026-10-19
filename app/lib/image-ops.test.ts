/**
 * Pipeline tests for the shared OCR pixel operations (app/lib/image-ops.ts).
 *
 * These are pure-function tests over synthetic buffers — no tesseract, no
 * images, milliseconds to run. The real-photo coverage lives in
 * app/lib/ocr.fixtures.test.ts, which is opt-in because tesseract.js has to
 * download a model and OCR five 12MP photos.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_OCR_PREPROCESS,
  adaptiveThreshold,
  applyContrast,
  computeScale,
  otsuThreshold,
  percentileStretch,
  preprocessPixels,
  threshold,
  toGrayscale,
  unsharp,
  type PreprocessOptions,
  type RgbaImage,
} from "./image-ops";

/** Build an RGBA image from a per-pixel [r,g,b] callback. */
function makeImage(
  width: number,
  height: number,
  pixel: (x: number, y: number) => [number, number, number],
): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      const i = (y * width + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return { data, width, height };
}

const red = (img: RgbaImage, x: number, y: number): number =>
  img.data[(y * img.width + x) * 4]!;

describe("toGrayscale", () => {
  it("collapses channels to luma and keeps alpha", () => {
    const img = makeImage(2, 1, () => [255, 0, 0]);
    toGrayscale(img);
    // 0.299 * 255 = 76.2 -> 76
    expect(red(img, 0, 0)).toBe(76);
    expect(img.data[1]).toBe(img.data[0]);
    expect(img.data[2]).toBe(img.data[0]);
    expect(img.data[3]).toBe(255);
  });
});

describe("percentileStretch", () => {
  it("expands a dim, low-contrast range toward black/white", () => {
    // Values 90..110 (a photo taken in a dim room), 100 pixels each value.
    const img = makeImage(200, 10, (x) => {
      const v = 90 + Math.floor(x / 10);
      return [v, v, v];
    });
    const before = red(img, 0, 0);
    expect(before).toBe(90);
    percentileStretch(img, 0.02);
    expect(red(img, 0, 0)).toBe(0); // 90 was the low percentile
    expect(red(img, 199, 0)).toBe(255); // 109 was the high percentile
  });

  it("leaves an already high-contrast image alone", () => {
    const img = makeImage(2, 1, (x) => {
      const v = x === 0 ? 0 : 255;
      return [v, v, v];
    });
    percentileStretch(img, 0.02);
    expect(red(img, 0, 0)).toBe(0);
    expect(red(img, 1, 0)).toBe(255);
  });

  it("is a no-op when clipping is disabled", () => {
    const img = makeImage(1, 1, () => [90, 90, 90]);
    percentileStretch(img, 0);
    expect(red(img, 0, 0)).toBe(90);
  });

  it("bounds the gain on a soft photo instead of amplifying noise", () => {
    // Mirrors fixture PXL_20261019_044748065: the whole range sits in a narrow
    // band (137..193), so an unguarded stretch would apply ~4.55x and turn
    // JPEG noise into speckle that tesseract reads as text.
    const img = makeImage(200, 10, (x) => {
      const v = 137 + Math.floor(x / 4); // 137..186, plus noise handled below
      return [v, v, v];
    });
    percentileStretch(img, 0.02, 2);
    // 137 is the low percentile; a 2x gain maps 137 -> 0, and no pixel may move
    // further than the capped gain allows.
    expect(red(img, 0, 0)).toBe(0);
    const gainFromLow = (red(img, 199, 0) - 0) / (186 - 137);
    expect(gainFromLow).toBeLessThanOrEqual(2 + 0.05);
  });

  it("still applies the full stretch when the range is wide enough", () => {
    const img = makeImage(100, 2, (x) => {
      const v = x < 50 ? 60 : 200;
      return [v, v, v];
    });
    percentileStretch(img, 0.02, 99);
    expect(red(img, 0, 0)).toBe(0);
    expect(red(img, 99, 0)).toBe(255);
  });
});

describe("applyContrast", () => {
  it("pushes values away from mid-gray and pins 128", () => {
    const img = makeImage(3, 1, (x) => {
      const v = [100, 128, 200][x]!;
      return [v, v, v];
    });
    applyContrast(img, 2);
    expect(red(img, 0, 0)).toBe(72); // 128 + (100-128)*2
    expect(red(img, 1, 0)).toBe(128);
    expect(red(img, 2, 0)).toBe(255); // clamped
  });
});

describe("unsharp", () => {
  it("keeps flat regions flat and reinforces a lone dark pixel", () => {
    const flat = makeImage(3, 3, () => [200, 200, 200]);
    unsharp(flat, 1);
    expect(red(flat, 1, 1)).toBe(200);

    // 5x5: the dark pixel at (2,2) only reaches the neighbourhoods of (1..3,
    // 1..3). A corner's 3x3 box never contains it, so corners stay flat while
    // the centre is pushed darker.
    const single = makeImage(5, 5, (x, y) =>
      x === 2 && y === 2 ? [50, 50, 50] : [200, 200, 200],
    );
    unsharp(single, 1);
    expect(red(single, 2, 2)).toBe(0); // 50 + (50 - 183.9) clamps to black
    expect(red(single, 0, 0)).toBe(200); // neighbourhood is all background
    expect(red(single, 1, 1)).toBe(217); // background neighbour of ink: lifted
    expect(red(single, 4, 4)).toBe(200);
  });
});

describe("otsuThreshold", () => {
  it("splits a bimodal histogram between the two peaks", () => {
    // 50 pixels at 30, 50 at 220.
    const img = makeImage(100, 1, (x) => {
      const v = x < 50 ? 30 : 220;
      return [v, v, v];
    });
    const value = otsuThreshold(img);
    expect(value).toBeGreaterThanOrEqual(30);
    expect(value).toBeLessThan(220);
  });
});

describe("threshold", () => {
  it("binarizes to 0/255", () => {
    const img = makeImage(2, 1, (x) => {
      const v = x === 0 ? 10 : 250;
      return [v, v, v];
    });
    threshold(img, 128);
    expect(red(img, 0, 0)).toBe(0);
    expect(red(img, 1, 0)).toBe(255);
  });
});

describe("adaptiveThreshold", () => {
  it("finds ink under a strong background gradient where a global cut cannot", () => {
    // Background ramps 60 -> 200 left to right; a dark bar sits at x=20 and at
    // x=180 (same ink, very different background). Global thresholding can only
    // catch one of them.
    const img = makeImage(200, 40, (x) => {
      const background = 60 + Math.round((x / 199) * 140);
      const isInk = x === 20 || x === 180;
      const v = isInk ? 40 : background;
      return [v, v, v];
    });
    const global = otsuThreshold(img);
    adaptiveThreshold(img, 31, 10);
    expect(red(img, 20, 20)).toBe(0);
    expect(red(img, 180, 20)).toBe(0);
    // Ink far from the global cut (40 < global) is only caught adaptively when
    // the local background is bright, which is the whole point.
    expect(global).toBeLessThan(200);
  });
});

describe("computeScale", () => {
  it("brings the short side to the target resolution", () => {
    // 4032x3024 phone photo -> short side 2400.
    const scale = computeScale(4032, 3024, DEFAULT_OCR_PREPROCESS);
    expect(Math.round(3024 * scale)).toBe(2400);
  });

  it("upscales a small image", () => {
    const scale = computeScale(800, 600, DEFAULT_OCR_PREPROCESS);
    expect(Math.round(600 * scale)).toBe(2400);
  });

  it("clamps the long side to maxLongSide", () => {
    const options: PreprocessOptions = {
      ...DEFAULT_OCR_PREPROCESS,
      targetShortSide: 2400,
      maxLongSide: 2000,
    };
    const scale = computeScale(4000, 1000, options);
    // Short-side target would give 2.4x (9600 long side) -> clamped to 2000/4000.
    expect(scale).toBeCloseTo(0.5, 5);
  });

  it("returns 1 for a degenerate image", () => {
    expect(computeScale(0, 0)).toBe(1);
  });
});

describe("preprocessPixels", () => {
  it("produces only 0/255 when a threshold mode is selected", () => {
    const img = makeImage(32, 32, (x, y) => {
      const v = (x + y) % 2 === 0 ? 90 : 140;
      return [v, v, v];
    });
    preprocessPixels(img, { ...DEFAULT_OCR_PREPROCESS, threshold: "otsu" });
    const values = new Set<number>();
    for (let i = 0; i < img.data.length; i += 4) values.add(img.data[i]!);
    expect([...values].sort((a, b) => a - b)).toEqual([0, 255]);
  });

  it("grayscales colour casts even with normalization disabled", () => {
    const img = makeImage(4, 4, () => [200, 60, 20]); // warm indoor cast
    preprocessPixels(img, {
      ...DEFAULT_OCR_PREPROCESS,
      normalize: 0,
      contrast: 1,
      sharpen: 0,
      threshold: "none",
    });
    expect(img.data[0]).toBe(img.data[1]);
    expect(img.data[1]).toBe(img.data[2]);
  });
});
