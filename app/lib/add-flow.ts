/**
 * Add flow orchestration — the client-safe state machine behind /add.
 *
 * UI and browser adapters stay in the route; imports, recognition and
 * persistence enter through dependencies so these commands can run in plain
 * node without React or browser globals at module load time.
 */
import type { RecipeDraft } from "./draft";
import { createDraft, type ImportedDraft } from "./import";
import {
  planBulkBatch,
  runBulkImport,
  summarizeBulkBatch,
  toBulkInputs,
  type BulkFileInput,
  type BulkFileState,
  type BulkRunResult,
  type BulkSummary,
  type RejectedFile,
  type RunBulkImportOptions,
} from "./bulk-import";
import { MAX_SCAN_UPLOAD_BYTES, MAX_SCAN_UPLOAD_MB } from "./scan/limits";

export type AddStep = 1 | 2 | 3 | 4;
export type Entry = "url" | "photo" | "bulk" | "type" | null;
export type PhotoStatus = "idle" | "capturing" | "ocr" | "done" | "error";

export interface AddFlowState {
  step: AddStep;
  entry: Entry;
  draft: RecipeDraft;
  recognized: RecipeDraft | null;
  urlInput: string;
  error: string | null;
  photo: { status: PhotoStatus; file: File | null };
  savedRecipeId: number | null;
  submitInFlight: boolean;
  bulk: {
    states: BulkFileState[];
    rejected: RejectedFile[];
    summary: BulkSummary | null;
    running: boolean;
  };
}

export function initialAddFlowState(): AddFlowState {
  return {
    step: 1,
    entry: null,
    draft: createDraft({ kind: "manual" }),
    recognized: null,
    urlInput: "",
    error: null,
    photo: { status: "idle", file: null },
    savedRecipeId: null,
    submitInFlight: false,
    bulk: { states: [], rejected: [], summary: null, running: false },
  };
}

/** Adapt the flow's recognized snapshot to the save hook's extras object. */
export function persistWithRecognized(
  save: (
    draft: RecipeDraft,
    photoFile: File | null,
    extras?: { recognized?: RecipeDraft | null },
  ) => Promise<number>,
): (
  draft: RecipeDraft,
  photoFile: File | null,
  recognized: RecipeDraft | null,
) => Promise<number> {
  return (draft, photoFile, recognized) =>
    save(draft, photoFile, { recognized });
}

export function chooseEntry(state: AddFlowState, entry: Entry): AddFlowState {
  return {
    ...state,
    entry,
    error: null,
    draft: createDraft({ kind: "manual" }),
    recognized: null,
    bulk: {
      ...state.bulk,
      states: [],
      rejected: [],
      summary: null,
    },
    step: entry === "type" ? 3 : 2,
  };
}

export function setUrlInput(state: AddFlowState, value: string): AddFlowState {
  return { ...state, urlInput: value };
}

export function editDraft(state: AddFlowState, draft: RecipeDraft): AddFlowState {
  return { ...state, draft };
}

export function goBack(state: AddFlowState): AddFlowState {
  if (state.step === 3) return { ...state, step: 2 };
  if (state.step === 2) return { ...state, step: 1 };
  return state;
}

export interface AddFlowActions {
  pickEntry(entry: Entry): void;
  resetBulk(): void;
  setUrlInput(value: string): void;
  editDraft(draft: RecipeDraft): void;
  goBack(): void;
  runUrlImport(): Promise<void>;
  captureAndOcr(file: File): Promise<void>;
  save(): Promise<void>;
  runBulk(files: File[]): Promise<void>;
  restart(): void;
}

export function createAddFlowActions(
  state: AddFlowState,
  setState: (
    next: AddFlowState | ((current: AddFlowState) => AddFlowState),
  ) => void,
  dependencies: {
    fetchUrlImport: (url: string) => Promise<Pick<ImportedDraft, "draft">>;
    recognize: (file: File) => Promise<string>;
    persist: (
      draft: RecipeDraft,
      photoFile: File | null,
      recognized: RecipeDraft | null,
    ) => Promise<number>;
    bulkSeams: AppBulkSeams;
    clearSaveError: () => void;
  },
): AddFlowActions {
  return {
    pickEntry: (entry) => {
      setState((current) => chooseEntry(current, entry));
      dependencies.clearSaveError();
    },
    resetBulk: () => setState((current) => resetBulk(current)),
    setUrlInput: (value) =>
      setState((current) => setUrlInput(current, value)),
    editDraft: (draft) => setState((current) => editDraft(current, draft)),
    goBack: () => setState((current) => goBack(current)),
    runUrlImport: async () => {
      if (state.urlInput.trim()) {
        setState({ ...state, error: null, submitInFlight: true });
      }
      setState(
        await importUrl(state, state.urlInput, {
          fetchUrlImport: dependencies.fetchUrlImport,
        }),
      );
    },
    captureAndOcr: async (file) => {
      if (file.size <= MAX_SCAN_UPLOAD_BYTES) {
        setState({
          ...state,
          error: null,
          photo: { status: "capturing", file },
        });
        setState({
          ...state,
          error: null,
          photo: { status: "ocr", file },
        });
      } else {
        setState({ ...state, error: null });
      }
      setState(
        await recognizePhoto(state, file, {
          recognize: dependencies.recognize,
        }),
      );
    },
    save: async () => {
      setState({ ...state, error: null });
      setState(
        await saveDraft(state, {
          persist: dependencies.persist,
        }),
      );
    },
    runBulk: async (files) => {
      if (state.bulk.running) return;
      dependencies.clearSaveError();
      const batchState = {
        ...state,
        error: null,
        bulk: { ...state.bulk, summary: null },
      };
      setState(batchState);
      const result = await importFiles(
        batchState,
        files,
        dependencies.bulkSeams,
        setState,
      );
      setState(result);
      dependencies.clearSaveError();
    },
    restart: () => {
      setState(restart(state));
      dependencies.clearSaveError();
    },
  };
}

export function resetBulk(state: AddFlowState): AddFlowState {
  return {
    ...state,
    bulk: { ...state.bulk, states: [], rejected: [], summary: null },
  };
}

export function restart(_state: AddFlowState): AddFlowState {
  return initialAddFlowState();
}

export async function importUrl(
  state: AddFlowState,
  url: string,
  dependencies: {
    fetchUrlImport: (url: string) => Promise<Pick<ImportedDraft, "draft">>;
  },
): Promise<AddFlowState> {
  let next: AddFlowState = { ...state, error: null };
  if (!url.trim()) return { ...next, error: "Paste a URL first." };
  next = { ...next, submitInFlight: true };
  try {
    const { draft } = await dependencies.fetchUrlImport(url);
    return {
      ...next,
      draft,
      recognized: structuredClone(draft),
      step: 3,
      submitInFlight: false,
    };
  } catch (error) {
    return {
      ...next,
      error:
        error instanceof Error ? error.message : "Couldn't import that URL.",
      submitInFlight: false,
    };
  }
}

export async function recognizePhoto(
  state: AddFlowState,
  file: File,
  dependencies: { recognize: (file: File) => Promise<string> },
): Promise<AddFlowState> {
  let next: AddFlowState = { ...state, error: null };
  if (file.size > MAX_SCAN_UPLOAD_BYTES) {
    return {
      ...next,
      error: `That image is larger than ${MAX_SCAN_UPLOAD_MB}MB. Retake it or pick a smaller file.`,
    };
  }
  next = {
    ...next,
    photo: { status: "capturing", file },
  };
  try {
    next = { ...next, photo: { ...next.photo, status: "ocr" } };
    const text = await dependencies.recognize(file);
    const draft = createDraft({
      kind: "scan",
      text,
      pages: [{ pageNo: 1, imageFilename: "", text }],
    });
    return {
      ...next,
      draft,
      // The machine's draft is captured before any human edit; the working
      // draft may later be replaced, so this stays the pre-edit echo (ADR-0006).
      recognized: structuredClone(draft),
      photo: { ...next.photo, status: "done" },
      step: 3,
    };
  } catch (error) {
    return {
      ...next,
      photo: { ...next.photo, status: "error" },
      error: error instanceof Error ? error.message : "OCR failed.",
    };
  }
}

export async function saveDraft(
  state: AddFlowState,
  dependencies: {
    persist: (
      draft: RecipeDraft,
      photoFile: File | null,
      recognized: RecipeDraft | null,
    ) => Promise<number>;
  },
): Promise<AddFlowState> {
  const next = { ...state, error: null };
  try {
    return {
      ...next,
      savedRecipeId: await dependencies.persist(
        state.draft,
        state.photo.file,
        state.recognized,
      ),
      step: 4,
    };
  } catch (error) {
    return {
      ...next,
      error: error instanceof Error ? error.message : "Couldn't save.",
    };
  }
}

type AppBulkFiles = BulkFileInput & { file: File };
type AppBulkSeams = Pick<
  RunBulkImportOptions<AppBulkFiles>,
  "recognize" | "ingestPdf" | "save"
>;

export async function importFiles(
  state: AddFlowState,
  files: File[],
  seams: AppBulkSeams,
  onChange?: (state: AddFlowState) => void,
): Promise<AddFlowState> {
  if (state.bulk.running) return state;

  let next: AddFlowState = {
    ...state,
    error: null,
    bulk: { ...state.bulk, summary: null },
  };
  const plan = planBulkBatch(await toBulkInputs(files));
  next = {
    ...next,
    bulk: {
      ...next.bulk,
      states: plan.states,
      rejected: plan.rejected,
    },
  };

  if (plan.accepted.length === 0) {
    return {
      ...next,
      bulk: {
        ...next.bulk,
        summary: summarizeBulkBatch(plan.states, plan.rejected),
      },
    };
  }

  next = { ...next, bulk: { ...next.bulk, running: true } };
  let summary: BulkSummary;
  try {
    const result: BulkRunResult = await runBulkImport({
      plan,
      ...seams,
      onChange: (states) => {
        next = { ...next, bulk: { ...next.bulk, states } };
        onChange?.(next);
      },
    });
    summary = result.summary;
  } finally {
    next = { ...next, bulk: { ...next.bulk, running: false } };
    onChange?.(next);
  }
  return { ...next, bulk: { ...next.bulk, summary } };
}
