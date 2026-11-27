import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rasterizeSourcePdf, storedPath } from "./rasterize.server";

const tempDirs: string[] = [];

function makePdf(pageCount: number): Buffer {
  const pageIds = Array.from({ length: pageCount }, (_, index) => 3 + index * 2);
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageCount} >>`,
  ];
  for (const pageId of pageIds) {
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents ${pageId + 1} 0 R >>`,
      "<< /Length 1 >>\nstream\n \nendstream",
    );
  }
  let contents = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(contents));
    contents += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(contents);
  contents += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  contents += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  contents += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(contents);
}

function makeDataDir(): string {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "recipedb-rasterize-"));
  tempDirs.push(dataDir);
  return dataDir;
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("rasterizeSourcePdf", () => {
  it("rasterizes a multipage PDF into retained page-<n>.png paths", async () => {
    const dataDir = makeDataDir();
    const recipeDir = path.join(dataDir, "images", "42");
    fs.mkdirSync(recipeDir, { recursive: true });
    fs.writeFileSync(path.join(recipeDir, "source.pdf"), makePdf(2));

    const pages = await rasterizeSourcePdf(dataDir, 42);

    expect(pages).toEqual([
      { pageNumber: 1, imageFilename: "42/page-1.png", byteSize: expect.any(Number) },
      { pageNumber: 2, imageFilename: "42/page-2.png", byteSize: expect.any(Number) },
    ]);
    for (const page of pages) {
      const bytes = fs.readFileSync(path.join(dataDir, "images", page.imageFilename));
      expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      expect(page.byteSize).toBe(bytes.byteLength);
    }
  });

  it("reports a missing source PDF", async () => {
    await expect(rasterizeSourcePdf(makeDataDir(), 7)).rejects.toThrow(
      "source-pdf-missing:7",
    );
  });

  it("reports a pdftoppm conversion failure for an invalid PDF", async () => {
    const dataDir = makeDataDir();
    const recipeDir = path.join(dataDir, "images", "8");
    fs.mkdirSync(recipeDir, { recursive: true });
    fs.writeFileSync(path.join(recipeDir, "source.pdf"), Buffer.from("%PDF-1.4\n%%EOF\n"));

    await expect(rasterizeSourcePdf(dataDir, 8)).rejects.toThrow(/pdftoppm exited with code/);
  });

  it("reports a valid empty PDF that produces no page rasters", async () => {
    const dataDir = makeDataDir();
    const recipeDir = path.join(dataDir, "images", "9");
    fs.mkdirSync(recipeDir, { recursive: true });
    fs.writeFileSync(path.join(recipeDir, "source.pdf"), makePdf(0));

    await expect(rasterizeSourcePdf(dataDir, 9)).rejects.toThrow(
      /pdftoppm (produced no pages|exited with code)/,
    );
  });

  it("rejects recipe ids that are not positive safe integers", async () => {
    const dataDir = makeDataDir();
    await expect(rasterizeSourcePdf(dataDir, 0)).rejects.toThrow("invalid-recipe-id");
    await expect(rasterizeSourcePdf(dataDir, 1.5)).rejects.toThrow("invalid-recipe-id");
    await expect(rasterizeSourcePdf(dataDir, Number.NaN)).rejects.toThrow(
      "invalid-recipe-id",
    );
  });

  it("throws when the injected rasterizer produces no files", async () => {
    const dataDir = makeDataDir();
    const recipeDir = path.join(dataDir, "images", "11");
    fs.mkdirSync(recipeDir, { recursive: true });
    fs.writeFileSync(path.join(recipeDir, "source.pdf"), makePdf(1));

    await expect(rasterizeSourcePdf(dataDir, 11, async () => {})).rejects.toThrow(
      /produced no pages for recipe 11/,
    );
  });

  it("reports a spawn failure when pdftoppm cannot start", async () => {
    const dataDir = makeDataDir();
    const recipeDir = path.join(dataDir, "images", "12");
    fs.mkdirSync(recipeDir, { recursive: true });
    fs.writeFileSync(path.join(recipeDir, "source.pdf"), makePdf(1));

    const savedPath = process.env.PATH;
    process.env.PATH = "";
    try {
      await expect(rasterizeSourcePdf(dataDir, 12)).rejects.toThrow(
        /Could not start pdftoppm/,
      );
    } finally {
      process.env.PATH = savedPath;
    }
  });
});

describe("storedPath", () => {
  const imagesDir = path.join(os.tmpdir(), "recipedb-stored-path");

  it("rejects filenames that are not retained recipe-relative paths", () => {
    expect(() => storedPath(imagesDir, "../escape.png")).toThrow(
      "invalid-stored-image-path",
    );
    expect(() => storedPath(imagesDir, "_staging/uuid.webp")).toThrow(
      "invalid-stored-image-path",
    );
  });

  it("rejects retained-form filenames that resolve outside the images dir", () => {
    expect(() => storedPath(imagesDir, "1/../../outside.png")).toThrow(
      "invalid-stored-image-path",
    );
  });

  it("accepts a retained path inside the images dir", () => {
    expect(storedPath(imagesDir, "1/page-1.png")).toBe(
      path.resolve(imagesDir, "1/page-1.png"),
    );
  });
});
