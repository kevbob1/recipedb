import { describe, expect, it, vi } from "vitest";
import {
  chooseEntry,
  createAddFlowActions,
  editDraft,
  goBack,
  importFiles,
  importUrl,
  initialAddFlowState,
  persistWithRecognized,
  recognizePhoto,
  resetBulk,
  restart,
  saveDraft,
  setUrlInput,
} from "./add-flow";
import type { RecipeDraft } from "./draft";
import type { RunBulkImportOptions } from "./bulk-import";
import { MAX_SCAN_UPLOAD_BYTES } from "./scan/limits";

function image(name: string, type = "image/jpeg"): File {
  return new File(["image bytes"], name, { type });
}

describe("persistWithRecognized", () => {
  it("passes the recognized snapshot as save extras", async () => {
    const draft = initialAddFlowState().draft;
    const recognized = { ...draft, title: "Recognized" };
    const save = vi.fn(async () => 17);

    await expect(
      persistWithRecognized(save)(draft, null, recognized),
    ).resolves.toBe(17);

    expect(save).toHaveBeenCalledWith(draft, null, { recognized });
  });
});

function bulkSeams(
  overrides: Partial<
    Pick<RunBulkImportOptions<{ name: string; size: number; type: string; file: File }>, "recognize" | "ingestPdf" | "save">
  > = {},
): Pick<
  RunBulkImportOptions<{ name: string; size: number; type: string; file: File }>,
  "recognize" | "ingestPdf" | "save"
> {
  return {
    recognize: async (pick) => `Recipe ${pick.file.name}`,
    ingestPdf: async () => [],
    save: async (_draft, pick) => pick.file.name.length,
    ...overrides,
  };
}

describe("Add flow state transitions", () => {
  it("chooses each entry and sends type directly to review", () => {
    const initial = initialAddFlowState();

    for (const entry of ["url", "photo", "bulk"] as const) {
      expect(chooseEntry(initial, entry)).toMatchObject({ entry, step: 2 });
    }
    expect(chooseEntry(initial, "type")).toMatchObject({
      entry: "type",
      step: 3,
      draft: { sourceType: "manual" },
    });
  });

  it("updates URL and draft through pure transitions", () => {
    const state = initialAddFlowState();
    const draft = { ...state.draft, title: "Edited" };

    expect(setUrlInput(state, " https://example.test ")).toMatchObject({
      urlInput: " https://example.test ",
    });
    expect(editDraft(state, draft).draft).toBe(draft);
  });

  it("goes back without clearing flow data and restart resets everything", () => {
    const state = {
      ...chooseEntry(initialAddFlowState(), "photo"),
      step: 3 as const,
      urlInput: "kept",
      error: "kept error",
      savedRecipeId: 42,
    };
    const backed = goBack(state);

    expect(backed).toMatchObject({
      step: 2,
      entry: "photo",
      urlInput: "kept",
      error: "kept error",
      savedRecipeId: 42,
    });
    expect(goBack(backed)).toMatchObject({ step: 1, entry: "photo" });
    expect(restart(state)).toEqual(initialAddFlowState());
  });

  it("clears bulk rows and summary while retaining the running flag", () => {
    const state = initialAddFlowState();
    state.bulk.running = true;
    state.bulk.states = [{ id: "x", name: "x", status: "queued" }];
    expect(resetBulk(state).bulk).toEqual({
      states: [],
      rejected: [],
      summary: null,
      running: true,
    });
  });
});

describe("Add flow commands", () => {
  it("imports a URL successfully and reports empty or failed input", async () => {
    const state = setUrlInput(chooseEntry(initialAddFlowState(), "url"), "https://recipe.test");
    const draft = { ...state.draft, title: "From URL" };
    const fetchUrlImport = vi.fn(async () => ({ draft }));

    await expect(importUrl(state, state.urlInput, { fetchUrlImport })).resolves.toMatchObject({
      step: 3,
      draft,
      error: null,
      submitInFlight: false,
    });
    expect(fetchUrlImport).toHaveBeenCalledWith("https://recipe.test");
    await expect(
      importUrl(state, " ", { fetchUrlImport }),
    ).resolves.toMatchObject({ error: "Paste a URL first.", submitInFlight: false });
    await expect(
      importUrl(state, "bad", {
        fetchUrlImport: async () => {
          throw new Error("Import rejected");
        },
      }),
    ).resolves.toMatchObject({ error: "Import rejected", submitInFlight: false });
  });

  it("rejects an oversized photo without recognition", async () => {
    const file = new File([new Uint8Array(MAX_SCAN_UPLOAD_BYTES + 1)], "large.jpg");
    const recognize = vi.fn(async () => "unused");

    await expect(
      recognizePhoto(initialAddFlowState(), file, { recognize }),
    ).resolves.toMatchObject({
      error: "That image is larger than 15MB. Retake it or pick a smaller file.",
      photo: { status: "idle", file: null },
    });
    expect(recognize).not.toHaveBeenCalled();
  });

  it("records OCR failure and produces a one-page scan draft on success", async () => {
    const file = image("capture.png");
    const initial = chooseEntry(initialAddFlowState(), "photo");
    await expect(
      recognizePhoto(initial, file, {
        recognize: async () => {
          throw new Error("OCR unavailable");
        },
      }),
    ).resolves.toMatchObject({
      step: 2,
      photo: { status: "error", file },
      error: "OCR unavailable",
    });

    const text = "Pancakes\n2 cups flour";
    const result = await recognizePhoto(initial, file, {
      recognize: async () => text,
    });
    expect(result).toMatchObject({
      step: 3,
      photo: { status: "done", file },
      draft: {
        sourceType: "scan",
        rawOcrText: text,
        pages: [{ pageNo: 1, imageFilename: null, text }],
      },
    });
    expect(result.recognized).toEqual(result.draft);
    expect(result.recognized).not.toBe(result.draft);
  });

  it("keeps an imported snapshot isolated from edits and sends it with the save", async () => {
    const original = {
      ...initialAddFlowState().draft,
      title: "Recognized title",
      tags: ["recognized"],
    };
    const imported = await importUrl(initialAddFlowState(), "https://recipe.test", {
      fetchUrlImport: async () => ({ draft: original }),
    });
    const working = { ...imported.draft, tags: ["edited"] };
    const edited = editDraft(imported, working);
    const persist = vi.fn(async () => 81);

    expect(edited.recognized?.tags).toEqual(["recognized"]);
    expect(edited.recognized).not.toBe(edited.draft);
    await saveDraft(edited, { persist });

    expect(persist).toHaveBeenCalledWith(edited.draft, null, edited.recognized);
  });

  it("omits recognized data for manual saves and turns failures into errors", async () => {
    const state = initialAddFlowState();
    const persist = vi.fn(async (_draft: RecipeDraft, photoFile: File | null, recognized) => {
      expect(photoFile).toBeNull();
      expect(recognized).toBeNull();
      return 81;
    });
    await expect(saveDraft(state, { persist })).resolves.toMatchObject({
      step: 4,
      savedRecipeId: 81,
      error: null,
    });

    await expect(
      saveDraft(state, {
        persist: async () => {
          throw new Error("Save failed");
        },
      }),
    ).resolves.toMatchObject({ step: 1, savedRecipeId: null, error: "Save failed" });
  });

  it("summarizes an all-rejected batch without entering the running state", async () => {
    const result = await importFiles(
      initialAddFlowState(),
      [image("notes.txt", "text/plain")],
      bulkSeams(),
    );

    expect(result.bulk).toMatchObject({
      running: false,
      states: [],
      rejected: [{ name: "notes.txt", code: "not-image" }],
      summary: { total: 1 },
    });
  });

  it("mirrors running status and isolates a row failure while continuing the batch", async () => {
    const callbacks: Array<ReturnType<typeof initialAddFlowState>> = [];
    const result = await importFiles(
      initialAddFlowState(),
      [image("broken.jpg"), image("good.jpg")],
      bulkSeams({
        recognize: async (pick) => {
          if (pick.file.name === "broken.jpg") throw new Error("Unreadable");
          return "Good recipe";
        },
      }),
      (state) => callbacks.push(state),
    );

    expect(callbacks.some((state) => state.bulk.running)).toBe(true);
    expect(callbacks.at(-1)?.bulk.running).toBe(false);
    expect(result.bulk).toMatchObject({
      running: false,
      states: [
        { name: "broken.jpg", status: "error", error: "Unreadable" },
        { name: "good.jpg", status: "done", recipeId: 8 },
      ],
      summary: { failures: [{ name: "broken.jpg", error: "Unreadable" }] },
    });
  });
});

describe("Add flow action bindings", () => {
  it("binds all UI actions to the current state and injected seams", async () => {
    let state = initialAddFlowState();
    const clearSaveError = vi.fn();
    const setState = (
      next:
        | ReturnType<typeof initialAddFlowState>
        | ((
            current: ReturnType<typeof initialAddFlowState>,
          ) => ReturnType<typeof initialAddFlowState>),
    ) => {
      state = typeof next === "function" ? next(state) : next;
    };
    const dependencies = {
      fetchUrlImport: async () => ({
        draft: { ...initialAddFlowState().draft, title: "Imported" },
      }),
      recognize: async () => "Recognized",
      persist: async () => 23,
      bulkSeams: bulkSeams(),
      clearSaveError,
    };
    const actions = () =>
      createAddFlowActions(state, setState, dependencies);

    actions().pickEntry("url");
    actions().setUrlInput("https://recipe.test");
    await actions().runUrlImport();
    expect(state).toMatchObject({ step: 3, draft: { title: "Imported" } });

    actions().editDraft({ ...state.draft, title: "Changed" });
    actions().goBack();
    expect(state).toMatchObject({ step: 2, draft: { title: "Changed" } });

    const capture = image("capture.jpg");
    await actions().captureAndOcr(capture);
    expect(state).toMatchObject({
      step: 3,
      photo: { status: "done", file: capture },
    });
    await actions().save();
    expect(state).toMatchObject({ step: 4, savedRecipeId: 23 });

    await actions().runBulk([image("one.jpg")]);
    expect(state.bulk.summary).not.toBeNull();
    actions().resetBulk();
    expect(state.bulk).toMatchObject({ states: [], rejected: [], summary: null });
    actions().restart();
    expect(state).toEqual(initialAddFlowState());
    expect(clearSaveError).toHaveBeenCalled();
  });

  it("does not start another batch while the snapshot is already running", async () => {
    const state = initialAddFlowState();
    state.bulk.running = true;
    const setState = vi.fn();
    const seams = bulkSeams();
    const actions = createAddFlowActions(state, setState, {
      fetchUrlImport: async () => ({ draft: state.draft }),
      recognize: async () => "",
      persist: async () => 1,
      bulkSeams: seams,
      clearSaveError: vi.fn(),
    });

    await actions.runBulk([image("ignored.jpg")]);
    expect(setState).not.toHaveBeenCalled();
  });

  it("exposes URL and photo in-flight state before injected work resolves", async () => {
    let state = setUrlInput(chooseEntry(initialAddFlowState(), "url"), "https://recipe.test");
    let resolveImport: ((result: { draft: RecipeDraft }) => void) | undefined;
    let resolveRecognition: ((text: string) => void) | undefined;
    const setState = (
      next:
        | ReturnType<typeof initialAddFlowState>
        | ((
            current: ReturnType<typeof initialAddFlowState>,
          ) => ReturnType<typeof initialAddFlowState>),
    ) => {
      state = typeof next === "function" ? next(state) : next;
    };
    const dependencies = {
      fetchUrlImport: () =>
        new Promise<{ draft: RecipeDraft }>((resolve) => {
          resolveImport = resolve;
        }),
      recognize: () =>
        new Promise<string>((resolve) => {
          resolveRecognition = resolve;
        }),
      persist: async () => 1,
      bulkSeams: bulkSeams(),
      clearSaveError: vi.fn(),
    };

    const urlImport = createAddFlowActions(state, setState, dependencies).runUrlImport();
    expect(state.submitInFlight).toBe(true);
    resolveImport?.({ draft: state.draft });
    await urlImport;
    expect(state.submitInFlight).toBe(false);

    const photo = image("capture.jpg");
    const photoRecognition = createAddFlowActions(state, setState, dependencies)
      .captureAndOcr(photo);
    expect(state.photo).toEqual({ status: "ocr", file: photo });
    resolveRecognition?.("Recognized");
    await photoRecognition;
    expect(state.photo).toEqual({ status: "done", file: photo });
  });
});
