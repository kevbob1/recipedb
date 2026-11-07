/**
 * URL import — the server half (#4).
 *
 * `recipe-scrapers` and the filesystem/DB helpers are mocked; the parsing,
 * fallback, image pipeline and error taxonomy are the real code. sharp is used
 * for real on a tiny synthetic PNG so the WebP write path is exercised.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  scrapeRecipe: vi.fn(),
  getImagesDir: vi.fn(),
  getRawSqlite: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("recipe-scrapers", () => ({ scrapeRecipe: mocks.scrapeRecipe }));
vi.mock("../db/client.server", () => ({
  getImagesDir: mocks.getImagesDir,
  getRawSqlite: mocks.getRawSqlite,
}));

import { ImportError, importFromUrl, normalizeUrl } from "./recipe-scrapers.server";

let tmpDir: string;
let sourcePng: Buffer;
const originalNodeEnv = process.env.NODE_ENV;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "recipedb-url-import-"));
  sourcePng = await sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: 200, g: 80, b: 40 } },
  })
    .png()
    .toBuffer();
});

beforeEach(() => {
  mocks.scrapeRecipe.mockReset();
  mocks.fetch.mockReset();
  mocks.getImagesDir.mockReset();
  mocks.getImagesDir.mockReturnValue(path.join(tmpDir, "images"));
  mocks.getRawSqlite.mockReset();
  mocks.getRawSqlite.mockReturnValue({
    prepare: () => ({ get: () => ({ m: 41 }) }),
  });
  vi.stubGlobal("fetch", mocks.fetch);
});

afterEach(() => {
  process.env.NODE_ENV = originalNodeEnv;
});

afterAll(() => {
  vi.unstubAllGlobals();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function htmlResponse(body: string) {
  return { ok: true, status: 200, text: async () => body, arrayBuffer: async () => new ArrayBuffer(0) };
}

function imageResponse(buf: Buffer) {
  return {
    ok: true,
    status: 200,
    text: async () => "",
    arrayBuffer: async () =>
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
  };
}

const PAGE = "<html><head><title>Pasta</title></head><body>recipe</body></html>";

function scraperResult(overrides: Record<string, unknown> = {}) {
  return {
    title: "  Weeknight Pasta  ",
    category: ["Dinner"],
    cuisine: ["Italian"],
    yields: " 4 servings ",
    keywords: ["quick", "pasta"],
    image: "https://cdn.example.com/pasta.jpg",
    ingredients: [
      {
        items: [
          {
            value: " 2 cups flour ",
            parsed: {
              quantity: 2,
              quantity2: null,
              unitOfMeasure: "cups",
              description: "flour",
            },
          },
          {
            value: "1-2 cloves garlic",
            parsed: {
              quantity: 1,
              quantity2: 2,
              unitOfMeasure: "cloves",
              description: "garlic",
            },
          },
          {
            value: "3 eggs",
            // quantity2 === quantity exercises the single-number branch.
            parsed: { quantity: 3, quantity2: 3, unitOfMeasure: null, description: "" },
          },
          { value: "salt to taste" },
        ],
      },
    ],
    instructions: [{ items: [{ value: " Boil the water. " }, { value: "Add pasta." }] }],
    ...overrides,
  };
}

function jsonLdHtml(recipe: Record<string, unknown>): string {
  return `<html><head>
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"BreadcrumbList"},${JSON.stringify(
    { "@context": "https://schema.org", "@type": "Recipe", ...recipe },
  )}]}</script>
<script type="application/ld+json">{ this is malformed }</script>
</head><body></body></html>`;
}

describe("normalizeUrl", () => {
  it("trims input and adds https:// when the scheme is missing", () => {
    expect(normalizeUrl("  example.com/recipes/1  ")).toBe("https://example.com/recipes/1");
    expect(normalizeUrl("https://example.com/a")).toBe("https://example.com/a");
    expect(normalizeUrl("http://example.com/a")).toBe("http://example.com/a");
  });

  it("rejects empty and malformed input", () => {
    expect(normalizeUrl("")).toBeNull();
    expect(normalizeUrl("   ")).toBeNull();
    expect(normalizeUrl("https://")).toBeNull();
  });
});

describe("importFromUrl — recipe-scrapers path", () => {
  it("maps scraper output to page data and downloads the image", async () => {
    mocks.scrapeRecipe.mockResolvedValue(scraperResult());
    mocks.fetch
      .mockResolvedValueOnce(htmlResponse(PAGE))
      .mockResolvedValueOnce(imageResponse(sourcePng));

    const result = await importFromUrl("example.com/pasta");

    expect(mocks.scrapeRecipe).toHaveBeenCalledWith(PAGE, "https://example.com/pasta", {
      parseIngredients: true,
    });
    expect(result.url).toBe("https://example.com/pasta");
    expect(result.data.title).toBe("Weeknight Pasta");
    expect(result.data.categoryKeywords).toEqual(["Dinner", "Italian"]);
    expect(result.data.yields).toBe("4 servings");
    expect(result.data.tags).toEqual(["quick", "pasta"]);

    const [flour, garlic, eggs, salt] = result.data.ingredients;
    expect(flour).toMatchObject({
      text: "2 cups flour",
      qty: "2",
      unit: "cups",
      item: "flour",
      note: null,
      confidence: "ok",
    });
    expect(garlic).toMatchObject({ qty: "1-2", unit: "cloves", confidence: "ok" });
    expect(eggs).toMatchObject({ qty: "3", unit: null, item: "3 eggs", confidence: "ok" });
    expect(salt).toMatchObject({
      qty: "",
      unit: null,
      item: "salt to taste",
      confidence: "warn",
    });

    expect(result.data.steps).toEqual([
      { position: 1, text: "Boil the water." },
      { position: 2, text: "Add pasta." },
    ]);

    expect(result.imageFilename).toBe("42.webp");
    const written = path.join(tmpDir, "images", "42.webp");
    expect(fs.existsSync(written)).toBe(true);
    expect(result.data.raw).toContain("# local image: /images/42.webp");
    // The fetch asked politely for HTML and then for an image.
    expect(mocks.fetch).toHaveBeenNthCalledWith(
      1,
      "https://example.com/pasta",
      expect.objectContaining({
        headers: expect.objectContaining({ accept: "text/html,application/xhtml+xml" }),
        redirect: "follow",
      }),
    );
    expect(mocks.fetch).toHaveBeenNthCalledWith(
      2,
      "https://cdn.example.com/pasta.jpg",
      expect.objectContaining({ headers: expect.objectContaining({ accept: "image/*" }) }),
    );
  });

  it("returns a null image when the page has none", async () => {
    mocks.scrapeRecipe.mockResolvedValue(scraperResult({ image: undefined }));
    mocks.fetch.mockResolvedValueOnce(htmlResponse(PAGE));

    const result = await importFromUrl("example.com/pasta");
    expect(result.imageFilename).toBeNull();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps the import when the image fetch fails (best effort)", async () => {
    mocks.scrapeRecipe.mockResolvedValue(scraperResult());
    mocks.fetch
      .mockResolvedValueOnce(htmlResponse(PAGE))
      .mockRejectedValueOnce(new Error("CDN down"));

    const result = await importFromUrl("example.com/pasta");
    expect(result.data.title).toBe("Weeknight Pasta");
    expect(result.imageFilename).toBeNull();
  });

  it("keeps the import when sharp cannot decode the downloaded image", async () => {
    mocks.scrapeRecipe.mockResolvedValue(scraperResult());
    mocks.fetch
      .mockResolvedValueOnce(htmlResponse(PAGE))
      .mockResolvedValueOnce(imageResponse(Buffer.from("not an image")));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await importFromUrl("example.com/pasta");
    expect(result.data.title).toBe("Weeknight Pasta");
    expect(result.imageFilename).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      "[import-url] image download failed:",
      expect.stringContaining("unsupported image format"),
    );
    warn.mockRestore();
  });

  it("treats an empty, non-OK or non-image image response as no image", async () => {
    mocks.scrapeRecipe.mockResolvedValue(scraperResult());

    for (const reply of [
      { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) },
      { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) },
    ]) {
      mocks.fetch.mockReset();
      mocks.fetch
        .mockResolvedValueOnce(htmlResponse(PAGE))
        .mockResolvedValueOnce(reply);

      const result = await importFromUrl("example.com/pasta");
      expect(result.imageFilename).toBeNull();
    }
  });

  it("silences the failure warnings in production", async () => {
    process.env.NODE_ENV = "production";
    mocks.scrapeRecipe.mockResolvedValue(scraperResult());
    mocks.fetch
      .mockResolvedValueOnce(htmlResponse(PAGE))
      .mockResolvedValueOnce(imageResponse(Buffer.from("not an image")));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await importFromUrl("example.com/pasta");
    expect(result.data.title).toBe("Weeknight Pasta");
    expect(result.imageFilename).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("importFromUrl — JSON-LD fallback", () => {
  it("uses the JSON-LD Recipe block when recipe-scrapers has no scraper", async () => {
    mocks.scrapeRecipe.mockRejectedValue(new Error("unknown site"));
    const html = jsonLdHtml({
      name: "  Grandmother's Pie ",
      recipeCategory: ["Dessert", "  "],
      recipeCuisine: "American",
      recipeYield: [" 8 slices ", "8"],
      keywords: "pie, dessert, ,comfort food",
      recipeIngredient: ["2 cups flour", "1 cup butter"],
      recipeInstructions: [
        { "@type": "HowToStep", text: "Mix the dough." },
        {
          "@type": "HowToSection",
          itemListElement: [{ "@type": "HowToStep", name: "Bake until golden." }],
        },
      ],
      image: { "@type": "ImageObject", url: "https://cdn.example.com/pie.jpg" },
    });
    mocks.fetch
      .mockResolvedValueOnce(htmlResponse(html))
      .mockResolvedValueOnce(imageResponse(sourcePng));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await importFromUrl("grandma.example/pie");

    expect(warn).toHaveBeenCalledWith(
      "[import-url] recipe-scrapers failed:",
      "unknown site",
    );
    expect(result.data.title).toBe("Grandmother's Pie");
    expect(result.data.categoryKeywords).toEqual(["Dessert", "American"]);
    expect(result.data.yields).toBe("8 slices");
    expect(result.data.tags).toEqual(["pie", "dessert", "comfort food"]);
    expect(result.data.ingredients.map((i) => i.text)).toEqual([
      "2 cups flour",
      "1 cup butter",
    ]);
    expect(result.data.ingredients[0]).toMatchObject({ confidence: "ok", qty: "" });
    expect(result.data.steps).toEqual([
      { position: 1, text: "Mix the dough." },
      { position: 2, text: "Bake until golden." },
    ]);
    // The fallback's raw drawer is the whole block list.
    expect(result.data.raw).toContain('"@graph"');
    expect(result.imageFilename).toBe("42.webp");
    warn.mockRestore();
  });

  it("silences the scraper-failure warning in production", async () => {
    process.env.NODE_ENV = "production";
    mocks.scrapeRecipe.mockRejectedValue(new Error("no scraper"));
    mocks.fetch.mockResolvedValueOnce(
      htmlResponse(
        jsonLdHtml({
          name: "Prod Cake",
          recipeIngredient: "1 cup flour",
          recipeInstructions: "Bake.",
        }),
      ),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await importFromUrl("example.com/cake");
    expect(result.data.title).toBe("Prod Cake");
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("falls back when the scraper returns an empty title", async () => {    mocks.scrapeRecipe.mockResolvedValue(scraperResult({ title: "   " }));
    const html = jsonLdHtml({
      name: "Fallback Cake",
      recipeIngredient: "1 cup sugar",
      recipeInstructions: "Bake.",
    });
    mocks.fetch.mockResolvedValueOnce(htmlResponse(html));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await importFromUrl("example.com/cake");
    expect(result.data.title).toBe("Fallback Cake");
    expect(result.data.ingredients).toHaveLength(1);
    expect(result.data.ingredients[0]).toMatchObject({ qty: "", confidence: "ok" });
  });

  it("throws no-recipe-found when neither path finds a recipe", async () => {
    mocks.scrapeRecipe.mockResolvedValue(scraperResult({ title: "" }));
    mocks.fetch.mockResolvedValueOnce(
      htmlResponse("<html><body>Nothing edible</body></html>"),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(importFromUrl("example.com/blank")).rejects.toMatchObject({
      code: "no-recipe-found",
    });
  });
});

describe("importFromUrl — error taxonomy", () => {
  it("rejects a URL that is not http(s) before fetching", async () => {
    await expect(importFromUrl("   ")).rejects.toBeInstanceOf(ImportError);
    await expect(importFromUrl("   ")).rejects.toMatchObject({ code: "invalid-url" });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("maps a non-OK page response to fetch-failed", async () => {
    mocks.fetch.mockResolvedValueOnce({ ok: false, status: 503, text: async () => "" });
    await expect(importFromUrl("example.com/down")).rejects.toMatchObject({
      code: "fetch-failed",
      message: "Fetch returned HTTP 503.",
    });
    expect(mocks.scrapeRecipe).not.toHaveBeenCalled();
  });

  it("maps a network error to fetch-failed", async () => {
    mocks.fetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(importFromUrl("example.com/down")).rejects.toMatchObject({
      code: "fetch-failed",
      message: "ECONNREFUSED",
    });
  });

  it("reports an abort as the 12s timeout", async () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    mocks.fetch.mockRejectedValueOnce(abort);
    await expect(importFromUrl("example.com/slow")).rejects.toMatchObject({
      code: "fetch-failed",
      message: "Fetch timed out after 12s.",
    });
  });

  it("exposes ImportError with its code and message", () => {
    const err = new ImportError("fetch-failed", "nope");
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("fetch-failed");
    expect(err.message).toBe("nope");
  });
});
