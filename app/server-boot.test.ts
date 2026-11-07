/**
 * Production bootstrap: migrations before listen, auth env assertion, port.
 *
 * The heavy pieces are mocked so the test states the *order and contract* the
 * esbuild bundle relies on, not their implementations (each has its own test).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runMigrations: vi.fn(),
  assertAuthEnvConfigured: vi.fn(),
}));

vi.mock("./db/migrate.server", () => ({ runMigrations: mocks.runMigrations }));
vi.mock("./lib/auth.server", () => ({
  assertAuthEnvConfigured: mocks.assertAuthEnvConfigured,
}));

import { bootstrap, handleStaticAsset } from "./server-boot";

const originalPort = process.env.PORT;

beforeEach(() => {
  mocks.runMigrations.mockReset();
  mocks.assertAuthEnvConfigured.mockReset();
  if (originalPort === undefined) delete process.env.PORT;
  else process.env.PORT = originalPort;
});

describe("bootstrap", () => {
  it("runs migrations, asserts auth env, then returns the port", () => {
    mocks.runMigrations.mockReturnValue({
      applied: ["0000_init"],
      skipped: ["0001_scaling_quantity"],
    });
    process.env.PORT = "4321";
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    expect(bootstrap()).toBe(4321);
    expect(log).toHaveBeenCalledWith(
      '[migrate] applied=["0000_init"] skipped=["0001_scaling_quantity"]',
    );
    expect(mocks.assertAuthEnvConfigured).toHaveBeenCalledTimes(1);
    log.mockRestore();
  });

  it("fails fast when the auth env is incomplete", () => {
    mocks.runMigrations.mockReturnValue({ applied: [], skipped: [] });
    mocks.assertAuthEnvConfigured.mockImplementation(() => {
      throw new Error("SESSION_SECRET is required");
    });
    vi.spyOn(console, "log").mockImplementation(() => {});

    expect(() => bootstrap()).toThrowError("SESSION_SECRET is required");
  });

  it("fails fast when migrations fail", () => {
    mocks.runMigrations.mockImplementation(() => {
      throw new Error("checksum mismatch");
    });

    expect(() => bootstrap()).toThrowError("checksum mismatch");
    expect(mocks.assertAuthEnvConfigured).not.toHaveBeenCalled();
  });

  it("re-exports the static asset handler server.js serves client files with", () => {
    expect(typeof handleStaticAsset).toBe("function");
  });
});
