/**
 * THROWAWAY PROTOTYPE — issue #17 "Cook mode step-focus UX" (Map #14).
 *
 * Floating bottom-bar variant switcher, shared by all three cook-mode layouts.
 * Rendered only outside a production build. Left/right arrow keys cycle with
 * wrap-around unless a text field (or contenteditable) has focus.
 */
import { useCallback, useEffect } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import { IS_DEV_BUILD } from "./flags";
import { metaFor, neighbor, type CookVariant } from "./variants";

export function CookVariantSwitcher({ variant }: { variant: CookVariant }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();

  const go = useCallback(
    (next: CookVariant) => {
      const search = new URLSearchParams(params);
      search.set("variant", next);
      navigate(`${location.pathname}?${search.toString()}`, { preventScrollReset: true });
    },
    [location.pathname, navigate, params],
  );

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable) {
          return;
        }
      }
      event.preventDefault();
      go(neighbor(variant, event.key === "ArrowRight" ? 1 : -1));
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [go, variant]);

  if (!IS_DEV_BUILD) return null;

  const meta = metaFor(variant);

  return (
    <div
      role="toolbar"
      aria-label="Prototype variant switcher"
      style={{
        position: "fixed",
        left: "50%",
        bottom: 18,
        transform: "translateX(-50%)",
        zIndex: 100,
        display: "flex",
        alignItems: "center",
        gap: 10,
        background: "#111111",
        color: "#ffffff",
        border: "1px solid #000000",
        borderRadius: 999,
        padding: "8px 10px",
        boxShadow: "0 10px 30px rgba(0, 0, 0, 0.35)",
        fontFamily: "system-ui, sans-serif",
        fontSize: 13,
        whiteSpace: "nowrap",
      }}
    >
      <button
        type="button"
        onClick={() => go(neighbor(variant, -1))}
        aria-label="Previous variant"
        style={arrowBtn}
      >
        ←
      </button>
      <span style={{ display: "flex", flexDirection: "column", lineHeight: 1.15, minWidth: 132, textAlign: "center" }}>
        <strong style={{ fontSize: 13, letterSpacing: "0.01em" }}>
          {meta.id} ({meta.slug})
        </strong>
        <span style={{ fontSize: 10, color: "#b9b3a8", letterSpacing: "0.06em", textTransform: "uppercase" }}>
          Cook mode · #17
        </span>
      </span>
      <button
        type="button"
        onClick={() => go(neighbor(variant, 1))}
        aria-label="Next variant"
        style={arrowBtn}
      >
        →
      </button>
    </div>
  );
}

const arrowBtn: React.CSSProperties = {
  appearance: "none",
  width: 36,
  height: 36,
  borderRadius: 999,
  border: "1px solid rgba(255, 255, 255, 0.45)",
  background: "transparent",
  color: "#ffffff",
  font: "inherit",
  fontSize: 18,
  lineHeight: 1,
  cursor: "pointer",
};
