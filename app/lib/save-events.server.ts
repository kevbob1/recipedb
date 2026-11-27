import { asc, eq } from "drizzle-orm";
import { getDb } from "../db/client.server";
import { saveEvents } from "../db/schema.server";
import type { RecipeDraft } from "./draft";

export type SaveEventCaptureMode = "save" | "revise" | "backfill" | "reparse";

export function isHumanOrigin(mode: SaveEventCaptureMode): boolean {
  return mode === "save" || mode === "revise";
}

export interface AppendSaveEventInput {
  recipeId: number;
  captureMode: SaveEventCaptureMode;
  recognized: RecipeDraft | null;
  saved: RecipeDraft;
  at: Date;
}

export interface ListedSaveEvent {
  id: number;
  recipeId: number;
  captureMode: SaveEventCaptureMode;
  recognized: RecipeDraft | null;
  saved: RecipeDraft;
  createdAt: Date;
}

function stableJson(value: unknown): string {
  const sortKeys = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(sortKeys);
    if (input !== null && typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, entry]) => [key, sortKeys(entry)]),
      );
    }
    return input;
  };

  // RecipeDraft is always an object with JSON-compatible fields.
  return JSON.stringify(sortKeys(value))!;
}

/**
 * Append a save snapshot using the caller's transaction so history and recipe
 * persistence commit or roll back together.
 */
export function appendSaveEvent(
  event: AppendSaveEventInput,
  tx: Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0],
): void {
  tx.insert(saveEvents)
    .values({
      recipeId: event.recipeId,
      captureMode: event.captureMode,
      recognizedJson:
        event.recognized === null ? null : stableJson(event.recognized),
      savedJson: stableJson(event.saved),
      createdAt: event.at,
    })
    .run();
}

/** Read a recipe's save history in chronological order. */
export function listSaveEvents(recipeId: number): ListedSaveEvent[] {
  return getDb()
    .select()
    .from(saveEvents)
    .where(eq(saveEvents.recipeId, recipeId))
    .orderBy(asc(saveEvents.createdAt), asc(saveEvents.id))
    .all()
    .map((row) => ({
      id: row.id,
      recipeId: row.recipeId,
      captureMode: row.captureMode,
      recognized:
        row.recognizedJson === null
          ? null
          : (JSON.parse(row.recognizedJson) as RecipeDraft),
      saved: JSON.parse(row.savedJson) as RecipeDraft,
      createdAt: row.createdAt,
    }));
}
