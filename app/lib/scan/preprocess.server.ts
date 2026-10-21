/**
 * Scan module: preprocess — the Node twin of the browser canvas pipeline.
 *
 * `preprocessPixels` and `DEFAULT_OCR_PREPROCESS` are NOT owned here: they live
 * in app/lib/image-ops.ts, the shared tuning contract that the browser
 * (app/lib/image-preprocess.ts) and this Node path both run. Moving them would
 * split the one thing that must stay identical, so this module only re-exports
 * them and adds the sharp-specific decode/rescale/encode around them.
 *
 * NODE ONLY: `sharp` is a native addon and cannot enter the client bundle; the
 * browser pipeline stays in app/lib/image-preprocess.ts (see its seam note).
 */
import sharp from "sharp";
import {
  DEFAULT_OCR_PREPROCESS,
  computeScale,
  preprocessPixels,
  type PreprocessOptions,
  type RgbaImage,
} from "../image-ops";

export { DEFAULT_OCR_PREPROCESS, computeScale, preprocessPixels };
export type { PreprocessOptions, RgbaImage };
export type { ThresholdMode } from "../image-ops";

export interface PreprocessedFixture {
  /** Lossless PNG of the preprocessed image. */
  png: Buffer;
  width: number;
  height: number;
  scale: number;
}

/**
 * Decode a capture with sharp (honouring EXIF orientation, like the browser
 * `createImageBitmap({imageOrientation: "from-image"})`), rescale with
 * lanczos3, then run the shared pixel pipeline and re-encode losslessly.
 *
 * Accepts a file path or raw bytes: `reocrRecipe` reads the retained capture
 * itself (so a deleted capture is one deterministic error, not a race), and the
 * tuning harness passes paths.
 *
 * `resize: false` keeps the source resolution and runs only the pixel pipeline
 * — the knob that separates "the rescale hurt" from "the contrast / normalize /
 * sharpen hurt" when tuning.
 */
export async function preprocessFixture(
  source: Buffer | string,
  options: PreprocessOptions = DEFAULT_OCR_PREPROCESS,
  resize = true,
): Promise<PreprocessedFixture> {
  const metadata = await sharp(source).metadata();
  const srcWidth = metadata.width ?? 0;
  const srcHeight = metadata.height ?? 0;
  if (srcWidth === 0 || srcHeight === 0) {
    throw new Error("scan/preprocess: could not read image dimensions");
  }

  // `.rotate()` with no argument applies EXIF orientation (which is why the
  // source dimensions above are only used for the scale decision).
  const scale = resize ? computeScale(srcWidth, srcHeight, options) : 1;
  const width = Math.max(1, Math.round(srcWidth * scale));
  const height = Math.max(1, Math.round(srcHeight * scale));

  const { data, info } = await sharp(source)
    .rotate()
    .resize(width, height, { kernel: "lanczos3" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const image: RgbaImage = {
    data: new Uint8ClampedArray(data),
    width: info.width,
    height: info.height,
  };
  preprocessPixels(image, options);

  const png = await sharp(Buffer.from(image.data), {
    raw: { width: info.width, height: info.height, channels: 4 },
  })
    .png()
    .toBuffer();

  return { png, width: info.width, height: info.height, scale };
}

/** Auto-orient only — the "cheap fixes, no rescale/contrast" control variant. */
export async function autoOrientOnly(source: Buffer | string): Promise<Buffer> {
  return sharp(source).rotate().png().toBuffer();
}
