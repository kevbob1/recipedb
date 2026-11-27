import type { Route } from "./+types/api.backfill-scan-ocr";
import { eq } from "drizzle-orm";
import { getDb } from "../db/client.server";
import { recipes } from "../db/schema.server";
import { requireAuth } from "../lib/auth.server";
import {
  backfillRecipe,
  listBackfillTargets,
} from "../lib/backfill.server";
import { reparseRecipe } from "../lib/scan/reparse.server";

function jsonError(error: string, status: number): Response {
  return Response.json({ error }, { status });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function loader({ request }: Route.LoaderArgs) {
  requireAuth(request, { isApi: true });
  return Response.json(listBackfillTargets());
}

export async function action({ request }: Route.ActionArgs) {
  requireAuth(request, { isApi: true });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError("invalid-json", 400);
  }
  if (!isRecord(body)) {
    return jsonError("invalid-body", 400);
  }
  const recipeId = body.recipeId;
  if (typeof recipeId !== "number" || !Number.isInteger(recipeId) || recipeId < 1) {
    return jsonError("invalid-recipe-id", 400);
  }
  const recipe = getDb()
    .select({ id: recipes.id })
    .from(recipes)
    .where(eq(recipes.id, recipeId))
    .get();
  if (!recipe) return jsonError("not-found", 404);

  if (body.mode === "reparse") {
    if (body.dryRun === true) {
      const result = listBackfillTargets();
      const status = body.force !== true &&
        result.skipped.some((entry) => entry.id === recipeId)
        ? "skipped-reviewed"
        : result.targets.some((entry) => entry.id === recipeId)
          ? "would-reparse"
          : "skipped-not-scan";
      return Response.json({ recipeId, status });
    }
    const result = await reparseRecipe(recipeId, undefined, {
      force: body.force === true,
    });
    if (result.reason === "not-found") return jsonError("not-found", 404);
    return Response.json(result);
  }

  if (body.dryRun === true) {
    const result = listBackfillTargets();
    const status = body.force !== true &&
      result.skipped.some((entry) => entry.id === recipeId)
      ? "skipped-reviewed"
      : result.targets.some((entry) => entry.id === recipeId)
        ? "would-backfill"
        : "skipped-not-scan";
    return Response.json({ recipeId, status });
  }
  const result = await backfillRecipe(recipeId, undefined, {
    force: body.force === true,
  });
  if (result.error === "not-found") return jsonError("not-found", 404);
  return Response.json(result);
}

export default function BackfillScanOcrRoute() {
  return null;
}
