import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { getDb, getImagesDir } from "../db/client.server";
import { recipes } from "../db/schema.server";
import { executeSave } from "../lib/draft-store.server";
import { createDraft } from "../lib/import";
import {
  action as backfillAction,
  loader as backfillLoader,
} from "./api.backfill-scan-ocr";
import {
  action as normalizeAction,
  loader as normalizeLoader,
} from "./api.backfill-normalize-images";
import { withDb } from "../lib/testing/with-db";

vi.mock("../lib/auth.server", () => ({
  requireAuth: vi.fn(),
}));

withDb();

function makeRecipe(sourceType: "scan" | "manual" = "scan"): number {
  const draft = createDraft({ kind: "scan", text: "Route recipe" });
  draft.sourceType = sourceType;
  return executeSave({ kind: "new", draft }).recipeId;
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
  it("returns the target list as a verbatim JSON resource response", async () => {
    const recipeId = makeRecipe();
    const response = await backfillLoader(routeArgs(request(undefined, "GET")));
    expect(response.headers.get("content-type")).toMatch(/^application\/json/);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({
      targets: [{ id: recipeId, title: "Route recipe" }],
      skipped: [],
    });
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
