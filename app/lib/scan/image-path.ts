import { randomUUID } from "node:crypto";

/**
 * URL-import images are staged under _staging/ at import, then committed to
 * <recipeId>/original.<ext> at first persistence; everything else retained
 * lives recipe-relative.
 */
export function isStagedPath(filename: string): boolean {
  return /^_staging\/[^/]+\.webp$/.test(filename);
}

export function stagedName(): string {
  return `_staging/${randomUUID()}.webp`;
}

export function retainedName(recipeId: number, ext: string): string {
  return `${recipeId}/original.${ext}`;
}

export function isStoredPath(filename: string): boolean {
  return /^\d+\/.+$/.test(filename);
}
