import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createDraft } from "../lib/import";
import { ReviewEditor } from "./review-editor";

describe("ReviewEditor scanned pages", () => {
  it("renders page labels, images, text, and the re-parse action", () => {
    const draft = createDraft({
      kind: "scan",
      text: "Cookies\n1 cup flour",
      imageFilename: null,
    });
    draft.pages = [
      {
        pageNo: 1,
        imageFilename: "12/page-1.png",
        text: "Page one text",
      },
      {
        pageNo: 2,
        imageFilename: null,
        text: "Page two text",
      },
    ];

    const markup = renderToStaticMarkup(
      createElement(ReviewEditor, { draft, setDraft: () => undefined }),
    );

    expect(markup).toContain("Page 1");
    expect(markup).toContain("Page 2");
    expect(markup).toContain('<img src="/api/scan-images/12/page-1.png"');
    expect(markup).not.toContain("/api/scan-images/null");
    expect(markup).toMatch(/<textarea[^>]*>Page one text<\/textarea>/);
    expect(markup).toMatch(/<textarea[^>]*>Page two text<\/textarea>/);
    expect(markup).toContain("Re-parse fields from page text");
  });

  it("does not render scanned-page markup when the draft has no pages", () => {
    const draft = createDraft({
      kind: "scan",
      text: "Cookies\n1 cup flour",
      imageFilename: null,
    });

    const markup = renderToStaticMarkup(
      createElement(ReviewEditor, { draft, setDraft: () => undefined }),
    );

    expect(markup).not.toContain("Scanned pages");
    expect(markup).not.toContain("Page 1");
  });
});
