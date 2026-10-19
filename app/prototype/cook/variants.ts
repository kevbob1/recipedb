/**
 * THROWAWAY PROTOTYPE — issue #17 "Cook mode step-focus UX" (Map #14).
 * Variant metadata shared by the route and the floating switcher.
 */

export const VARIANTS = [
  { id: "A", slug: "StepFocus" },
  { id: "B", slug: "ScrollSticky" },
  { id: "C", slug: "SplitBoard" },
] as const;

export type CookVariant = (typeof VARIANTS)[number]["id"];
export type VariantMeta = (typeof VARIANTS)[number];

/** ?variant= is case-insensitive; anything unknown falls back to A. */
export function parseVariant(raw: string | null | undefined): CookVariant {
  const wanted = (raw ?? "A").toUpperCase();
  const found = VARIANTS.find((v) => v.id === wanted);
  return found ? found.id : "A";
}

export function metaFor(id: CookVariant): VariantMeta {
  return VARIANTS.find((v) => v.id === id) ?? VARIANTS[0];
}

/** Previous/next variant with wrap-around. */
export function neighbor(id: CookVariant, delta: 1 | -1): CookVariant {
  const current = VARIANTS.findIndex((v) => v.id === id);
  const base = current === -1 ? 0 : current;
  const next = (base + delta + VARIANTS.length) % VARIANTS.length;
  return VARIANTS[next].id;
}
