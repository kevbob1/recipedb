/**
 * HTTP transport for POST /api/save-draft: body bytes -> SaveCommand.
 *
 * This module is a pure adapter. It reads either transport (JSON or multipart),
 * keeps the cheap `file.size` pre-check, and returns the command the store
 * should run. It makes no persistence decision, never touches the database,
 * and never decodes a draft: the wire draft rides through untouched and
 * app/lib/save-command.ts decides whether it is valid. The definitive
 * validateScanUpload happens in the store, on the bytes.
 *
 * Lives outside the route module because React Router strips server code only
 * from route exports (loader/action/...); a helper exported from the route
 * would be pulled into the client bundle.
 */
import { MAX_SCAN_UPLOAD_BYTES } from "./scan/index.server";
import type { SaveCommand } from "./save-command";

/** A command ready to dispatch, or a Response the caller should return. */
export type ParseSaveResult = SaveCommand | { error: Response };

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

/** A delete needs an id; without one the request carries no command. */
function deleteCommand(recipeId: number | null): ParseSaveResult {
  if (recipeId === null) return badRequest("bad-recipe-id");
  return { kind: "delete", recipeId };
}

/**
 * Turn a present draft into a new-or-revise command. `draft` stays raw (a JSON
 * string for multipart, the parsed value for JSON bodies) because decoding is
 * a validity decision owned by the store.
 */
function draftCommand(
  recipeId: number | null,
  draft: unknown,
  imageBytes: Buffer | null,
): ParseSaveResult {
  return recipeId === null
    ? { kind: "new", draft, imageBytes }
    : { kind: "revise", recipeId, draft };
}

/**
 * Read the draft, optional capture, and routing fields from either transport.
 * Returns a Response for malformed input so the caller can early-return.
 *
 * Accepted shapes (unchanged):
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
    return draftCommand(recipeId, payload, null);
  }

  if (intent === "delete") return deleteCommand(recipeId);
  if (body.draft === null || body.draft === undefined) {
    return badRequest("missing-draft");
  }
  return draftCommand(recipeId, body.draft, null);
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
  if (intent === "delete") return deleteCommand(recipeId);

  const rawDraft = form.get("draft");
  if (typeof rawDraft !== "string" || rawDraft.length === 0) {
    return badRequest("missing-draft");
  }

  const file = form.get("image");
  if (file === null) return draftCommand(recipeId, rawDraft, null);
  if (typeof file === "string") return badRequest("bad-image");
  // Cheap pre-check before buffering; the definitive check is on the bytes
  // inside the store.
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

  const imageBytes = Buffer.from(await file.arrayBuffer());
  // Revisions do not attach captures (unchanged): the bytes were still
  // size-checked, then dropped before the command is built.
  return draftCommand(recipeId, rawDraft, recipeId === null ? imageBytes : null);
}
