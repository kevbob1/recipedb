/**
 * Scan limits — the one definition of the upload ceiling.
 *
 * This lives outside ./storage.server.ts (which owns enforcement and re-exports
 * it as part of its public surface) because the Add flow's browser-side
 * pre-check and the server-side validator must agree on one number, and the
 * browser cannot import the fs/DB stack that storage.server.ts pulls in.
 * Import this module, never a literal: a second copy of the ceiling is exactly
 * the drift this module exists to prevent.
 */

/** Upload ceiling for a scan capture (~15MB). */
export const MAX_SCAN_UPLOAD_BYTES = 15 * 1024 * 1024;

/** The same ceiling in whole megabytes, for user-facing messages. */
export const MAX_SCAN_UPLOAD_MB = MAX_SCAN_UPLOAD_BYTES / (1024 * 1024);
