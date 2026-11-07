/**
 * Bulk import — many photos in, many auto-saved recipes out.
 *
 * The Add flow's single-photo path (#5, #28) stops at the review screen and
 * saves one draft. This module is the batch variant: the person picks N images,
 * each is OCR'd in this tab and saved immediately as its own draft — no
 * per-recipe review. Everything here is client-safe and DOM-free so the queue
 * rules (validation, status transitions, summary) can be tested without a
 * browser.
 *
 * Seam: this module owns the BATCH and nothing else. Recognition is
 * ./ocr.ts (`recognizeText`), draft construction is the one Draft factory in
 * ./import.ts (`createDraft({ kind: "scan" })`, ADR-0002), and persistence is
 * the save seam (`useSaveDraft`). It never re-implements any of those: the
 * caller injects `recognize` and `save`, which also keeps the runner testable
 * with fakes.
 *
 * Sequential on purpose. tesseract.js is a WASM engine with one worker per
 * `recognizeText` call; running a batch in parallel would spin up a worker per
 * image and contend for CPU, which on a phone makes every OCR slower. One at a
 * time also means the save order matches the pick order.
 */

import type { RecipeDraft } from "./draft";
import { createDraft } from "./import";
import { MAX_SCAN_UPLOAD_BYTES, MAX_SCAN_UPLOAD_MB } from "./scan/limits";

/**
 * How many images one batch may contain. Above this the extras are rejected up
 * front rather than queued: a single tesseract worker per image makes a large
 * batch a long, uncancellable wait on a phone.
 */
export const MAX_BULK_FILES = 20;

/** The shape validation needs from a picked file — no DOM `File` required. */
export interface BulkFileInput {
  name: string;
  size: number;
  type: string;
}

/** Where one image is in the batch. Ordered: queued -> ocr -> saving -> done. */
export type BulkFileStatus = "queued" | "ocr" | "saving" | "done" | "error";

/** Per-image state the UI renders. `id` is stable for the life of the batch. */
export interface BulkFileState {
  id: string;
  name: string;
  status: BulkFileStatus;
  /** Set once a save succeeds. */
  recipeId?: number;
  /** Set when OCR or save fails; safe to show. */
  error?: string;
}

/** A picked file plus its batch id, so the caller can map back to the bytes. */
export interface BulkAcceptedFile<T extends BulkFileInput> {
  id: string;
  file: T;
}

/** Why a picked file never entered the queue. */
export type BulkRejectionCode = "too-large" | "not-image" | "over-limit";

export interface RejectedFile {
  name: string;
  code: BulkRejectionCode;
  /** Safe to show to the person; includes the file name. */
  message: string;
}

/** The queue a pick produces: what will run, and what was refused up front. */
export interface BulkPlan<T extends BulkFileInput = BulkFileInput> {
  /** One entry per accepted file, in pick order, all `queued`. */
  states: BulkFileState[];
  /** `id` -> the picked file, in pick order. */
  accepted: BulkAcceptedFile<T>[];
  rejected: RejectedFile[];
}

function labelFor(file: BulkFileInput): string {
  return file.name.trim() || "Unnamed image";
}

function isImageType(type: string | undefined): boolean {
  // Some browsers report an empty type for camera/HEIC files; the file input
  // already filters on accept="image/*", so trust the pick rather than block it.
  const normalized = (type ?? "").toLowerCase();
  return normalized === "" || normalized.startsWith("image/");
}

/**
 * Validate a picked list and turn it into a queue. Pure: no reading, no
 * OCR. A rejection never stops the rest of the batch — the caller shows them
 * in the closing summary.
 */
export function planBulkBatch<T extends BulkFileInput>(
  files: readonly T[],
): BulkPlan<T> {
  const plan: BulkPlan<T> = { states: [], accepted: [], rejected: [] };

  files.forEach((file, index) => {
    const name = labelFor(file);

    if (index >= MAX_BULK_FILES) {
      plan.rejected.push({
        name,
        code: "over-limit",
        message: `Only ${MAX_BULK_FILES} images per batch — ${name} was skipped.`,
      });
      return;
    }
    if (!isImageType(file.type)) {
      plan.rejected.push({
        name,
        code: "not-image",
        message: `${name} isn't an image file.`,
      });
      return;
    }
    if (file.size > MAX_SCAN_UPLOAD_BYTES) {
      plan.rejected.push({
        name,
        code: "too-large",
        message: `${name} is larger than ${MAX_SCAN_UPLOAD_MB}MB.`,
      });
      return;
    }

    const id = `bulk-${index}`;
    plan.states.push({ id, name, status: "queued" });
    plan.accepted.push({ id, file });
  });

  return plan;
}

export type BulkFilePatch = Partial<
  Pick<BulkFileState, "status" | "recipeId" | "error">
>;

/**
 * Apply one transition to one file, returning a new array in the same order.
 * Transitions are forward-only in practice; this only merges, and keeps the
 * state clean by dropping `error` outside `error` and `recipeId` outside `done`.
 */
export function updateBulkFile(
  states: readonly BulkFileState[],
  id: string,
  patch: BulkFilePatch,
): BulkFileState[] {
  return states.map((state) => {
    if (state.id !== id) return state;
    const next: BulkFileState = { ...state, ...patch };
    const status = next.status;
    if (status !== "error") delete next.error;
    if (status !== "done") delete next.recipeId;
    return next;
  });
}

/** How far the batch has got, for a progress line. */
export function bulkProgress(states: readonly BulkFileState[]): {
  total: number;
  finished: number;
} {
  const total = states.length;
  const finished = states.filter(
    (state) => state.status === "done" || state.status === "error",
  ).length;
  return { total, finished };
}

/** The closing report: what got saved (with links) and what didn't. */
export interface BulkSummary {
  /** Accepted files plus up-front rejections. */
  total: number;
  saved: number;
  failed: number;
  savedRecipes: Array<{ name: string; recipeId: number | null }>;
  /** Every failure, validation included, in pick order. */
  failures: Array<{ name: string; error: string }>;
}

export function summarizeBulkBatch(
  states: readonly BulkFileState[],
  rejected: readonly RejectedFile[] = [],
): BulkSummary {
  const savedRecipes = states
    .filter((state) => state.status === "done")
    .map((state) => ({ name: state.name, recipeId: state.recipeId ?? null }));

  const failures = [
    ...rejected.map((file) => ({ name: file.name, error: file.message })),
    ...states
      .filter((state) => state.status === "error")
      .map((state) => ({
        name: state.name,
        error: state.error ?? "Import failed.",
      })),
  ];

  return {
    total: states.length + rejected.length,
    saved: savedRecipes.length,
    failed: failures.length,
    savedRecipes,
    failures,
  };
}

/** One-line closing headline, e.g. "5 saved, 2 failed". */
export function formatBulkHeadline(summary: BulkSummary): string {
  const saved = `${summary.saved} saved`;
  return summary.failed > 0 ? `${saved}, ${summary.failed} failed` : saved;
}

/** Compact size for the pre-run file list ("1.2 MB"). */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * A suggested title when OCR found nothing usable. The server refuses a draft
 * with no title (`title-required`), and bulk import has no review step where a
 * person could type one, so a filename-derived title keeps the recipe.
 */
export function fallbackTitleFromName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const withoutExtension = base.replace(/\.[^.]+$/, "");
  const spaced = withoutExtension.replace(/[_-]+/g, " ").trim();
  return spaced || "Untitled recipe";
}

function failureMessage(err: unknown): string {
  if (err instanceof Error && err.message.trim()) return err.message;
  return "Import failed.";
}

export interface RunBulkImportOptions<T extends BulkFileInput> {
  plan: BulkPlan<T>;
  /** OCR one image. In the app: `recognizeText`. */
  recognize: (file: T) => Promise<string>;
  /** Persist one draft (and its original bytes). In the app: `useSaveDraft`. */
  save: (draft: RecipeDraft, file: T) => Promise<number>;
  /** Called with a fresh array after every transition, for React state. */
  onChange?: (states: BulkFileState[]) => void;
}

export interface BulkRunResult {
  states: BulkFileState[];
  summary: BulkSummary;
}

/**
 * Run the queue: recognize -> draft -> save, one image at a time. A failure is
 * recorded on that image and the batch continues; the returned summary accounts
 * for every picked file, rejections included.
 */
export async function runBulkImport<T extends BulkFileInput>(
  options: RunBulkImportOptions<T>,
): Promise<BulkRunResult> {
  let states = options.plan.states;
  const emit = () => options.onChange?.([...states]);

  emit();

  for (const { id, file } of options.plan.accepted) {
    states = updateBulkFile(states, id, { status: "ocr" });
    emit();

    try {
      const text = await options.recognize(file);
      // The one Draft factory (ADR-0002) stamps scan provenance and confidence.
      const draft = createDraft({ kind: "scan", text });
      if (!draft.title.trim()) {
        draft.title = fallbackTitleFromName(file.name);
        draft.titleConfidence = "warn";
      }

      states = updateBulkFile(states, id, { status: "saving" });
      emit();

      const recipeId = await options.save(draft, file);
      states = updateBulkFile(states, id, { status: "done", recipeId });
    } catch (err) {
      states = updateBulkFile(states, id, {
        status: "error",
        error: failureMessage(err),
      });
    }
    emit();
  }

  return {
    states,
    summary: summarizeBulkBatch(states, options.plan.rejected),
  };
}
