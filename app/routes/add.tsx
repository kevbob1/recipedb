/**
 * /add — the Stepper A flow (Add → Get it → Review → Saved).
 *
 * This is the rebuilt, real-data version of the winning prototype variant
 * from ticket #7. We do NOT promote prototype-add-flow.html — this is a
 * ground-up implementation against the Drizzle + better-sqlite3 data layer.
 *
 *  Step 1: Pick entry method (URL paste / snap photo / type it in).
 *  Step 2: Capture input — fetches a URL, captures a photo, or nothing.
 *  Step 3: Shared review screen. Both URL and photo paths land here.
 *  Step 4: Saved. Confirms with the new recipe id; offers "Add another".
 *
 * The review screen itself lives in /recipes/$id/review, but during the
 * stepper we render an inline draft that is then either saved (which
 * redirects to /recipes/:id/review) or discarded. Either way, the editor
 * is the same component.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import type { Route } from "./+types/add";
import {
  CATEGORIES,
  type Category,
  type DraftIngredient,
  type RecipeDraft,
  blankDraft,
  clearParsedQuantity,
  countNeedEyes,
  ingredientConfidence,
} from "../lib/draft";
import { formatAmount, scaledIngredientRows } from "../lib/quantity-parse";
import { recognizeText, ocrTextToDraft, guessCategory } from "../lib/ocr";
import { requireAuth } from "../lib/auth.server";

export function meta(_args: Route.MetaArgs) {
  return [{ title: "Add a recipe — recipedb" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  // Auth gate. The /add page is the only protected route with no
  // loaderData; we still need to call requireAuth so an unauthenticated
  // visitor is bounced to /login.
  requireAuth(request);
  return null;
}

type Step = 1 | 2 | 3 | 4;
type Entry = "url" | "photo" | "type" | null;

export default function AddRoute(_args: Route.ComponentProps) {
  return (
    <main style={{ maxWidth: 640, margin: "0 auto", padding: "1.5rem 1rem 8rem", fontFamily: "system-ui, sans-serif" }}>
      <StepperShell />
    </main>
  );
}

function StepperShell() {
  const [step, setStep] = useState<Step>(1);
  const [entry, setEntry] = useState<Entry>(null);
  const [draft, setDraft] = useState<RecipeDraft>(() => blankDraft());
  const [urlInput, setUrlInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [photoState, setPhotoState] = useState<"idle" | "capturing" | "ocr" | "done" | "error">("idle");
  const [savedRecipeId, setSavedRecipeId] = useState<number | null>(null);
  const [submitInFlight, setSubmitInFlight] = useState(false);

  const stepLabels = ["1 · Add", "2 · Get it", "3 · Review", "4 · Saved"];

  const need = useMemo(() => countNeedEyes(draft), [draft]);

  function pickEntry(e: Entry) {
    setEntry(e);
    setError(null);
    if (e === "type") {
      setDraft({ ...blankDraft(), sourceType: "manual" });
      setStep(3);
    } else {
      setDraft({ ...blankDraft(), sourceType: e === "url" ? "url" : "scan" });
      setStep(2);
    }
  }

  async function runUrlImport() {
    setError(null);
    if (!urlInput.trim()) {
      setError("Paste a URL first.");
      return;
    }
    setSubmitInFlight(true);
    try {
      const res = await fetch("/api/import-url", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: urlInput }),
      });
      const json = (await res.json()) as
        | { draft: RecipeDraft; imageFilename: string | null }
        | { error: string; message?: string };
      if (!res.ok || "error" in json) {
        const msg = "message" in json && json.message ? json.message : "Couldn't import that URL.";
        setError(msg);
        return;
      }
      setDraft({ ...json.draft, sourceType: "url" });
      setStep(3);
    } finally {
      setSubmitInFlight(false);
    }
  }

  async function captureAndOcr(file: File) {
    setError(null);
    setPhotoState("capturing");
    try {
      // Camera bytes stay in memory; we never write the file to disk.
      const blob = file.slice(0, file.size, file.type || "image/*");
      setPhotoState("ocr");
      const text = await recognizeText(blob);
      const ocrDraft = ocrTextToDraft(text);
      ocrDraft.sourceType = "scan";
      ocrDraft.category = guessCategory(ocrDraft.title || text);
      setDraft(ocrDraft);
      setPhotoState("done");
      setStep(3);
    } catch (err) {
      setPhotoState("error");
      setError((err as Error).message ?? "OCR failed.");
    }
  }

  async function save() {
    setError(null);
    setSubmitInFlight(true);
    try {
      const res = await fetch("/api/save-draft", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(draft),
      });
      const json = (await res.json()) as
        | { recipeId: number }
        | { error: string; message?: string };
      if (!res.ok || "error" in json) {
        const msg = "message" in json && json.message ? json.message : "Couldn't save.";
        setError(msg);
        return;
      }
      setSavedRecipeId(json.recipeId);
      setStep(4);
    } finally {
      setSubmitInFlight(false);
    }
  }

  function restart() {
    setStep(1);
    setEntry(null);
    setDraft(blankDraft());
    setUrlInput("");
    setError(null);
    setPhotoState("idle");
    setSavedRecipeId(null);
  }

  return (
    <>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h1 style={{ margin: 0, fontSize: "1.25rem" }}>New recipe</h1>
        <span style={{ fontSize: "0.8rem", color: "#6b655c" }}>
          <strong>Draft</strong> · {need.total} fields · {need.need} need eyes
        </span>
      </header>
      <StepperProgress step={step} labels={stepLabels} />

      {step === 1 ? <Step1Pick onPick={pickEntry} /> : null}
      {step === 2 ? (
        <Step2Get
          entry={entry}
          url={urlInput}
          setUrl={setUrlInput}
          onUrlImport={runUrlImport}
          onCapture={captureAndOcr}
          photoState={photoState}
          submitting={submitInFlight}
          onBack={() => setStep(1)}
          error={error}
        />
      ) : null}
      {step === 3 ? (
        <Step3Review
          draft={draft}
          setDraft={setDraft}
          error={error}
          onBack={() => setStep(2)}
          onSave={save}
          saving={submitInFlight}
        />
      ) : null}
      {step === 4 ? (
        <Step4Saved
          recipeId={savedRecipeId}
          count={need.total}
          onAddAnother={restart}
        />
      ) : null}
    </>
  );
}

function StepperProgress({ step, labels }: { step: Step; labels: string[] }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, margin: "14px 0 18px", fontSize: "0.8rem", color: "#6b655c" }}>
      {[1, 2, 3, 4].map((n) => (
        <span
          key={n}
          style={{
            flex: 1,
            height: 4,
            background: n <= step ? "#b04a2f" : "#e3ddd2",
            borderRadius: 2,
          }}
        />
      ))}
      <span style={{ marginLeft: 8 }}>{labels[step - 1]}</span>
    </div>
  );
}

function Step1Pick({ onPick }: { onPick: (e: Entry) => void }) {
  return (
    <section>
      <h2 style={{ margin: "0 0 4px" }}>Add a recipe</h2>
      <p style={{ color: "#6b655c", marginTop: 0 }}>Pick how you want to bring it in. Everything lands as a draft for review.</p>
      <div style={{ display: "grid", gap: 10, marginTop: 12 }}>
        <button
          type="button"
          className="entry-btn"
          onClick={() => onPick("url")}
          style={entryBtnStyle}
        >
          <span style={{ fontSize: 22 }}>🔗</span>
          <strong>Paste a public URL</strong>
          <span style={{ color: "#6b655c", fontSize: 12 }}>Title, ingredients, steps parsed from the page</span>
        </button>
        <button
          type="button"
          className="entry-btn"
          onClick={() => onPick("photo")}
          style={entryBtnStyle}
        >
          <span style={{ fontSize: 22 }}>📷</span>
          <strong>Snap a photo of a printout</strong>
          <span style={{ color: "#6b655c", fontSize: 12 }}>Local OCR — the photo is read once and discarded</span>
        </button>
        <button
          type="button"
          className="entry-btn"
          onClick={() => onPick("type")}
          style={entryBtnStyle}
        >
          <span style={{ fontSize: 22 }}>✍️</span>
          <strong>Type it in</strong>
          <span style={{ color: "#6b655c", fontSize: 12 }}>Blank form, you fill every field</span>
        </button>
      </div>
    </section>
  );
}

const entryBtnStyle: React.CSSProperties = {
  appearance: "none",
  border: "1px solid #c9c1b1",
  background: "#fff",
  borderRadius: 14,
  padding: "16px",
  textAlign: "left",
  cursor: "pointer",
  minHeight: 88,
  display: "flex",
  flexDirection: "column",
  gap: 4,
  justifyContent: "center",
  font: "inherit",
  color: "inherit",
};

function Step2Get(props: {
  entry: Entry;
  url: string;
  setUrl: (v: string) => void;
  onUrlImport: () => void;
  onCapture: (file: File) => void;
  photoState: "idle" | "capturing" | "ocr" | "done" | "error";
  submitting: boolean;
  onBack: () => void;
  error: string | null;
}) {
  if (props.entry === "url") {
    return (
      <section>
        <h2 style={{ margin: "0 0 4px" }}>Paste a public URL</h2>
        <p style={{ color: "#6b655c", marginTop: 0 }}>
          We fetch the page and parse JSON-LD on the server. Missing fields are flagged in review.
        </p>
        <label style={fieldLabelStyle}>
          Source URL
          <input
            type="url"
            value={props.url}
            onChange={(e) => props.setUrl(e.target.value)}
            placeholder="https://…"
            style={inputStyle}
          />
        </label>
        {props.error ? <p style={{ color: "#9a3030", fontSize: 13 }}>{props.error}</p> : null}
        <Nav onBack={props.onBack} primaryLabel="Review →" onPrimary={props.onUrlImport} disabled={props.submitting} />
      </section>
    );
  }
  if (props.entry === "photo") {
    return <Step2Photo {...props} />;
  }
  return (
    <section>
      <h2 style={{ margin: "0 0 4px" }}>Type it in</h2>
      <p style={{ color: "#6b655c", marginTop: 0 }}>Nothing to do here — head to Review to fill the form.</p>
      <Nav onBack={props.onBack} primaryLabel="Review →" onPrimary={() => undefined} disabled={props.submitting} />
    </section>
  );
}

function Step2Photo(props: {
  onBack: () => void;
  onCapture: (file: File) => void;
  photoState: "idle" | "capturing" | "ocr" | "done" | "error";
  error: string | null;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !stream) return;
    video.srcObject = stream;
    video.play().catch(() => {});
    return () => {
      for (const track of stream.getTracks()) track.stop();
    };
  }, [stream]);

  async function startCamera() {
    setStreamError(null);
    try {
      const ms = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
        audio: false,
      });
      setStream(ms);
    } catch (err) {
      setStreamError(
        "Couldn't access the camera. You can also pick a file from your device below.",
      );
    }
  }

  function stopCamera() {
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
    }
    setStream(null);
  }

  function snapFromCamera() {
    const video = videoRef.current;
    if (!video) return;
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) return;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, w, h);
    canvas.toBlob(
      (blob) => {
        if (blob) {
          // Camera bytes never touch disk: we keep the Blob in memory and
          // pass it directly to OCR. No data URL, no file input, no upload.
          const file = new File([blob], "capture.png", { type: blob.type });
          props.onCapture(file);
        }
        stopCamera();
      },
      "image/png",
    );
  }

  function onFilePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) props.onCapture(file);
  }

  const ocrInFlight = props.photoState === "capturing" || props.photoState === "ocr";

  return (
    <section>
      <h2 style={{ margin: "0 0 4px" }}>Snap a photo of a printout</h2>
      <p style={{ color: "#6b655c", marginTop: 0 }}>Local OCR. The photo is read once and discarded — never stored.</p>
      <p style={{ fontSize: 12, color: "#6b655c", fontStyle: "italic" }}>📷 photo discarded after import</p>
      {stream ? (
        <div>
          <video ref={videoRef} muted playsInline style={{ width: "100%", borderRadius: 12, background: "#000" }} />
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <button type="button" onClick={snapFromCamera} style={primaryBtn} disabled={ocrInFlight}>
              Capture
            </button>
            <button type="button" onClick={stopCamera} style={ghostBtn}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          <button type="button" onClick={startCamera} style={entryBtnStyle}>
            <span style={{ fontSize: 22 }}>📷</span>
            <strong>Use camera</strong>
            <span style={{ color: "#6b655c", fontSize: 12 }}>Photo stays in this tab; tesseract.js reads it locally</span>
          </button>
          <label style={entryBtnStyle}>
            <span style={{ fontSize: 22 }}>🖼️</span>
            <strong>Or pick an image file</strong>
            <span style={{ color: "#6b655c", fontSize: 12 }}>File is read in memory; never uploaded</span>
            <input
              type="file"
              accept="image/*"
              capture="environment"
              onChange={onFilePicked}
              style={{ display: "none" }}
            />
          </label>
        </div>
      )}
      {streamError ? <p style={{ color: "#a26800", fontSize: 13 }}>{streamError}</p> : null}
      {props.error ? <p style={{ color: "#9a3030", fontSize: 13 }}>{props.error}</p> : null}
      {ocrInFlight ? <p style={{ color: "#6b655c", fontSize: 13 }}>Reading the page…</p> : null}
      <Nav onBack={props.onBack} primaryLabel="Review →" onPrimary={() => undefined} disabled />
    </section>
  );
}

function Nav({
  onBack,
  primaryLabel,
  onPrimary,
  disabled,
}: {
  onBack: () => void;
  primaryLabel: string;
  onPrimary: () => void;
  disabled?: boolean;
}) {
  return (
    <div style={{ display: "flex", gap: 10, marginTop: 18, position: "sticky", bottom: 0, background: "#fff", padding: "12px 0", borderTop: "1px solid #e3ddd2" }}>
      <button type="button" onClick={onBack} style={ghostBtn}>Back</button>
      <button type="button" onClick={onPrimary} style={{ ...primaryBtn, marginLeft: "auto" }} disabled={disabled}>
        {primaryLabel}
      </button>
    </div>
  );
}

function Step3Review(props: {
  draft: RecipeDraft;
  setDraft: (d: RecipeDraft) => void;
  error: string | null;
  onBack: () => void;
  onSave: () => void;
  saving: boolean;
}) {
  return (
    <section>
      <h2 style={{ margin: "0 0 4px" }}>Review the draft</h2>
      <p style={{ color: "#6b655c", marginTop: 0 }}>Badges flag what we couldn't trust. Fix what needs fixing, then save.</p>
      <ReviewEditor draft={props.draft} setDraft={props.setDraft} />
      {props.error ? <p style={{ color: "#9a3030", fontSize: 13 }}>{props.error}</p> : null}
      <div style={{ display: "flex", gap: 10, marginTop: 18, position: "sticky", bottom: 0, background: "#fff", padding: "12px 0", borderTop: "1px solid #e3ddd2" }}>
        <button type="button" onClick={props.onBack} style={ghostBtn}>Back</button>
        <button
          type="button"
          onClick={props.onSave}
          style={{ ...primaryBtn, marginLeft: "auto" }}
          disabled={props.saving || !props.draft.title.trim()}
        >
          {props.saving ? "Saving…" : "Save draft"}
        </button>
      </div>
    </section>
  );
}

function Step4Saved(props: { recipeId: number | null; count: number; onAddAnother: () => void }) {
  return (
    <section style={{ textAlign: "center", padding: "40px 20px" }}>
      <div style={{ width: 56, height: 56, borderRadius: "50%", background: "#e1f1e3", color: "#2f7a3e", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 28, marginBottom: 12 }}>
        ✓
      </div>
      <h2 style={{ margin: "0 0 4px" }}>Draft saved</h2>
      <p style={{ color: "#6b655c", marginTop: 0 }}>Your draft is in the review queue. {props.count} fields captured.</p>
      <div style={{ display: "flex", gap: 10, justifyContent: "center", marginTop: 20 }}>
        <button type="button" onClick={props.onAddAnother} style={ghostBtn}>Add another</button>
        {props.recipeId !== null ? (
          <Link to={`/recipes/${props.recipeId}/review`} style={{ ...primaryBtn, textDecoration: "none", display: "inline-block" }}>
            Open in review
          </Link>
        ) : null}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* The shared review editor. Used by both /add and /recipes/:id/review. */
/* ------------------------------------------------------------------ */

export function ReviewEditor({
  draft,
  setDraft,
}: {
  draft: RecipeDraft;
  setDraft: (d: RecipeDraft) => void;
}) {
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <FieldLabel label="Title" badge={badge(draft.titleConfidence)}>
        <input
          type="text"
          value={draft.title}
          onChange={(e) =>
            setDraft({
              ...draft,
              title: e.target.value,
              titleConfidence: e.target.value.trim() ? "ok" : "bad",
            })
          }
          placeholder="Recipe title"
          style={inputStyle}
        />
      </FieldLabel>

      <FieldLabel label="Category" badge={badge(draft.categoryConfidence)}>
        <select
          value={draft.category}
          onChange={(e) =>
            setDraft({
              ...draft,
              category: e.target.value as Category,
              categoryConfidence: "ok",
            })
          }
          style={inputStyle}
        >
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
      </FieldLabel>

      <FieldLabel label="Yield / servings" badge={badge(draft.yieldConfidence)}>
        <input
          type="text"
          value={draft.yield ?? ""}
          onChange={(e) =>
            setDraft({
              ...draft,
              yield: e.target.value,
              yieldConfidence: e.target.value.trim() ? "ok" : "bad",
            })
          }
          placeholder="e.g. 4 servings"
          style={inputStyle}
        />
      </FieldLabel>

      <FieldLabel
        label="Tags"
        badge={
          draft.tags.length > 0 ? <BadgeOk text={`✓ ${draft.tags.length}`} /> : <BadgeBad text="✗ none" />
        }
      >
        <TagsEditor
          tags={draft.tags}
          onChange={(tags) => setDraft({ ...draft, tags })}
        />
      </FieldLabel>

      <FieldLabel
        label="Ingredients"
        badge={
          draft.ingredients.length > 0 ? (
            <BadgeOk text={`✓ ${draft.ingredients.length}`} />
          ) : (
            <BadgeBad text="✗ none" />
          )
        }
      />
      <IngredientListEditor
        ingredients={draft.ingredients}
        onChange={(ingredients) => setDraft({ ...draft, ingredients })}
      />

      <ScaledIngredientList ingredients={draft.ingredients} />

      <FieldLabel
        label="Steps"
        badge={
          draft.steps.length > 0 ? (
            <BadgeOk text={`✓ ${draft.steps.length}`} />
          ) : (
            <BadgeBad text="✗ none" />
          )
        }
      />
      <StepListEditor steps={draft.steps} onChange={(steps) => setDraft({ ...draft, steps })} />

      <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 14 }}>
        <input
          type="checkbox"
          checked={draft.favorite}
          onChange={(e) => setDraft({ ...draft, favorite: e.target.checked })}
        />
        ★ Favorite
      </label>

      <details>
        <summary style={{ cursor: "pointer", color: "#6b655c", fontSize: 12 }}>View source</summary>
        <pre style={{ background: "#1f1d1a", color: "#f6f4ee", padding: 12, borderRadius: 10, fontSize: 12, whiteSpace: "pre-wrap", overflowX: "auto", maxHeight: 240 }}>
          {draft.raw ?? draft.rawOcrText ?? "(no source)"}
        </pre>
      </details>
    </div>
  );
}

function FieldLabel({
  label,
  badge,
  children,
}: {
  label: string;
  badge?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <label style={{ display: "block" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12, color: "#6b655c", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4 }}>
        <span>{label}</span>
        {badge}
      </div>
      {children}
    </label>
  );
}

function badge(level: "ok" | "warn" | "bad"): React.ReactNode {
  if (level === "ok") return <BadgeOk text="✓ extracted" />;
  if (level === "warn") return <BadgeWarn text="⚠ needs eyes" />;
  return <BadgeBad text="✗ missing" />;
}

function BadgeOk({ text }: { text: string }) {
  return <span style={badgeStyle("#2f7a3e", "#e1f1e3")}>{text}</span>;
}
function BadgeWarn({ text }: { text: string }) {
  return <span style={badgeStyle("#a26800", "#fbecd0")}>{text}</span>;
}
function BadgeBad({ text }: { text: string }) {
  return <span style={badgeStyle("#9a3030", "#f5dada")}>{text}</span>;
}
function badgeStyle(color: string, bg: string): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    fontSize: 11,
    padding: "2px 8px",
    borderRadius: 999,
    fontWeight: 600,
    color,
    background: bg,
    whiteSpace: "nowrap",
  };
}

function TagsEditor({ tags, onChange }: { tags: string[]; onChange: (t: string[]) => void }) {
  const [draft, setDraft] = useState("");
  return (
    <div>
      <div style={{ marginBottom: 6 }}>
        {tags.map((t, i) => (
          <span key={`${t}-${i}`} style={pill}>
            {t}
            <button
              type="button"
              onClick={() => onChange(tags.filter((_, j) => j !== i))}
              style={{ marginLeft: 6, appearance: "none", background: "transparent", border: "none", color: "inherit", cursor: "pointer" }}
              aria-label={`remove tag ${t}`}
            >
              ×
            </button>
          </span>
        ))}
        <span style={{ ...pill, background: "#ece8de", color: "#6b655c" }}>+ add tag</span>
      </div>
      <input
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if ((e.key === "Enter" || e.key === ",") && draft.trim()) {
            e.preventDefault();
            const t = draft.trim().toLowerCase();
            if (!tags.includes(t)) onChange([...tags, t]);
            setDraft("");
          }
        }}
        placeholder="press enter to add"
        style={inputStyle}
      />
    </div>
  );
}

/**
 * Hand-editing the qty text clears the derived numeric view. The write path
 * re-parses from the text (see resolveQuantity), which is what "a manual qty
 * edit resets the row to unparsed" means in the decision on #15: numbers we
 * derived from text the person has since replaced are not trusted.
 */
function applyQtyEdit(ing: DraftIngredient, qty: string): DraftIngredient {
  return clearParsedQuantity({ ...ing, qty });
}

/** Factors offered by the review screen; anything else goes in the custom box. */
const MULTIPLIER_PRESETS = [0.5, 1, 2, 3] as const;

function multiplierLabel(factor: number): string {
  return `${formatAmount(factor)}\u00d7`;
}

/**
 * Derived scaled view of the ingredient list — the multiplier UI.
 *
 * Display only: `qty` is the stored source of truth and is never rewritten.
 * Rows whose quantity could not be parsed (a pinch, to taste) render verbatim
 * with a "scaling not applied" mark instead of a wrong number.
 *
 * Lives in the shared ReviewEditor, so it is on both /add (step 3) and
 * /recipes/:id/review; exported so the cook view (#18) can reuse it.
 */
export function ScaledIngredientList({
  ingredients,
}: {
  ingredients: RecipeDraft["ingredients"];
}) {
  const [factor, setFactor] = useState<number>(1);
  const [custom, setCustom] = useState("");

  function onCustom(value: string) {
    setCustom(value);
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) setFactor(parsed);
  }

  const presetActive = MULTIPLIER_PRESETS.some((f) => f === factor);

  return (
    <div style={{ border: "1px solid #e3ddd2", borderRadius: 12, padding: "10px 12px", background: "#fdfcf8" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <strong style={{ fontSize: 13 }}>Scaled view</strong>
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          {MULTIPLIER_PRESETS.map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={factor === f}
              onClick={() => {
                setFactor(f);
                setCustom("");
              }}
              style={{
                ...ghostBtn,
                padding: "4px 10px",
                fontSize: 12,
                background: factor === f ? "#f6e1d8" : "#fff",
                borderColor: factor === f ? "#b04a2f" : "#c9c1b1",
                color: factor === f ? "#b04a2f" : "inherit",
              }}
            >
              {multiplierLabel(f)}
            </button>
          ))}
          <input
            aria-label="custom multiplier"
            inputMode="decimal"
            value={custom}
            onChange={(e) => onCustom(e.target.value)}
            placeholder={presetActive ? "custom" : multiplierLabel(factor)}
            style={{ ...inputStyle, width: 96, marginTop: 0 }}
          />
        </div>
      </div>
      <p style={{ color: "#6b655c", fontSize: 12, margin: "6px 0 8px" }}>
        Display only — showed at {multiplierLabel(factor)}; the saved quantity never changes.
      </p>
      {ingredients.length === 0 ? (
        <p style={{ color: "#6b655c", fontSize: 13 }}>Nothing to scale yet.</p>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {scaledIngredientRows(ingredients, factor).map((row, i) => (
            <li
              key={i}
              style={{ display: "flex", gap: 8, alignItems: "baseline", padding: "4px 0", fontSize: 14, borderTop: i === 0 ? "none" : "1px solid #ece8de" }}
            >
              <span style={{ minWidth: 84, fontWeight: 600 }}>{row.display}</span>
              <span style={{ color: "#3a3733" }}>
                {[row.unit, row.item].filter(Boolean).join(" ")}
                {row.note ? <span style={{ color: "#6b655c" }}>, {row.note}</span> : null}
              </span>
              {row.scaled ? null : <BadgeWarn text="⚠ scaling not applied" />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function IngredientListEditor({
  ingredients,
  onChange,
}: {
  ingredients: RecipeDraft["ingredients"];
  onChange: (i: RecipeDraft["ingredients"]) => void;
}) {
  return (
    <div>
      {ingredients.length === 0 ? (
        <p style={{ color: "#6b655c", fontSize: 13 }}>No ingredients yet. Add the first one below.</p>
      ) : null}
      {ingredients.map((ing, i) => {
        const conf = ingredientConfidence(ing);
        return (
          <div key={i} style={ingLineStyle}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
              <input
                type="text"
                value={ing.text}
                onChange={(e) => updateIng(i, { ...ing, text: e.target.value })}
                placeholder="e.g. 1 lb chicken thighs"
                style={{ ...inputStyle, flex: 1 }}
              />
              {conf === "ok" ? (
                <BadgeOk text="✓ parsed" />
              ) : conf === "warn" ? (
                <BadgeWarn text="⚠ no qty" />
              ) : (
                <BadgeBad text="✗ empty" />
              )}
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
              <input
                aria-label="quantity"
                value={ing.qty}
                onChange={(e) => updateIng(i, applyQtyEdit(ing, e.target.value))}
                placeholder="qty"
                style={{ ...inputStyle, flex: 1 }}
              />
              <input
                aria-label="unit"
                value={ing.unit ?? ""}
                onChange={(e) =>
                  updateIng(i, { ...ing, unit: e.target.value || null, qtyUnitNormalized: null })
                }
                placeholder="unit"
                style={{ ...inputStyle, flex: 1 }}
              />
              <input
                aria-label="item"
                value={ing.item}
                onChange={(e) => updateIng(i, { ...ing, item: e.target.value })}
                placeholder="item"
                style={{ ...inputStyle, flex: 2 }}
              />
            </div>
            <input
              aria-label="note"
              value={ing.note ?? ""}
              onChange={(e) => updateIng(i, { ...ing, note: e.target.value || null })}
              placeholder="note (optional)"
              style={{ ...inputStyle, marginTop: 6 }}
            />
            {ing.qtyParseStatus === "unparseable" ? (
              <span style={{ fontSize: 11, color: "#a26800" }}>
                ⚠ could not read a number from “{ing.qty}” — shown as written
              </span>
            ) : null}
            <button
              type="button"
              onClick={() => onChange(ingredients.filter((_, j) => j !== i))}
              style={{ ...ghostBtn, alignSelf: "flex-start", marginTop: 6, fontSize: 12 }}
            >
              remove
            </button>
          </div>
        );
      })}
      <button
        type="button"
        onClick={() =>
          onChange([
            ...ingredients,
            {
              text: "",
              qty: "",
              unit: null,
              item: "",
              note: null,
              confidence: "bad",
              qtyParseStatus: "unparsed",
            },
          ])
        }
        style={{ ...ghostBtn, marginTop: 6 }}
      >
        + Add ingredient
      </button>
    </div>
  );

  function updateIng(i: number, next: RecipeDraft["ingredients"][number]) {
    const out = ingredients.slice();
    out[i] = next;
    onChange(out);
  }
}

function StepListEditor({
  steps,
  onChange,
}: {
  steps: RecipeDraft["steps"];
  onChange: (s: RecipeDraft["steps"]) => void;
}) {
  return (
    <div>
      {steps.map((s, i) => (
        <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start", border: "1px solid #e3ddd2", borderRadius: 12, padding: "10px 12px", marginBottom: 8, background: "#fdfcf8" }}>
          <span style={{ color: "#b04a2f", fontWeight: 700, minWidth: 22 }}>{i + 1}.</span>
          <textarea
            value={s.text}
            onChange={(e) => update(i, e.target.value)}
            placeholder="Describe this step…"
            style={{ ...inputStyle, minHeight: 60, resize: "vertical" }}
          />
          <button
            type="button"
            onClick={() => onChange(steps.filter((_, j) => j !== i).map((row, j) => ({ ...row, position: j + 1 })))}
            style={ghostBtn}
          >
            ×
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...steps, { position: steps.length + 1, text: "" }])}
        style={ghostBtn}
      >
        + Add step
      </button>
    </div>
  );

  function update(i: number, text: string) {
    const out = steps.slice();
    out[i] = { ...out[i]!, text };
    onChange(out);
  }
}

const fieldLabelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 12,
  color: "#6b655c",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
};
const inputStyle: React.CSSProperties = {
  width: "100%",
  border: "1px solid #c9c1b1",
  background: "#fff",
  borderRadius: 10,
  padding: "10px 12px",
  font: "inherit",
  color: "inherit",
  marginTop: 4,
};
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
const pill: React.CSSProperties = {
  display: "inline-block",
  padding: "4px 10px",
  borderRadius: 999,
  background: "#f6e1d8",
  color: "#b04a2f",
  fontSize: 12,
  margin: "0 6px 6px 0",
};
const ingLineStyle: React.CSSProperties = {
  border: "1px solid #e3ddd2",
  borderRadius: 12,
  padding: "10px 12px",
  marginBottom: 8,
  display: "flex",
  flexDirection: "column",
  gap: 6,
  background: "#fdfcf8",
};
