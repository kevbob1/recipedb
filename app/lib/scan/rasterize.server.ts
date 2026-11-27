import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isStoredPath } from "./image-path";

export interface RasterizedPage {
  pageNumber: number;
  imageFilename: string;
  byteSize: number;
}

type RunPdftoppm = (sourcePdf: string, outputPrefix: string) => Promise<void>;

function runPdftoppm(sourcePdf: string, outputPrefix: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "pdftoppm",
      ["-png", "-r", "150", "-forcenum", sourcePdf, outputPrefix],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      reject(new Error(`Could not start pdftoppm: ${error.message}`));
    });
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `pdftoppm exited with code ${String(code)}${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
          ),
        );
      }
    });
  });
}

export function storedPath(imagesDir: string, filename: string): string {
  if (!isStoredPath(filename)) throw new Error("invalid-stored-image-path");
  const resolved = path.resolve(imagesDir, filename);
  const relative = path.relative(imagesDir, resolved);
  if (relative.length === 0 || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("invalid-stored-image-path");
  }
  return resolved;
}

/**
 * Rasterize a retained source PDF into the existing page-<n>.png convention.
 * Poppler is invoked without a shell; the recipe id is validated before it is
 * used to construct any filesystem path.
 */
export async function rasterizeSourcePdf(
  dataDir: string,
  recipeId: number,
  run: RunPdftoppm = runPdftoppm,
): Promise<RasterizedPage[]> {
  if (!Number.isSafeInteger(recipeId) || recipeId < 1) {
    throw new Error("invalid-recipe-id");
  }
  const imagesDir = path.resolve(dataDir, "images");
  const sourcePdf = storedPath(imagesDir, `${recipeId}/source.pdf`);
  if (!fs.existsSync(sourcePdf) || !fs.statSync(sourcePdf).isFile()) {
    throw new Error(`source-pdf-missing:${recipeId}`);
  }

  const recipeDir = path.dirname(sourcePdf);
  const tempDir = fs.mkdtempSync(path.join(recipeDir, ".rasterize-"));
  const prefix = path.join(tempDir, "raster");
  try {
    await run(sourcePdf, prefix);
    const rendered = fs
      .readdirSync(tempDir)
      .map((name) => {
        const match = /^raster-(\d+)\.png$/.exec(name);
        return match ? { name, pageNumber: Number(match[1]) } : null;
      })
      .filter((page): page is { name: string; pageNumber: number } => page !== null)
      .sort((a, b) => a.pageNumber - b.pageNumber);
    if (rendered.length === 0) {
      throw new Error(`pdftoppm produced no pages for recipe ${recipeId}`);
    }

    const pages: RasterizedPage[] = [];
    for (const [index, page] of rendered.entries()) {
      const pageNumber = index + 1;
      const imageFilename = `${recipeId}/page-${pageNumber}.png`;
      if (!isStoredPath(imageFilename)) throw new Error("invalid-stored-image-path");
      const destination = storedPath(imagesDir, imageFilename);
      fs.renameSync(path.join(tempDir, page.name), destination);
      pages.push({
        pageNumber,
        imageFilename,
        byteSize: fs.statSync(destination).size,
      });
    }
    return pages;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}
