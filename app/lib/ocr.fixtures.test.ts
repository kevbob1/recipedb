/**
 * Fixture OCR tests — real photos, real tesseract.js WASM, opt-in.
 *
 * These tests are SLOW and network-dependent on first run: tesseract.js
 * downloads eng.traineddata (~10MB) into /tmp/opencode/tesseract-cache, and
 * each photo costs several seconds of WASM OCR. They are therefore skipped by
 * default. Run them with:
 *
 *   OCR_FIXTURE_TEST=1 npx vitest run app/lib/ocr.fixtures.test.ts
 *   OCR_FIXTURE_TEST=1 OCR_FIXTURE_MAX=2 npx vitest run app/lib/ocr.fixtures.test.ts
 *
 * Env knobs:
 *   OCR_FIXTURE_TEST=1   enable this suite
 *   OCR_FIXTURE_MAX=n    only the first n fixtures (a quick smoke run)
 *   OCR_TESSDATA_CACHE   where eng.traineddata is cached (default /tmp/opencode/tesseract-cache)
 *   OCR_LANG_PATH        offline/air-gapped traineddata directory
 *
 * What is asserted: preprocessing (the real app/lib/image-ops.ts pipeline, with
 * sharp standing in for the canvas decode/encode that the browser uses) yields
 * text that is *plausible recipe text* — long enough, mostly letters, with at
 * least one ingredient-shaped line — and that the mean quality score across
 * fixtures does not regress versus handing tesseract the raw photo, which is
 * what the app did before. The numbers themselves are printed so a failing run
 * is diagnosable, and `npx tsx scripts/ocr-tune.ts` is the tool for tuning.
 */
import { basename } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DEFAULT_OCR_PREPROCESS } from "./image-ops";
import { ocrTextToDraft } from "./ocr";
import { scoreOcrText, type OcrQuality } from "./ocr-metrics";
import {
  createOcrSession,
  fixturePaths,
  preprocessFixture,
  type OcrSession,
} from "./ocr-node.server";

const ENABLED = process.env.OCR_FIXTURE_TEST === "1";
const TIMEOUT_MS = 300_000;

/** describe.skip keeps the whole file — including the sharp import — quiet by default. */
const suite = ENABLED ? describe : describe.skip;

interface Measurement {
  fixture: string;
  raw: OcrQuality;
  preprocessed: OcrQuality;
  rawText: string;
  preprocessedText: string;
}

const measurements: Measurement[] = [];

suite("OCR fixtures (opt-in: OCR_FIXTURE_TEST=1)", () => {
  const max = Number(process.env.OCR_FIXTURE_MAX ?? "0");
  const files = fixturePaths().slice(0, max > 0 ? max : undefined);

  let session: OcrSession | null = null;
  const getSession = async (): Promise<OcrSession> => {
    session ??= await createOcrSession();
    return session;
  };

  afterAll(async () => {
    await session?.terminate();
  });

  it("ships the printed-page fixture photos", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    it(
      `recovers recipe text from ${basename(file)}`,
      async () => {
        const ocr = await getSession();
        const preprocessed = await preprocessFixture(file, DEFAULT_OCR_PREPROCESS);

        const rawRun = await ocr.recognize(file);
        const preRun = await ocr.recognize(preprocessed.png);

        const raw = scoreOcrText(rawRun.text);
        const pre = scoreOcrText(preRun.text);
        measurements.push({
          fixture: basename(file),
          raw,
          preprocessed: pre,
          rawText: rawRun.text,
          preprocessedText: preRun.text,
        });

        console.log(
          `\n[fixtures] ${basename(file)}\n` +
            `  raw          conf ${rawRun.confidence.toFixed(1)} · chars ${raw.chars} · ` +
            `garbage ${raw.garbageRatio} · ingredient-lines ${raw.ingredientLines} · score ${raw.score}\n` +
            `  preprocessed conf ${preRun.confidence.toFixed(1)} · chars ${pre.chars} · ` +
            `garbage ${pre.garbageRatio} · ingredient-lines ${pre.ingredientLines} · score ${pre.score}` +
            `\n  --- preprocessed text (first 15 lines) ---\n` +
            preRun.text.split("\n").slice(0, 15).join("\n"),
        );

        // Sanity: the preprocessed pass must produce text at all, and it must
        // look like prose rather than line noise.
        expect(pre.chars).toBeGreaterThan(50);
        expect(pre.alphaRatio).toBeGreaterThan(0.5);
        expect(pre.garbageRatio).toBeLessThan(0.25);

        // The import flow only needs ingredient rows and steps to be present.
        expect(pre.ingredientLines).toBeGreaterThanOrEqual(1);
        const draft = ocrTextToDraft(preRun.text);
        expect(
          draft.ingredients.length + draft.steps.length,
        ).toBeGreaterThanOrEqual(1);
      },
      TIMEOUT_MS,
    );
  }

  it(
    "does not regress mean quality versus raw bytes",
    async () => {
      // Ordering matters: vitest runs the tests above first, then this summary.
      expect(measurements.length).toBeGreaterThan(0);
      const mean = (pick: (m: Measurement) => number): number =>
        measurements.reduce((acc, m) => acc + pick(m), 0) / measurements.length;
      const rawMean = mean((m) => m.raw.score);
      const preMean = mean((m) => m.preprocessed.score);
      const rawGarbage = mean((m) => m.raw.garbageRatio);
      const preGarbage = mean((m) => m.preprocessed.garbageRatio);

      console.log(
        `\n[fixtures] mean raw score ${rawMean.toFixed(3)} -> preprocessed ${preMean.toFixed(3)}; ` +
          `mean garbage ${rawGarbage.toFixed(3)} -> ${preGarbage.toFixed(3)}`,
      );

      // Preprocessing must not make things worse; it is expected to help, and
      // the printed numbers above are the evidence for how much.
      expect(preGarbage).toBeLessThanOrEqual(rawGarbage + 0.02);
      expect(preMean).toBeGreaterThanOrEqual(rawMean - 0.05);
    },
    TIMEOUT_MS,
  );
});
