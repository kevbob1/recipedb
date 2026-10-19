/**
 * Pure pixel-level image operations for OCR preprocessing.
 *
 * This module is deliberately dependency-free: no DOM and no Node imports.
 * The browser path (app/lib/image-preprocess.ts) decodes/encodes with a
 * canvas and calls `preprocessPixels`; the Node tuning harness
 * (app/lib/ocr-node.server.ts) decodes/encodes with `sharp` and calls the very
 * same `preprocessPixels`. Sharing the pipeline is the point — otherwise the
 * parameters Kevin tunes from the command line would not be the parameters
 * the browser actually runs.
 *
 * Phone photos of printed recipe pages are the target: small print, uneven
 * indoor lighting, mild blur. The pipeline is therefore
 * grayscale -> percentile normalize -> contrast -> unsharp -> (optional)
 * threshold, in that order (sharpening before thresholding keeps thin strokes
 * from being eaten).
 */

/** A decoded image in RGBA byte order, one byte per channel, 4 bytes/pixel. */
export interface RgbaImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export type ThresholdMode = "none" | "otsu" | "adaptive";

export interface PreprocessOptions {
  /** Target length of the image's *short* side, in pixels. Upscales small print. */
  targetShortSide: number;
  /** Hard cap for the *long* side, in pixels (keeps memory/CPU bounded). */
  maxLongSide: number;
  /** Convert to luminance (tesseract binarizes internally anyway; this removes colour casts). */
  grayscale: boolean;
  /**
   * Histogram percentile clip for the normalize step: the 0..1 fraction of
   * pixels saturated to pure black/white before a linear stretch. 0 (the
   * default) disables it — see the DEFAULT_OCR_PREPROCESS note for why.
   */
  normalize: number;
  /**
   * Ceiling on the contrast gain the normalize step may apply.
   *
   * Only relevant when `normalize > 0`. Measured: fixture
   * PXL_20261019_044748065 is a soft phone shot whose entire grayscale range is
   * p2=137 .. p98=193, so an unguarded stretch applied a 4.55x gain and turned
   * paper texture and JPEG noise into speckle (confidence 87 -> 20, 5400
   * characters of line noise, 23s). The cap bounds that — though at 2x it still
   * loses on that fixture, which is why the step is off by default.
   */
  normalizeMaxGain: number;
  /** Contrast multiplier around mid-gray. 1 disables. */
  contrast: number;
  /** Unsharp-mask amount (0..2). 0 disables. */
  sharpen: number;
  threshold: ThresholdMode;
  /** Odd window size for the adaptive (local mean) threshold. */
  adaptiveWindow: number;
  /** Bias subtracted from the local mean for the adaptive threshold. */
  adaptiveC: number;
}

/**
 * Defaults chosen for phone photos of printed pages. Overridable per call so
 * `scripts/ocr-tune.ts` can sweep them without touching this file.
 *
 * These were picked by measurement over tests/fixtures/ocr (5 x 12MP phone
 * photos of printed pages) — see the `=== mean per variant ===` table the
 * tuning script prints. What the fixtures say, including the surprises:
 *   - tesseract is already accurate on these photos (conf 87-93 on raw bytes).
 *     The risk here is making them *worse*, so every default is conservative.
 *   - rescaling to a 2400px short side is 20-40% FASTER (~0.7-1.8s vs
 *     0.9-2.5s) with the same text — it normalizes the 12MP input, it does not
 *     cost accuracy.
 *   - grayscale + unsharp + mild contrast are neutral (mean score 0.972 vs
 *     0.972 raw) and faster.
 *   - the percentile stretch is DANGEROUS on soft photos and is therefore off
 *     by default: on PXL_20261019_044748065 (grayscale range p2=137..p98=193)
 *     it blew the image into speckle — tesseract's confidence fell 87 -> 20,
 *     emitted 5400 characters of line noise and took 23s instead of 0.7s.
 *     Capping the gain at 2x did NOT rescue it, so `normalize` stays available
 *     as a knob for genuinely dim, wide-range photos rather than a default.
 *   - global (otsu) and local (adaptive) binarization both LOSE here (adaptive:
 *     confidence ~20-50, 2-70s). Kept for degraded scans, not as defaults.
 */
export const DEFAULT_OCR_PREPROCESS: PreprocessOptions = {
  targetShortSide: 2400,
  maxLongSide: 3600,
  grayscale: true,
  normalize: 0,
  normalizeMaxGain: 2,
  contrast: 1.15,
  sharpen: 0.6,
  threshold: "none",
  adaptiveWindow: 31,
  adaptiveC: 10,
};

const clamp255 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v);

/** Luma weights (Rec. 601), matching what most OCR pipelines assume. */
export function toGrayscale(img: RgbaImage): void {
  const { data } = img;
  for (let i = 0; i < data.length; i += 4) {
    const y = 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!;
    const v = clamp255(Math.round(y));
    data[i] = v;
    data[i + 1] = v;
    data[i + 2] = v;
  }
}

/**
 * Linear histogram stretch between the `clip`-th and (1 - `clip`)-th
 * percentiles, measured on the red channel (call after `toGrayscale`).
 *
 * `maxGain` bounds how much contrast the stretch is allowed to invent — see
 * `PreprocessOptions.normalizeMaxGain` for the measurement that motivates it.
 */
export function percentileStretch(
  img: RgbaImage,
  clip = 0.02,
  maxGain = DEFAULT_OCR_PREPROCESS.normalizeMaxGain,
): void {
  if (clip <= 0) return;
  const { data } = img;
  const histogram = new Uint32Array(256);
  for (let i = 0; i < data.length; i += 4) histogram[data[i]!]!++;

  const total = data.length / 4;
  const cut = Math.floor(total * clip);
  let low = 0;
  for (let acc = 0, v = 0; v < 256; v++) {
    acc += histogram[v]!;
    if (acc > cut) {
      low = v;
      break;
    }
  }
  let high = 255;
  for (let acc = 0, v = 255; v >= 0; v--) {
    acc += histogram[v]!;
    if (acc > cut) {
      high = v;
      break;
    }
  }
  if (high - low < 8) return; // already high-contrast; nothing safe to gain

  const scale = Math.min(255 / (high - low), Math.max(1, maxGain));
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) lut[v] = clamp255(Math.round((v - low) * scale));
  for (let i = 0; i < data.length; i += 4) {
    const v = lut[data[i]!]!;
    data[i] = v;
    data[i + 1] = v;
    data[i + 2] = v;
  }
}

/** Multiply contrast around mid-gray: `out = 128 + (v - 128) * factor`. */
export function applyContrast(img: RgbaImage, factor: number): void {
  if (factor === 1) return;
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) lut[v] = clamp255(Math.round(128 + (v - 128) * factor));
  const { data } = img;
  for (let i = 0; i < data.length; i += 4) {
    const v = lut[data[i]!]!;
    data[i] = v;
    data[i + 1] = v;
    data[i + 2] = v;
  }
}

/**
 * 3x3 unsharp mask on the red channel: `out = v + amount * (v - boxBlur3(v))`.
 * Rescues the soft strokes of handheld phone shots.
 */
export function unsharp(img: RgbaImage, amount: number): void {
  if (amount <= 0) return;
  const { width, height } = img;
  const src = new Uint8ClampedArray(img.data);
  const out = img.data;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      let count = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= width) continue;
          sum += src[(yy * width + xx) * 4]!;
          count++;
        }
      }
      const i = (y * width + x) * 4;
      const v = src[i]!;
      const sharpened = clamp255(Math.round(v + amount * (v - sum / count)));
      out[i] = sharpened;
      out[i + 1] = sharpened;
      out[i + 2] = sharpened;
    }
  }
}

/** Otsu's method: the between-class-variance-maximizing split of the histogram. */
export function otsuThreshold(img: RgbaImage): number {
  const { data } = img;
  const histogram = new Uint32Array(256);
  for (let i = 0; i < data.length; i += 4) histogram[data[i]!]!++;

  const total = data.length / 4;
  let sum = 0;
  for (let v = 0; v < 256; v++) sum += v * histogram[v]!;

  let sumB = 0;
  let weightB = 0;
  let best = 0;
  let bestVariance = -1;
  for (let v = 0; v < 256; v++) {
    weightB += histogram[v]!;
    if (weightB === 0) continue;
    const weightF = total - weightB;
    if (weightF === 0) break;
    sumB += v * histogram[v]!;
    const meanB = sumB / weightB;
    const meanF = (sum - sumB) / weightF;
    const variance = weightB * weightF * (meanB - meanF) ** 2;
    if (variance > bestVariance) {
      bestVariance = variance;
      best = v;
    }
  }
  return best;
}

/** Global binarization at a fixed threshold. */
export function threshold(img: RgbaImage, value: number): void {
  const { data } = img;
  for (let i = 0; i < data.length; i += 4) {
    const v = data[i]! > value ? 255 : 0;
    data[i] = v;
    data[i + 1] = v;
    data[i + 2] = v;
  }
}

/**
 * Local-mean (adaptive) binarization via an integral image: a pixel is ink when
 * it is darker than the mean of its `windowSize` neighbourhood minus `c`.
 * Survives the page-curvature/shadow gradient that defeats a global threshold.
 */
export function adaptiveThreshold(
  img: RgbaImage,
  windowSize = 31,
  c = 10,
): void {
  const { data, width, height } = img;
  const stride = width + 1;
  // Worst case sum = 255 * w * h; Uint32 holds that for images under ~16.8M px.
  const integral = new Uint32Array(stride * (height + 1));
  for (let y = 0; y < height; y++) {
    let rowSum = 0;
    for (let x = 0; x < width; x++) {
      rowSum += data[(y * width + x) * 4]!;
      integral[(y + 1) * stride + (x + 1)] = integral[y * stride + (x + 1)]! + rowSum;
    }
  }

  const half = Math.max(1, Math.floor(windowSize / 2));
  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - half);
    const y1 = Math.min(height - 1, y + half);
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - half);
      const x1 = Math.min(width - 1, x + half);
      const area = (x1 - x0 + 1) * (y1 - y0 + 1);
      const sum =
        integral[(y1 + 1) * stride + (x1 + 1)]! -
        integral[y0 * stride + (x1 + 1)]! -
        integral[(y1 + 1) * stride + x0]! +
        integral[y0 * stride + x0]!;
      const mean = sum / area;
      const i = (y * width + x) * 4;
      const v = data[i]! < mean - c ? 0 : 255;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
    }
  }
}

/**
 * Run the shared OCR preprocessing pipeline in place. Both the browser and the
 * Node harness call exactly this, so a parameter tuned in one is the parameter
 * the other uses.
 */
export function preprocessPixels(
  img: RgbaImage,
  options: PreprocessOptions = DEFAULT_OCR_PREPROCESS,
): RgbaImage {
  if (options.grayscale) toGrayscale(img);
  if (options.normalize > 0) {
    percentileStretch(img, options.normalize, options.normalizeMaxGain);
  }
  if (options.contrast !== 1) applyContrast(img, options.contrast);
  if (options.sharpen > 0) unsharp(img, options.sharpen);
  if (options.threshold === "otsu") threshold(img, otsuThreshold(img));
  else if (options.threshold === "adaptive") {
    adaptiveThreshold(img, options.adaptiveWindow, options.adaptiveC);
  }
  return img;
}

/**
 * Scale factor that brings an image to the OCR target resolution: the short
 * side lands on `targetShortSide`, and the long side is clamped to
 * `maxLongSide`. Returns 1 when the image is already in range.
 */
export function computeScale(
  width: number,
  height: number,
  options: PreprocessOptions = DEFAULT_OCR_PREPROCESS,
): number {
  const shortSide = Math.min(width, height);
  const longSide = Math.max(width, height);
  if (shortSide <= 0 || longSide <= 0) return 1;
  let scale = options.targetShortSide / shortSide;
  if (longSide * scale > options.maxLongSide) scale = options.maxLongSide / longSide;
  return scale;
}
