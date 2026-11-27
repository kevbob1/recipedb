import fs from "node:fs";
import { asc, eq } from "drizzle-orm";
import { getDb } from "../../db/client.server";
import { recipePages, recipes } from "../../db/schema.server";
import { executeSave } from "../draft-store.server";
import { createDraft } from "../import";
import { joinPageText } from "../review-pages";
import { isRecipeReviewed } from "./training-samples.server";
import { ingest } from "./recognize-node.server";
import { resolveStoredImagePath } from "./storage.server";

export type ReparseStatus = "reparsed" | "skipped" | "error";

export interface ReparseResult {
  recipeId: number;
  status: ReparseStatus;
  fieldsParsed?: {
    title?: string;
    ingredientCount: number;
    stepCount: number;
  };
  reason?: "not-found" | "not-scan" | "reviewed" | "empty-ocr";
  error?: string;
}

export interface ReparseDependencies {
  recognize: typeof ingest;
}

const defaultDependencies: ReparseDependencies = { recognize: ingest };

interface PageSource {
  pageNo: number;
  imageFilename: string | null;
}

function pageSources(
  recipeId: number,
  imageFilename: string | null,
): PageSource[] {
  const pages = getDb()
    .select({
      pageNo: recipePages.pageNo,
      imageFilename: recipePages.imageFilename,
    })
    .from(recipePages)
    .where(eq(recipePages.recipeId, recipeId))
    .orderBy(asc(recipePages.pageNo))
    .all();
  if (pages.length > 0) {
    return pages.map((page) => ({
      pageNo: page.pageNo,
      imageFilename: page.imageFilename,
    }));
  }
  return imageFilename ? [{ pageNo: 1, imageFilename }] : [];
}

/**
 * Re-OCR retained originals, then persist the server-derived machine snapshot.
 * Human edits are intentionally replaced; reviewed recipes require force.
 */
export async function reparseRecipe(
  recipeId: number,
  deps: ReparseDependencies = defaultDependencies,
  options: { force?: boolean } = {},
): Promise<ReparseResult> {
  const db = getDb();
  const recipe = db
    .select({
      id: recipes.id,
      sourceType: recipes.sourceType,
      imageFilename: recipes.imageFilename,
    })
    .from(recipes)
    .where(eq(recipes.id, recipeId))
    .get();
  if (!recipe) return { recipeId, status: "skipped", reason: "not-found" };
  if (recipe.sourceType !== "scan") {
    return { recipeId, status: "skipped", reason: "not-scan" };
  }
  if (!options.force && isRecipeReviewed(db, recipeId)) {
    return { recipeId, status: "skipped", reason: "reviewed" };
  }

  try {
    const sources = pageSources(recipeId, recipe.imageFilename);
    if (sources.length === 0) throw new Error("missing-image");
    const pages = [];
    for (const source of sources) {
      if (!source.imageFilename) {
        throw new Error(`missing-image:page-${source.pageNo}`);
      }
      const filePath = resolveStoredImagePath(source.imageFilename);
      if (!filePath) throw new Error(`missing-image:${source.imageFilename}`);
      const result = await deps.recognize({ bytes: fs.readFileSync(filePath) });
      pages.push({
        pageNo: source.pageNo,
        imageFilename: source.imageFilename,
        text: result.text,
      });
    }
    const text = joinPageText(pages);
    if (text.trim().length === 0) {
      return { recipeId, status: "skipped", reason: "empty-ocr" };
    }

    const draft = createDraft({
      kind: "scan",
      text,
      pages: pages.map(({ pageNo, imageFilename, text: pageText }) => ({
        pageNo,
        imageFilename,
        text: pageText,
      })),
      imageFilename: recipe.imageFilename,
    });
    executeSave({
      kind: "revise",
      recipeId,
      draft,
      capture: "reparse",
      recognized: draft,
    });
    return {
      recipeId,
      status: "reparsed",
      fieldsParsed: {
        title: draft.title || undefined,
        ingredientCount: draft.ingredients.length,
        stepCount: draft.steps.length,
      },
    };
  } catch (error) {
    return {
      recipeId,
      status: "error",
      error: error instanceof Error ? error.message : "reparse-failed",
    };
  }
}
