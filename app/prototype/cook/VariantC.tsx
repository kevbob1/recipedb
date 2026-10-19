/**
 * THROWAWAY PROTOTYPE — issue #17 "Cook mode step-focus UX" (Map #14).
 *
 * Variant C · SplitBoard — ingredients live in a persistent side column with
 * check-off; steps are large stacked cards. On wide screens the board is a
 * two-pane split with a sticky ingredient rail; on narrow screens the
 * ingredients come first and the step cards follow. State is local and resets
 * on reload.
 */
import { useState } from "react";
import type { PrototypeRecipe } from "./fake-recipe";
import { useWakeLock } from "./useWakeLock";

const muted = "#6b655c";

export function VariantC({ recipe }: { recipe: PrototypeRecipe }) {
  const total = recipe.steps.length;
  const [index, setIndex] = useState(0);
  const [checked, setChecked] = useState<Record<number, boolean>>({});
  const wake = useWakeLock();

  const checkedCount = recipe.ingredients.filter((_, i) => checked[i] === true).length;
  const progress = total === 0 ? 0 : ((index + 1) / total) * 100;

  function go(delta: number) {
    setIndex((current) => Math.min(total - 1, Math.max(0, current + delta)));
  }

  return (
    <main style={{ maxWidth: 1120, margin: "0 auto", padding: "20px 16px 150px" }}>
      <style>{`
        .cook-c-split {
          display: grid;
          grid-template-columns: minmax(0, 1fr);
          gap: 16px;
          align-items: start;
        }
        @media (min-width: 920px) {
          .cook-c-split {
            grid-template-columns: minmax(260px, 320px) minmax(0, 1fr);
            gap: 28px;
          }
          .cook-c-side {
            position: sticky;
            top: 16px;
          }
        }
      `}</style>

      <header style={{ marginBottom: 18 }}>
        <p style={eyebrow}>Variant C · SplitBoard</p>
        <h1 style={{ margin: "4px 0 2px", fontSize: "1.5rem" }}>{recipe.title}</h1>
        <p style={{ margin: 0, color: muted, fontSize: 13 }}>
          {recipe.yield} · {recipe.totalTime}
        </p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 12 }}>
          <span style={chip}>
            Current step {Math.min(index + 1, total)} / {total}
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
          </span>
        </div>
      </header>

      <div className="cook-c-split">
        <aside
          className="cook-c-side"
          style={{
            border: "1px solid #e3ddd2",
            borderRadius: 18,
            background: "#fff",
            padding: "16px 16px 18px",
          }}
        >
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
            <h2 style={{ margin: 0, fontSize: 14, letterSpacing: "0.06em", textTransform: "uppercase" }}>
              Ingredients
            </h2>
            <span style={{ fontSize: 12, color: muted }}>
              {checkedCount}/{recipe.ingredients.length}
            </span>
          </div>

          <div style={{ height: 5, margin: "8px 0 12px", borderRadius: 999, background: "#efe9df", overflow: "hidden" }}>
            <div
              style={{
                width: `${recipe.ingredients.length === 0 ? 0 : (checkedCount / recipe.ingredients.length) * 100}%`,
                height: "100%",
                background: "#5c7a4f",
                transition: "width 150ms",
              }}
            />
          </div>

          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 4 }}>
            {recipe.ingredients.map((item, i) => (
              <li key={i}>
                <label
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 9,
                    padding: "6px 4px",
                    borderRadius: 8,
                    cursor: "pointer",
                    fontSize: 13,
                    lineHeight: 1.35,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={checked[i] === true}
                    onChange={() => setChecked((prev) => ({ ...prev, [i]: !prev[i] }))}
                    style={{ width: 18, height: 18, marginTop: 1, accentColor: "#5c7a4f", flex: "none" }}
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

          <button
            type="button"
            onClick={() => setChecked({})}
            style={{ ...smallBtn, marginTop: 10, width: "100%" }}
            disabled={checkedCount === 0}
          >
            Clear checks
          </button>

          <hr style={{ border: 0, borderTop: "1px solid #e3ddd2", margin: "16px 0 12px" }} />

          <h2 style={{ margin: "0 0 8px", fontSize: 14, letterSpacing: "0.06em", textTransform: "uppercase" }}>
            Screen
          </h2>
          <button type="button" onClick={() => void wake.toggle()} style={{ ...smallBtn, width: "100%" }}>
            {wake.on ? "Release wake lock" : "Keep screen awake"}
          </button>
          <p style={{ margin: "8px 0 0", fontSize: 11, color: muted, lineHeight: 1.4 }}>
            {wake.message ?? "Screen wake lock not requested yet."}
          </p>
        </aside>

        <section aria-label="Steps">
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10 }}>
            <h2 style={{ margin: 0, fontSize: 14, letterSpacing: "0.06em", textTransform: "uppercase" }}>
              Steps
            </h2>
            <span style={{ fontSize: 12, color: muted }}>tap a card to make it current</span>
          </div>

          <div style={{ height: 5, margin: "8px 0 14px", borderRadius: 999, background: "#efe9df", overflow: "hidden" }}>
            <div style={{ width: `${progress}%`, height: "100%", background: "#b04a2f", transition: "width 180ms" }} />
          </div>

          <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 12 }}>
            {recipe.steps.map((step, i) => {
              const current = i === index;
              return (
                <li key={step.position}>
                  <article
                    role="button"
                    tabIndex={0}
                    aria-current={current ? "step" : undefined}
                    aria-label={`Step ${i + 1}${current ? " (current)" : ""}: ${step.text}`}
                    onClick={() => setIndex(i)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setIndex(i);
                      }
                    }}
                    style={{
                      display: "flex",
                      gap: 14,
                      padding: "16px 18px",
                      borderRadius: 16,
                      border: current ? "2px solid #b04a2f" : "1px solid #e3ddd2",
                      background: current ? "#fff" : "rgba(255, 255, 255, 0.5)",
                      cursor: "pointer",
                      outline: "none",
                      boxShadow: current ? "0 10px 26px rgba(176, 74, 47, 0.13)" : "none",
                    }}
                  >
                    <span
                      style={{
                        flex: "none",
                        width: 40,
                        height: 40,
                        borderRadius: 12,
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        background: current ? "#b04a2f" : "#efe9df",
                        color: current ? "#fff" : "#3a332b",
                        fontSize: 16,
                        fontWeight: 700,
                      }}
                    >
                      {i + 1}
                    </span>
                    <div>
                      <p
                        style={{
                          margin: 0,
                          fontSize: current ? "1.16rem" : "1.02rem",
                          lineHeight: 1.5,
                          fontWeight: current ? 600 : 400,
                          color: current ? "#211d18" : "#4a4238",
                        }}
                      >
                        {step.text}
                      </p>
                      {current ? (
                        <p style={{ margin: "6px 0 0", fontSize: 11, color: "#b04a2f", fontWeight: 700, letterSpacing: "0.08em" }}>
                          COOKING THIS NOW
                        </p>
                      ) : null}
                    </div>
                  </article>
                </li>
              );
            })}
          </ol>

          <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
            <button
              type="button"
              onClick={() => go(-1)}
              disabled={index === 0}
              style={{ ...navBtn, opacity: index === 0 ? 0.35 : 1 }}
            >
              ← Previous step
            </button>
            <button
              type="button"
              onClick={() => go(1)}
              disabled={index === total - 1}
              style={{ ...navBtn, ...navPrimary, opacity: index === total - 1 ? 0.35 : 1 }}
            >
              {index === total - 1 ? "Done" : "Next step →"}
            </button>
          </div>

          <p style={{ margin: "14px 0 0", fontSize: 12, color: muted }}>
            Current step {Math.min(index + 1, total)} of {total} · {checkedCount} ingredients checked · wake lock{" "}
            {wake.on ? "ON" : "OFF"}
          </p>
        </section>
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

const smallBtn: React.CSSProperties = {
  appearance: "none",
  border: "1px solid #c9c1b1",
  background: "#fff",
  color: "inherit",
  borderRadius: 999,
  padding: "7px 12px",
  font: "inherit",
  fontSize: 12,
  cursor: "pointer",
};

const navBtn: React.CSSProperties = {
  flex: 1,
  minHeight: 52,
  padding: "12px 16px",
  borderRadius: 999,
  border: "1px solid #c9c1b1",
  background: "#fff",
  color: "inherit",
  font: "inherit",
  fontSize: 15,
  fontWeight: 600,
  cursor: "pointer",
};

const navPrimary: React.CSSProperties = {
  border: "1px solid #b04a2f",
  background: "#b04a2f",
  color: "#fff",
};
