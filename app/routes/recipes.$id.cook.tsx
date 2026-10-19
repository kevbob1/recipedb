/**
 * /recipes/:id/cook — the cook screen (issue #18, decision made on #17).
 *
 * Read-only by construction: the loader calls requireAuth + loadCookRecipe
 * and there is no action, so nothing here can write to the database.
 *
 * Cook progress (checked ingredients + current step) survives for 24 hours on
 * the device under `cook:<recipeId>` in localStorage (issue #27). A same-tab
 * reload restores silently; a new tab offers a dismissible resume banner;
 * stale entries are ignored and overwritten lazily. Nothing leaves the device,
 * and there is no per-user scoping — one key per recipe suits the shared
 * kitchen tablet.
 *
 * Structure is the winning variant B (ScrollSticky) from the #17 prototype,
 * with variant C's ingredient progress bar grafted on:
 *   - the whole recipe scrolls as one page; the header sticks and tracks the
 *     current step with a progress bar
 *   - large step cards; tap / Enter / Space makes a card current, and the
 *     card scrolls itself into view
 *   - a collapsible ingredient checklist at the top, with its own bar
 *   - a wake-lock toggle so the screen does not sleep mid-recipe
 * Variants A (one step at a time) and C (split board) lost on #17 and are not
 * coming back here.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link } from "react-router";
import type { Route } from "./+types/recipes.$id.cook";
import { loadCookRecipe } from "../lib/cook.server";
import {
  cookStorageKey,
  cookTabKey,
  describeSavedAge,
  parseCookState,
  serializeCookState,
  type CookRecipeId,
  type CookSavedState,
} from "../lib/cook-resume";
import { useScreenWakeLock } from "../lib/wake-lock";
import { requireAuth } from "../lib/auth.server";

// Applies the stored session before the first paint on the client, while still
// giving the server render a clean (empty) session — restoring in a useState
// initializer instead would hydrate a different tree from the SSR markup.
const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;

function readSavedState(recipeId: CookRecipeId): CookSavedState | null {
  if (typeof window === "undefined") return null;
  try {
    return parseCookState(window.localStorage.getItem(cookStorageKey(recipeId)));
  } catch {
    // Storage disabled or the payload throws on access — cook without resume.
    return null;
  }
}

function readTabAlive(recipeId: CookRecipeId): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.sessionStorage.getItem(cookTabKey(recipeId)) === "1";
  } catch {
    return false;
  }
}

function markTabAlive(recipeId: CookRecipeId): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(cookTabKey(recipeId), "1");
  } catch {
    // ignore
  }
}

function clearSavedState(recipeId: CookRecipeId): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(cookStorageKey(recipeId));
  } catch {
    // ignore
  }
  try {
    window.sessionStorage.removeItem(cookTabKey(recipeId));
  } catch {
    // ignore
  }
}

export function meta({ data }: Route.MetaArgs) {
  if (!data) return [{ title: "Cook — recipedb" }];
  return [{ title: `Cook: ${data.draft.title || "untitled"} — recipedb` }];
}

export async function loader({ params, request }: Route.LoaderArgs) {
  requireAuth(request);
  const result = loadCookRecipe(params.id);
  if (!result.ok) {
    throw new Response(result.message, { status: result.status });
  }
  return { draft: result.draft, recipeId: result.recipeId };
}

export default function CookRoute({ loaderData }: Route.ComponentProps) {
  const { draft, recipeId } = loaderData;
  const ingredients = draft.ingredients;
  const steps = draft.steps;
  const total = steps.length;

  const [rawIndex, setRawIndex] = useState(0);
  // Clamp on read: the recipe cannot change under a cook session today, but a
  // stale index must never render "Step 4 / 3".
  const index = total === 0 ? 0 : Math.min(rawIndex, total - 1);
  const [checked, setChecked] = useState<Record<number, boolean>>({});
  const [ingredientsOpen, setIngredientsOpen] = useState(true);
  // A fresh new tab holds saved state here until the person answers the
  // banner. While it is non-null, persistence is paused so the offer cannot
  // overwrite itself with the empty starting session.
  const [pendingResume, setPendingResume] = useState<CookSavedState | null>(null);
  const [restored, setRestored] = useState(false);
  const wake = useScreenWakeLock();
  const stepRefs = useRef<Array<HTMLLIElement | null>>([]);

  const checkedCount = ingredients.reduce(
    (n, _ing, i) => (checked[i] ? n + 1 : n),
    0,
  );
  const stepProgress = total === 0 ? 0 : ((index + 1) / total) * 100;
  const ingredientProgress =
    ingredients.length === 0 ? 0 : (checkedCount / ingredients.length) * 100;
  const resumeCheckedCount = pendingResume
    ? Object.values(pendingResume.checked).filter(Boolean).length
    : 0;

  // Restore after mount, once the SSR markup has hydrated: a same-tab reload
  // applies silently and scrolls to the saved step (the observer below then
  // agrees with it); a new tab only offers to resume.
  useIsomorphicLayoutEffect(() => {
    const stored = readSavedState(recipeId);
    if (stored) {
      const boundedIndex = total === 0 ? 0 : Math.min(stored.index, total - 1);
      if (readTabAlive(recipeId)) {
        setChecked(stored.checked);
        setRawIndex(boundedIndex);
        stepRefs.current[boundedIndex]?.scrollIntoView({ block: "center" });
      } else {
        setPendingResume({ ...stored, index: boundedIndex });
      }
    }
    setRestored(true);
  }, [recipeId, total]);

  // Mark this tab as carrying a cook session only after the restore check has
  // read the flag — StrictMode re-runs layout effects, and setting it there
  // would make the second run mistake a new tab for a reload.
  useEffect(() => {
    markTabAlive(recipeId);
  }, [recipeId]);

  // Persist on change. An empty session is not worth a key: removing it keeps
  // a dismissed banner (or "Start over") from leaving a pointless resume offer
  // on the shared tablet.
  useEffect(() => {
    if (!restored || pendingResume !== null) return;
    if (typeof window === "undefined") return;
    if (checkedCount === 0 && index === 0) {
      try {
        window.localStorage.removeItem(cookStorageKey(recipeId));
      } catch {
        // ignore
      }
      return;
    }
    try {
      window.localStorage.setItem(
        cookStorageKey(recipeId),
        serializeCookState({ checked, index }),
      );
      markTabAlive(recipeId);
    } catch {
      // Storage full or disabled — cook mode still works, it just cannot resume.
    }
  }, [checked, checkedCount, index, pendingResume, restored, recipeId]);

  // Follow the scroll: whichever step card is nearest the middle band under
  // the sticky header becomes the current step. Tapping also sets the index,
  // so this only ever agrees with — never fights — the person.
  useEffect(() => {
    if (total === 0 || typeof IntersectionObserver === "undefined") return;
    const nodes = stepRefs.current.filter(
      (node): node is HTMLLIElement => node !== null,
    );
    if (nodes.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (!visible) return;
        const next = Number((visible.target as HTMLElement).dataset.stepIndex);
        if (Number.isInteger(next)) setRawIndex(next);
      },
      { rootMargin: "-38% 0px -55% 0px", threshold: 0 },
    );

    for (const node of nodes) observer.observe(node);
    return () => observer.disconnect();
  }, [total]);

  function makeCurrent(i: number) {
    setRawIndex(i);
    stepRefs.current[i]?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function resumeSession() {
    if (pendingResume === null) return;
    const bounded = total === 0 ? 0 : Math.min(pendingResume.index, total - 1);
    setChecked(pendingResume.checked);
    setRawIndex(bounded);
    setPendingResume(null);
    stepRefs.current[bounded]?.scrollIntoView({ block: "center" });
  }

  // "Start fresh" on the banner, its dismiss control, and "Start over" all
  // land here: wipe both storage keys and the in-memory session.
  function startFresh() {
    clearSavedState(recipeId);
    setChecked({});
    setRawIndex(0);
    setPendingResume(null);
    if (typeof window !== "undefined") {
      window.scrollTo({ top: 0 });
    }
  }

  return (
    <main style={shellStyle}>
      <header style={headerStyle}>
        <div style={headerRowStyle}>
          <div style={{ minWidth: 0 }}>
            <p style={eyebrowStyle}>Cook mode</p>
            <h1 style={titleStyle}>{draft.title || "Untitled recipe"}</h1>
            <p style={subNavStyle}>
              <Link to="/" style={linkStyle}>← Home</Link>
              {" · "}
              <Link to={`/recipes/${recipeId}/review`} style={linkStyle}>
                Review
              </Link>
              {draft.yield ? ` · ${draft.yield}` : null}
            </p>
          </div>
          <p style={counterStyle}>
            <strong style={{ fontSize: 15, display: "block" }}>
              {total === 0 ? "No steps" : `Step ${index + 1} / ${total}`}
            </strong>
            <span style={mutedStyle}>
              {checkedCount}/{ingredients.length} ingredients ready
            </span>
          </p>
        </div>

        <div
          role="progressbar"
          aria-label="Step progress"
          aria-valuemin={0}
          aria-valuemax={Math.max(total, 1)}
          aria-valuenow={total === 0 ? 0 : index + 1}
          aria-valuetext={
            total === 0 ? "No steps" : `Step ${index + 1} of ${total}`
          }
          style={trackStyle}
        >
          <div style={{ ...fillStyle, width: `${stepProgress}%` }} />
        </div>

        <div style={toggleRowStyle}>
          <button
            type="button"
            onClick={() => setIngredientsOpen((open) => !open)}
            aria-expanded={ingredientsOpen}
            style={chipBtnStyle}
          >
            {ingredientsOpen ? "Hide ingredients" : "Show ingredients"} (
            {checkedCount}/{ingredients.length})
          </button>
          <button
            type="button"
            onClick={() => void wake.toggle()}
            aria-pressed={wake.on}
            style={{
              ...chipBtnStyle,
              borderColor: wake.on ? "#2f7a3e" : "#c9c1b1",
              color: wake.on ? "#2f7a3e" : "inherit",
            }}
          >
            {wake.on ? "Screen staying awake ✓" : "Keep screen awake"}
          </button>
          <button
            type="button"
            onClick={startFresh}
            style={chipBtnStyle}
            aria-label="Start over: clear checkmarks, step and saved progress"
          >
            Start over
          </button>
        </div>
        {wake.message ? (
          <p role="status" style={statusStyle}>{wake.message}</p>
        ) : wake.supported === false ? (
          <p style={statusStyle}>
            No wake lock in this browser — keep the screen on by hand.
          </p>
        ) : null}
      </header>

      {pendingResume ? (
        <section aria-label="Resume saved cook session" style={bannerStyle}>
          <div style={bannerHeadStyle}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <p style={bannerTitleStyle}>Resume where you left off?</p>
              <p style={bannerMetaStyle}>
                {total === 0
                  ? "No steps"
                  : `Step ${Math.min(pendingResume.index + 1, total)} / ${total}`}
                {" · "}
                {resumeCheckedCount} ingredient
                {resumeCheckedCount === 1 ? "" : "s"} checked · saved{" "}
                {describeSavedAge(pendingResume.savedAt)}
              </p>
            </div>
            <button
              type="button"
              onClick={startFresh}
              aria-label="Dismiss resume offer and start fresh"
              style={dismissBtnStyle}
            >
              ×
            </button>
          </div>
          <div style={bannerActionsStyle}>
            <button
              type="button"
              onClick={resumeSession}
              style={primaryChipStyle}
            >
              Resume
            </button>
            <button type="button" onClick={startFresh} style={chipBtnStyle}>
              Start fresh
            </button>
          </div>
        </section>
      ) : null}

      {ingredientsOpen ? (
        <section aria-label="Ingredient checklist" style={cardStyle}>
          <div style={sectionHeadStyle}>
            <h2 style={sectionTitleStyle}>Ingredients</h2>
            <span style={mutedStyle}>
              {checkedCount} / {ingredients.length} checked
            </span>
          </div>
          <div
            role="progressbar"
            aria-label={`${checkedCount} of ${ingredients.length} ingredients checked`}
            aria-valuemin={0}
            aria-valuemax={Math.max(ingredients.length, 1)}
            aria-valuenow={checkedCount}
            style={{ ...trackStyle, height: 5, marginTop: 6 }}
          >
            <div style={{ ...fillStyle, width: `${ingredientProgress}%`, background: "#2f7a3e" }} />
          </div>
          {ingredients.length === 0 ? (
            <p style={mutedStyle}>No ingredients listed for this recipe.</p>
          ) : (
            <ul style={checklistStyle}>
              {ingredients.map((ing, i) => {
                const isChecked = checked[i] === true;
                return (
                  <li key={`${i}-${ing.text}`}>
                    <label style={checkLabelStyle}>
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() =>
                          setChecked((prev) => ({ ...prev, [i]: !prev[i] }))
                        }
                        style={checkboxStyle}
                      />
                      <span
                        style={{
                          textDecoration: isChecked ? "line-through" : "none",
                          opacity: isChecked ? 0.55 : 1,
                        }}
                      >
                        {ing.text}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      ) : null}

      {total === 0 ? (
        <section style={cardStyle}>
          <div style={sectionHeadStyle}>
            <h2 style={sectionTitleStyle}>No steps yet</h2>
          </div>
          <p style={{ margin: "8px 0 14px", fontSize: 15, color: muted }}>
            This recipe has no written steps, so there is nothing to cook from
            yet. Add them on the review screen and come back.
          </p>
          <Link to={`/recipes/${recipeId}/review`} style={primaryLinkStyle}>
            Go to review
          </Link>
        </section>
      ) : (
        <ol style={stepListStyle}>
          {steps.map((step, i) => {
            const current = i === index;
            return (
              <li
                key={`${step.position}-${i}`}
                ref={(node) => {
                  stepRefs.current[i] = node;
                }}
                data-step-index={i}
              >
                <article
                  role="button"
                  tabIndex={0}
                  aria-current={current ? "step" : undefined}
                  aria-label={`Step ${i + 1} of ${total}${
                    current ? ", current step" : ""
                  }. ${step.text}`}
                  onClick={() => makeCurrent(i)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      makeCurrent(i);
                    }
                  }}
                  style={current ? currentCardStyle : stepCardStyle}
                >
                  <div style={stepRowStyle}>
                    <span
                      aria-hidden
                      style={current ? currentBadgeStyle : badgeStyle}
                    >
                      {i + 1}
                    </span>
                    <p style={current ? currentStepTextStyle : stepTextStyle}>
                      {step.text}
                    </p>
                  </div>
                  {current ? (
                    <p style={currentHintStyle}>
                      Current step — tap another card to move on
                    </p>
                  ) : null}
                </article>
              </li>
            );
          })}
        </ol>
      )}

      <p style={footnoteStyle}>
        Your checkmarks and place are saved on this device for 24 hours, so a
        reload picks up where you left off — open this page in a new tab and it
        offers to resume. Use “Start over” to clear it. ·{" "}
        <Link to="/" style={linkStyle}>Back to recipes</Link>
      </p>
    </main>
  );
}

/* ------------------------------- styles ------------------------------- */
/* Inline objects, matching the idiom used by home and review. */

const muted = "#6b655c";
const brand = "#b04a2f";

const shellStyle: React.CSSProperties = {
  fontFamily: "system-ui, sans-serif",
  maxWidth: 760,
  margin: "0 auto",
  padding: "0 0 6rem",
};

const headerStyle: React.CSSProperties = {
  position: "sticky",
  top: 0,
  zIndex: 10,
  background: "rgba(253, 252, 248, 0.96)",
  backdropFilter: "blur(6px)",
  borderBottom: "1px solid #e3ddd2",
  padding: "12px 16px 10px",
};

const headerRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  gap: 12,
};

const eyebrowStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: "0.1em",
  textTransform: "uppercase",
  color: brand,
};

const titleStyle: React.CSSProperties = {
  margin: 0,
  fontSize: "1.05rem",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const subNavStyle: React.CSSProperties = {
  margin: "3px 0 0",
  fontSize: 12,
  color: muted,
};

const counterStyle: React.CSSProperties = {
  margin: 0,
  textAlign: "right",
  fontSize: 12,
  color: "#3a332b",
  flex: "none",
};

const mutedStyle: React.CSSProperties = { color: muted };

const linkStyle: React.CSSProperties = { color: brand };

const trackStyle: React.CSSProperties = {
  height: 6,
  marginTop: 8,
  borderRadius: 999,
  background: "#e8e1d5",
  overflow: "hidden",
};

const fillStyle: React.CSSProperties = {
  height: "100%",
  background: brand,
  transition: "width 180ms",
};

const toggleRowStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 8,
  marginTop: 8,
};

const chipBtnStyle: React.CSSProperties = {
  appearance: "none",
  border: "1px solid #c9c1b1",
  background: "#fff",
  color: "inherit",
  borderRadius: 999,
  padding: "9px 14px",
  minHeight: 40,
  font: "inherit",
  fontSize: 12,
  cursor: "pointer",
};

const statusStyle: React.CSSProperties = {
  margin: "6px 0 0",
  fontSize: 11,
  color: muted,
};

const bannerStyle: React.CSSProperties = {
  margin: "14px 16px 0",
  padding: "12px 14px",
  border: "1px solid #e0c9b8",
  borderRadius: 14,
  background: "#fdf3ec",
};

const bannerHeadStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 8,
};

const bannerTitleStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 14,
  fontWeight: 700,
  color: "#211d18",
};

const bannerMetaStyle: React.CSSProperties = {
  margin: "3px 0 0",
  fontSize: 12,
  color: muted,
};

const bannerActionsStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 8,
  marginTop: 10,
};

const dismissBtnStyle: React.CSSProperties = {
  appearance: "none",
  border: "none",
  background: "transparent",
  color: muted,
  fontSize: 20,
  lineHeight: 1,
  padding: "4px 6px",
  minWidth: 32,
  minHeight: 32,
  cursor: "pointer",
};

const primaryChipStyle: React.CSSProperties = {
  ...chipBtnStyle,
  background: brand,
  borderColor: brand,
  color: "#fff",
  fontWeight: 600,
};

const cardStyle: React.CSSProperties = {
  margin: "14px 16px 0",
  padding: "12px 14px",
  border: "1px solid #e3ddd2",
  borderRadius: 14,
  background: "#fff",
};

const sectionHeadStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  gap: 10,
};

const sectionTitleStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 13,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
};

const checklistStyle: React.CSSProperties = {
  listStyle: "none",
  margin: "10px 0 0",
  padding: 0,
  display: "grid",
  gap: 2,
};

const checkLabelStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  minHeight: 44,
  cursor: "pointer",
  fontSize: 15,
};

const checkboxStyle: React.CSSProperties = {
  width: 22,
  height: 22,
  accentColor: brand,
  flex: "none",
};

const stepListStyle: React.CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: "18px 16px 0",
  display: "grid",
  gap: 12,
};

const stepCardStyle: React.CSSProperties = {
  padding: "16px 18px",
  borderRadius: 18,
  border: "1px solid #e3ddd2",
  background: "rgba(255, 255, 255, 0.55)",
  cursor: "pointer",
};

const currentCardStyle: React.CSSProperties = {
  padding: "16px 18px",
  borderRadius: 18,
  border: `2px solid ${brand}`,
  background: "#fff",
  boxShadow: "0 8px 22px rgba(176, 74, 47, 0.12)",
  cursor: "pointer",
};

const stepRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 12,
};

const badgeBase: React.CSSProperties = {
  flex: "none",
  width: 32,
  height: 32,
  borderRadius: 999,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 14,
  fontWeight: 700,
};

const badgeStyle: React.CSSProperties = {
  ...badgeBase,
  background: "#efe9df",
  color: "#3a332b",
};

const currentBadgeStyle: React.CSSProperties = {
  ...badgeBase,
  background: brand,
  color: "#fff",
};

const stepTextStyle: React.CSSProperties = {
  margin: 0,
  fontSize: "1rem",
  lineHeight: 1.5,
  color: "#4a4238",
};

const currentStepTextStyle: React.CSSProperties = {
  margin: 0,
  fontSize: "1.18rem",
  lineHeight: 1.5,
  fontWeight: 600,
  color: "#211d18",
};

const currentHintStyle: React.CSSProperties = {
  margin: "10px 0 0 44px",
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: brand,
};

const primaryLinkStyle: React.CSSProperties = {
  display: "inline-block",
  padding: "12px 18px",
  background: brand,
  color: "#fff",
  borderRadius: 999,
  textDecoration: "none",
  fontWeight: 600,
  fontSize: 15,
};

const footnoteStyle: React.CSSProperties = {
  margin: "18px 16px 0",
  fontSize: 12,
  color: muted,
};
