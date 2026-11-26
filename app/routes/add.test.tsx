import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { initialAddFlowState } from "../lib/add-flow";
import { StepperShell } from "./add";

function renderStep(step: 1 | 2 | 3 | 4, entry: "url" | "photo" | "bulk" | "type" | null) {
  const state = { ...initialAddFlowState(), step, entry };
  return renderToStaticMarkup(
    <MemoryRouter>
      <StepperShell initialState={state} />
    </MemoryRouter>,
  );
}

describe("/add stepper rendering", () => {
  it("renders each step with the matching entry branch", () => {
    expect(renderStep(1, null)).toContain("Add a recipe");
    expect(renderStep(2, "url")).toContain("Paste a public URL");
    expect(renderStep(2, "photo")).toContain("Snap a photo of a printout");
    expect(renderStep(2, "bulk")).toContain("Import a batch of photos");
    expect(renderStep(2, "type")).toContain("Type it in");
    expect(renderStep(3, "type")).toContain("Review the draft");
    expect(renderStep(4, "type")).toContain("Draft saved");
  });
});
