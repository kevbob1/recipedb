import { describe, expect, it } from "vitest";
import { blankDraft } from "./draft";
import { parseSaveBody } from "./save-draft-http.server";

describe("parseSaveBody recognized snapshots", () => {
  it("reads recognized from JSON and preserves omission", async () => {
    const draft = { ...blankDraft(), title: "Saved" };
    const recognized = { ...blankDraft(), title: "Recognized" };
    const parsed = await parseSaveBody(
      new Request("http://localhost/api/save-draft", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ draft, recognized }),
      }),
    );
    expect(parsed).toMatchObject({ kind: "new", draft, recognized });

    const omitted = await parseSaveBody(
      new Request("http://localhost/api/save-draft", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ draft }),
      }),
    );
    expect(omitted).toMatchObject({ kind: "new", draft });
    expect("recognized" in omitted && omitted.recognized).toBe(false);
  });

  it("reads recognized from multipart and rejects malformed values", async () => {
    const draft = { ...blankDraft(), title: "Saved" };
    const recognized = { ...blankDraft(), title: "Recognized" };
    const form = new FormData();
    form.set("draft", JSON.stringify(draft));
    form.set("recognized", JSON.stringify(recognized));
    const parsed = await parseSaveBody(
      new Request("http://localhost/api/save-draft", {
        method: "POST",
        body: form,
      }),
    );
    expect(parsed).toMatchObject({
      kind: "new",
      draft: JSON.stringify(draft),
      recognized,
    });

    form.set("recognized", "{not json");
    const malformed = await parseSaveBody(
      new Request("http://localhost/api/save-draft", {
        method: "POST",
        body: form,
      }),
    );
    expect("error" in malformed && malformed.error.status).toBe(400);
  });

  it("rejects malformed JSON recognized snapshots", async () => {
    const parsed = await parseSaveBody(
      new Request("http://localhost/api/save-draft", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ draft: blankDraft(), recognized: [] }),
      }),
    );
    expect("error" in parsed && parsed.error.status).toBe(400);
  });
});
