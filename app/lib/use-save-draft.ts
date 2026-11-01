/**
 * useSaveDraft — the one client entry point for persisting review state.
 *
 * Shared by /add (creates a recipe, possibly with the original capture) and
 * /recipes/:id/review (revises an existing one, or deletes it). The endpoint,
 * the JSON-vs-multipart decision, and the mapping from a failed response to a
 * displayable message live here; callers just await a recipe id.
 *
 * Client-safe by design: no `.server` imports, so this file can live inside a
 * component module without dragging the DB or the Scan module into the bundle.
 */
import { useCallback, useState } from "react";
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

export interface UseSaveDraftOptions {
  /** Existing recipe to revise; omit to create a new recipe (the /add flow). */
  recipeId?: number;
}

export interface UseSaveDraft {
  /** Persist review state and resolve with the recipe id. */
  save: (draft: RecipeDraft, photoFile?: File | null) => Promise<number>;
  /** Review's delete intent: remove the stored recipe and its capture. */
  remove: () => Promise<void>;
  saving: boolean;
  error: string | null;
  clearError: () => void;
}

interface PostSaveBody {
  draft?: RecipeDraft;
  intent?: "delete";
  photoFile?: File | null;
}

async function postSave(
  recipeId: number | undefined,
  { draft, intent, photoFile }: PostSaveBody,
): Promise<number> {
  let body: BodyInit;
  let headers: HeadersInit | undefined;

  if (photoFile) {
    // The Add flow's original capture rides with the draft untouched (#28).
    const form = new FormData();
    if (draft) form.set("draft", JSON.stringify(draft));
    if (recipeId !== undefined) form.set("recipeId", String(recipeId));
    form.set("image", photoFile, photoFile.name || "capture.png");
    body = form;
  } else {
    body = JSON.stringify({
      ...(draft ? { draft } : {}),
      ...(recipeId !== undefined ? { recipeId } : {}),
      ...(intent ? { intent } : {}),
    });
    headers = { "content-type": "application/json" };
  }

  const res = await fetch("/api/save-draft", { method: "POST", headers, body });
  const json = (await res.json().catch(() => null)) as
    | { recipeId?: number; error?: string; message?: string }
    | null;
  if (!res.ok || !json || json.error !== undefined) {
    throw new SaveDraftError(
      json?.message ?? json?.error ?? "Couldn't save.",
      json?.error ?? "save-failed",
    );
  }
  if (typeof json.recipeId !== "number") {
    throw new SaveDraftError("Couldn't save.", "save-failed");
  }
  return json.recipeId;
}

/**
 * Wire save/delete to the review screen's busy and error state. Both operations
 * set `saving`/`error`; a rejected call still rethrows so the caller can react
 * (e.g. stay on the form) without losing the message.
 */
export function useSaveDraft({
  recipeId,
}: UseSaveDraftOptions = {}): UseSaveDraft {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const clearError = useCallback(() => setError(null), []);

  const save = useCallback(
    async (draft: RecipeDraft, photoFile: File | null = null) => {
      setSaving(true);
      setError(null);
      try {
        return await postSave(recipeId, { draft, photoFile });
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't save.");
        throw err;
      } finally {
        setSaving(false);
      }
    },
    [recipeId],
  );

  const remove = useCallback(async () => {
    if (recipeId === undefined) {
      throw new SaveDraftError("No recipe to delete.", "bad-recipe-id");
    }
    setSaving(true);
    setError(null);
    try {
      await postSave(recipeId, { intent: "delete" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't delete.");
      throw err;
    } finally {
      setSaving(false);
    }
  }, [recipeId]);

  return { save, remove, saving, error, clearError };
}
