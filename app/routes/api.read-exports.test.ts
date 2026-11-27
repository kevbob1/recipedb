import { describe, expect, it } from "vitest";
import { getDb } from "../db/client.server";
import {
  ocrTrainingSamples,
  recipePages,
  recipes,
  saveEvents,
} from "../db/schema.server";
import { blankDraft } from "../lib/draft";
import { mintToken } from "../lib/tokens.server";
import { withDb } from "../lib/testing/with-db";
import { action as adjustmentsAction, loader as adjustmentsLoader } from "./api.adjustments";
import { action as recipesAction, loader as recipesLoader } from "./api.recipes";
import {
  action as recipeAction,
  loader as recipeLoader,
} from "./api.recipes.$id";
import {
  action as historyAction,
  loader as historyLoader,
} from "./api.recipes.$id.history";

withDb();

function args(request: Request, params: { id: string } = { id: "" }) {
  return {
    request,
    params,
    context: {},
    url: new URL(request.url),
    pattern: new URL(request.url).pathname,
  };
}

function getRequest(path: string, token?: string): Request {
  return new Request(`http://localhost${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

function expectUnauthorized(call: () => unknown): void {
  try {
    call();
  } catch (error) {
    if (!(error instanceof Response)) throw error;
    expect(error.status).toBe(401);
    return;
  }
  throw new Error("Expected the route to throw an unauthorized response.");
}

function seedRecipe(input: {
  title: string;
  sourceType: "scan" | "url" | "manual";
  rawOcrText: string | null;
  createdAt: Date;
}) {
  const row = getDb()
    .insert(recipes)
    .values({
      title: input.title,
      category: "other",
      sourceType: input.sourceType,
      rawOcrText: input.rawOcrText,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    })
    .returning()
    .get();
  if (!row) throw new Error("recipe insert failed");
  return row;
}

function seedEvents(recipeId: number, at: Date) {
  const recognized = { ...blankDraft(), title: "machine title", sourceType: "scan" as const };
  const saved = { ...recognized, title: "human title" };
  getDb()
    .insert(saveEvents)
    .values([
      {
        recipeId,
        captureMode: "save",
        recognizedJson: JSON.stringify(recognized),
        savedJson: JSON.stringify(saved),
        createdAt: at,
      },
      {
        recipeId,
        captureMode: "backfill",
        recognizedJson: JSON.stringify(saved),
        savedJson: JSON.stringify({ ...saved, title: "machine revised" }),
        createdAt: new Date(at.getTime() + 1_000),
      },
    ])
    .run();
}

describe("read-only recipe exports", () => {
  it("requires auth, accepts bearer tokens, lists recipes, and paginates", async () => {
    const first = seedRecipe({
      title: "First",
      sourceType: "scan",
      rawOcrText: "raw first",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    seedRecipe({
      title: "Second",
      sourceType: "manual",
      rawOcrText: null,
      createdAt: new Date("2026-01-02T00:00:00Z"),
    });
    const path = "/api/recipes";
    expectUnauthorized(() => recipesLoader(args(getRequest(path))));

    const token = mintToken("export test").secret;
    const response = await recipesLoader(args(getRequest(`${path}?limit=1&offset=1`, token)));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      expect.objectContaining({ id: first.id + 1, title: "Second" }),
    ]);
    expect((await recipesLoader(args(getRequest(`${path}?limit=0`, token)))).status).toBe(400);
    expect((await recipesAction(args(getRequest(path, token)))).status).toBe(405);
  });

  it("returns a composed recipe draft with OCR/pages and chronological save history", async () => {
    const at = new Date("2026-02-01T00:00:00Z");
    const recipe = seedRecipe({
      title: "Soup",
      sourceType: "scan",
      rawOcrText: "raw OCR",
      createdAt: at,
    });
    getDb().insert(ocrTrainingSamples).values({
      recipeId: recipe.id,
      pageNo: 1,
      rawOcrText: "raw page",
      correctedText: "corrected page",
      acceptedAt: at,
    }).run();
    getDb().insert(recipePages).values({
      recipeId: recipe.id,
      pageNo: 1,
      rawOcrText: "raw page",
      imageFilename: null,
    }).run();
    seedEvents(recipe.id, at);
    const token = mintToken("recipe read").secret;

    const path = `/api/recipes/${recipe.id}`;
    expectUnauthorized(() =>
      recipeLoader(args(getRequest(path), { id: String(recipe.id) })),
    );
    const detail = await recipeLoader(args(getRequest(path, token), { id: String(recipe.id) }));
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      title: "Soup",
      rawOcrText: "raw OCR",
      raw: "raw OCR",
      pages: [{ pageNo: 1, text: "raw page" }],
    });
    expect((await recipeLoader(args(getRequest("/api/recipes/999", token), { id: "999" }))).status)
      .toBe(404);
    expect((await recipeAction(args(getRequest(path, token)))).status).toBe(405);

    const historyPath = `${path}/history`;
    expectUnauthorized(() =>
      historyLoader(args(getRequest(historyPath), { id: String(recipe.id) })),
    );
    const history = await historyLoader(
      args(getRequest(historyPath, token), { id: String(recipe.id) }),
    );
    expect(await history.json()).toMatchObject([
      {
        captureMode: "save",
        hasRecognized: true,
        event: { recognized: { title: "machine title" }, saved: { title: "human title" } },
      },
      { captureMode: "backfill", hasRecognized: true },
    ]);
    expect((await historyLoader(args(getRequest("/api/recipes/999/history", token), { id: "999" })))
      .status).toBe(404);
    expect((await historyAction(args(getRequest(historyPath, token)))).status).toBe(405);
  });

  it("filters adjustment exports by source, machine events, acceptance, and recipe window", async () => {
    const at = new Date("2026-03-01T00:00:00Z");
    const scan = seedRecipe({
      title: "Scan soup",
      sourceType: "scan",
      rawOcrText: "whole OCR",
      createdAt: at,
    });
    const manual = seedRecipe({
      title: "Manual cake",
      sourceType: "manual",
      rawOcrText: null,
      createdAt: new Date(at.getTime() + 1_000),
    });
    seedEvents(scan.id, at);
    getDb()
      .insert(ocrTrainingSamples)
      .values([
        {
          recipeId: scan.id,
          pageNo: 1,
          rawOcrText: "accepted OCR",
          correctedText: "accepted correction",
          acceptedAt: at,
        },
        {
          recipeId: scan.id,
          pageNo: 2,
          rawOcrText: "unaccepted OCR",
          correctedText: "unaccepted correction",
          acceptedAt: null,
        },
      ])
      .run();
    const token = mintToken("adjustment export").secret;
    const path = "/api/adjustments";
    expectUnauthorized(() => adjustmentsLoader(args(getRequest(path))));

    const ordinary = await adjustmentsLoader(args(getRequest(`${path}?source=scan`, token)));
    const [ordinaryExport] = await ordinary.json();
    expect(ordinaryExport.recipeId).toBe(scan.id);
    expect(ordinaryExport.adjustments.machineAdjustments).toEqual([]);
    expect(ordinaryExport.pages).toHaveLength(2);

    const expanded = await adjustmentsLoader(
      args(getRequest(`${path}?source=scan&include=machine&accepted=true`, token)),
    );
    const [expandedExport] = await expanded.json();
    expect(expandedExport.adjustments.machineAdjustments.length).toBeGreaterThan(0);
    expect(expandedExport.pages).toEqual([
      {
        pageNo: 1,
        rawOcrText: "accepted OCR",
        correctedText: "accepted correction",
        accepted: true,
      },
    ]);

    const paged = await adjustmentsLoader(
      args(getRequest(`${path}?limit=1&offset=1`, token)),
    );
    expect((await paged.json()).map((entry: { recipeId: number }) => entry.recipeId))
      .toEqual([manual.id]);
    expect((await adjustmentsLoader(args(getRequest(`${path}?source=invalid`, token)))).status)
      .toBe(400);
    expect((await adjustmentsAction(args(getRequest(path, token)))).status).toBe(405);
  });

  it("returns empty arrays for an empty corpus", async () => {
    const token = mintToken("empty export").secret;
    expect(await (await recipesLoader(args(getRequest("/api/recipes", token)))).json()).toEqual([]);
    expect(await (await adjustmentsLoader(args(getRequest("/api/adjustments", token)))).json())
      .toEqual([]);
  });
});
