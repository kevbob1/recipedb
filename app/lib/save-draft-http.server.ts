/**
 * HTTP transport for saving a draft (#28 multipart upload included).
 *
 * Lives outside the route module because React Router strips server code only
 * from route exports (loader/action/...); a helper exported from the route
 * would be pulled into the client bundle and drag `auth.server` with it.
 */
import { saveDraft, SaveError, deleteRecipe } from "./save-draft.server";
import type { RecipeDraft } from "./draft";
import { requireAuth } from "./auth.server";
import {
  MAX_SCAN_UPLOAD_BYTES,
  ScanImageError,
  attachImageFilename,
  saveOriginalScanImage,
  validateScanUpload,
} from "./scan-image.server";

function scanErrorResponse(err: ScanImageError): Response {
  const status =
    err.code === "image-too-large"
      ? 413
      : err.code === "image-write-failed"
        ? 500
        : 400;
  return Response.json({ error: err.code, message: err.message }, { status });
}

/**
 * Read the draft and (optionally) the original capture from either transport.
 * Returns a Response for malformed input so the caller can early-return.
 */
async function parseSaveBody(
  request: Request,
): Promise<
  | { draft: RecipeDraft; imageBytes: Buffer | null }
  | { error: Response }
> {
  const contentType = (request.headers.get("content-type") ?? "").toLowerCase();

  if (contentType.includes("multipart/form-data")) {
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return { error: Response.json({ error: "bad-form" }, { status: 400 }) };
    }
    const raw = form.get("draft");
    if (typeof raw !== "string" || raw.length === 0) {
      return {
        error: Response.json({ error: "missing-draft" }, { status: 400 }),
      };
    }
    let draft: RecipeDraft;
    try {
      draft = JSON.parse(raw) as RecipeDraft;
    } catch {
      return { error: Response.json({ error: "bad-json" }, { status: 400 }) };
    }

    const file = form.get("image");
    if (file === null) return { draft, imageBytes: null };
    if (typeof file === "string") {
      return {
        error: Response.json({ error: "bad-image" }, { status: 400 }),
      };
    }
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
    return { draft, imageBytes: Buffer.from(await file.arrayBuffer()) };
  }

  try {
    const draft = (await request.json()) as RecipeDraft;
    return { draft, imageBytes: null };
  } catch {
    return { error: Response.json({ error: "bad-json" }, { status: 400 }) };
  }
}

/** Handle POST /api/save-draft (JSON or multipart). */
export async function handleSaveDraftRequest(request: Request): Promise<Response> {
  // Auth gate: this is the write path, gate before any DB work.
  requireAuth(request, { isApi: true });
  if (request.method !== "POST") {
    return Response.json({ error: "method-not-allowed" }, { status: 405 });
  }

  const parsed = await parseSaveBody(request);
  if ("error" in parsed) return parsed.error;
  const { draft, imageBytes } = parsed;

  if (imageBytes) {
    try {
      validateScanUpload(imageBytes);
    } catch (err) {
      if (err instanceof ScanImageError) return scanErrorResponse(err);
      throw err;
    }
  }

  let recipeId: number | null = null;
  try {
    const result = saveDraft(draft);
    recipeId = result.recipeId;
    if (imageBytes) {
      const filename = saveOriginalScanImage(result.recipeId, imageBytes);
      attachImageFilename(result.recipeId, filename);
    }
    return Response.json(result);
  } catch (err) {
    // Never leave a recipe behind when its capture could not be stored.
    if (recipeId !== null && err instanceof ScanImageError) {
      deleteRecipe(recipeId);
      return scanErrorResponse(err);
    }
    if (err instanceof SaveError) {
      return Response.json({ error: err.code, message: err.message }, { status: 400 });
    }
    console.error("[api.save-draft] unexpected error", err);
    return Response.json({ error: "internal" }, { status: 500 });
  }
}
