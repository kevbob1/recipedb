import { describe, expect, it } from "vitest";
import { recipes } from "../db/schema.server";
import { blankDraft } from "./draft";
import { executeSave } from "./draft-store.server";
import { getDb, getRawSqlite } from "../db/client.server";
import { decodeDraftPayload, validateSaveCommand } from "./save-command";
import { listSaveEvents } from "./save-events.server";
import { withDb } from "./testing/with-db";

withDb();

function draft(title: string) {
  return { ...blankDraft(), title, category: "other" as const };
}

describe("executeSave event ledger", () => {
  it("validates recognized snapshots when present and absent", () => {
    const recognized = draft("Recognized");
    expect(
      validateSaveCommand({
        kind: "new",
        draft: draft("Saved"),
        recognized,
      }),
    ).toMatchObject({ kind: "new", recognized });
    expect(
      validateSaveCommand({ kind: "new", draft: draft("Manual") }),
    ).toMatchObject({ kind: "new", recognized: null });
    expect(() => decodeDraftPayload("[]")).toThrow();
    const malformed = JSON.parse(
      JSON.stringify({
        kind: "new",
        draft: draft("Saved"),
        recognized: [],
      }),
    );
    expect(() => validateSaveCommand(malformed)).toThrow();
  });

  it("records one new-save event with recognized and final saved snapshots", () => {
    const recognized = draft("Recognized");
    const result = executeSave({
      kind: "new",
      draft: draft("Saved"),
      recognized,
    });
    const events = listSaveEvents(result.recipeId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      captureMode: "save",
      recognized,
      saved: { title: "Saved" },
    });
  });

  it("records revise and backfill events, and no event for delete", () => {
    const created = executeSave({ kind: "new", draft: draft("Before") });
    expect(listSaveEvents(created.recipeId)).toHaveLength(1);
    executeSave({
      kind: "revise",
      recipeId: created.recipeId,
      draft: draft("Revised"),
      recognized: draft("Before"),
    });
    expect(listSaveEvents(created.recipeId)).toHaveLength(2);
    expect(listSaveEvents(created.recipeId)[1]).toMatchObject({
      captureMode: "revise",
      recognized: draft("Before"),
      saved: { title: "Revised" },
    });

    executeSave({
      kind: "revise",
      recipeId: created.recipeId,
      draft: draft("Machine"),
      capture: "backfill",
    });
    expect(listSaveEvents(created.recipeId)[2]).toMatchObject({
      captureMode: "backfill",
      recognized: null,
      saved: { title: "Machine" },
    });

    executeSave({ kind: "delete", recipeId: created.recipeId });
    expect(listSaveEvents(created.recipeId)).toHaveLength(0);
  });

  it("rolls back the recipe and event if event insertion fails", () => {
    const sqlite = getRawSqlite();
    sqlite.exec(
      "CREATE TRIGGER reject_save_event BEFORE INSERT ON save_events BEGIN SELECT RAISE(ABORT, 'reject event'); END;",
    );
    expect(() => executeSave({ kind: "new", draft: draft("Rollback") })).toThrow(
      "reject event",
    );
    expect(getDb().select().from(recipes).all()).toHaveLength(0);
    expect(listSaveEvents(1)).toHaveLength(0);
    sqlite.exec("DROP TRIGGER reject_save_event");
  });
});
