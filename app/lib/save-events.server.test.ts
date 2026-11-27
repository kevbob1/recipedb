import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { getDb } from "../db/client.server";
import { recipes, saveEvents } from "../db/schema.server";
import { blankDraft } from "./draft";
import {
  appendSaveEvent,
  isHumanOrigin,
  listSaveEvents,
  type SaveEventCaptureMode,
} from "./save-events.server";
import { withDb } from "./testing/with-db";

withDb();

function createRecipe(): number {
  const result = getDb()
    .insert(recipes)
    .values({ title: "History test", category: "other", sourceType: "manual" })
    .run();
  return Number(result.lastInsertRowid);
}

function eventFor(recipeId: number, at: Date, title: string) {
  const saved = { ...blankDraft(), title };
  return {
    recipeId,
    captureMode: "save" as const,
    recognized: null,
    saved,
    at,
  };
}

describe("save events", () => {
  it("declares a cascading recipe foreign key", () => {
    expect(getTableConfig(saveEvents).foreignKeys).toHaveLength(1);
  });

  it("persists only when the caller's transaction commits", () => {
    const recipeId = createRecipe();
    const event = eventFor(recipeId, new Date("2026-01-01T00:00:00Z"), "First");

    getDb().transaction((tx) => appendSaveEvent(event, tx));
    expect(listSaveEvents(recipeId)).toHaveLength(1);

    expect(() =>
      getDb().transaction((tx) => {
        appendSaveEvent(
          eventFor(recipeId, new Date("2026-01-02T00:00:00Z"), "Rolled back"),
          tx,
        );
        throw new Error("rollback");
      }),
    ).toThrow("rollback");
    expect(listSaveEvents(recipeId)).toHaveLength(1);
  });

  it("lists events oldest first and parses draft snapshots", () => {
    const recipeId = createRecipe();
    const db = getDb();
    db.transaction((tx) => {
      const recognized = { ...blankDraft(), title: "Machine recognized" };
      appendSaveEvent({
        ...eventFor(recipeId, new Date("2026-01-02T00:00:00Z"), "Second"),
        recognized,
      }, tx);
      appendSaveEvent(
        eventFor(recipeId, new Date("2026-01-01T00:00:00Z"), "First"),
        tx,
      );
    });

    expect(listSaveEvents(recipeId).map((event) => event.saved.title)).toEqual([
      "First",
      "Second",
    ]);
    expect(listSaveEvents(recipeId)[0]?.recognized).toBeNull();
    expect(listSaveEvents(recipeId)[1]?.recognized?.title).toBe(
      "Machine recognized",
    );
    expect(listSaveEvents(recipeId)[0]?.createdAt).toEqual(
      new Date("2026-01-01T00:00:00Z"),
    );
  });

  it.each([
    ["save", true],
    ["revise", true],
    ["backfill", false],
    ["reparse", false],
  ] as const)("classifies %s origin", (mode: SaveEventCaptureMode, human) => {
    expect(isHumanOrigin(mode)).toBe(human);
  });
});
