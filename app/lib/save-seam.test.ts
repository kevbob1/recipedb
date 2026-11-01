/**
 * Seam guard for the unified save path (candidate #1).
 *
 * Three jobs:
 *  1. Static: prove the review-save decisions stay in the store — the route
 *     module is auth + dispatch, the HTTP helper is body parsing, and neither
 *     one touches SQL, decodes a draft, or sequences the capture itself. The
 *     pure module must stay I/O free.
 *  2. Pure: payload decoding + field validation are unit-tested with no
 *     Request, no FormData, and no SQLite.
 *  3. Behavioural: `executeSave` covers the three paths the review screen can
 *     ask for — new draft, existing draft, delete intent — and a rejected
 *     capture never leaves a recipe behind.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureDataDirs, getDb, getRawSqlite } from "../db/client.server";
import { recipes } from "../db/schema.server";
import { runMigrations } from "../db/migrate.server";
import type { RecipeDraft } from "./draft";
import {
  executeSave,
  loadDraft,
  saveExistingDraft,
  saveNewDraft,
} from "./draft-store.server";
import {
  SaveError,
  decodeDraftPayload,
  validateSaveCommand,
} from "./save-command";
import { ScanImageError } from "./scan/index.server";

const root = process.cwd();
function source(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

const routeSource = source("app/routes/api.save-draft.ts");
const httpSource = source("app/lib/save-draft-http.server.ts");
const pureSource = source("app/lib/save-command.ts");

/** SQL, image writes, and draft preparation belong to the store alone. */
const STORE_ONLY = [
  /getDb\(/,
  /getRawSqlite\(/,
  /\.insert\(/,
  /\.update\(/,
  /\.delete\(/,
  /prepareDraft\(/,
  /validateScanUpload\(/,
  /saveOriginalScanImage\(/,
  /attachImageFilename\(/,
];

/** The validator must stay pure: no db, no scan module, no store import. */
const PURE_ONLY = [
  /getDb\(/,
  /getRawSqlite\(/,
  /from "\.\.\/db\/client/,
  /from "\.\/scan\//,
  /from "\.\/draft-store\.server"/,
  /request\.(json|formData)\(/,
  /saveOriginalScanImage\(/,
  /validateScanUpload\(/,
];

describe("save seam — static guard", () => {
  it("keeps SQL, draft preparation, and capture handling out of the route and HTTP layers", () => {
    for (const [layer, text] of [
      ["route", routeSource],
      ["http helper", httpSource],
    ] as const) {
      for (const pattern of STORE_ONLY) {
        expect(text, `${layer} must not match ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it("keeps the pure validator free of I/O and store imports", () => {
    for (const pattern of PURE_ONLY) {
      expect(pureSource, `save-command must not match ${pattern}`).not.toMatch(
        pattern,
      );
    }
  });

  it("route is an auth gate and one-command dispatcher", () => {
    expect(routeSource).toMatch(/requireAuth\(/);
    expect(routeSource).toMatch(/executeSave\(/);
    expect(routeSource).not.toMatch(/saveNewDraft\(|saveExistingDraft\(/);
    expect(routeSource).not.toMatch(/request\.formData\(/);
    expect(routeSource).not.toMatch(/request\.json\(/);
    expect(routeSource).not.toMatch(/decodeDraftPayload/);
    // No intent/recipeId re-interpretation: the command already says what to
    // do, so the route never reads either field.
    expect(routeSource).not.toMatch(/\.(intent|recipeId)\b/);
  });

  it("HTTP helper builds commands and never decodes or persists", () => {
    expect(httpSource).toMatch(/export async function parseSaveBody/);
    expect(httpSource).toMatch(/multipart\/form-data/);
    expect(httpSource).not.toMatch(/draft-store\.server/);
    expect(httpSource).not.toMatch(/decodeDraftPayload|prepareDraft\(/);
    expect(httpSource).not.toMatch(
      /saveNewDraft|saveExistingDraft|saveDraft\(|updateDraft\(|deleteRecipe\(|executeSave\(/,
    );
  });
});

let tmpDir: string;
let originalDataDir: string | undefined;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "recipedb-seam-"));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tmpDir;
  ensureDataDirs();
  runMigrations();
});

afterAll(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  getRawSqlite().close();
});

function draft(title: string): RecipeDraft {
  return {
    title,
    titleConfidence: "ok",
    category: "soup",
    categoryConfidence: "ok",
    yield: "2 servings",
    yieldConfidence: "ok",
    tags: ["seam"],
    sourceType: "manual",
    sourceUrl: null,
    rawOcrText: null,
    imageFilename: null,
    favorite: false,
    ingredients: [
      {
        text: "1 cup water",
        qty: "1 cup",
        unit: "cup",
        item: "water",
        note: null,
        confidence: "ok",
      },
    ],
    steps: [{ position: 1, text: "Boil." }],
  };
}

describe("save seam — pure validation", () => {
  it("decodes a wire payload and reduces it to the persisted half", () => {
    const validated = validateSaveCommand({
      kind: "new",
      draft: JSON.stringify(draft("  Pure  ")),
    });
    expect(validated.kind).toBe("new");
    if (validated.kind !== "new") throw new Error("unreachable");
    expect(validated.prepared.fields.title).toBe("Pure");
    expect(validated.prepared.tags).toEqual(["seam"]);
    expect(validated.prepared.ingredients).toHaveLength(1);
    expect(validated.prepared.ingredients[0]?.position).toBe(1);
    expect(validated.imageBytes).toBeNull();
  });

  it("accepts an already-parsed payload (JSON transport)", () => {
    const validated = validateSaveCommand({
      kind: "revise",
      recipeId: 12,
      draft: draft("Parsed"),
    });
    expect(validated).toMatchObject({ kind: "revise", recipeId: 12 });
    if (validated.kind !== "revise") throw new Error("unreachable");
    expect(validated.prepared.fields.title).toBe("Parsed");
  });

  it("carries the capture bytes through the command", () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const validated = validateSaveCommand({
      kind: "new",
      draft: draft("With capture"),
      imageBytes: bytes,
    });
    expect(validated.kind).toBe("new");
    if (validated.kind !== "new") throw new Error("unreachable");
    expect(validated.imageBytes).toEqual(bytes);
  });

  it("turns a delete into a validated delete command with no draft", () => {
    expect(validateSaveCommand({ kind: "delete", recipeId: 7 })).toEqual({
      kind: "delete",
      recipeId: 7,
    });
    expect(() => validateSaveCommand({ kind: "delete", recipeId: 0 })).toThrowError(
      SaveError,
    );
  });

  it("rejects missing, malformed, and non-object drafts", () => {
    for (const bad of [null, undefined]) {
      expect(() =>
        validateSaveCommand({ kind: "new", draft: bad, imageBytes: null }),
      ).toThrowError(SaveError);
    }
    try {
      decodeDraftPayload("{not json");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as SaveError).code).toBe("bad-json");
    }
    try {
      decodeDraftPayload([1, 2, 3]);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as SaveError).code).toBe("bad-draft");
    }
  });

  it("rejects a blank title and an unknown category without touching storage", () => {
    expect(() =>
      validateSaveCommand({ kind: "new", draft: draft("   ") }),
    ).toThrowError(SaveError);
    try {
      validateSaveCommand({
        kind: "new",
        draft: { ...draft("Bad category"), category: "brunch" },
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as SaveError).code).toBe("invalid-category");
    }
  });

  it("requires a positive integer id to revise or delete", () => {
    for (const recipeId of [0, -3, 1.5]) {
      expect(() =>
        validateSaveCommand({ kind: "revise", recipeId, draft: draft("Bad id") }),
      ).toThrowError(SaveError);
      expect(() =>
        validateSaveCommand({ kind: "delete", recipeId }),
      ).toThrowError(SaveError);
    }
  });
});

describe("save seam — executeSave dispatch", () => {
  it("creates a reviewable draft from a command", () => {
    const result = executeSave({ kind: "new", draft: draft("Command New") });
    expect(result).toMatchObject({ isDraft: true });
    if (!("isDraft" in result)) throw new Error("unreachable");
    expect(loadDraft(result.recipeId)?.title).toBe("Command New");
  });

  it("accepts a JSON-string draft straight from the wire", () => {
    const result = executeSave({
      kind: "new",
      draft: JSON.stringify(draft("Command Wire")),
    });
    if (!("isDraft" in result)) throw new Error("unreachable");
    expect(loadDraft(result.recipeId)?.title).toBe("Command Wire");
  });

  it("revises in place from a command", () => {
    const created = executeSave({ kind: "new", draft: draft("Command Before") });
    if (!("isDraft" in created)) throw new Error("unreachable");

    const revised = executeSave({
      kind: "revise",
      recipeId: created.recipeId,
      draft: draft("Command After"),
    });
    expect(revised).toMatchObject({ recipeId: created.recipeId, isDraft: true });
    expect(loadDraft(created.recipeId)?.title).toBe("Command After");
  });

  it("deletes from a command and reports a missing id as not-found", () => {
    const created = executeSave({ kind: "new", draft: draft("Command Delete") });
    if (!("isDraft" in created)) throw new Error("unreachable");

    expect(
      executeSave({ kind: "delete", recipeId: created.recipeId }),
    ).toEqual({ recipeId: created.recipeId, deleted: true });
    expect(loadDraft(created.recipeId)).toBeNull();

    expect(() =>
      executeSave({ kind: "delete", recipeId: created.recipeId }),
    ).toThrowError(SaveError);
  });

  it("rejects an invalid draft before any row is written", () => {
    const before = getDb().select().from(recipes).all().length;
    expect(() =>
      executeSave({ kind: "new", draft: draft("  "), imageBytes: null }),
    ).toThrowError(SaveError);
    expect(getDb().select().from(recipes).all().length).toBe(before);
  });
});

describe("save seam — store path wrappers", () => {
  it("saveNewDraft creates a reviewable draft", () => {
    const { recipeId, isDraft } = saveNewDraft(draft("Seam New"));
    expect(isDraft).toBe(true);
    expect(loadDraft(recipeId)?.title).toBe("Seam New");
  });

  it("saveExistingDraft revises in place", () => {
    const { recipeId } = saveNewDraft(draft("Seam Before"));
    const result = saveExistingDraft(recipeId, draft("Seam After"));
    expect(result).toMatchObject({ recipeId, isDraft: true });
    expect(loadDraft(recipeId)?.title).toBe("Seam After");

    expect(() => saveExistingDraft(999_999, draft("Missing"))).toThrowError(
      SaveError,
    );
  });

  it("saveExistingDraft honours the delete intent", () => {
    const { recipeId } = saveNewDraft(draft("Seam Delete"));
    expect(saveExistingDraft(recipeId, null, { delete: true })).toMatchObject({
      recipeId,
      deleted: true,
    });
    expect(loadDraft(recipeId)).toBeNull();

    expect(() => saveExistingDraft(recipeId, null, { delete: true })).toThrowError(
      SaveError,
    );
  });

  it("rolls the recipe back when the capture cannot be stored", () => {
    const before = getDb().select().from(recipes).all().length;
    expect(() =>
      saveNewDraft(draft("Seam Bad Capture"), Buffer.from("not an image")),
    ).toThrowError(ScanImageError);
    expect(getDb().select().from(recipes).all().length).toBe(before);
  });
});
