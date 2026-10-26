/**
 * The shared review editor. Used by both /add (step 3) and
 * /recipes/:id/review, so URL, photo, and manual entries all share one
 * review surface.
 */
import { useState } from "react";
import {
  CATEGORIES,
  type Category,
  type DraftIngredient,
  type RecipeDraft,
  ingredientConfidence,
} from "../lib/draft";
import { display, formatAmount, fromText, setQty } from "../lib/ingredient-line";
import { importScan } from "../lib/import";

export function ReviewEditor({
  draft,
  setDraft,
  reOcr,
}: {
  draft: RecipeDraft;
  setDraft: (d: RecipeDraft) => void;
  /**
   * Re-run OCR for this recipe and resolve with fresh text (#28). The text is
   * shown for approval; only the explicit "Use this text" button touches the
   * draft, so a person's edits are never auto-overwritten.
   */
  reOcr?: () => Promise<string>;
}) {
  const [ocrPreview, setOcrPreview] = useState<string | null>(null);
  const [ocrRunning, setOcrRunning] = useState(false);
  const [ocrError, setOcrError] = useState<string | null>(null);

  async function runOcr() {
    if (!reOcr) return;
    setOcrRunning(true);
    setOcrError(null);
    try {
      setOcrPreview(await reOcr());
    } catch (err) {
      setOcrError((err as Error).message ?? "Couldn't re-run OCR.");
    } finally {
      setOcrRunning(false);
    }
  }

  /**
   * Explicit approval: replace the editable fields with the fresh OCR parse.
   * Nothing here runs automatically — the preview is the staging area.
   */
  function applyOcr() {
    if (ocrPreview === null) return;
    // The import seam owns the parse stamping (sourceType/category guess);
    // the retained capture is the recipe's, not the fresh text's.
    setDraft(
      importScan(ocrPreview, {
        imageFilename: draft.imageFilename ?? null,
      }),
    );
    setOcrPreview(null);
  }

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

      {reOcr ? (
        <div style={{ border: "1px solid #e3ddd2", borderRadius: 12, padding: "10px 12px", background: "#fdfcf8" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <strong style={{ fontSize: 13 }}>OCR source</strong>
            <button type="button" onClick={runOcr} style={{ ...ghostBtn, padding: "4px 10px", fontSize: 12 }} disabled={ocrRunning}>
              {ocrRunning ? "Re-reading…" : "Re-run OCR"}
            </button>
          </div>
          <p style={{ color: "#6b655c", fontSize: 12, margin: "6px 0 0" }}>
            The stored capture is re-read with the current settings. Nothing changes until you approve it.
          </p>
          {ocrError ? <p style={{ color: "#9a3030", fontSize: 12, margin: "6px 0 0" }}>{ocrError}</p> : null}
          {ocrPreview !== null ? (
            <div style={{ marginTop: 8 }}>
              <pre style={{ background: "#1f1d1a", color: "#f6f4ee", padding: 12, borderRadius: 10, fontSize: 12, whiteSpace: "pre-wrap", overflowX: "auto", maxHeight: 240 }}>
                {ocrPreview || "(no text recognized)"}
              </pre>
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <button type="button" onClick={applyOcr} style={primaryBtn}>
                  Use this text
                </button>
                <button type="button" onClick={() => setOcrPreview(null)} style={ghostBtn}>
                  Keep my edits
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

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
 * Hand-editing qty or unit rebuilds the line from its text. `setQty` takes the
 * whole (qty, unit) pair and re-derives the numeric view, so numbers derived
 * from text the person has since replaced can never linger: what "a manual qty
 * edit resets the derived fields" means in the decision on #15.
 */
function applyQtyEdit(
  ing: DraftIngredient,
  qty: string,
  unit: string | null = ing.unit,
): DraftIngredient {
  return setQty(ing, qty, unit);
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
          {display(ingredients, factor).map((row, i) => (
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
                  updateIng(i, applyQtyEdit(ing, ing.qty, e.target.value || null))
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
            {fromText(ing.qty, ing.unit).qtyParseStatus === "unparseable" ? (
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

export const inputStyle: React.CSSProperties = {
  width: "100%",
  border: "1px solid #c9c1b1",
  background: "#fff",
  borderRadius: 10,
  padding: "10px 12px",
  font: "inherit",
  color: "inherit",
  marginTop: 4,
};
export const primaryBtn: React.CSSProperties = {
  appearance: "none",
  border: "1px solid #b04a2f",
  background: "#b04a2f",
  color: "#fff",
  borderRadius: 999,
  padding: "10px 18px",
  font: "inherit",
  cursor: "pointer",
};
export const ghostBtn: React.CSSProperties = {
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
