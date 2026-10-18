/**
 * Centralized server env. Resolves once at first read.
 */
export function getPort(): number {
  const raw = process.env.PORT;
  if (!raw) return 3000;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n <= 0 || n > 65535) {
    throw new Error(`PORT must be an integer 1-65535, got: ${raw}`);
  }
  return n;
}

export function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}
