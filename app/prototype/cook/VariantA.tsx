/**
 * THROWAWAY PROTOTYPE — issue #17 "Cook mode step-focus UX" (Map #14).
 *
 * Variant A · StepFocus — exactly one step on screen at a time, huge touch
 * text, prev/next, step dots, an ephemeral ingredient checklist, and a screen
 * wake-lock toggle. All state is local and resets on reload.
 */
import { useState } from "react";
import type { PrototypeRecipe } from "./fake-recipe";
import { useWakeLock } from "./useWakeLock";

const muted = "#6b655c";

export function VariantA({ recipe }: { recipe: PrototypeRecipe }) {
  const total = recipe.steps.length;
  const [index, setIndex] = useState(0);
  const [checked, setChecked] = useState<Record<number, boolean>>({});
  const [showIngredients, setShowIngredients] = useState(false);
  const wake = useWakeLock();

  const step = recipe.steps[index] ?? recipe.steps[0];
  const checkedCount = recipe.ingredients.filter((_, i) => checked[i] === true).length;

  if (!step) {
    return <p style={{ padding: 24 }}>This fake recipe has no steps.</p>;
  }

  function go(delta: number) {
    setIndex((current) => Math.min(total - 1, Math.max(0, current + delta)));
  }

  return (
    <main style={{ maxWidth: 680, margin: "0 auto", padding: "20px 16px 150px" }}>
      <header>
        <p style={eyebrow}>Variant A · StepFocus</p>
        <h1 style={{ margin: "4px 0 2px", fontSize: "1.4rem" }}>{recipe.title}</h1>
        <p style={{ margin: 0, color: muted, fontSize: 13 }}>
          {recipe.yield} · {recipe.totalTime}
        </p>
      </header>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 14 }}>
        <span style={chip}>
          Step {index + 1} / {total}
        </span>
        <span style={chip}>
          {checkedCount} / {recipe.ingredients.length} ingredients checked
        </span>
        <span
          style={{
            ...chip,
            background: wake.on ? "#e4f3e6" : "#efe9df",
            borderColor: wake.on ? "#8fbf97" : "#d8cfc0",
          }}
        >
          Wake lock {wake.on ? "ON" : "OFF"}
          {wake.supported ? "" : " · unsupported"}
        </span>
      </div>

      <section style={{ marginTop: 30 }}>
        <p style={{ ...eyebrow, marginBottom: 8 }}>Step {index + 1}</p>
        <p
          style={{
            margin: 0,
            fontSize: "clamp(1.7rem, 6.2vw, 2.7rem)",
            lineHeight: 1.22,
            fontWeight: 600,
            letterSpacing: "-0.015em",
          }}
        >
          {step.text}
        </p>
      </section>

      <div style={{ display: "flex", gap: 12, marginTop: 32 }}>
        <button
          type="button"
          onClick={() => go(-1)}
          disabled={index === 0}
          style={{ ...navBtn, opacity: index === 0 ? 0.35 : 1 }}
        >
          ← Previous
        </button>
        <button
          type="button"
          onClick={() => go(1)}
          disabled={index === total - 1}
          style={{ ...navBtn, ...navPrimary, opacity: index === total - 1 ? 0.35 : 1 }}
        >
          {index === total - 1 ? "Done" : "Next →"}
        </button>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 9, marginTop: 26 }} aria-label="Step dots">
        {recipe.steps.map((_, i) => (
          <button
            key={i}
            type="button"
            aria-label={`Go to step ${i + 1}`}
            aria-current={i === index ? "step" : undefined}
            onClick={() => setIndex(i)}
            style={{
              width: i === index ? 34 : 16,
              height: 16,
              padding: 0,
              borderRadius: 999,
              border: "1px solid #b04a2f",
              background: i === index ? "#b04a2f" : i < index ? "#e8c9bf" : "#fff",
              cursor: "pointer",
              transition: "width 150ms, background 150ms",
            }}
          />
        ))}
      </div>

      <div style={{ marginTop: 30, borderTop: "1px solid #e3ddd2", paddingTop: 16 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <button type="button" onClick={() => setShowIngredients((v) => !v)} style={ghostBtn}>
            {showIngredients ? "Hide ingredient checklist" : `Ingredients (${checkedCount}/${recipe.ingredients.length})`}
          </button>
          <button type="button" onClick={() => void wake.toggle()} style={ghostBtn}>
            {wake.on ? "Release wake lock" : "Keep screen awake"}
          </button>
        </div>
        {wake.message ? (
          <p style={{ color: muted, fontSize: 12, marginTop: 8 }}>{wake.message}</p>
        ) : null}

        {showIngredients ? (
          <ul style={{ listStyle: "none", margin: "14px 0 0", padding: 0, display: "grid", gap: 8 }}>
            {recipe.ingredients.map((item, i) => (
              <li key={i}>
                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "10px 12px",
                    borderRadius: 12,
                    border: "1px solid #e3ddd2",
                    background: checked[i] ? "#f2eee6" : "#fff",
                    cursor: "pointer",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={checked[i] === true}
                    onChange={() => setChecked((prev) => ({ ...prev, [i]: !prev[i] }))}
                    style={{ width: 22, height: 22, accentColor: "#b04a2f", flex: "none" }}
                  />
                  <span
                    style={{
                      textDecoration: checked[i] ? "line-through" : "none",
                      opacity: checked[i] ? 0.55 : 1,
                    }}
                  >
                    {item.text}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        ) : (
          <p style={{ color: muted, fontSize: 13, marginTop: 10 }}>
            Ingredient checks are ephemeral — they reset on reload.
          </p>
        )}
      </div>
    </main>
  );
}

const eyebrow: React.CSSProperties = {
  margin: 0,
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: "0.1em",
  textTransform: "uppercase",
  color: "#b04a2f",
};

const chip: React.CSSProperties = {
  display: "inline-block",
  padding: "4px 10px",
  borderRadius: 999,
  border: "1px solid #e3ddd2",
  background: "#fff",
  fontSize: 12,
  color: "#3a332b",
};

const navBtn: React.CSSProperties = {
  flex: 1,
  minHeight: 64,
  padding: "16px 20px",
  borderRadius: 999,
  border: "1px solid #c9c1b1",
  background: "#fff",
  color: "inherit",
  font: "inherit",
  fontSize: 18,
  fontWeight: 600,
  cursor: "pointer",
};

const navPrimary: React.CSSProperties = {
  border: "1px solid #b04a2f",
  background: "#b04a2f",
  color: "#fff",
};

const ghostBtn: React.CSSProperties = {
  appearance: "none",
  border: "1px solid #c9c1b1",
  background: "#fff",
  color: "inherit",
  borderRadius: 999,
  padding: "9px 16px",
  font: "inherit",
  fontSize: 13,
  cursor: "pointer",
};
