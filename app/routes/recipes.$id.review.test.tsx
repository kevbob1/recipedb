import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { initialAddFlowState } from "../lib/add-flow";
import ReviewRoute from "./recipes.$id.review";

vi.mock("../lib/draft-store.server", () => ({ loadDraft: vi.fn() }));
vi.mock("../lib/auth.server", () => ({ requireAuth: vi.fn() }));
vi.mock("../lib/use-save-draft", () => ({
  useSaveDraft: () => ({
    save: vi.fn(),
    remove: vi.fn(),
    saving: false,
    error: null,
    clearError: vi.fn(),
  }),
}));

describe("/recipes/:id/review rendering", () => {
  it("renders the review screen from loader-shaped data", () => {
    const draft = { ...initialAddFlowState().draft, title: "Soup" };
    const loaderData = { draft, recipeId: 42 };
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <ReviewRoute
          loaderData={loaderData}
          params={{ id: "42" }}
          matches={[
            {
              id: "root",
              params: {},
              pathname: "/",
              data: undefined,
              loaderData: undefined,
              handle: undefined,
            },
            {
              id: "routes/recipes.$id.review",
              params: { id: "42" },
              pathname: "/recipes/42/review",
              data: loaderData,
              loaderData,
              handle: undefined,
            },
          ]}
        />
      </MemoryRouter>,
    );

    expect(markup).toContain("Review draft #42");
    expect(markup).toContain("Save draft");
    expect(markup).toContain("Soup");
  });
});
