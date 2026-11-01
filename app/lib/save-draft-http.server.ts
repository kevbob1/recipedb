/**
 * HTTP parsing for POST /api/save-draft.
 *
 * This module decodes bodies only (JSON or multipart, new or existing, with or
 * without the original capture). It makes no persistence decision and never
 * touches the database — the route dispatches to the store seam, and
 * app/lib/draft-store.server.ts owns everything that follows.
 *
 * Lives outside the route module because React Router strips server code only
 * from route exports (loader/action/...); a helper exported from the route
 * would be pulled into the client bundle.
 */
import type { RecipeDraft } from "./draft";
import { decodeDraftPayload } from "./draft-store.server";
import { MAX_SCAN_UPLOAD_BYTES } from "./scan/index.server";

/** What a save request asks the store to do. */
export interface ParsedSaveRequest {
  /** Null only for a delete intent, which carries no draft. */
  draft: RecipeDraft | null;
  imageBytes: Buffer | null;
  /** Present when revising (or deleting) an already-stored recipe. */
  recipeId: number | null;
  intent: "delete" | null;
}

export type ParseSaveResult = ParsedSaveRequest | { error: Response };

function badRequest(error: string, message?: string): { error: Response } {
  return {
    error: Response.json(message ? { error, message } : { error }, { status: 400 }),
  };
}

function readRecipeId(value: unknown): number | null | undefined {
  if (value === null || value === undefined || value === "") return null;
  const id = typeof value === "number" ? value : Number(value);
  return Number.isInteger(id) && id > 0 ? id : undefined;
}

function readIntent(value: unknown): "delete" | null {
  return value === "delete" ? "delete" : null;
}

/**
 * Read the draft, optional capture, and routing fields from either transport.
 * Returns a Response for malformed input so the caller can early-return.
 *
 * Accepted shapes:
 *  - JSON `{ draft, recipeId?, intent? }` (and the legacy bare draft)
 *  - multipart `draft`, `image?`, `recipeId?`, `intent?`
 */
export async function parseSaveBody(request: Request): Promise<ParseSaveResult> {
  const contentType = (request.headers.get("content-type") ?? "").toLowerCase();
  if (contentType.includes("multipart/form-data")) {
    return parseMultipartBody(request);
  }
  return parseJsonBody(request);
}

async function parseJsonBody(request: Request): Promise<ParseSaveResult> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return badRequest("bad-json");
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return badRequest("bad-json");
  }

  const body = payload as Record<string, unknown>;
  const wrapper = "draft" in body || "recipeId" in body || "intent" in body;
  const recipeId = readRecipeId(body.recipeId);
  if (recipeId === undefined) return badRequest("bad-recipe-id");
  const intent = readIntent(body.intent);

  if (!wrapper) {
    // Legacy shape: the JSON body *is* the draft.
    return { draft: decodeDraftPayload(payload), imageBytes: null, recipeId, intent };
  }

  let draft: RecipeDraft | null = null;
  if (body.draft !== null && body.draft !== undefined) {
    try {
      draft = decodeDraftPayload(body.draft);
    } catch {
      return badRequest("bad-json");
    }
  }
  if (!draft && intent !== "delete") return badRequest("missing-draft");

  return { draft, imageBytes: null, recipeId, intent };
}

async function parseMultipartBody(request: Request): Promise<ParseSaveResult> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return badRequest("bad-form");
  }

  const recipeId = readRecipeId(form.get("recipeId"));
  if (recipeId === undefined) return badRequest("bad-recipe-id");
  const intent = readIntent(form.get("intent"));

  const rawDraft = form.get("draft");
  let draft: RecipeDraft | null = null;
  if (typeof rawDraft === "string" && rawDraft.length > 0) {
    try {
      draft = decodeDraftPayload(rawDraft);
    } catch {
      return badRequest("bad-json");
    }
  }
  if (!draft && intent !== "delete") return badRequest("missing-draft");

  const file = form.get("image");
  if (file === null) return { draft, imageBytes: null, recipeId, intent };
  if (typeof file === "string") return badRequest("bad-image");
  // Cheap pre-check before buffering; the definitive check is on the bytes.
  if (file.size > MAX_SCAN_UPLOAD_BYTES) {
    return {
      error: Response.json(
        {
          error: "image-too-large",
          message: `Images must be ${MAX_SCAN_UPLOAD_BYTES / (1024 * 1024)}MB or smaller.`,
        },
        { status: 413 },
      ),
    };
  }
  return {
    draft,
    imageBytes: Buffer.from(await file.arrayBuffer()),
    recipeId,
    intent,
  };
}
