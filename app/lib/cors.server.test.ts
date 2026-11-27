import { describe, expect, it } from "vitest";

import {
  corsHeadersForRequest,
  handleCors,
  handleCorsHttpRequest,
} from "./cors.server";

describe("CORS handling", () => {
  it("answers token API preflights with the requested headers and origin", () => {
    const response = handleCors(
      new Request("http://localhost/api/token", {
        method: "OPTIONS",
        headers: {
          origin: "https://restfox.example",
          "access-control-request-method": "POST",
          "access-control-request-headers": "authorization, content-type",
        },
      }),
    );

    expect(response?.status).toBe(204);
    expect(response?.headers.get("access-control-allow-origin")).toBe(
      "https://restfox.example",
    );
    expect(response?.headers.get("vary")).toBe("Origin");
    expect(response?.headers.get("access-control-allow-methods")).toBe(
      "GET, POST, DELETE, OPTIONS",
    );
    expect(response?.headers.get("access-control-allow-headers")).toBe(
      "authorization, content-type",
    );
    expect(response?.headers.get("access-control-max-age")).toBe("600");
  });

  it("omits allow-origin when no Origin header was sent", () => {
    const response = handleCors(
      new Request("http://localhost/api/token", { method: "OPTIONS" }),
    );

    expect(response?.status).toBe(204);
    expect(response?.headers.has("access-control-allow-origin")).toBe(false);
    expect(response?.headers.get("vary")).toBe("Origin");
    expect(response?.headers.get("access-control-allow-headers")).toBe(
      "authorization, content-type",
    );
  });

  it("reflects an unconfigured origin instead of rejecting the preflight", () => {
    const response = handleCors(
      new Request("http://localhost/api/token", {
        method: "OPTIONS",
        headers: { origin: "https://unknown.example" },
      }),
    );

    expect(response?.headers.get("access-control-allow-origin")).toBe(
      "https://unknown.example",
    );
  });

  it("leaves OPTIONS on non-API paths to the framework", () => {
    expect(
      handleCors(
        new Request("http://localhost/recipes", { method: "OPTIONS" }),
      ),
    ).toBeNull();
  });

  it("adds readable CORS headers to real API responses without handling them", () => {
    const request = new Request("http://localhost/api/token", {
      method: "POST",
      headers: { origin: "https://restfox.example" },
    });

    expect(handleCors(request)).toBeNull();
    const headers = corsHeadersForRequest(request);
    expect(headers.get("access-control-allow-origin")).toBe(
      "https://restfox.example",
    );
    expect(headers.get("vary")).toBe("Origin");
  });

  it("does not add CORS headers to non-API requests", () => {
    const headers = corsHeadersForRequest(
      new Request("http://localhost/recipes", {
        headers: { origin: "https://restfox.example" },
      }),
    );
    expect([...headers]).toEqual([]);
  });

  it("answers preflights at the Node listener boundary", () => {
    const response = createResponseWriter();

    expect(
      handleCorsHttpRequest(
        {
          method: "OPTIONS",
          url: "/api/token",
          headers: {
            host: "localhost",
            origin: "https://restfox.example",
            "access-control-request-headers": "authorization",
          },
        },
        response.writer,
      ),
    ).toBe(true);
    expect(response.writer.statusCode).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://restfox.example",
    );
    expect(response.headers.get("access-control-allow-headers")).toBe(
      "authorization",
    );
    expect(response.ended).toBe(true);
  });

  it("adds CORS to API responses and preserves existing Vary values", () => {
    const response = createResponseWriter();
    response.writer.setHeader("Vary", "Accept-Encoding");

    expect(
      handleCorsHttpRequest(
        {
          method: "GET",
          url: "/api/token",
          headers: {
            host: "localhost",
            origin: "https://restfox.example",
          },
        },
        response.writer,
      ),
    ).toBe(false);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://restfox.example",
    );
    expect(response.headers.get("vary")).toBe("Accept-Encoding, Origin");
    expect(response.ended).toBe(false);
  });

  it("does not intercept non-API OPTIONS in the Node listener", () => {
    const response = createResponseWriter();
    expect(
      handleCorsHttpRequest(
        { method: "OPTIONS", url: "/recipes", headers: {} },
        response.writer,
      ),
    ).toBe(false);
    expect(response.headers.size).toBe(0);
    expect(response.ended).toBe(false);
  });
});

function createResponseWriter() {
  const headers = new Map<string, string>();
  let ended = false;
  const writer = {
    statusCode: 200,
    getHeader(name: string) {
      return headers.get(name.toLowerCase());
    },
    setHeader(name: string, value: string) {
      headers.set(name.toLowerCase(), value);
    },
    end() {
      ended = true;
    },
  };
  return {
    writer,
    headers,
    get ended() {
      return ended;
    },
  };
}
