import { describe, expect, it } from "vitest";
import {
  MAX_BULK_FILES,
  bulkProgress,
  fallbackTitleFromName,
  formatBulkHeadline,
  formatFileSize,
  planBulkBatch,
  runBulkImport,
  summarizeBulkBatch,
  updateBulkFile,
  type BulkFileInput,
  type BulkFileState,
} from "./bulk-import";
import { MAX_SCAN_UPLOAD_BYTES } from "./scan/limits";

function input(
  name: string,
  overrides: Partial<BulkFileInput> = {},
): BulkFileInput {
  return { name, size: 1024, type: "image/jpeg", ...overrides };
}

describe("planBulkBatch", () => {
  it("queues every valid image in pick order with stable ids", () => {
    const files = [input("a.jpg"), input("b.png", { type: "image/png" })];
    const plan = planBulkBatch(files);

    expect(plan.states).toEqual([
      { id: "bulk-0", name: "a.jpg", status: "queued" },
      { id: "bulk-1", name: "b.png", status: "queued" },
    ]);
    // The caller maps id -> file to run OCR and upload the original bytes.
    expect(plan.accepted).toEqual([
      { id: "bulk-0", file: files[0] },
      { id: "bulk-1", file: files[1] },
    ]);
    expect(plan.rejected).toEqual([]);
  });

  it("rejects non-image files but keeps the rest of the batch", () => {
    const plan = planBulkBatch([
      input("notes.pdf", { type: "application/pdf" }),
      input("a.jpg"),
    ]);

    expect(plan.states.map((state) => state.name)).toEqual(["a.jpg"]);
    expect(plan.rejected).toEqual([
      {
        name: "notes.pdf",
        code: "not-image",
        message: "notes.pdf isn't an image file.",
      },
    ]);
  });

  it("trusts a pick when the browser reports no mime type", () => {
    const plan = planBulkBatch([input("IMG_0042.HEIC", { type: "" })]);
    expect(plan.states).toHaveLength(1);
    expect(plan.rejected).toEqual([]);
  });

  it("rejects an image over the scan upload ceiling", () => {
    const plan = planBulkBatch([
      input("huge.jpg", { size: MAX_SCAN_UPLOAD_BYTES + 1 }),
      input("fits.jpg", { size: MAX_SCAN_UPLOAD_BYTES }),
    ]);

    expect(plan.states.map((state) => state.name)).toEqual(["fits.jpg"]);
    expect(plan.rejected[0].code).toBe("too-large");
    expect(plan.rejected[0].message).toContain("15MB");
  });

  it("caps the batch and reports the extras as over-limit", () => {
    const files = Array.from({ length: MAX_BULK_FILES + 3 }, (_, i) =>
      input(`photo-${i}.jpg`),
    );
    const plan = planBulkBatch(files);

    expect(plan.states).toHaveLength(MAX_BULK_FILES);
    expect(plan.accepted).toHaveLength(MAX_BULK_FILES);
    expect(plan.rejected.map((file) => file.code)).toEqual([
      "over-limit",
      "over-limit",
      "over-limit",
    ]);
    expect(plan.rejected[0].message).toContain(String(MAX_BULK_FILES));
  });

  it("labels an unnamed pick instead of leaving a blank row", () => {
    const plan = planBulkBatch([input("  ")]);
    expect(plan.states[0].name).toBe("Unnamed image");
  });
});

describe("updateBulkFile", () => {
  const states: BulkFileState[] = [
    { id: "bulk-0", name: "a.jpg", status: "queued" },
    { id: "bulk-1", name: "b.jpg", status: "queued" },
  ];

  it("replaces only the matching file, in place", () => {
    const next = updateBulkFile(states, "bulk-1", { status: "ocr" });

    expect(next.map((state) => state.id)).toEqual(["bulk-0", "bulk-1"]);
    expect(next[0]).toBe(states[0]);
    expect(next[1].status).toBe("ocr");
    // The input is never mutated: React state compares by identity.
    expect(states[1].status).toBe("queued");
  });

  it("keeps the recipe id only while done and the error only while failed", () => {
    const done = updateBulkFile(states, "bulk-0", {
      status: "done",
      recipeId: 42,
      error: "stale",
    });
    expect(done[0]).toEqual({
      id: "bulk-0",
      name: "a.jpg",
      status: "done",
      recipeId: 42,
    });

    const failed = updateBulkFile(done, "bulk-0", {
      status: "error",
      error: "OCR failed.",
    });
    expect(failed[0]).toEqual({
      id: "bulk-0",
      name: "a.jpg",
      status: "error",
      error: "OCR failed.",
    });
  });

  it("ignores an id that isn't in the batch", () => {
    expect(updateBulkFile(states, "nope", { status: "ocr" })).toEqual(states);
  });
});

describe("bulkProgress", () => {
  it("counts only finished files", () => {
    const states: BulkFileState[] = [
      { id: "bulk-0", name: "a.jpg", status: "queued" },
      { id: "bulk-1", name: "b.jpg", status: "ocr" },
      { id: "bulk-2", name: "c.jpg", status: "saving" },
      { id: "bulk-3", name: "d.jpg", status: "done", recipeId: 1 },
      { id: "bulk-4", name: "e.jpg", status: "error", error: "boom" },
    ];

    expect(bulkProgress(states)).toEqual({ total: 5, finished: 2 });
  });
});

describe("summarizeBulkBatch", () => {
  it("reports saved recipes with ids and every failure by name", () => {
    const states: BulkFileState[] = [
      { id: "bulk-0", name: "a.jpg", status: "done", recipeId: 7 },
      { id: "bulk-1", name: "b.jpg", status: "error", error: "OCR failed." },
    ];
    const rejected = [
      {
        name: "notes.pdf",
        code: "not-image" as const,
        message: "notes.pdf isn't an image file.",
      },
    ];

    const summary = summarizeBulkBatch(states, rejected);

    expect(summary).toEqual({
      total: 3,
      saved: 1,
      failed: 2,
      savedRecipes: [{ name: "a.jpg", recipeId: 7 }],
      failures: [
        { name: "notes.pdf", error: "notes.pdf isn't an image file." },
        { name: "b.jpg", error: "OCR failed." },
      ],
    });
    expect(formatBulkHeadline(summary)).toBe("1 saved, 2 failed");
  });

  it("falls back to a generic failure message", () => {
    const summary = summarizeBulkBatch([
      { id: "bulk-0", name: "a.jpg", status: "error" },
    ]);
    expect(summary.failures).toEqual([
      { name: "a.jpg", error: "Import failed." },
    ]);
    expect(formatBulkHeadline(summary)).toBe("0 saved, 1 failed");
  });
});

describe("formatFileSize", () => {
  it("scales bytes to KB and MB", () => {
    expect(formatFileSize(900)).toBe("900 B");
    expect(formatFileSize(2048)).toBe("2 KB");
    expect(formatFileSize(1.5 * 1024 * 1024)).toBe("1.5 MB");
  });
});

describe("fallbackTitleFromName", () => {  it("turns a filename stem into a readable title", () => {
    expect(fallbackTitleFromName("grandma_apple-pie.jpg")).toBe(
      "grandma apple pie",
    );
    expect(fallbackTitleFromName("/tmp/batch/IMG_0042.HEIC")).toBe("IMG 0042");
    expect(fallbackTitleFromName("scan.tar.gz")).toBe("scan.tar");
  });

  it("never returns an empty title", () => {
    expect(fallbackTitleFromName(".jpg")).toBe("Untitled recipe");
    expect(fallbackTitleFromName("")).toBe("Untitled recipe");
  });
});

describe("runBulkImport", () => {
  const files = [input("one.jpg"), input("two.jpg"), input("three.jpg")];

  function makePlan() {
    return planBulkBatch(files);
  }

  it("recognizes and saves sequentially, emitting every transition", async () => {
    const plan = makePlan();
    const events: string[] = [];
    const texts = ["Chocolate cake", "Sourdough bread", "Tomato soup"];
    let nextId = 100;

    const result = await runBulkImport({
      plan,
      recognize: async (file) => {
        events.push(`ocr:${file.name}`);
        return texts[files.indexOf(file)];
      },
      save: async (draft) => {
        events.push(`save:${draft.title}`);
        return nextId++;
      },
      onChange: (states) =>
        events.push(
          states.map((state) => `${state.name}:${state.status}`).join("|"),
        ),
    });

    // Work interleaves with state updates: no file's save starts before the
    // previous file finishes.
    expect(events.filter((event) => !event.includes("|"))).toEqual([
      "ocr:one.jpg",
      "save:Chocolate cake",
      "ocr:two.jpg",
      "save:Sourdough bread",
      "ocr:three.jpg",
      "save:Tomato soup",
    ]);
    expect(result.states.map((state) => state.status)).toEqual([
      "done",
      "done",
      "done",
    ]);
    expect(result.states.map((state) => state.recipeId)).toEqual([
      100, 101, 102,
    ]);
    expect(result.summary).toEqual({
      total: 3,
      saved: 3,
      failed: 0,
      savedRecipes: [
        { name: "one.jpg", recipeId: 100 },
        { name: "two.jpg", recipeId: 101 },
        { name: "three.jpg", recipeId: 102 },
      ],
      failures: [],
    });
  });

  it("records a failure and keeps going with the rest of the batch", async () => {
    const plan = makePlan();
    const saved: string[] = [];

    const result = await runBulkImport({
      plan,
      recognize: async (file) => {
        if (file.name === "two.jpg") throw new Error("OCR engine exploded");
        return `Recipe ${file.name}`;
      },
      save: async (draft) => {
        saved.push(draft.title);
        return saved.length;
      },
    });

    expect(saved).toEqual(["Recipe one.jpg", "Recipe three.jpg"]);
    expect(result.states[1]).toEqual({
      id: "bulk-1",
      name: "two.jpg",
      status: "error",
      error: "OCR engine exploded",
    });
    expect(result.summary.saved).toBe(2);
    expect(result.summary.failed).toBe(1);
    expect(result.summary.failures).toEqual([
      { name: "two.jpg", error: "OCR engine exploded" },
    ]);
  });

  it("does not save a draft when OCR failed", async () => {
    const plan = planBulkBatch([input("broken.jpg")]);
    let saveCalls = 0;

    const result = await runBulkImport({
      plan,
      recognize: async () => {
        throw new Error("no text");
      },
      save: async () => {
        saveCalls += 1;
        return 1;
      },
    });

    expect(saveCalls).toBe(0);
    expect(result.states[0].status).toBe("error");
  });

  it("treats a save failure as that file's failure", async () => {
    const plan = planBulkBatch([input("a.jpg"), input("b.jpg")]);

    const result = await runBulkImport({
      plan,
      recognize: async (file) => `Recipe ${file.name}`,
      save: async (_draft, file) => {
        if (file.name === "a.jpg") throw new Error("Couldn't save.");
        return 9;
      },
    });

    expect(result.states.map((state) => state.status)).toEqual([
      "error",
      "done",
    ]);
    expect(result.summary.failures).toEqual([
      { name: "a.jpg", error: "Couldn't save." },
    ]);
  });

  it("keeps a scan draft with a filename title when OCR finds nothing", async () => {
    const plan = planBulkBatch([input("family_lasagna.png")]);
    let captured: {
      title: string;
      sourceType: string;
      rawOcrText: string | null;
    } | null = null;

    const result = await runBulkImport({
      plan,
      recognize: async () => "",
      save: async (draft) => {
        captured = {
          title: draft.title,
          sourceType: draft.sourceType,
          rawOcrText: draft.rawOcrText,
        };
        return 3;
      },
    });

    expect(captured).toEqual({
      title: "family lasagna",
      sourceType: "scan",
      rawOcrText: "",
    });
    expect(result.states[0].status).toBe("done");
  });

  it("keeps OCR'd titles and scan provenance untouched", async () => {
    const plan = planBulkBatch([input("scan.jpg")]);
    let title = "";
    let confidence: string | null = "";

    await runBulkImport({
      plan,
      recognize: async () => "Lemon drizzle cake\n2 eggs",
      save: async (draft) => {
        title = draft.title;
        confidence = draft.titleConfidence;
        return 5;
      },
    });

    expect(title).toBe("Lemon drizzle cake");
    expect(confidence).toBe("warn");
  });

  it("reports up-front rejections in the summary without running them", async () => {
    const plan = planBulkBatch([
      input("ok.jpg"),
      input("bad.pdf", { type: "application/pdf" }),
    ]);
    const recognized: string[] = [];

    const result = await runBulkImport({
      plan,
      recognize: async (file) => {
        recognized.push(file.name);
        return "Something";
      },
      save: async () => 1,
    });

    expect(recognized).toEqual(["ok.jpg"]);
    expect(result.summary).toEqual({
      total: 2,
      saved: 1,
      failed: 1,
      savedRecipes: [{ name: "ok.jpg", recipeId: 1 }],
      failures: [{ name: "bad.pdf", error: "bad.pdf isn't an image file." }],
    });
  });

  it("does nothing for an empty plan", async () => {
    const result = await runBulkImport({
      plan: planBulkBatch([]),
      recognize: async () => "never",
      save: async () => 1,
    });

    expect(result.states).toEqual([]);
    expect(result.summary.saved).toBe(0);
  });

  it("reports a non-Error rejection with a generic message", async () => {
    const plan = planBulkBatch([input("a.jpg")]);
    const result = await runBulkImport({
      plan,
      recognize: async () => {
        throw "nope";
      },
      save: async () => 1,
    });

    expect(result.states[0].error).toBe("Import failed.");
  });
});
