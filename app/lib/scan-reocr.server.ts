/**
 * Node-side OCR for a retained scan capture (#28).
 *
 * NODE ONLY (`.server.ts`): `sharp` decodes the stored photo, the shared pixel
 * pipeline (app/lib/image-ops.ts) preprocesses it exactly as the browser does,
 * and tesseract.js runs the same engine parameters the capture path uses. This
 * is the code behind POST /api/re-ocr; `scripts/ocr-tune.ts` exercises the same
 * pieces against fixtures and stored captures.
 */
import { createOcrSession, preprocessFixture } from "./ocr-node.server";
import type { StoredOcrRun } from "./scan-image.server";

/**
 * OCR an image file from disk with the shipped preprocessing defaults and
 * engine parameters. Returns fresh text plus engine confidence/timing.
 */
export async function recognizeScanFile(
  filePath: string,
): Promise<StoredOcrRun> {
  // sharp re-encodes to a lossless PNG after orient + rescale + pixel work, so
  // tesseract never has to decode a camera JPEG itself.
  const { png } = await preprocessFixture(filePath);
  const session = await createOcrSession();
  try {
    return await session.recognize(png);
  } finally {
    await session.terminate();
  }
}
