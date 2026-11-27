import { describe, expect, it, vi } from "vitest";
import { createDraft } from "./import";
import {
  bindPageText,
  joinPageText,
  pageTextSetter,
  reparseFromPages,
  reparseSetter,
  createReviewSavePayload,
  reviewSaveHandler,
  withPageText,
} from "./review-pages";

describe("createReviewSavePayload", () => {
  it("pairs the edited draft with the original recognized snapshot", () => {
    const initial = createDraft({ kind: "scan", text: "Original title" });
    const edited = { ...initial, title: "Edited title" };
    const payload = createReviewSavePayload(initial)(edited);

    expect(payload).toEqual({ draft: edited, recognized: initial });
    expect(payload.draft).toBe(edited);
  });

  it("isolates the snapshot from later initial and returned-payload mutations", () => {
    const initial = createDraft({ kind: "scan", text: "Original title" });
    const buildPayload = createReviewSavePayload(initial);
    initial.title = "Mutated initial";
    const first = buildPayload({ ...initial, title: "Edited" });
    first.recognized.title = "Mutated output";

    expect(buildPayload(initial).recognized.title).toBe("Original title");
  });
});

describe("reviewSaveHandler", () => {
  it("saves the paired payload and signals success", async () => {
    const initial = createDraft({ kind: "scan", text: "Original title" });
    const edited = { ...initial, title: "Edited title" };
    const save = vi.fn(async () => 7);
    const onSaved = vi.fn();
    const handler = reviewSaveHandler(
      createReviewSavePayload(initial),
      save,
      edited,
      onSaved,
    );

    await handler();

    expect(save).toHaveBeenCalledWith(edited, null, { recognized: initial });
    expect(onSaved).toHaveBeenCalledWith(true);
  });

  it("keeps the save error in the save seam without signaling success", async () => {
    const initial = createDraft({ kind: "scan", text: "Original title" });
    const save = vi.fn(async () => {
      throw new Error("Save failed");
    });
    const onSaved = vi.fn();

    await reviewSaveHandler(
      createReviewSavePayload(initial),
      save,
      initial,
      onSaved,
    )();

    expect(onSaved).not.toHaveBeenCalled();
  });
});

describe("joinPageText", () => {
  it("joins page texts with a blank line", () => {
    expect(
      joinPageText([
        { pageNo: 1, imageFilename: null, text: "First page" },
        { pageNo: 2, imageFilename: null, text: "Second page" },
      ]),
    ).toBe("First page\n\nSecond page");
  });
});

describe("withPageText", () => {
  it("replaces only the matching page text and updates raw OCR text", () => {
    const draft = createDraft({
      kind: "scan",
      text: "First page\n\nSecond page",
      pages: [
        { pageNo: 1, imageFilename: "12/page-1.png", text: "First page" },
        { pageNo: 2, imageFilename: null, text: "Second page" },
      ],
    });

    const updated = withPageText(draft, 2, "Edited second page");

    expect(updated.pages).toEqual([
      { pageNo: 1, imageFilename: "12/page-1.png", text: "First page" },
      { pageNo: 2, imageFilename: null, text: "Edited second page" },
    ]);
    expect(updated.rawOcrText).toBe("First page\n\nEdited second page");
  });

  it("sets pages to an empty array when the draft has no pages", () => {
    const draft = createDraft({ kind: "scan", text: "Single page" });

    const updated = withPageText(draft, 1, "Updated text");

    expect(updated.pages).toEqual([]);
    expect(updated.rawOcrText).toBe("");
  });

  it("pageTextSetter updates the draft and synchronized raw OCR text", () => {
    const draft = createDraft({
      kind: "scan",
      text: "First page\n\nSecond page",
      pages: [
        { pageNo: 1, imageFilename: null, text: "First page" },
        { pageNo: 2, imageFilename: null, text: "Second page" },
      ],
    });
    let updated = draft;
    const setDraft = (next: typeof draft) => {
      updated = next;
    };

    pageTextSetter(draft, setDraft)(2, "Edited second page");

    expect(updated).toEqual(withPageText(draft, 2, "Edited second page"));
    expect(updated.rawOcrText).toBe("First page\n\nEdited second page");
  });
});

describe("reparseFromPages", () => {
  it("rebuilds fields from edited page text and retains page provenance", () => {
    const pages = [
      {
        pageNo: 1,
        imageFilename: "12/page-1.png",
        text: "Oat Cookies\nIngredients\n2 cups oats",
      },
      {
        pageNo: 2,
        imageFilename: null,
        text: "Instructions\nBake until golden.",
      },
    ];
    const draft = createDraft({
      kind: "scan",
      text: "Old title\n1 cup old ingredient",
      imageFilename: "12/original.pdf",
      pages,
    });

    const reparsed = reparseFromPages(draft);

    expect(reparsed.title).toBe("Oat Cookies");
    expect(reparsed.ingredients.map((ingredient) => ingredient.text)).toContain(
      "2 cups oats",
    );
    expect(reparsed.rawOcrText).toBe(
      "Oat Cookies\nIngredients\n2 cups oats\n\nInstructions\nBake until golden.",
    );
    expect(reparsed.pages).toEqual(pages);
    expect(reparsed.pages?.map((page) => page.imageFilename)).toEqual([
      "12/page-1.png",
      null,
    ]);
  });

  it("reparseSetter stores the reparsed draft", () => {
    const draft = createDraft({
      kind: "scan",
      text: "Oat Cookies\nIngredients\n2 cups oats",
      pages: [
        {
          pageNo: 1,
          imageFilename: null,
          text: "Oat Cookies\nIngredients\n2 cups oats",
        },
      ],
    });
    let updated = draft;
    const setDraft = (next: typeof draft) => {
      updated = next;
    };

    reparseSetter(draft, setDraft)();

    expect(updated).toEqual(reparseFromPages(draft));
  });
});

describe("bindPageText", () => {
  it("forwards the bound page number and event value", () => {
    const calls: Array<[number, string]> = [];

    bindPageText((pageNo, text) => calls.push([pageNo, text]), 3)({
      target: { value: "Edited page" },
    });

    expect(calls).toEqual([[3, "Edited page"]]);
  });
});
