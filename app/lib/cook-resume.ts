/**
 * Cook-mode resume state (issue #27).
 *
 * The cook screen keeps its progress on the device only: a single
 * localStorage entry per recipe under `cook:<recipeId>` holding
 *
 *   { checked: Record<number, boolean>, index: number, savedAt: number }
 *
 * where `index` is the zero-based current step and `savedAt` is epoch ms.
 * Entries older than 24 hours are ignored (lazily — no sweep) and overwritten
 * by the next write. A second sessionStorage flag, `cook-tab:<recipeId>`,
 * distinguishes a same-tab reload (restore silently) from a new tab (offer a
 * resume banner).
 *
 * This module is pure: it parses and serialises strings and never touches
 * `window`, so it can be unit-tested outside a browser. The route owns all
 * storage access, which it already must guard for SSR.
 */

export const COOK_RESUME_TTL_MS = 24 * 60 * 60 * 1000;

export type CookSavedState = {
  checked: Record<number, boolean>;
  index: number;
  savedAt: number;
};

export type CookRecipeId = string | number;

export function cookStorageKey(recipeId: CookRecipeId): string {
  return `cook:${recipeId}`;
}

export function cookTabKey(recipeId: CookRecipeId): string {
  return `cook-tab:${recipeId}`;
}

/**
 * Parse a stored payload. Returns null for absent, malformed, wrongly typed or
 * stale (>24h) entries, so callers can treat "null" as "nothing to restore".
 */
export function parseCookState(
  raw: string | null,
  now: number = Date.now(),
): CookSavedState | null {
  if (raw === null || raw === "") return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const record = parsed as Record<string, unknown>;
  const { savedAt, index, checked } = record;
  if (typeof savedAt !== "number" || !Number.isFinite(savedAt)) return null;
  if (typeof index !== "number" || !Number.isFinite(index) || index < 0) {
    return null;
  }
  if (now - savedAt > COOK_RESUME_TTL_MS) return null;

  const normalizedChecked: Record<number, boolean> = {};
  if (typeof checked === "object" && checked !== null && !Array.isArray(checked)) {
    for (const [key, value] of Object.entries(checked)) {
      const n = Number(key);
      if (Number.isInteger(n) && n >= 0 && value === true) {
        normalizedChecked[n] = true;
      }
    }
  }

  return {
    checked: normalizedChecked,
    index: Math.floor(index),
    savedAt,
  };
}

/** Wrap a session in the stored payload shape, stamping `savedAt`. */
export function serializeCookState(
  state: Pick<CookSavedState, "checked" | "index">,
  now: number = Date.now(),
): string {
  return JSON.stringify({
    checked: state.checked,
    index: state.index,
    savedAt: now,
  });
}

/** "just now" / "12 min ago" / "3 h ago" — for the resume banner. */
export function describeSavedAge(
  savedAt: number,
  now: number = Date.now(),
): string {
  const minutes = Math.max(0, Math.round((now - savedAt) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.round(minutes / 60)} h ago`;
}
