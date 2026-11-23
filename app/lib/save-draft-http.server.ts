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
import type { SaveCommand, SavePageFile } from "./save-command";

/** A command ready to dispatch, or a Response the caller should return. */
export type ParseSaveResult = SaveCommand | { error: Response };

function badRequest(error: string, message?: string): { error: Response } {
  return {
    error: Response.json(message ? { error, message } : { error }, { status: 400 }),
  };
}

function tooLarge(error: string, message: string): { error: Response } {
  return { error: Response.json({ error, message }, { status: 413 }) };
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
 *
 * Page rasters and the source PDF (ADR-0004) ride alongside the capture on
 * new saves only; on a revise the transport still size/magic-checks the bytes,
 * then drops them, mirroring the original capture.
 */
function draftCommand(
  recipeId: number | null,
  draft: unknown,
  imageBytes: Buffer | null,
  pageFiles: SavePageFile[] = [],
  pdfBytes: Buffer | null = null,
): ParseSaveResult {
  return recipeId === null
    ? { kind: "new", draft, imageBytes, pageFiles, pdfBytes }
    : { kind: "revise", recipeId, draft };
}

/**
 * Read the draft, optional capture, and routing fields from either transport.
 * Returns a Response for malformed input so the caller can early-return.
 *
 * Accepted shapes:
 *  - JSON `{ draft, recipeId?, intent? }` (and the legacy bare draft)
 *  - multipart `draft`, `image?`, `page-<n>?`, `pdf?`, `recipeId?`, `intent?`
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
  if (typeof file === "string") return badRequest("bad-image");
  // Cheap pre-check before buffering; the definitive check is on the bytes
  // inside the store.
  if (file && file.size > MAX_SCAN_UPLOAD_BYTES) {
    return tooLarge(
      "image-too-large",
      `Images must be ${MAX_SCAN_UPLOAD_BYTES / (1024 * 1024)}MB or smaller.`,
    );
  }
  const imageBytes = file ? Buffer.from(await file.arrayBuffer()) : null;

  // Page rasters (ADR-0004): one uploaded file per scanned-PDF page, named
  // page-<n> after its 1-based page number. Same ceiling and pre-check rules
  // as the original capture.
  const seenPages = new Set<number>();
  const pageFiles: SavePageFile[] = [];
  for (const [name, value] of form.entries()) {
    const match = /^page-(\d+)$/.exec(name);
    if (!match) continue;
    const pageNo = Number(match[1]);
    if (!Number.isInteger(pageNo) || pageNo < 1) {
      return badRequest("bad-page", `Page number "${name}" is not valid.`);
    }
    if (typeof value === "string") {
      return badRequest("bad-page", `Page ${pageNo} upload is not a file.`);
    }
    if (seenPages.has(pageNo)) {
      return badRequest("bad-page", `Page ${pageNo} was uploaded twice.`);
    }
    seenPages.add(pageNo);
    if (value.size > MAX_SCAN_UPLOAD_BYTES) {
      return tooLarge(
        "image-too-large",
        `Images must be ${MAX_SCAN_UPLOAD_BYTES / (1024 * 1024)}MB or smaller.`,
      );
    }
    pageFiles.push({ pageNo, bytes: Buffer.from(await value.arrayBuffer()) });
  }
  pageFiles.sort((a, b) => a.pageNo - b.pageNo);

  // The original scanned PDF rides alongside the page rasters and is stored
  // byte-for-byte (ADR-0004). Cheap pre-checks here; the definitive check is
  // on the bytes inside the store.
  const pdf = form.get("pdf");
  let pdfBytes: Buffer | null = null;
  if (pdf !== null) {
    if (typeof pdf === "string") {
      return badRequest("bad-pdf", "The PDF upload is not a file.");
    }
    if (pdf.size > MAX_SCAN_UPLOAD_BYTES) {
      return tooLarge(
        "pdf-too-large",
        `PDFs must be ${MAX_SCAN_UPLOAD_BYTES / (1024 * 1024)}MB or smaller.`,
      );
    }
    pdfBytes = Buffer.from(await pdf.arrayBuffer());
    if (pdfBytes.toString("ascii", 0, 5) !== "%PDF-") {
      return badRequest("bad-pdf", "The uploaded file is not a PDF.");
    }
  }

  // Revisions do not attach captures (unchanged): the bytes were still
  // checked, then dropped before the command is built.
  return draftCommand(
    recipeId,
    rawDraft,
    recipeId === null ? imageBytes : null,
    recipeId === null ? pageFiles : [],
    recipeId === null ? pdfBytes : null,
  );
}
