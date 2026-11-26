#!/usr/bin/env node

import { appendFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createWorker } from "tesseract.js";
import { OCR_WORKER_PARAMS } from "../app/lib/ocr.ts";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

const scanDir = path.resolve("_pdf_scans");
const outputPath =
  process.env.SCAN_TITLES_OUT ?? "/tmp/opencode/scan-titles.tsv";
const matchPattern = /pec\w*n|waln[au]t|walln[au]t/i;
const limitArg = process.argv.find((arg) => arg.startsWith("--limit="));
const limit = limitArg ? Number(limitArg.slice("--limit=".length)) : Infinity;

async function loadCanvas() {
  for (const name of ["@napi-rs/canvas", "canvas"]) {
    try {
      return await import(name);
    } catch {
      // Try the other supported Node canvas implementation.
    }
  }
  throw new Error(
    "No Node canvas package found (expected @napi-rs/canvas or canvas).",
  );
}

function cleanColumn(value) {
  return value.replace(/[\t\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

async function main() {
  if (!Number.isInteger(limit) && limit !== Infinity) {
    throw new Error("--limit must be a positive integer");
  }
  mkdirSync(path.dirname(outputPath), { recursive: true });
  const files = readdirSync(scanDir)
    .filter((name) => name.toLowerCase().endsWith(".pdf"))
    .sort()
    .slice(0, limit);
  if (files.length === 0) throw new Error(`No PDF files found in ${scanDir}`);

  const canvasModule = await loadCanvas();
  const createCanvas = canvasModule.createCanvas;
  if (typeof createCanvas !== "function") {
    throw new Error("The Node canvas package does not export createCanvas.");
  }

  const worker = await createWorker("eng", undefined, {
    cachePath: path.join(os.tmpdir(), "opencode", "tesseract-cache"),
  });
  await worker.setParameters(OCR_WORKER_PARAMS);
  try {
    for (const [index, filename] of files.entries()) {
      let text;
      let result;
      try {
        const bytes = readFileSync(path.join(scanDir, filename));
        const document = await pdfjs.getDocument({
          data: new Uint8Array(bytes),
        }).promise;
        try {
          const page = await document.getPage(1);
          const viewport = page.getViewport({ scale: 300 / 72 });
          const canvas = createCanvas(
            Math.floor(viewport.width),
            Math.floor(viewport.height),
          );
          await page.render({
            canvasContext: canvas.getContext("2d"),
            viewport,
          }).promise;
          const png = canvas.toBuffer("image/png");
          const recognized = await worker.recognize(png);
          text = cleanColumn((recognized.data.text ?? "").slice(0, 400));
        } finally {
          await document.destroy();
        }
        result = matchPattern.test(text) ? "MATCH" : "no";
      } catch (error) {
        text = cleanColumn(`ERROR ${error instanceof Error ? error.message : String(error)}`);
        result = "no";
      }

      appendFileSync(outputPath, `${filename}\t${text}\t${result}\n`);
      console.log(
        `[${index + 1}/${files.length}] ${filename}: ${result} — ${text.slice(0, 100)}`,
      );
    }
  } finally {
    await worker.terminate();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[ocr-scan-titles] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
