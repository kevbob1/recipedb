/**
 * THROWAWAY PROTOTYPE — issue #17 "Cook mode step-focus UX" (Map #14).
 *
 * Variant B · ScrollSticky — the whole recipe scrolls as one page. A sticky
 * header tracks the current step with a progress bar; tapping a step card makes
 * it current (and scrolls it into view). Ingredients are a collapsible
 * checklist at the top. State is local and resets on reload.
 */
import { useEffect, useRef, useState } from "react";
import type { PrototypeRecipe } from "./fake-recipe";
import { useWakeLock } from "./useWakeLock";

const muted = "#6b655c";

export function VariantB({ recipe }: { recipe: PrototypeRecipe }) {
  const total = recipe.steps.length;
  const [index, setIndex] = useState(0);
  const [checked, setChecked] = useState<Record<number, boolean>>({});
  const [ingredientsOpen, setIngredientsOpen] = useState(true);
  const wake = useWakeLock();
  const stepRefs = useRef<Array<HTMLLIElement | null>>([]);

  const checkedCount = recipe.ingredients.filter((_, i) => checked[i] === true).length;
  const progress = total === 0 ? 0 : ((index + 1) / total) * 100;

  useEffect(() => {
    const nodes = stepRefs.current.filter((node): node is HTMLLIElement => node !== null);
    if (nodes.length === 0 || typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (!visible) return;
        const raw = (visible.target as HTMLElement).dataset.stepIndex;
        const next = raw === undefined ? Number.NaN : Number(raw);
        if (!Number.isNaN(next)) setIndex(next);
      },
      { rootMargin: "-38% 0px -55% 0px", threshold: 0 },
    );

    nodes.forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, [recipe.steps.length]);

  function makeCurrent(i: number) {
    setIndex(i);
    stepRefs.current[i]?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  return (
    <div style={{ maxWidth: 760, margin: "0 auto", paddingBottom: 150 }}>
      <header
        style={{
          position: "sticky",
          top: 0,
          zIndex: 10,
          background: "rgba(250, 247, 242, 0.96)",
          backdropFilter: "blur(6px)",
          borderBottom: "1px solid #e3ddd2",
          padding: "12px 16px 10px",
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
          <div>
            <p style={{ ...eyebrow, marginBottom: 2 }}>Variant B · ScrollSticky</p>
            <h1 style={{ margin: 0, fontSize: "1.05rem" }}>{recipe.title}</h1>
          </div>
          <div style={{ textAlign: "right", fontSize: 12, color: "#3a332b" }}>
            <strong style={{ fontSize: 14 }}>
              Step {Math.min(index + 1, total)} / {total}
            </strong>
            <div style={{ color: muted }}>
              {checkedCount}/{recipe.ingredients.length} checked · wake {wake.on ? "ON" : "OFF"}
            </div>
          </div>
        </div>

        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={Math.min(index + 1, total)}
          style={{ height: 6, marginTop: 8, borderRadius: 999, background: "#e8e1d5", overflow: "hidden" }}
        >
          <div
            style={{
              width: `${progress}%`,
              height: "100%",
              background: "#b04a2f",
              transition: "width 180ms",
            }}
          />
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
          <button
            type="button"
            onClick={() => setIngredientsOpen((open) => !open)}
            style={smallBtn}
            aria-expanded={ingredientsOpen}
          >
            {ingredientsOpen ? "Hide ingredients" : "Show ingredients"} ({checkedCount}/{recipe.ingredients.length})
          </button>
          <button type="button" onClick={() => void wake.toggle()} style={smallBtn}>
            {wake.on ? "Release wake lock" : "Keep screen awake"}
          </button>
        </div>
        {wake.message ? <p style={{ margin: "6px 0 0", fontSize: 11, color: muted }}>{wake.message}</p> : null}
      </header>

      {ingredientsOpen ? (
        <section
          aria-label="Ingredient checklist"
          style={{
            margin: "14px 16px 0",
            padding: "12px 14px",
            border: "1px solid #e3ddd2",
            borderRadius: 14,
            background: "#fff",
          }}
        >
          <h2 style={{ margin: "0 0 8px", fontSize: 13, letterSpacing: "0.06em", textTransform: "uppercase" }}>
            Ingredients
          </h2>
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}>
            {recipe.ingredients.map((item, i) => (
              <li key={i}>
                <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer", fontSize: 14 }}>
                  <input
                    type="checkbox"
                    checked={checked[i] === true}
                    onChange={() => setChecked((prev) => ({ ...prev, [i]: !prev[i] }))}
                    style={{ width: 18, height: 18, accentColor: "#b04a2f", flex: "none" }}
                  />
                  <span
                    style={{
                      textDecoration: checked[i] ? "line-through" : "none",
                      opacity: checked[i] ? 0.5 : 1,
                    }}
                  >
                    {item.text}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <ol style={{ listStyle: "none", margin: 0, padding: "18px 16px 0", display: "grid", gap: 12 }}>
        {recipe.steps.map((step, i) => {
          const current = i === index;
          return (
            <li
              key={step.position}
              ref={(node) => {
                stepRefs.current[i] = node;
              }}
              data-step-index={i}
            >
              <article
                role="button"
                tabIndex={0}
                aria-current={current ? "step" : undefined}
                aria-label={`Step ${i + 1}${current ? " (current)" : ""}: ${step.text}`}
                onClick={() => makeCurrent(i)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    makeCurrent(i);
                  }
                }}
                style={{
                  padding: "16px 18px",
                  borderRadius: 18,
                  border: current ? "2px solid #b04a2f" : "1px solid #e3ddd2",
                  background: current ? "#fff" : "rgba(255, 255, 255, 0.55)",
                  boxShadow: current ? "0 8px 22px rgba(176, 74, 47, 0.12)" : "none",
                  cursor: "pointer",
                  outline: "none",
                }}
              >
                <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
                  <span
                    style={{
                      flex: "none",
                      width: 30,
                      height: 30,
                      borderRadius: 999,
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      background: current ? "#b04a2f" : "#efe9df",
                      color: current ? "#fff" : "#3a332b",
                      fontSize: 13,
                      fontWeight: 700,
                    }}
                  >
                    {i + 1}
                  </span>
                  <p
                    style={{
                      margin: 0,
                      fontSize: current ? "1.18rem" : "1rem",
                      lineHeight: 1.5,
                      fontWeight: current ? 600 : 400,
                      color: current ? "#211d18" : "#4a4238",
                      transition: "font-size 150ms",
                    }}
                  >
                    {step.text}
                  </p>
                </div>
                {current ? (
                  <p style={{ margin: "8px 0 0 40px", fontSize: 11, color: "#b04a2f", fontWeight: 700, letterSpacing: "0.08em" }}>
                    CURRENT STEP — tap another card to advance
                  </p>
                ) : null}
              </article>
            </li>
          );
        })}
      </ol>

      <p style={{ margin: "16px", fontSize: 12, color: muted }}>
        Current step {Math.min(index + 1, total)} of {total} · {checkedCount} ingredients checked · wake lock{" "}
        {wake.on ? "ON" : "OFF"}
      </p>
    </div>
  );
}

const eyebrow: React.CSSProperties = {
  margin: 0,
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: "0.1em",
  textTransform: "uppercase",
  color: "#b04a2f",
};

const smallBtn: React.CSSProperties = {
  appearance: "none",
  border: "1px solid #c9c1b1",
  background: "#fff",
  color: "inherit",
  borderRadius: 999,
  padding: "5px 12px",
  font: "inherit",
  fontSize: 12,
  cursor: "pointer",
};
