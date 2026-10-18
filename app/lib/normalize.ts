/**
 * Trim-only normalizer (ticket #3).
 *
 * Centralized so every path that mutates user-facing text — review edits, URL
 * imports, OCR imports — applies the same rule: whitespace only, never
 * content. See GLOSSARY.md ("Auto-normalization at review is trim-only:
 * whitespace, never content.").
 */

export function trimOnly(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function trimOnlyRequired(value: string | null | undefined): string {
  return trimOnly(value) ?? "";
}

/** Lowercase + trim a tag label. Tags are stored case-insensitively. */
export function normalizeTag(label: string): string {
  return label.trim().toLowerCase();
}
