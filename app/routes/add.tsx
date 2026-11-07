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
  countNeedEyes,
  display,
  formatAmount,
  ingredientConfidence,
  setQty,
} from "../lib/draft";
import { recognizeText } from "../lib/ocr";
import { createDraft, requestUrlImport } from "../lib/import";
import { useSaveDraft } from "../lib/use-save-draft";
import { MAX_SCAN_UPLOAD_BYTES, MAX_SCAN_UPLOAD_MB } from "../lib/scan/limits";
import {
  MAX_BULK_FILES,
  bulkProgress,
  formatBulkHeadline,
  formatFileSize,
  planBulkBatch,
  runBulkImport,
  summarizeBulkBatch,
  type BulkFileState,
  type BulkFileStatus,
  type BulkSummary,
  type RejectedFile,
} from "../lib/bulk-import";
import { ReviewEditor, inputStyle, primaryBtn, ghostBtn } from "./review-editor";
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
type Entry = "url" | "photo" | "bulk" | "type" | null;

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
  const [draft, setDraft] = useState<RecipeDraft>(() =>
    createDraft({ kind: "manual" }),
  );
  const [urlInput, setUrlInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [photoState, setPhotoState] = useState<"idle" | "capturing" | "ocr" | "done" | "error">("idle");
  // The original capture is retained for this import and uploaded with the
  // draft, so the server can keep it for re-OCR (#28). No downscale.
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [savedRecipeId, setSavedRecipeId] = useState<number | null>(null);
  const [submitInFlight, setSubmitInFlight] = useState(false);
  // Bulk import (many photos -> many auto-saved recipes). The queue, the
  // up-front rejections and the closing report are all bulk-import.ts state;
  // this route only drives the run and renders it.
  const [bulkStates, setBulkStates] = useState<BulkFileState[]>([]);
  const [bulkRejected, setBulkRejected] = useState<RejectedFile[]>([]);
  const [bulkSummary, setBulkSummary] = useState<BulkSummary | null>(null);
  const [bulkRunning, setBulkRunning] = useState(false);
  // The save seam owns JSON-vs-multipart and the busy/error state for it.
  const {
    save: saveToServer,
    saving,
    error: saveError,
    clearError: clearSaveError,
  } = useSaveDraft();

  const stepLabels = ["1 · Add", "2 · Get it", "3 · Review", "4 · Saved"];

  const need = useMemo(() => countNeedEyes(draft), [draft]);

  function pickEntry(e: Entry) {
    setEntry(e);
    setError(null);
    clearSaveError();
    // Clear the previous run. Provenance is stamped by the adapter that
    // actually produces the next draft (manual here; url/scan once their
    // import succeeds), never by the route.
    setDraft(createDraft({ kind: "manual" }));
    resetBulk();
    setStep(e === "type" ? 3 : 2);
  }

  function resetBulk() {
    setBulkStates([]);
    setBulkRejected([]);
    setBulkSummary(null);
  }

  async function runUrlImport() {
    setError(null);
    if (!urlInput.trim()) {
      setError("Paste a URL first.");
      return;
    }
    setSubmitInFlight(true);
    try {
      const { draft: imported } = await requestUrlImport(urlInput);
      setDraft(imported);
      setStep(3);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Couldn't import that URL.",
      );
    } finally {
      setSubmitInFlight(false);
    }
  }

  async function captureAndOcr(file: File) {
    setError(null);
    if (file.size > MAX_SCAN_UPLOAD_BYTES) {
      setError(
        `That image is larger than ${MAX_SCAN_UPLOAD_MB}MB. Retake it or pick a smaller file.`,
      );
      return;
    }
    setPhotoState("capturing");
    setPhotoFile(file);
    try {
      // OCR reads the same original bytes in this tab; the file is also kept
      // and uploaded with the draft so the server can retain it (#28).
      setPhotoState("ocr");
      const text = await recognizeText(file);
      setDraft(createDraft({ kind: "scan", text }));
      setPhotoState("done");
      setStep(3);
    } catch (err) {
      setPhotoState("error");
      setError((err as Error).message ?? "OCR failed.");
    }
  }

  async function save() {
    setError(null);
    try {
      // The hook decides JSON vs multipart (a retained scan rides along as the
      // untouched bytes) and surfaces a failed save through its own error.
      setSavedRecipeId(await saveToServer(draft, photoFile));
      setStep(4);
    } catch {
      // Message already lives in the hook's error state.
    }
  }

  /**
   * Bulk path: N images -> N recipes, no review step. Validation happens up
   * front (planBulkBatch), then runBulkImport walks the queue one image at a
   * time: OCR -> createDraft({kind:'scan'}) -> the same save seam the single
   * photo flow uses. One failure never stops the batch.
   */
  async function runBulk(files: File[]) {
    if (bulkRunning) return;
    setError(null);
    clearSaveError();
    setBulkSummary(null);

    const plan = planBulkBatch(files);
    setBulkStates(plan.states);
    setBulkRejected(plan.rejected);

    if (plan.accepted.length === 0) {
      // Nothing passed validation — report that straight away.
      setBulkSummary(summarizeBulkBatch(plan.states, plan.rejected));
      return;
    }

    setBulkRunning(true);
    try {
      const { summary } = await runBulkImport({
        plan,
        recognize: (file) => recognizeText(file),
        save: (bulkDraft, file) => saveToServer(bulkDraft, file),
        onChange: setBulkStates,
      });
      setBulkSummary(summary);
    } finally {
      // A failed per-file save sets the hook's error; the batch reports it per
      // row instead, so don't leave a stale banner behind for the next step.
      clearSaveError();
      setBulkRunning(false);
    }
  }

  function restart() {
    setStep(1);
    setEntry(null);
    setDraft(createDraft({ kind: "manual" }));
    setUrlInput("");
    setError(null);
    clearSaveError();
    setPhotoState("idle");
    setPhotoFile(null);
    setSavedRecipeId(null);
    resetBulk();
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
      {step === 2 && entry === "bulk" ? (
        <Step2Bulk
          states={bulkStates}
          rejected={bulkRejected}
          summary={bulkSummary}
          running={bulkRunning}
          onRun={runBulk}
          onReset={resetBulk}
          onBack={() => setStep(1)}
        />
      ) : null}
      {step === 2 && entry !== "bulk" ? (
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
          error={error ?? saveError}
          onBack={() => setStep(2)}
          onSave={save}
          saving={saving}
          onReOcr={photoFile ? () => recognizeText(photoFile) : undefined}
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
          <span style={{ color: "#6b655c", fontSize: 12 }}>Local OCR — the photo is kept with the recipe for re-runs</span>
        </button>
        <button
          type="button"
          className="entry-btn"
          onClick={() => onPick("bulk")}
          style={entryBtnStyle}
        >
          <span style={{ fontSize: 22 }}>🗂️</span>
          <strong>Import a batch of photos</strong>
          <span style={{ color: "#6b655c", fontSize: 12 }}>Up to {MAX_BULK_FILES} images — each is read and saved automatically</span>
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
          // The Blob stays local for OCR now, and the same bytes are kept in
          // state so they ride along with the draft on save (retained by the
          // server for re-OCR, #28).
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
      <p style={{ color: "#6b655c", marginTop: 0 }}>Local OCR. The original photo is uploaded once with the draft and kept with the recipe so OCR can be re-run.</p>
      <p style={{ fontSize: 12, color: "#6b655c", fontStyle: "italic" }}>📷 original photo retained with the recipe</p>
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
            <span style={{ color: "#6b655c", fontSize: 12 }}>Photo is read locally now and kept with the saved recipe</span>
          </button>
          <label style={entryBtnStyle}>
            <span style={{ fontSize: 22 }}>🖼️</span>
            <strong>Or pick an image file</strong>
            <span style={{ color: "#6b655c", fontSize: 12 }}>File is read locally and uploaded once with the draft</span>
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
  onReOcr?: () => Promise<string>;
}) {
  return (
    <section>
      <h2 style={{ margin: "0 0 4px" }}>Review the draft</h2>
      <p style={{ color: "#6b655c", marginTop: 0 }}>Badges flag what we couldn't trust. Fix what needs fixing, then save.</p>
      <ReviewEditor draft={props.draft} setDraft={props.setDraft} reOcr={props.onReOcr} />
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

const BULK_STATUS_LABELS: Record<BulkFileStatus, string> = {
  queued: "Queued",
  ocr: "Reading",
  saving: "Saving",
  done: "Saved",
  error: "Failed",
};

const BULK_STATUS_COLORS: Record<
  BulkFileStatus,
  { color: string; background: string }
> = {
  queued: { color: "#6b655c", background: "#efebe3" },
  ocr: { color: "#8a5a00", background: "#fdf3dd" },
  saving: { color: "#8a5a00", background: "#fdf3dd" },
  done: { color: "#2f7a3e", background: "#e1f1e3" },
  error: { color: "#9a3030", background: "#f7e3e1" },
};

/**
 * Batch entry: pick many images, let the queue run. Unlike Step2Photo there is
 * no review stop — the closing summary (saved links + named failures) is the
 * only checkpoint. All queue rules live in ../lib/bulk-import.
 */
function Step2Bulk(props: {
  states: BulkFileState[];
  rejected: RejectedFile[];
  summary: BulkSummary | null;
  running: boolean;
  onRun: (files: File[]) => void;
  onReset: () => void;
  onBack: () => void;
}) {
  const [selection, setSelection] = useState<File[]>([]);
  const started = props.states.length > 0 || props.summary !== null;
  const { total, finished } = bulkProgress(props.states);

  function onFilesPicked(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files ?? []);
    props.onReset();
    setSelection(picked);
    // Allow picking the same images again after a run.
    e.target.value = "";
  }

  function resetAll() {
    setSelection([]);
    props.onReset();
  }

  return (
    <section>
      <h2 style={{ margin: "0 0 4px" }}>Import a batch of photos</h2>
      <p style={{ color: "#6b655c", marginTop: 0 }}>
        Up to {MAX_BULK_FILES} images at once. Each one is read locally and saved
        as its own recipe — there is no per-recipe review, so check the titles in
        the summary at the end.
      </p>

      {!started ? (
        <div style={{ display: "grid", gap: 10 }}>
          <label style={entryBtnStyle}>
            <span style={{ fontSize: 22 }}>🖼️</span>
            <strong>
              {selection.length > 0
                ? `${selection.length} image${selection.length === 1 ? "" : "s"} selected`
                : "Pick images"}
            </strong>
            <span style={{ color: "#6b655c", fontSize: 12 }}>
              Images up to {MAX_SCAN_UPLOAD_MB}MB each · {MAX_BULK_FILES} per batch
            </span>
            <input
              type="file"
              multiple
              accept="image/*"
              onChange={onFilesPicked}
              style={{ display: "none" }}
            />
          </label>

          {selection.length > 0 ? (
            <>
              <ul style={bulkListStyle}>
                {selection.map((file) => (
                  <li
                    key={`${file.name}:${file.size}:${file.lastModified}`}
                    style={bulkRowStyle}
                  >
                    <span style={bulkNameStyle}>{file.name}</span>
                    <span
                      style={{
                        ...bulkChipStyle,
                        color: "#6b655c",
                        background: "#efebe3",
                      }}
                    >
                      {formatFileSize(file.size)}
                    </span>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                onClick={() => props.onRun(selection)}
                style={primaryBtn}
              >
                Import {selection.length} image{selection.length === 1 ? "" : "s"}
              </button>
            </>
          ) : null}
        </div>
      ) : null}

      {props.rejected.length > 0 ? (
        <ul style={{ ...bulkListStyle, marginTop: 12 }}>
          {props.rejected.map((file, index) => (
            <li
              key={`${file.name}:${index}`}
              style={{ ...bulkRowStyle, color: "#a26800", fontSize: 13 }}
            >
              <span style={bulkNameStyle}>{file.name}</span>
              <span>{file.message}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {props.states.length > 0 ? (
        <>
          <p style={{ fontSize: 12, color: "#6b655c", margin: "14px 0 6px" }}>
            {props.running
              ? `Working… ${finished} of ${total} finished`
              : props.summary
                ? formatBulkHeadline(props.summary)
                : `${total} image${total === 1 ? "" : "s"} queued`}
          </p>
          <ul style={bulkListStyle}>
            {props.states.map((state) => (
              <li key={state.id} style={bulkRowStyle}>
                <span style={bulkNameStyle}>{state.name}</span>
                {state.status === "done" && state.recipeId !== undefined ? (
                  <Link
                    to={`/recipes/${state.recipeId}/review`}
                    style={{ fontSize: 12, color: "#b04a2f" }}
                  >
                    open #{state.recipeId}
                  </Link>
                ) : (
                  <span
                    style={{
                      ...bulkChipStyle,
                      ...BULK_STATUS_COLORS[state.status],
                    }}
                  >
                    {BULK_STATUS_LABELS[state.status]}
                  </span>
                )}
                {state.error ? (
                  <span
                    style={{ flexBasis: "100%", color: "#9a3030", fontSize: 12 }}
                  >
                    {state.error}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {props.summary ? (
        <div
          style={{
            marginTop: 16,
            padding: "12px 14px",
            border: "1px solid #e3ddd2",
            borderRadius: 12,
            background: "#fbf9f5",
          }}
        >
          <strong style={{ display: "block", marginBottom: 6 }}>
            {formatBulkHeadline(props.summary)}
          </strong>
          {props.summary.savedRecipes.length > 0 ? (
            <ul style={{ margin: "0 0 8px", paddingLeft: 18, fontSize: 13 }}>
              {props.summary.savedRecipes.map((saved, index) => (
                <li key={`${saved.name}:${index}`}>
                  {saved.recipeId === null ? (
                    saved.name
                  ) : (
                    <Link
                      to={`/recipes/${saved.recipeId}/review`}
                      style={{ color: "#b04a2f" }}
                    >
                      {saved.name}
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          ) : null}
          {props.summary.failures.length > 0 ? (
            <ul
              style={{
                margin: 0,
                paddingLeft: 18,
                fontSize: 12,
                color: "#9a3030",
              }}
            >
              {props.summary.failures.map((failure, index) => (
                <li key={`${failure.name}:${index}`}>
                  {failure.name} — {failure.error}
                </li>
              ))}
            </ul>
          ) : null}
          {!props.running ? (
            <button
              type="button"
              onClick={resetAll}
              style={{ ...ghostBtn, marginTop: 10 }}
            >
              Import another batch
            </button>
          ) : null}
        </div>
      ) : null}

      <div style={stickyBarStyle}>
        <button
          type="button"
          onClick={props.onBack}
          style={ghostBtn}
          disabled={props.running}
        >
          Back
        </button>
        <span
          style={{
            marginLeft: "auto",
            alignSelf: "center",
            fontSize: 12,
            color: "#6b655c",
          }}
        >
          {props.running ? "Saving as it goes…" : null}
        </span>
      </div>
    </section>
  );
}

const bulkListStyle: React.CSSProperties = {
  listStyle: "none",
  margin: "10px 0 0",
  padding: 0,
  border: "1px solid #e3ddd2",
  borderRadius: 12,
  overflow: "hidden",
};

const bulkRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  flexWrap: "wrap",
  padding: "8px 12px",
  borderBottom: "1px solid #f0ece3",
  fontSize: 13,
};

const bulkNameStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const bulkChipStyle: React.CSSProperties = {
  fontSize: 11,
  padding: "2px 8px",
  borderRadius: 999,
  whiteSpace: "nowrap",
};

const stickyBarStyle: React.CSSProperties = {
  display: "flex",
  gap: 10,
  marginTop: 18,
  position: "sticky",
  bottom: 0,
  background: "#fff",
  padding: "12px 0",
  borderTop: "1px solid #e3ddd2",
};

const fieldLabelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 12,
  color: "#6b655c",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
};
