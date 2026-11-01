/**
 * Seam guard for the unified save path (candidate #1).
 *
 * Two jobs:
 *  1. Static: prove the review-save decisions stay in the store — the route
 *     module is auth + dispatch, the HTTP helper is body parsing, and neither
 *     one touches SQL or sequences the capture itself.
 *  2. Behavioural: the store covers the three paths the review screen can ask
 *     for — new draft, existing draft, delete intent — and a rejected capture
 *     never leaves a recipe behind.
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
  SaveError,
  loadDraft,
  saveExistingDraft,
  saveNewDraft,
} from "./draft-store.server";
import { ScanImageError } from "./scan/index.server";

const root = process.cwd();
function source(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

const routeSource = source("app/routes/api.save-draft.ts");
const httpSource = source("app/lib/save-draft-http.server.ts");

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

  it("route is an auth gate and dispatcher, not a body parser", () => {
    expect(routeSource).toMatch(/requireAuth\(/);
    expect(routeSource).toMatch(/saveNewDraft\(/);
    expect(routeSource).toMatch(/saveExistingDraft\(/);
    expect(routeSource).not.toMatch(/request\.formData\(/);
    expect(routeSource).not.toMatch(/request\.json\(/);
    expect(routeSource).not.toMatch(/decodeDraftPayload/);
  });

  it("HTTP helper parses both transports and never persists", () => {
    expect(httpSource).toMatch(/export async function parseSaveBody/);
    expect(httpSource).toMatch(/multipart\/form-data/);
    expect(httpSource).not.toMatch(
      /saveNewDraft|saveExistingDraft|saveDraft\(|updateDraft\(|deleteRecipe\(/,
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

describe("save seam — store paths", () => {
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
