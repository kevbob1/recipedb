import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { eq } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { runMigrations } from "../db/migrate.server";
import { getDb, getImagesDir, getRawSqlite } from "../db/client.server";
import { recipes } from "../db/schema.server";
import { saveDraft } from "../lib/draft-store.server";
import { createDraft } from "../lib/import";
import {
  action as backfillAction,
  default as BackfillRoute,
  loader as backfillLoader,
} from "./api.backfill-scan-ocr";
import {
  action as normalizeAction,
  default as NormalizeRoute,
  loader as normalizeLoader,
} from "./api.backfill-normalize-images";

vi.mock("../lib/auth.server", () => ({
  requireAuth: vi.fn(),
}));

let dataDir: string;
let previousDataDir: string | undefined;

beforeAll(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "recipedb-backfill-routes-"));
  previousDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dataDir;
  runMigrations();
});

afterAll(() => {
  getRawSqlite().close();
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  getRawSqlite().exec(
    "DELETE FROM ocr_training_samples; DELETE FROM recipe_pages; DELETE FROM ingredient_lines; DELETE FROM steps; DELETE FROM tags; DELETE FROM recipes;",
  );
  fs.rmSync(getImagesDir(), { recursive: true, force: true });
  fs.mkdirSync(getImagesDir(), { recursive: true });
});

function makeRecipe(sourceType: "scan" | "manual" = "scan"): number {
  const draft = createDraft({ kind: "scan", text: "Route recipe" });
  draft.sourceType = sourceType;
  return saveDraft(draft).recipeId;
}

function request(body?: string, method = "POST"): Request {
  return new Request("http://localhost/api/test", {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body }),
  });
}

function routeArgs(request: Request) {
  return {
    request,
    params: {},
    context: {},
    url: new URL(request.url),
    pattern: new URL(request.url).pathname,
  };
}

async function responseJson(response: Response): Promise<unknown> {
  return response.json();
}

describe("backfill routes", () => {
  it("lists targets and renders the minimal API component", async () => {
    const recipeId = makeRecipe();
    const response = await backfillLoader(routeArgs(request(undefined, "GET")));
    expect(await responseJson(response as Response)).toMatchObject({
      targets: [{ id: recipeId, title: "Route recipe" }],
      skipped: [],
    });
    expect(renderToStaticMarkup(createElement(BackfillRoute))).toBe("");
  });

  it("validates post payloads and returns 404 for unknown recipes", async () => {
    expect((await backfillAction(routeArgs(request("{")))).status).toBe(400);
    expect((await backfillAction(routeArgs(request("null")))).status).toBe(400);
    expect((await backfillAction(routeArgs(request(JSON.stringify({ recipeId: 1.5 }))))).status).toBe(400);
    const missing = await backfillAction(
      routeArgs(request(JSON.stringify({ recipeId: 999 }))),
    );
    expect(missing.status).toBe(404);
    expect(await responseJson(missing)).toEqual({ error: "not-found" });
  });

  it("supports dry-run and executes the engine for a valid recipe", async () => {
    const scanId = makeRecipe();
    const dryRun = await backfillAction(
      routeArgs(request(JSON.stringify({ recipeId: scanId, dryRun: true }))),
    );
    expect(await responseJson(dryRun)).toEqual({
      recipeId: scanId,
      status: "would-backfill",
    });

    const manualId = makeRecipe("manual");
    const manual = await backfillAction(
      routeArgs(request(JSON.stringify({ recipeId: manualId }))),
    );
    expect(await responseJson(manual)).toMatchObject({
      recipeId: manualId,
      status: "skipped-not-scan",
    });

    const scan = await backfillAction(
      routeArgs(request(JSON.stringify({ recipeId: scanId, force: false }))),
    );
    expect(await responseJson(scan)).toMatchObject({
      recipeId: scanId,
      status: "failed",
    });
  });
});

describe("normalize image route", () => {
  it("previews on GET and validates POST payloads", async () => {
    const response = await normalizeLoader(
      routeArgs(request(undefined, "GET")),
    );
    expect(await responseJson(response as Response)).toEqual({
      moved: [],
      failed: [],
      orphans: { reported: [] },
    });
    expect(renderToStaticMarkup(createElement(NormalizeRoute))).toBe("");
    expect((await normalizeAction(routeArgs(request("{")))).status).toBe(400);
    expect((await normalizeAction(routeArgs(request("null")))).status).toBe(400);
  });

  it("moves flat covers and reports or deletes orphan files", async () => {
    const recipeId = makeRecipe();
    fs.writeFileSync(path.join(getImagesDir(), "flat.png"), "cover");
    fs.writeFileSync(path.join(getImagesDir(), "orphan.png"), "orphan");
    getDb()
      .update(recipes)
      .set({ imageFilename: "flat.png" })
      .where(eq(recipes.id, recipeId))
      .run();
    const kept = await normalizeAction(
      routeArgs(request(JSON.stringify({ keepOrphans: true }))),
    );
    expect(await responseJson(kept)).toEqual({
      moved: [{ recipeId, from: "flat.png", to: `${recipeId}/original.png` }],
      failed: [],
      orphans: { reported: ["orphan.png"] },
    });
    expect(fs.existsSync(path.join(getImagesDir(), "orphan.png"))).toBe(true);

    const deleted = await normalizeAction(routeArgs(request(JSON.stringify({}))));
    expect(await responseJson(deleted)).toEqual({
      moved: [],
      failed: [],
      orphans: { deleted: ["orphan.png"] },
    });
    expect(fs.existsSync(path.join(getImagesDir(), "orphan.png"))).toBe(false);
  });
});
