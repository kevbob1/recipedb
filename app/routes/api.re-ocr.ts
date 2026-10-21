/**
 * Action endpoint: re-run OCR against a recipe's retained scan capture (#28).
 *
 * POST { id: number } -> { recipeId, text, confidence, ms }
 *
 * Explicit user action only: the review screen shows the fresh text and the
 * person decides whether to apply it. Nothing is written to the recipe here —
 * a human's edits are never auto-overwritten.
 *
 * Thin adapter: the transport, storage and recognizer all live in the Scan
 * module (../lib/scan), which keeps this route exports-only.
 */
import type { Route } from "./+types/api.re-ocr";
import { handleReOcrRequest } from "../lib/scan/index.server";

export async function action({ request }: Route.ActionArgs) {
  return handleReOcrRequest(request);
}

export function loader() {
  return Response.json({ error: "method-not-allowed" }, { status: 405 });
}
