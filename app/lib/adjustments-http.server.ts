import { asc, eq, inArray } from "drizzle-orm";
import { getDb } from "../db/client.server";
import {
  ocrTrainingSamples,
  recipePages,
  recipes,
  saveEvents,
  ingredientLines,
  steps,
  tags,
  type SourceType,
} from "../db/schema.server";
import { composeDraft } from "./draft-store.server";
import { deriveRecipeAdjustments } from "./adjustments";
import { isAccepted } from "./scan/training-samples.server";

interface WindowOptions {
  limit?: number;
  offset?: number;
}

function isSourceType(value: string): value is SourceType {
  return value === "scan" || value === "url" || value === "manual";
}

function parseWindow(url: URL): WindowOptions | Response {
  const rawLimit = url.searchParams.get("limit");
  const rawOffset = url.searchParams.get("offset");
  const limit = rawLimit === null ? undefined : Number(rawLimit);
  const offset = rawOffset === null ? undefined : Number(rawOffset);
  if (
    (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) ||
    (offset !== undefined && (!Number.isInteger(offset) || offset < 0))
  ) {
    return Response.json({ error: "invalid-pagination" }, { status: 400 });
  }
  return { limit, offset };
}

export function listRecipeSummaries(url: URL): Response {
  const window = parseWindow(url);
  if (window instanceof Response) return window;

  const db = getDb();
  let query = db
    .select({
      id: recipes.id,
      title: recipes.title,
      category: recipes.category,
      sourceType: recipes.sourceType,
      favorite: recipes.favorite,
      createdAt: recipes.createdAt,
      updatedAt: recipes.updatedAt,
    })
    .from(recipes)
    .orderBy(asc(recipes.id))
    .$dynamic();
  if (window.limit !== undefined) query = query.limit(window.limit);
  if (window.offset !== undefined) query = query.offset(window.offset);
  return Response.json(query.all());
}

export function getRecipeDraft(rawId: string | undefined): Response {
  const id = rawId === undefined ? Number.NaN : Number(rawId);
  if (!Number.isSafeInteger(id) || id < 1) {
    return Response.json({ error: "not-found" }, { status: 404 });
  }
  const db = getDb();
  const recipe = db.select().from(recipes).where(eq(recipes.id, id)).get();
  if (!recipe) return Response.json({ error: "not-found" }, { status: 404 });

  const persisted = {
    fields: {
      title: recipe.title,
      category: recipe.category,
      yield: recipe.yield,
      favorite: recipe.favorite,
      sourceType: recipe.sourceType,
      sourceUrl: recipe.sourceUrl,
      rawOcrText: recipe.rawOcrText,
      imageFilename: recipe.imageFilename,
    },
    ingredients: db
      .select()
      .from(ingredientLines)
      .where(eq(ingredientLines.recipeId, id))
      .all()
      .map(({ id: _rowId, recipeId: _recipeId, ...row }) => row),
    steps: db
      .select()
      .from(steps)
      .where(eq(steps.recipeId, id))
      .all()
      .map(({ id: _rowId, recipeId: _recipeId, ...row }) => row),
    tags: db
      .select({ label: tags.label })
      .from(tags)
      .where(eq(tags.recipeId, id))
      .all()
      .map((row) => row.label),
    pages: db
      .select()
      .from(recipePages)
      .where(eq(recipePages.recipeId, id))
      .all()
      .map(({ id: _rowId, recipeId: _recipeId, ...row }) => ({
        ...row,
        rawOcrText: row.rawOcrText,
      })),
  };
  return Response.json(composeDraft(persisted, recipe.rawOcrText ?? undefined));
}

export function getRecipeHistory(rawId: string | undefined): Response {
  const id = rawId === undefined ? Number.NaN : Number(rawId);
  if (!Number.isSafeInteger(id) || id < 1) {
    return Response.json({ error: "not-found" }, { status: 404 });
  }
  const db = getDb();
  const exists = db
    .select({ id: recipes.id })
    .from(recipes)
    .where(eq(recipes.id, id))
    .get();
  if (!exists) return Response.json({ error: "not-found" }, { status: 404 });

  const events = db
    .select()
    .from(saveEvents)
    .where(eq(saveEvents.recipeId, id))
    .orderBy(asc(saveEvents.createdAt), asc(saveEvents.id))
    .all()
    .map((event) => {
      const recognized =
        event.recognizedJson === null ? null : JSON.parse(event.recognizedJson);
      return {
        id: event.id,
        captureMode: event.captureMode,
        createdAt: event.createdAt,
        hasRecognized: recognized !== null,
        event: {
          recognized,
          saved: JSON.parse(event.savedJson),
        },
      };
    });
  return Response.json(events);
}

export function exportRecipeAdjustments(url: URL): Response {
  const window = parseWindow(url);
  if (window instanceof Response) return window;

  const source = url.searchParams.get("source");
  if (source !== null && !isSourceType(source)) {
    return Response.json({ error: "invalid-source" }, { status: 400 });
  }
  const includeMachine = url.searchParams.get("include") === "machine";
  const acceptedOnly = url.searchParams.get("accepted") === "true";
  const db = getDb();

  let recipeQuery = db
    .select()
    .from(recipes)
    .orderBy(asc(recipes.id))
    .$dynamic();
  if (source !== null) {
    recipeQuery = recipeQuery.where(eq(recipes.sourceType, source));
  }
  if (window.limit !== undefined) recipeQuery = recipeQuery.limit(window.limit);
  if (window.offset !== undefined) recipeQuery = recipeQuery.offset(window.offset);
  const selectedRecipes = recipeQuery.all();
  if (selectedRecipes.length === 0) return Response.json([]);

  const ids = selectedRecipes.map((recipe) => recipe.id);
  const sampleRows = db
    .select()
    .from(ocrTrainingSamples)
    .where(inArray(ocrTrainingSamples.recipeId, ids))
    .orderBy(asc(ocrTrainingSamples.recipeId), asc(ocrTrainingSamples.pageNo))
    .all();
  const samplesByRecipe = new Map<number, typeof sampleRows>();
  for (const sample of sampleRows) {
    if (acceptedOnly && !isAccepted(sample)) continue;
    const rows = samplesByRecipe.get(sample.recipeId) ?? [];
    rows.push(sample);
    samplesByRecipe.set(sample.recipeId, rows);
  }

  const result = selectedRecipes.map((recipe) => {
    const events = db
      .select()
      .from(saveEvents)
      .where(eq(saveEvents.recipeId, recipe.id))
      .orderBy(asc(saveEvents.createdAt), asc(saveEvents.id))
      .all();
    const derived = deriveRecipeAdjustments(events);
    return {
      recipeId: recipe.id,
      sourceType: recipe.sourceType,
      rawOcrText: recipe.rawOcrText,
      adjustments: {
        adjustments: derived.adjustments,
        machineAdjustments: includeMachine ? derived.machineAdjustments : [],
      },
      pages: (samplesByRecipe.get(recipe.id) ?? []).map((sample) => ({
        pageNo: sample.pageNo,
        rawOcrText: sample.rawOcrText,
        correctedText: sample.correctedText,
        accepted: isAccepted(sample),
      })),
    };
  });
  return Response.json(result);
}
