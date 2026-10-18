/**
 * JSON-LD extractor + recipe-scrapers draft builder — the URL pipeline that
 * runs on the server (ticket #4).
 *
 * Tests are pure (no network) by feeding sample HTML strings in directly.
 */
import { describe, expect, it } from "vitest";
import {
  extractJsonLd,
  pickDurationMin,
  pickImage,
  pickInstructionTexts,
  pickKeywords,
  pickString,
  pickStringArray,
} from "./url-parse";

const SAMPLE_HTML = `<!doctype html><html><head>
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "Recipe",
  "name": "  Big  Stew  ",
  "recipeIngredient": [
    "1 lb beef",
    "2 onions"
  ],
  "recipeInstructions": [
    "Brown the beef.",
    "Add onions."
  ],
  "recipeYield": "4 servings",
  "image": "https://example.com/stew.jpg",
  "recipeCategory": ["Soup"],
  "keywords": "beef, stew, family"
}
</script>
</head><body><h1>Big Stew</h1></body></html>`;

const SAMPLE_GRAPH_HTML = `<!doctype html><html><head>
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    { "@type": "WebSite", "name": "Example" },
    {
      "@type": "Recipe",
      "name": "Graph Pancakes",
      "recipeIngredient": ["2 cups flour"],
      "recipeInstructions": ["Mix."]
    }
  ]
}
</script>
</head><body></body></html>`;

const MALFORMED_HTML = `<!doctype html><html><head>
<script type="application/ld+json">not json{</script>
<script type="application/ld+json">{"@type":"Recipe","name":"After Bad"}</script>
</head><body></body></html>`;

describe("extractJsonLd", () => {
  it("pulls a Recipe block from a single script", () => {
    const { recipe } = extractJsonLd(SAMPLE_HTML);
    expect(recipe).not.toBeNull();
    expect((recipe as Record<string, unknown>)["name"]).toBe("  Big  Stew  ");
  });

  it("handles @graph arrays", () => {
    const { recipe, blocks } = extractJsonLd(SAMPLE_GRAPH_HTML);
    expect(recipe).not.toBeNull();
    expect((recipe as Record<string, unknown>)["name"]).toBe("Graph Pancakes");
    expect(blocks.length).toBeGreaterThanOrEqual(2);
  });

  it("skips malformed JSON-LD without losing the rest", () => {
    const { recipe, blocks } = extractJsonLd(MALFORMED_HTML);
    expect(recipe).not.toBeNull();
    expect((recipe as Record<string, unknown>)["name"]).toBe("After Bad");
    expect(blocks.length).toBe(1);
  });

  it("returns null when no Recipe block is present", () => {
    const html = `<html><head><script type="application/ld+json">{"@type":"WebSite"}</script></head></html>`;
    const { recipe } = extractJsonLd(html);
    expect(recipe).toBeNull();
  });
});

describe("pickString", () => {
  it("returns the trimmed string", () => {
    expect(pickString("  hi  ")).toBe("hi");
  });
  it("returns null for empty", () => {
    expect(pickString("")).toBeNull();
    expect(pickString("   ")).toBeNull();
  });
  it("walks arrays", () => {
    expect(pickString(["", "  real  "])).toBe("real");
  });
  it("returns null for nullish", () => {
    expect(pickString(null)).toBeNull();
    expect(pickString(undefined)).toBeNull();
  });
});

describe("pickStringArray", () => {
  it("flattens arrays of strings", () => {
    expect(pickStringArray(["a", "b"])).toEqual(["a", "b"]);
  });
  it("coerces a single string into a one-element list", () => {
    expect(pickStringArray("only")).toEqual(["only"]);
  });
  it("skips empties", () => {
    expect(pickStringArray(["", "  ", "kept"])).toEqual(["kept"]);
  });
});

describe("pickImage", () => {
  it("returns a string URL", () => {
    expect(pickImage("https://x.com/y.jpg")).toBe("https://x.com/y.jpg");
  });
  it("walks an object with a url field", () => {
    expect(pickImage({ url: "https://x.com/y.jpg" })).toBe("https://x.com/y.jpg");
  });
  it("returns the first URL out of an array", () => {
    expect(pickImage([{ url: "https://a" }, "https://b"])).toBe("https://a");
  });
  it("returns null for missing", () => {
    expect(pickImage(null)).toBeNull();
    expect(pickImage({})).toBeNull();
  });
});

describe("pickDurationMin", () => {
  it("parses minutes", () => {
    expect(pickDurationMin("PT15M")).toBe("15 min");
  });
  it("parses hours + minutes", () => {
    expect(pickDurationMin("PT1H30M")).toBe("1 hr 30 min");
  });
  it("parses hours only", () => {
    expect(pickDurationMin("PT2H")).toBe("2 hr");
  });
  it("returns the raw text for non-ISO inputs", () => {
    expect(pickDurationMin("about an hour")).toBe("about an hour");
  });
});

describe("pickInstructionTexts", () => {
  it("handles a plain string", () => {
    expect(pickInstructionTexts("Stir.")).toEqual(["Stir."]);
  });
  it("handles an array of strings", () => {
    expect(pickInstructionTexts(["One.", "Two."])).toEqual(["One.", "Two."]);
  });
  it("handles HowToStep objects (the common JSON-LD shape)", () => {
    expect(
      pickInstructionTexts([
        { "@type": "HowToStep", text: "Brown the beef." },
        { "@type": "HowToStep", text: "Add the onions." },
      ]),
    ).toEqual(["Brown the beef.", "Add the onions."]);
  });
  it("flattens HowToSection nesting", () => {
    expect(
      pickInstructionTexts([
        {
          "@type": "HowToSection",
          name: "Sauce",
          itemListElement: [
            { "@type": "HowToStep", text: "Simmer." },
            { "@type": "HowToStep", text: "Season." },
          ],
        },
      ]),
    ).toEqual(["Simmer.", "Season."]);
  });
  it("skips empty and unknown shapes", () => {
    expect(pickInstructionTexts(null)).toEqual([]);
    expect(pickInstructionTexts([{ "@type": "HowToStep" }, "  "])).toEqual([]);
  });
});

describe("pickKeywords", () => {
  it("splits a comma-separated string", () => {
    expect(pickKeywords("soup, comfort food, tomato")).toEqual([
      "soup",
      "comfort food",
      "tomato",
    ]);
  });
  it("accepts an array and trims entries", () => {
    expect(pickKeywords([" soup ", "tomato"])).toEqual(["soup", "tomato"]);
  });
  it("drops empty entries", () => {
    expect(pickKeywords("a,, ,b")).toEqual(["a", "b"]);
    expect(pickKeywords(null)).toEqual([]);
  });
});
