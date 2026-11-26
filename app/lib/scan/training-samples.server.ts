import { eq } from "drizzle-orm";
import type { getDb } from "../../db/client.server";
import { ocrTrainingSamples, type NewRecipePage } from "../../db/schema.server";

type RecipeDb = ReturnType<typeof getDb>;
type SamplePage = Omit<NewRecipePage, "recipeId">;
type CaptureMode =
  | { mode: "initial" }
  | { mode: "accept" }
  | { mode: "backfill"; acceptedAt?: Date };

/**
 * The single owner of ADR-0004 §3 OCR training-sample lifecycle policy.
 *
 * Call from the recipe save transaction so the sample set and recipe pages
 * commit together.
 */
export function captureTrainingSamples(
  db: RecipeDb,
  recipeId: number,
  pages: SamplePage[],
  capture: CaptureMode,
): void {
  // ADR-0004 §3 Backfill: backfill deliberately replaces both OCR texts. It
  // must not preserve prior raw OCR, unlike an ordinary review acceptance.
  const existing =
    capture.mode !== "backfill"
      ? db
          .select({
            pageNo: ocrTrainingSamples.pageNo,
            rawOcrText: ocrTrainingSamples.rawOcrText,
          })
          .from(ocrTrainingSamples)
          .where(eq(ocrTrainingSamples.recipeId, recipeId))
          .all()
      : [];
  const rawByPageNo = new Map(
    existing.map((row) => [row.pageNo, row.rawOcrText]),
  );
  db.delete(ocrTrainingSamples)
    .where(eq(ocrTrainingSamples.recipeId, recipeId))
    .run();
  if (pages.length === 0) return;
  db.insert(ocrTrainingSamples)
    .values(
      pages.map((page) => ({
        recipeId,
        pageNo: page.pageNo,
        imageFilename: page.imageFilename,
        rawOcrText: rawByPageNo.get(page.pageNo) ?? page.rawOcrText ?? "",
        correctedText: page.rawOcrText ?? "",
        acceptedAt:
          capture.mode === "initial"
            ? null
            : capture.mode === "accept"
              ? new Date()
              : (capture.acceptedAt ?? new Date()),
      })),
    )
    .run();
}

/** A sample is accepted once its human/backfill acceptance timestamp exists. */
export function isAccepted(sample: {
  acceptedAt: Date | number | null;
}): boolean {
  return sample.acceptedAt !== null;
}

/** Return recipe IDs with at least one accepted OCR training sample. */
export function reviewedRecipeIds(db: RecipeDb): Set<number> {
  const samples = db
    .select({
      recipeId: ocrTrainingSamples.recipeId,
      acceptedAt: ocrTrainingSamples.acceptedAt,
    })
    .from(ocrTrainingSamples)
    .all();
  return new Set(
    samples.filter(isAccepted).map((sample) => sample.recipeId),
  );
}

/** Whether any page sample for this recipe has been accepted. */
export function isRecipeReviewed(db: RecipeDb, recipeId: number): boolean {
  const samples = db
    .select({ acceptedAt: ocrTrainingSamples.acceptedAt })
    .from(ocrTrainingSamples)
    .where(eq(ocrTrainingSamples.recipeId, recipeId))
    .all();
  return samples.some(isAccepted);
}

/** Ensure a backfill persisted one accepted sample for every current page. */
export function verifyBackfilledSamples(
  db: RecipeDb,
  recipeId: number,
  expectedPages: number,
): void {
  const samples = db
    .select({ acceptedAt: ocrTrainingSamples.acceptedAt })
    .from(ocrTrainingSamples)
    .where(eq(ocrTrainingSamples.recipeId, recipeId))
    .all();
  if (
    samples.length !== expectedPages ||
    samples.some((sample) => !isAccepted(sample))
  ) {
    throw new Error("training-sample-verification-failed");
  }
}
