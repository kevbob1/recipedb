import fs from "node:fs";
import { asc, eq } from "drizzle-orm";
import { getDataDir, getDb } from "../db/client.server";
import {
  recipePages,
  recipes,
} from "../db/schema.server";
import { createDraft } from "./import";
import { executeSave } from "./draft-store.server";
import { joinPageText } from "./review-pages";
import { ingest } from "./scan/recognize-node.server";
import { resolveStoredImagePath } from "./scan/storage.server";
import { rasterizeSourcePdf } from "./scan/rasterize.server";
import {
  isRecipeReviewed,
  reviewedRecipeIds,
  verifyBackfilledSamples,
} from "./scan/training-samples.server";

export type BackfillStatus =
  | "backfilled"
  | "skipped-reviewed"
  | "skipped-not-scan"
  | "skipped-empty-ocr"
  | "failed";

export interface BackfillResult {
  recipeId: number;
  status: BackfillStatus;
  pageCount?: number;
  confidence?: number;
  error?: string;
}

export interface BackfillDependencies {
  recognize: typeof ingest;
  clock: () => Date;
}

const defaultSeam: BackfillDependencies = {
  recognize: ingest,
  clock: () => new Date(),
};

export interface BackfillOptions {
  /** Destructively replace reviewed OCR and its training samples. */
  force?: boolean;
}

type PageSource = {
  pageNo: number;
  imageFilename: string | null;
};

export function listBackfillTargets(): {
  targets: { id: number; title: string }[];
  skipped: { id: number; title: string; reason: "reviewed" }[];
} {
  const db = getDb();
  const rows = db
    .select({ id: recipes.id, title: recipes.title })
    .from(recipes)
    .where(eq(recipes.sourceType, "scan"))
    .orderBy(asc(recipes.id))
    .all();
  const reviewed = reviewedRecipeIds(db);
  return {
    targets: rows
      .filter((row) => !reviewed.has(row.id))
      .map(({ id, title }) => ({ id, title })),
    skipped: rows
      .filter((row) => reviewed.has(row.id))
      .map(({ id, title }) => ({ id, title, reason: "reviewed" as const })),
  };
}

function pageSources(recipeId: number, imageFilename: string | null): PageSource[] {
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

export async function backfillRecipe(
  recipeId: number,
  deps: BackfillDependencies = defaultSeam,
  options: BackfillOptions = {},
): Promise<BackfillResult> {
  const db = getDb();
  const recipe = db
    .select({
      id: recipes.id,
      title: recipes.title,
      sourceType: recipes.sourceType,
      imageFilename: recipes.imageFilename,
    })
    .from(recipes)
    .where(eq(recipes.id, recipeId))
    .get();
  if (!recipe) return { recipeId, status: "failed", error: "not-found" };
  if (recipe.sourceType !== "scan") {
    return { recipeId, status: "skipped-not-scan" };
  }
  if (!options.force && isRecipeReviewed(db, recipeId)) {
    return { recipeId, status: "skipped-reviewed" };
  }

  try {
    let sources = pageSources(recipeId, recipe.imageFilename);
    if (sources.length === 0) {
      const sourcePath = resolveStoredImagePath(`${recipeId}/source.pdf`);
      if (sourcePath && fs.existsSync(sourcePath)) {
        const rasterized = await rasterizeSourcePdf(getDataDir(), recipeId);
        executeSave({
          kind: "pages",
          recipeId,
          pages: rasterized.map(({ pageNumber, imageFilename }) => ({
            pageNo: pageNumber,
            imageFilename,
            text: "",
          })),
        });
        sources = pageSources(recipeId, recipe.imageFilename);
      }
    }
    if (sources.length === 0) throw new Error("missing-image");
    const pages = [];
    for (const source of sources) {
      if (!source.imageFilename) throw new Error(`missing-image:page-${source.pageNo}`);
      const filePath = resolveStoredImagePath(source.imageFilename);
      if (!filePath) throw new Error(`missing-image:${source.imageFilename}`);
      const bytes = fs.readFileSync(filePath);
      const result = await deps.recognize({ bytes });
      pages.push({
        pageNo: source.pageNo,
        imageFilename: source.imageFilename,
        text: result.text,
        confidence: result.confidence,
      });
    }
    const joinedText = joinPageText(pages);
    if (joinedText.trim().length === 0) {
      return { recipeId, status: "skipped-empty-ocr", pageCount: pages.length };
    }

    const draft = createDraft({
      kind: "scan",
      text: joinedText,
      pages: pages.map(({ pageNo, imageFilename, text }) => ({
        pageNo,
        imageFilename,
        text,
      })),
    });
    executeSave({
      kind: "revise",
      recipeId,
      draft,
      capture: "backfill",
      acceptedAt: deps.clock(),
    });
    verifyBackfilledSamples(db, recipeId, pages.length);
    return {
      recipeId,
      status: "backfilled",
      pageCount: pages.length,
      confidence:
        pages.reduce((sum, page) => sum + page.confidence, 0) / pages.length,
    };
  } catch (error) {
    return {
      recipeId,
      status: "failed",
      error: error instanceof Error ? error.message : "backfill-failed",
    };
  }
}
