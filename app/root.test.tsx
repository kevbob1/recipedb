/**
 * Root route: the HTML shell's error boundary.
 *
 * ErrorBoundary is renderable without a router context (it only uses
 * isRouteErrorResponse + plain elements), so it is covered directly; the
 * Layout/App wrappers need a live router and belong to the smoke tests.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ErrorBoundary, links } from "./root";

describe("root route", () => {
  it("contributes no stylesheet links", () => {
    expect(links()).toEqual([]);
  });

  it("renders the generic boundary for an unexpected error", () => {
    const html = renderToStaticMarkup(
      <ErrorBoundary error={new Error("database is on fire")} />,
    );
    expect(html).toContain("<h1>Oops!</h1>");
    // vitest runs with import.meta.env.DEV, so the message and stack show.
    expect(html).toContain("database is on fire");
    expect(html).toContain("<pre");
  });

  it("omits details and stack for non-Error throws", () => {
    const html = renderToStaticMarkup(<ErrorBoundary error="nope" />);
    expect(html).toContain("<h1>Oops!</h1>");
    expect(html).not.toContain("<pre");
  });

  it("renders the 404 page for a 404 route error response", () => {
    const html = renderToStaticMarkup(
      <ErrorBoundary
        error={{ status: 404, statusText: "Not Found", internal: false, data: null }}
      />,
    );
    expect(html).toContain("<h1>404</h1>");
    expect(html).toContain("The requested page could not be found.");
  });

  it("uses the statusText for non-404 route errors", () => {
    const html = renderToStaticMarkup(
      <ErrorBoundary
        error={{ status: 500, statusText: "Server exploded", internal: false, data: null }}
      />,
    );
    expect(html).toContain("<h1>Error</h1>");
    expect(html).toContain("Server exploded");
  });

  it("falls back to generic details when a route error has no statusText", () => {
    const html = renderToStaticMarkup(
      <ErrorBoundary
        error={{ status: 500, statusText: "", internal: true, data: null }}
      />,
    );
    expect(html).toContain("An unexpected error occurred.");
  });
});
