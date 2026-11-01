/**
 * /recipes/:id/review — the shared, editable review screen.
 *
 * Both URL and photo imports land here after saving (the /add stepper
 * redirects to this route on success). The same screen is also the place
 * to keep editing an existing draft.
 *
 * The editor itself is the same `ReviewEditor` component used by /add, so
 * URL, photo, and manual entries all share one review surface.
 */
import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import type { Route } from "./+types/recipes.$id.review";
import { ReviewEditor } from "./review-editor";
import {
  CATEGORIES,
  type Category,
  type RecipeDraft,
  countNeedEyes,
} from "../lib/draft";
import { loadDraft } from "../lib/draft-store.server";
import { useSaveDraft } from "../lib/use-save-draft";
import { requireAuth } from "../lib/auth.server";

export function meta({ data }: Route.MetaArgs) {
  if (!data) return [{ title: "Review — recipedb" }];
  return [{ title: `Review: ${data.draft.title || "untitled"} — recipedb` }];
}

export async function loader({ params, request }: Route.LoaderArgs) {
  requireAuth(request);
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Response("Not a recipe id", { status: 400 });
  }
  const draft = loadDraft(id);
  if (!draft) {
    throw new Response("Not found", { status: 404 });
  }
  return { draft, recipeId: id };
}

export default function ReviewRoute({ loaderData }: Route.ComponentProps) {
  const initial = loaderData.draft;
  const [draft, setDraft] = useState<RecipeDraft>(initial);
  const [params] = useSearchParams();
  const [saved, setSaved] = useState(params.get("saved") === "1");
  // The save seam owns the endpoint, the busy flag, and the error message.
  const {
    save: saveDraft,
    remove: removeDraft,
    saving,
    error,
  } = useSaveDraft({ recipeId: loaderData.recipeId });

  const need = countNeedEyes(draft);

  // Explicit re-run against the retained capture (#28). The endpoint returns
  // fresh text only; ReviewEditor stages it until the person approves.
  const reOcr =
    initial.imageFilename && initial.sourceType === "scan"
      ? async (): Promise<string> => {
        const res = await fetch("/api/re-ocr", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: loaderData.recipeId }),
        });
        const json = (await res.json().catch(() => null)) as
          | { text?: string; error?: string; message?: string }
          | null;
        if (!res.ok || !json || typeof json.text !== "string") {
          throw new Error(json?.message ?? json?.error ?? "Couldn't re-run OCR.");
        }
        return json.text;
      }
      : undefined;

  async function save() {
    try {
      await saveDraft(draft);
      setSaved(true);
    } catch {
      // Message already lives in the hook's error state.
    }
  }

  async function remove() {
    if (
      !window.confirm(
        "Delete this recipe? Its ingredients, steps, and tags are removed too. This cannot be undone.",
      )
    ) {
      return;
    }
    try {
      await removeDraft();
      window.location.assign("/");
    } catch {
      // Message already lives in the hook's error state.
    }
  }

  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "1.5rem 1rem 8rem", fontFamily: "system-ui, sans-serif" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h1 style={{ margin: 0, fontSize: "1.25rem" }}>Review draft #{loaderData.recipeId}</h1>
        <span style={{ fontSize: "0.8rem", color: "#6b655c" }}>
          <strong>Draft</strong> · {need.total} fields · {need.need} need eyes
        </span>
      </header>
      <p style={{ color: "#6b655c", fontSize: 13, marginTop: 4 }}>
        Source: {draft.sourceType}
        {draft.sourceUrl ? <> · <a href={draft.sourceUrl} target="_blank" rel="noreferrer">{draft.sourceUrl}</a></> : null}
      </p>
      {saved ? (
        <p
          role="status"
          style={{
            color: "#2f7a3e",
            background: "#eef6ef",
            border: "1px solid #b9d9be",
            borderRadius: 6,
            padding: "8px 10px",
            fontSize: 13,
          }}
        >
          Saved — your changes are now the stored recipe.
        </p>
      ) : null}
      <ReviewEditor draft={draft} setDraft={setDraft} reOcr={reOcr} />
      {error ? <p style={{ color: "#9a3030", fontSize: 13 }}>{error}</p> : null}
      <div style={{ display: "flex", gap: 10, marginTop: 18, position: "sticky", bottom: 0, background: "#fff", padding: "12px 0", borderTop: "1px solid #e3ddd2" }}>
        <Link to="/add" style={{ ...ghostBtn, textDecoration: "none", display: "inline-block" }}>+ Add another</Link>
        <Link
          to={`/recipes/${loaderData.recipeId}/cook`}
          style={{ ...ghostBtn, textDecoration: "none", display: "inline-block" }}
        >
          Cook this →
        </Link>
        <button type="button" onClick={remove} style={dangerBtn} disabled={saving}>
          Delete recipe
        </button>
        <button type="button" onClick={save} style={{ ...primaryBtn, marginLeft: "auto" }} disabled={saving || !draft.title.trim()}>
          {saving ? "Saving…" : "Save draft"}
        </button>
      </div>
    </main>
  );
}

const primaryBtn: React.CSSProperties = {
  appearance: "none",
  border: "1px solid #b04a2f",
  background: "#b04a2f",
  color: "#fff",
  borderRadius: 999,
  padding: "10px 18px",
  font: "inherit",
  cursor: "pointer",
};
const ghostBtn: React.CSSProperties = {
  appearance: "none",
  border: "1px solid #c9c1b1",
  background: "#fff",
  color: "inherit",
  borderRadius: 999,
  padding: "10px 18px",
  font: "inherit",
  cursor: "pointer",
};
const dangerBtn: React.CSSProperties = {
  appearance: "none",
  border: "1px solid #9a3030",
  background: "#fff",
  color: "#9a3030",
  borderRadius: 999,
  padding: "10px 18px",
  font: "inherit",
  cursor: "pointer",
};
