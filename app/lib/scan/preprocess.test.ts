/**
 * Node twin of the OCR preprocessing pipeline (sharp decode/rescale/encode).
 *
 * Runs for real on a tiny synthetic image — sharp is a direct dependency and
 * works offline. The pixel work itself is covered by image-ops.test.ts; here we
 * pin the sharp-specific contract: EXIF rotate, short-side scale, lossless PNG,
 * and the resize control knob.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DEFAULT_OCR_PREPROCESS } from "../image-ops";
import { autoOrientOnly, preprocessFixture } from "./preprocess.server";

const OPTIONS = {
  ...DEFAULT_OCR_PREPROCESS,
  targetShortSide: 16,
  maxLongSide: 32,
  normalize: 0,
  contrast: 1,
  sharpen: 0,
  threshold: "none" as const,
};

let tmpDir: string;
let sourcePng: Buffer;
let sourcePath: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "recipedb-preprocess-"));
  sourcePng = await sharp({
    create: { width: 8, height: 4, channels: 3, background: { r: 120, g: 140, b: 160 } },
  })
    .png()
    .toBuffer();
  sourcePath = path.join(tmpDir, "capture.png");
  fs.writeFileSync(sourcePath, sourcePng);
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("preprocessFixture", () => {
  it("rescales from raw bytes and returns a lossless PNG", async () => {
    const result = await preprocessFixture(sourcePng, OPTIONS);

    // 8x4 with a 16px short side -> 32x16 (long side cap 32).
    expect(result.width).toBe(32);
    expect(result.height).toBe(16);
    expect(result.scale).toBe(4);

    const metadata = await sharp(result.png).metadata();
    expect(metadata.format).toBe("png");
    expect(metadata.width).toBe(32);
    expect(metadata.height).toBe(16);
  });

  it("accepts a file path, as the tuning harness passes one", async () => {
    const result = await preprocessFixture(sourcePath, OPTIONS, false);
    expect(result.width).toBe(8);
    expect(result.height).toBe(4);
    expect(result.scale).toBe(1);
    expect(result.png.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  });

  it("caps the long side while keeping the aspect ratio", async () => {
    const tall = await sharp({
      create: { width: 4, height: 40, channels: 3, background: { r: 10, g: 20, b: 30 } },
    })
      .png()
      .toBuffer();

    const result = await preprocessFixture(tall, OPTIONS);
    // Short side 4 -> 16 would make the long side 160; the cap wins.
    expect(result.width).toBe(3);
    expect(result.height).toBe(32);
    expect(result.scale).toBe(0.8);
  });

  it("rejects bytes that are not an image", async () => {
    await expect(preprocessFixture(Buffer.from("not an image"), OPTIONS)).rejects.toThrow();
  });
});

describe("autoOrientOnly", () => {
  it("returns a PNG at the source resolution", async () => {
    const png = await autoOrientOnly(sourcePng);
    const metadata = await sharp(png).metadata();
    expect(metadata.format).toBe("png");
    expect(metadata.width).toBe(8);
    expect(metadata.height).toBe(4);
  });
});
