#!/usr/bin/env tsx
/**
 * OCR tuning harness for the printed-recipe fixtures.
 *
 *   npx tsx scripts/ocr-tune.ts                     # all fixtures, all variants
 *   npx tsx scripts/ocr-tune.ts --fixture 044713    # one photo
 *   npx tsx scripts/ocr-tune.ts --dir /data/images  # sweep stored scans too
 *   npx tsx scripts/ocr-tune.ts --full              # dump the whole text
 *   npx tsx scripts/ocr-tune.ts --threshold adaptive --psm 6
 *
 * For every fixture it OCRs the image several ways — raw bytes, EXIF-orient
 * only, and the browser pipeline with different thresholds — and prints
 * tesseract confidence plus the heuristic quality metrics from
 * app/lib/ocr-metrics.ts. The point is to let Kevin iterate on preprocessing
 * parameters in one command instead of waiting on the vitest fixture suite.
 *
 * Artifacts (preprocessed PNGs + recognized text) are written under
 * /tmp/opencode/ocr-tune/<fixture>/ so a run can be inspected without OCRing
 * again. Override with --out=<dir>.
 *
 * The preprocessing itself comes from the shared modules, so a parameter that
 * measures better here is a parameter the browser will run (app/lib/ocr.ts).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PSM } from "tesseract.js";
import {
  DEFAULT_OCR_PREPROCESS,
  type PreprocessOptions,
  type ThresholdMode,
} from "../app/lib/image-ops";
import { scoreOcrText } from "../app/lib/ocr-metrics";
import {
  autoOrientOnly,
  collectImagePaths,
  createOcrSession,
  fixturePaths,
  preprocessFixture,
  type OcrParamOverrides,
} from "../app/lib/ocr-node.server";

interface Variant {
  name: string;
  psm: PSM;
  /** null = OCR the original file untouched (upstream baseline). */
  options: PreprocessOptions | null;
  /** Use sharp auto-orient only, no rescale or pixel work. */
  orientOnly?: boolean;
  /** Keep source resolution (default true). */
  resize?: boolean;
  params?: OcrParamOverrides;
}

function buildVariants(args: Args): Variant[] {
  const psm = args.psm ?? PSM.SINGLE_BLOCK;
  const auto = PSM.AUTO;
  const threshold = args.threshold ?? "none";
  /** Every pixel stage off — isolates the decode/rescale/jpeg round-trip. */
  const off: Partial<PreprocessOptions> = {
    grayscale: false,
    normalize: 0,
    contrast: 1,
    sharpen: 0,
    threshold: "none",
  };
  /**
   * Explicit stage sets rather than "DEFAULT plus tweak", so a change to the
   * shipped defaults never silently rewrites what this table measured.
   */
  const set = (overrides: Partial<PreprocessOptions>): PreprocessOptions => ({
    ...DEFAULT_OCR_PREPROCESS,
    ...off,
    ...overrides,
  });
  const candidate = set({
    grayscale: true,
    normalize: 0.02,
    normalizeMaxGain: 2,
    contrast: 1.15,
    sharpen: 0.6,
  });

  const variants: Variant[] = [
    // Baseline: exactly what the app did before this change (hand tesseract the
    // raw phone photo).
    { name: "raw/psm-auto", psm: auto, options: null },
    { name: "raw/psm-block", psm, options: null },
    // Phone photos carry density=72 and no usable DPI; how much does the hint buy?
    {
      name: "raw/no-dpi-hint",
      psm,
      options: null,
      params: { user_defined_dpi: "0" },
    },
    { name: "orient-only", psm, options: null, orientOnly: true },
    // Stage isolation: rescale alone, then each pixel stage on its own.
    { name: "resize-only", psm, options: set({}) },
    { name: "gray-only", psm, options: set({ grayscale: true }) },
    { name: "gray+sharpen", psm, options: set({ grayscale: true, sharpen: 0.6 }) },
    { name: "gray+contrast", psm, options: set({ grayscale: true, contrast: 1.15 }) },
    {
      name: "gray+normalize/uncapped",
      psm,
      options: set({ grayscale: true, normalize: 0.02, normalizeMaxGain: 99 }),
    },
    {
      name: "gray+normalize/cap2",
      psm,
      options: set({ grayscale: true, normalize: 0.02, normalizeMaxGain: 2 }),
    },
    // Combinations of the stages that survived isolation.
    { name: "candidate", psm, options: candidate },
    { name: "candidate/no-normalize", psm, options: set({ grayscale: true, contrast: 1.15, sharpen: 0.6 }) },
    {
      name: "candidate/no-resize",
      psm,
      options: candidate,
      resize: false,
    },
    { name: "candidate/otsu", psm, options: { ...candidate, threshold: "otsu" } },
    {
      name: "candidate/adaptive",
      psm,
      options: { ...candidate, threshold: "adaptive" },
    },
    // Whatever the app actually ships, so a run also reports the shipped config.
    { name: "defaults(shipped)", psm, options: { ...DEFAULT_OCR_PREPROCESS, threshold } },
  ];

  return args.variant
    ? variants.filter((v) => args.variant!.some((wanted) => v.name.includes(wanted)))
    : variants;
}

interface Args {
  fixture?: string[];
  /** Extra directory to sweep recursively (e.g. a copied DATA_DIR/images). */
  dir?: string;
  variant?: string[];
  full: boolean;
  out: string;
  psm?: PSM;
  threshold?: ThresholdMode;
  noWrite: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    full: false,
    noWrite: false,
    out: path.join("/tmp/opencode", "ocr-tune"),
  };
  for (const arg of argv) {
    const [flag, value] = arg.split("=");
    switch (flag) {
      case "--fixture":
        args.fixture = [...(args.fixture ?? []), ...(value ?? "").split(",")];
        break;
      case "--dir":
        args.dir = value;
        break;
      case "--variant":
        args.variant = [...(args.variant ?? []), ...(value ?? "").split(",")];
        break;
      case "--full":
        args.full = true;
        break;
      case "--no-write":
        args.noWrite = true;
        break;
      case "--out":
        args.out = value ?? args.out;
        break;
      case "--psm":
        args.psm = Number(value) === 6 ? PSM.SINGLE_BLOCK : PSM.AUTO;
        break;
      case "--threshold":
        if (value === "none" || value === "otsu" || value === "adaptive") {
          args.threshold = value;
        } else {
          throw new Error(`--threshold must be none|otsu|adaptive (got ${value})`);
        }
        break;
      case "--help":
        console.log(
          "usage: npx tsx scripts/ocr-tune.ts [--fixture=substr] [--dir=images-dir] " +
            "[--variant=substr] [--psm=3|6] [--threshold=none|otsu|adaptive] " +
            "[--full] [--no-write] [--out=dir]",
        );
        process.exit(0);
        break;
      default:
        if (arg.startsWith("--")) throw new Error(`unknown flag ${arg}`);
    }
  }
  return args;
}

interface Row {
  fixture: string;
  variant: string;
  psm: string;
  ms: number;
  confidence: number;
  chars: number;
  garbageRatio: number;
  ingredientLines: number;
  score: number;
}

const pad = (value: string | number, width: number): string =>
  String(value).padEnd(width);
const padStart = (value: string | number, width: number): string =>
  String(value).padStart(width);

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const variants = buildVariants(args);
  // Fixtures always participate; --dir adds the real retained captures from a
  // DATA_DIR/images tree (recursively) so tuning covers what actually shipped.
  const fixtures = [...fixturePaths(), ...(args.dir ? collectImagePaths(args.dir) : [])].filter(
    (file) =>
      !args.fixture || args.fixture.some((needle) => file.includes(needle)),
  );

  if (fixtures.length === 0) {
    console.error(
      "no fixtures matched; expected tests/fixtures/ocr/*.jpg (or pass --dir=<images dir>)",
    );
    process.exit(1);
  }

  console.log(
    `fixtures: ${fixtures.length} · variants: ${variants.length} ` +
      `(${variants.map((v) => v.name).join(", ")})`,
  );

  const session = await createOcrSession({
    // Worker init (model load) is slow; keep it visible.
    onProgress: (status, progress) => {
      if (status === "loading language traineddata" || status === "initializing api") {
        process.stderr.write(`\r${status} ${(progress * 100).toFixed(0)}%   `);
      }
    },
  });
  process.stderr.write("\n");

  const rows: Row[] = [];
  try {
    for (const file of fixtures) {
      const dirRoot = args.dir ? path.resolve(args.dir) : null;
      const inDir =
        dirRoot !== null &&
        path.resolve(file).startsWith(dirRoot + path.sep);
      // Stored captures are named <recipeId>/original so runs are distinguishable.
      const name = inDir
        ? path.relative(dirRoot, file).replace(/\.[^.]+$/, "")
        : path.basename(file, path.extname(file));
      const outDir = path.join(args.out, name);
      console.log(`\n=== ${path.basename(file)} ===`);

      for (const variant of variants) {
        let image: Buffer | string = file;
        if (variant.orientOnly) {
          image = await autoOrientOnly(file);
        } else if (variant.options) {
          const preprocessed = await preprocessFixture(
            file,
            variant.options,
            variant.resize ?? true,
          );
          image = preprocessed.png;
          if (!args.noWrite) {
            mkdirSync(outDir, { recursive: true });
            writeFileSync(
              path.join(outDir, `${variant.name.replace(/\//g, "_")}.png`),
              preprocessed.png,
            );
          }
        }

        const run = await session.recognize(image, {
          psm: variant.psm,
          params: variant.params,
        });
        const quality = scoreOcrText(run.text);
        rows.push({
          fixture: name,
          variant: variant.name,
          psm: variant.psm === PSM.SINGLE_BLOCK ? "6" : "3",
          ms: run.ms,
          confidence: Math.round(run.confidence * 10) / 10,
          chars: quality.chars,
          garbageRatio: quality.garbageRatio,
          ingredientLines: quality.ingredientLines,
          score: quality.score,
        });

        if (!args.noWrite) {
          mkdirSync(outDir, { recursive: true });
          writeFileSync(
            path.join(outDir, `${variant.name.replace(/\//g, "_")}.txt`),
            run.text,
          );
        }

        const preview = args.full
          ? run.text
          : run.text.split("\n").slice(0, 10).join("\n");
        console.log(
          `\n--- ${variant.name} (psm ${variant.psm === PSM.SINGLE_BLOCK ? 6 : 3}) ` +
            `conf ${run.confidence.toFixed(1)} · ${run.ms}ms · score ${quality.score} ` +
            `· garbage ${quality.garbageRatio} · ingredient-lines ${quality.ingredientLines}`,
        );
        console.log(preview.trimEnd() || "(empty)");
      }
    }
  } finally {
    await session.terminate();
  }

  console.log("\n\n=== summary (higher score / ingredient-lines is better) ===");
  console.log(
    [
      pad("fixture", 24),
      pad("variant", 24),
      padStart("psm", 4),
      padStart("conf", 6),
      padStart("chars", 7),
      padStart("garb", 6),
      padStart("ingr", 5),
      padStart("ms", 7),
      padStart("score", 6),
    ].join(" "),
  );
  for (const row of rows) {
    console.log(
      [
        pad(row.fixture, 24),
        pad(row.variant, 24),
        padStart(row.psm, 4),
        padStart(row.confidence.toFixed(1), 6),
        padStart(row.chars, 7),
        padStart(row.garbageRatio.toFixed(3), 6),
        padStart(row.ingredientLines, 5),
        padStart(row.ms, 7),
        padStart(row.score.toFixed(3), 6),
      ].join(" "),
    );
  }

  const byVariant = new Map<
    string,
    { score: number; garbage: number; ingredients: number; runs: number }
  >();
  for (const row of rows) {
    const entry = byVariant.get(row.variant) ?? {
      score: 0,
      garbage: 0,
      ingredients: 0,
      runs: 0,
    };
    entry.score += row.score;
    entry.garbage += row.garbageRatio;
    entry.ingredients += row.ingredientLines;
    entry.runs += 1;
    byVariant.set(row.variant, entry);
  }

  console.log("\n=== mean per variant ===");
  const ranked = [...byVariant.entries()]
    .map(([variant, entry]) => ({
      variant,
      score: entry.score / entry.runs,
      garbage: entry.garbage / entry.runs,
      ingredients: entry.ingredients / entry.runs,
    }))
    .sort((a, b) => b.score - a.score);
  for (const entry of ranked) {
    console.log(
      `${pad(entry.variant, 26)} score ${entry.score.toFixed(3)} ` +
        `· garbage ${entry.garbage.toFixed(3)} · ingredient-lines ${entry.ingredients.toFixed(2)}`,
    );
  }
  console.log(`\nbest: ${ranked[0]?.variant ?? "n/a"}`);
  if (!args.noWrite) {
    console.log(`artifacts: ${args.out}`);
  }
}

main().catch((error: unknown) => {
  console.error("\nocr-tune failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
