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
import { Link, useSearchParams, redirect } from "react-router";
import type { Route } from "./+types/recipes.$id.review";
import { ReviewEditor } from "./add";
import {
  CATEGORIES,
  type Category,
  type RecipeDraft,
  blankDraft,
  countNeedEyes,
} from "../lib/draft";
import { loadDraft, saveDraft, SaveError } from "../lib/save-draft.server";
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

export async function action({ request, params }: Route.ActionArgs) {
  requireAuth(request, { isApi: true });
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return Response.json({ ok: false, error: "bad-id" }, { status: 400 });
  }
  const form = await request.formData();
  const raw = String(form.get("draft") ?? "");
  if (!raw) {
    return Response.json({ ok: false, error: "empty-draft" }, { status: 400 });
  }
  try {
    const incoming = JSON.parse(raw) as RecipeDraft;
    // Make sure the saved recipe keeps its id/source type even if the editor
    // clears them by accident.
    incoming.sourceType = incoming.sourceType;
    saveDraft(incoming);
    return redirect(`/recipes/${id}/review?saved=1`);
  } catch (err) {
    if (err instanceof SaveError) {
      return Response.json({ ok: false, error: err.code, message: err.message }, { status: 400 });
    }
    return Response.json({ ok: false, error: "internal" }, { status: 500 });
  }
}

export default function ReviewRoute({ loaderData }: Route.ComponentProps) {
  const initial = loaderData.draft;
  const [draft, setDraft] = useState<RecipeDraft>(initial);
  const [params] = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(params.get("saved") === "1");

  const need = countNeedEyes(draft);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/recipes/${loaderData.recipeId}/review`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ draft: JSON.stringify(draft) }),
      });
      if (res.redirected) {
        setSaved(true);
        return;
      }
      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as
          | { error?: string; message?: string }
          | null;
        setError(json?.message ?? json?.error ?? "Couldn't save.");
        return;
      }
      setSaved(true);
    } catch (err) {
      setError((err as Error).message ?? "Couldn't save.");
    } finally {
      setSaving(false);
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
      {saved ? <p style={{ color: "#2f7a3e", fontSize: 13 }}>Saved.</p> : null}
      <ReviewEditor draft={draft} setDraft={setDraft} />
      {error ? <p style={{ color: "#9a3030", fontSize: 13 }}>{error}</p> : null}
      <div style={{ display: "flex", gap: 10, marginTop: 18, position: "sticky", bottom: 0, background: "#fff", padding: "12px 0", borderTop: "1px solid #e3ddd2" }}>
        <Link to="/add" style={{ ...ghostBtn, textDecoration: "none", display: "inline-block" }}>+ Add another</Link>
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
