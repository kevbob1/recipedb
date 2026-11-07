/**
 * Server env helpers: the port contract in production and the NODE_ENV flag.
 */
import { afterEach, describe, expect, it } from "vitest";

import { getPort, isProduction } from "./env.server";

const originalPort = process.env.PORT;
const originalNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  if (originalPort === undefined) delete process.env.PORT;
  else process.env.PORT = originalPort;
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
});

describe("getPort", () => {
  it("defaults to 3000 when PORT is unset", () => {
    delete process.env.PORT;
    expect(getPort()).toBe(3000);
  });

  it("parses a valid PORT", () => {
    process.env.PORT = "8080";
    expect(getPort()).toBe(8080);
  });

  it("accepts the bounds of the valid range", () => {
    process.env.PORT = "1";
    expect(getPort()).toBe(1);
    process.env.PORT = "65535";
    expect(getPort()).toBe(65535);
  });

  it.each(["not-a-number", "0", "-1", "65536"])(
    "rejects %s with an actionable message",
    (raw) => {
      process.env.PORT = raw;
      expect(() => getPort()).toThrowError(
        `PORT must be an integer 1-65535, got: ${raw}`,
      );
    },
  );
});

describe("isProduction", () => {
  it("is true only for NODE_ENV=production", () => {
    process.env.NODE_ENV = "production";
    expect(isProduction()).toBe(true);
    process.env.NODE_ENV = "development";
    expect(isProduction()).toBe(false);
  });
});
