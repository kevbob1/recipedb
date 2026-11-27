import { describe, expect, it } from "vitest";
import {
  isStagedPath,
  isStoredPath,
  retainedName,
  stagedName,
} from "./image-path";

describe("image path contract", () => {
  it("recognizes staged WebP import paths only", () => {
    expect(isStagedPath("_staging/abc-123.webp")).toBe(true);
    expect(isStagedPath("_staging/.webp")).toBe(false);
    expect(isStagedPath("42/original.webp")).toBe(false);
    expect(isStagedPath("_staging/abc.jpg")).toBe(false);
    expect(isStagedPath("_staging/nested/abc.webp")).toBe(false);
  });

  it("creates fresh staged WebP paths", () => {
    const first = stagedName();
    const second = stagedName();

    expect(first).toMatch(/^_staging\/[0-9a-f-]+\.webp$/i);
    expect(second).toMatch(/^_staging\/[0-9a-f-]+\.webp$/i);
    expect(second).not.toBe(first);
  });

  it("builds recipe-relative retained names", () => {
    expect(retainedName(42, "webp")).toBe("42/original.webp");
    expect(retainedName(7, "jpg")).toBe("7/original.jpg");
  });

  it("recognizes recipe-relative stored paths", () => {
    expect(isStoredPath("42/original.webp")).toBe(true);
    expect(isStoredPath("7/page-1.png")).toBe(true);
    expect(isStoredPath("42/")).toBe(false);
    expect(isStoredPath("original.webp")).toBe(false);
    expect(isStoredPath("_staging/abc.webp")).toBe(false);
    expect(isStoredPath("42/../secret.png")).toBe(false);
    expect(isStoredPath("42/nested/../../secret.png")).toBe(false);
    expect(isStoredPath("42\\secret.png")).toBe(false);
    expect(isStoredPath("42/pages/page-1.png")).toBe(true);
  });
});
