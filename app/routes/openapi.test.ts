import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import openApiSpec from "../../docs/openapi.yaml?raw";
import { action, loader } from "./openapi";

function args(request: Request) {
  return {
    request,
    params: {},
    context: {},
    url: new URL(request.url),
    pattern: new URL(request.url).pathname,
  };
}

describe("OpenAPI document route", () => {
  it("serves the embedded spec publicly as YAML", async () => {
    const response = await loader(args(new Request("http://localhost/openapi.yaml")));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/yaml; charset=utf-8");
    const body = await response.text();
    expect(body.startsWith("openapi: 3.1")).toBe(true);
    expect(body).toContain("/api/adjustments:");
    expect(body).toContain("/api/tokens:");
  });

  it("checks that API and health routes are documented", () => {
    const routes = readFileSync(new URL("../routes.ts", import.meta.url), "utf8");
    const routePaths = [...routes.matchAll(/route\("([^"]+)"/g)]
      .map(([, path]) => path)
      .filter((path): path is string => path !== undefined)
      .filter((path) => path.startsWith("api/") || path === "health")
      .map((path) => `/${path}`
        .replace(/:([^/]+)/g, "{$1}")
        .replace(/\*$/, "{filename}"));

    for (const path of routePaths) {
      expect(openApiSpec).toContain(`${path}:`);
    }
  });

  it("returns 405 for POST", async () => {
    const response = await action();

    expect(response.status).toBe(405);
  });
});
