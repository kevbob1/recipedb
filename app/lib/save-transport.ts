/**
 * Save transport — how a reviewed draft becomes a stored recipe.
 *
 * The draft is saved as JSON, except when the Add flow still holds the
 * original scan capture: then the draft and the untouched bytes travel as one
 * multipart POST so the server can retain the capture (#28). That decision,
 * the endpoint, and the mapping from a failed response to a displayable
 * message all live here; callers just await a recipe id.
 */
import type { RecipeDraft } from "./draft";

/** Save failed. `message` is safe to show to the person. */
export class SaveDraftError extends Error {
  constructor(
    message: string,
    public code: string = "save-failed",
  ) {
    super(message);
    this.name = "SaveDraftError";
  }
}

/**
 * Persist a draft and resolve with its new recipe id.
 *
 * `photoFile` is the original capture, kept in the page for exactly this
 * upload; pass null (or omit) for URL/manual drafts and the JSON transport is
 * used instead.
 */
export async function submitDraft(
  draft: RecipeDraft,
  photoFile: File | null = null,
): Promise<number> {
  let body: BodyInit;
  if (photoFile) {
    const form = new FormData();
    form.set("draft", JSON.stringify(draft));
    form.set("image", photoFile, photoFile.name || "capture.png");
    body = form;
  } else {
    body = JSON.stringify(draft);
  }
  const res = await fetch("/api/save-draft", {
    method: "POST",
    ...(photoFile ? {} : { headers: { "content-type": "application/json" } }),
    body,
  });
  const json = (await res.json()) as
    | { recipeId: number }
    | { error: string; message?: string };
  if (!res.ok || "error" in json) {
    throw new SaveDraftError(
      "message" in json && json.message ? json.message : "Couldn't save.",
      "error" in json ? json.error : "save-failed",
    );
  }
  return json.recipeId;
}
