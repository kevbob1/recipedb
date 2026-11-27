const DEFAULT_ALLOWED_HEADERS = "authorization, content-type";
const ALLOWED_METHODS = "GET, POST, DELETE, OPTIONS";

interface IncomingCorsRequest {
  method?: string;
  url?: string;
  headers: {
    host?: string | string[];
    origin?: string | string[];
    "access-control-request-headers"?: string | string[];
  };
}

interface CorsResponseWriter {
  statusCode: number;
  getHeader(name: string): string | number | string[] | undefined;
  setHeader(name: string, value: string): unknown;
  end(): unknown;
}

function isApiRequest(request: Request): boolean {
  return new URL(request.url).pathname.startsWith("/api/");
}

/** Headers shared by API responses and their browser-readable CORS behavior. */
export function corsHeadersForRequest(request: Request): Headers {
  const headers = new Headers();
  if (!isApiRequest(request)) return headers;

  const origin = request.headers.get("origin");
  if (origin !== null) headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Vary", "Origin");
  return headers;
}

/**
 * Handle browser CORS preflights before React Router sees OPTIONS, which it
 * cannot dispatch to a route loader or action.
 */
export function handleCors(request: Request): Response | null {
  if (request.method !== "OPTIONS" || !isApiRequest(request)) return null;

  const headers = corsHeadersForRequest(request);
  headers.set("Access-Control-Allow-Methods", ALLOWED_METHODS);
  headers.set(
    "Access-Control-Allow-Headers",
    request.headers.get("access-control-request-headers") ??
      DEFAULT_ALLOWED_HEADERS,
  );
  headers.set("Access-Control-Max-Age", "600");
  return new Response(null, { status: 204, headers });
}

/**
 * Adapt Node's HTTP listener to the pure CORS decision above. Returns true
 * when a preflight was fully answered; otherwise the caller should continue
 * to the React Router listener.
 */
export function handleCorsHttpRequest(
  incoming: IncomingCorsRequest,
  response: CorsResponseWriter,
): boolean {
  const method = incoming.method ?? "GET";
  const requestMethod =
    ["CONNECT", "TRACE", "TRACK"].includes(method.toUpperCase()) ? "GET" : method;
  const headers = new Headers();
  if (typeof incoming.headers.origin === "string") {
    headers.set("origin", incoming.headers.origin);
  }
  if (typeof incoming.headers["access-control-request-headers"] === "string") {
    headers.set(
      "access-control-request-headers",
      incoming.headers["access-control-request-headers"],
    );
  }
  const request = new Request(
    new URL(incoming.url ?? "/", "http://localhost"),
    { method: requestMethod, headers },
  );

  const preflight = handleCors(request);
  if (preflight) {
    response.statusCode = preflight.status;
    writeCorsHeaders(preflight.headers, response);
    response.end();
    return true;
  }

  writeCorsHeaders(corsHeadersForRequest(request), response);
  return false;
}

function writeCorsHeaders(
  headers: Headers,
  response: CorsResponseWriter,
): void {
  headers.forEach((value, name) => {
    if (name === "vary") {
      const existing = response.getHeader("Vary");
      if (existing) {
        const existingValue = Array.isArray(existing)
          ? existing.join(", ")
          : String(existing);
        if (!existingValue.toLowerCase().split(/\s*,\s*/).includes("origin")) {
          response.setHeader(name, `${existingValue}, ${value}`);
        }
        return;
      }
    }
    response.setHeader(name, value);
  });
}
