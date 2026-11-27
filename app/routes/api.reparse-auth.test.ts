import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getDb, getImagesDir } from "../db/client.server";
import { ocrTrainingSamples, recipes } from "../db/schema.server";
import { executeSave } from "../lib/draft-store.server";
import { createDraft } from "../lib/import";
import { mintToken } from "../lib/tokens.server";
import { buildSessionCookie } from "../lib/auth.server";
import { withDb } from "../lib/testing/with-db";
import { ingest } from "../lib/scan/recognize-node.server";
import { action } from "./api.backfill-scan-ocr";

vi.mock("../lib/scan/recognize-node.server", () => ({ ingest: vi.fn() }));

withDb();

const originalSessionSecret = process.env.SESSION_SECRET;

afterEach(() => {
  if (originalSessionSecret === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = originalSessionSecret;
});

function makeRecipe(): number {
  const recipeId = executeSave({
    kind: "new",
    draft: createDraft({ kind: "scan", text: "Old recipe" }),
  }).recipeId;
  const imageFilename = `${recipeId}/original.png`;
  const directory = path.join(getImagesDir(), String(recipeId));
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "original.png"), "capture");
  getDb()
    .update(recipes)
    .set({ imageFilename })
    .where(eq(recipes.id, recipeId))
    .run();
  return recipeId;
}

function args(request: Request) {
  return {
    request,
    params: {},
    context: {},
    url: new URL(request.url),
    pattern: new URL(request.url).pathname,
  };
}

function reparseRequest(recipeId: number, authorization: string): Request {
  return new Request("http://localhost/api/backfill/scan-ocr", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization,
    },
    body: JSON.stringify({ recipeId, mode: "reparse" }),
  });
}

describe("reparse action authentication", () => {
  it("accepts both cookie sessions and API bearer tokens", async () => {
    process.env.SESSION_SECRET = "reparse-route-test-secret";
    vi.mocked(ingest).mockResolvedValue({
      text: "Fresh recipe\n1 cup oats",
      confidence: 0.9,
      ms: 1,
    });
    const cookieRecipe = makeRecipe();
    const cookie = buildSessionCookie().split(";")[0]!;
    const cookieResponse = await action(
      args(
        new Request("http://localhost/api/backfill/scan-ocr", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie,
          },
          body: JSON.stringify({ recipeId: cookieRecipe, mode: "reparse" }),
        }),
      ),
    );
    expect(cookieResponse.status).toBe(200);
    expect(await cookieResponse.json()).toMatchObject({
      recipeId: cookieRecipe,
      status: "reparsed",
    });

    const bearerRecipe = makeRecipe();
    const token = mintToken("reparse test");
    const bearerResponse = await action(
      args(reparseRequest(bearerRecipe, `Bearer ${token.secret}`)),
    );
    expect(bearerResponse.status).toBe(200);
    expect(await bearerResponse.json()).toMatchObject({
      recipeId: bearerRecipe,
      status: "reparsed",
    });
  });

  it("reports reparse dry-run targets, reviewed skips, and non-scan skips", async () => {
    process.env.SESSION_SECRET = "reparse-route-test-secret";
    const cookie = buildSessionCookie().split(";")[0]!;
    const targetRecipe = makeRecipe();
    const target = await action(
      args(
        new Request("http://localhost/api/backfill/scan-ocr", {
          method: "POST",
          headers: { "content-type": "application/json", cookie },
          body: JSON.stringify({
            recipeId: targetRecipe,
            mode: "reparse",
            dryRun: true,
          }),
        }),
      ),
    );
    expect(await target.json()).toEqual({
      recipeId: targetRecipe,
      status: "would-reparse",
    });

    const reviewedRecipe = makeRecipe();
    getDb()
      .insert(ocrTrainingSamples)
      .values({
        recipeId: reviewedRecipe,
        pageNo: 1,
        imageFilename: `${reviewedRecipe}/original.png`,
        rawOcrText: "Original OCR",
        correctedText: "Reviewed OCR",
        acceptedAt: new Date("2026-01-01T00:00:00.000Z"),
      })
      .run();
    const reviewed = await action(
      args(
        new Request("http://localhost/api/backfill/scan-ocr", {
          method: "POST",
          headers: { "content-type": "application/json", cookie },
          body: JSON.stringify({
            recipeId: reviewedRecipe,
            mode: "reparse",
            dryRun: true,
          }),
        }),
      ),
    );
    expect(await reviewed.json()).toEqual({
      recipeId: reviewedRecipe,
      status: "skipped-reviewed",
    });

    const manualRecipe = makeRecipe();
    getDb()
      .update(recipes)
      .set({ sourceType: "manual" })
      .where(eq(recipes.id, manualRecipe))
      .run();
    const manual = await action(
      args(
        new Request("http://localhost/api/backfill/scan-ocr", {
          method: "POST",
          headers: { "content-type": "application/json", cookie },
          body: JSON.stringify({
            recipeId: manualRecipe,
            mode: "reparse",
            dryRun: true,
          }),
        }),
      ),
    );
    expect(await manual.json()).toEqual({
      recipeId: manualRecipe,
      status: "skipped-not-scan",
    });
  });
});
