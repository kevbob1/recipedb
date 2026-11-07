/**
 * Cook-screen Wake Lock (#18): every failure mode must end in a message, not a
 * thrown error or a toggle stuck on.
 *
 * Node has no React renderer, so `react` is replaced with a tiny synchronous
 * hook runtime (state cells, refs, effects) that can mount, re-render and
 * unmount the hook deterministically. The hook code under test is untouched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const react = vi.hoisted(() => {
  interface EffectRecord {
    deps?: unknown[];
    cleanup?: () => void;
    pending?: () => void | (() => void);
  }
  const h = {
    state: [] as unknown[],
    refs: [] as Array<{ current: unknown }>,
    callbacks: [] as unknown[],
    effects: [] as EffectRecord[],
    cursor: 0,
    effectCursor: 0,
    body: null as null | (() => unknown),
    latest: undefined as unknown,
    dirty: false,
  };

  function useState<T>(initial: T | (() => T)): [T, (next: T | ((prev: T) => T)) => void] {
    const index = h.cursor++;
    if (index >= h.state.length) {
      h.state[index] =
        typeof initial === "function" ? (initial as () => T)() : initial;
    }
    const set = (next: T | ((prev: T) => T)) => {
      const value =
        typeof next === "function"
          ? (next as (prev: T) => T)(h.state[index] as T)
          : next;
      if (Object.is(value, h.state[index])) return;
      h.state[index] = value;
      h.dirty = true;
    };
    return [h.state[index] as T, set];
  }

  function useRef<T>(initial: T): { current: T } {
    const index = h.cursor++;
    if (index >= h.refs.length) h.refs[index] = { current: initial };
    return h.refs[index] as { current: T };
  }

  function useCallback<T>(fn: T): T {
    const index = h.cursor++;
    if (index >= h.callbacks.length) h.callbacks[index] = fn;
    return h.callbacks[index] as T;
  }

  function depsChanged(prev: unknown[] | undefined, next: unknown[] | undefined): boolean {
    if (!prev || !next) return true;
    if (prev.length !== next.length) return true;
    return next.some((value, index) => !Object.is(value, prev[index]));
  }

  function useEffect(effect: () => void | (() => void), deps?: unknown[]): void {
    const index = h.effectCursor++;
    h.cursor++;
    const record = h.effects[index];
    if (record && !depsChanged(record.deps, deps)) return;
    record?.cleanup?.();
    h.effects[index] = { deps, pending: effect };
  }

  function renderOnce(): void {
    h.cursor = 0;
    h.effectCursor = 0;
    h.latest = h.body!();
    for (const effect of h.effects) {
      if (!effect.pending) continue;
      const cleanup = effect.pending();
      effect.pending = undefined;
      if (typeof cleanup === "function") effect.cleanup = cleanup;
    }
  }

  function settle(): unknown {
    let guard = 0;
    do {
      h.dirty = false;
      renderOnce();
    } while (h.dirty && guard++ < 10);
    return h.latest;
  }

  function mount<T>(body: () => T): T {
    h.state = [];
    h.refs = [];
    h.callbacks = [];
    h.effects = [];
    h.cursor = 0;
    h.effectCursor = 0;
    h.body = body;
    return settle() as T;
  }

  function unmount(): void {
    for (const effect of h.effects) effect.cleanup?.();
  }

  return { h, useState, useRef, useCallback, useEffect, mount, settle, unmount };
});

vi.mock("react", () => ({
  useState: react.useState,
  useRef: react.useRef,
  useCallback: react.useCallback,
  useEffect: react.useEffect,
}));

import { useScreenWakeLock, type WakeLockHandle } from "./wake-lock";

interface Sentinel {
  release: ReturnType<typeof vi.fn>;
  addEventListener?: ReturnType<typeof vi.fn>;
}

function sentinel(): Sentinel {
  return { release: vi.fn(async () => {}), addEventListener: vi.fn() };
}

function makeDocument() {
  const listeners = new Map<string, Set<() => void>>();
  return {
    visibilityState: "visible" as "visible" | "hidden",
    addEventListener(type: string, fn: () => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener(type: string, fn: () => void) {
      listeners.get(type)?.delete(fn);
    },
    fire(type: string) {
      for (const fn of listeners.get(type) ?? []) fn();
    },
    listenerCount(type: string) {
      return listeners.get(type)?.size ?? 0;
    },
  };
}

let doc: ReturnType<typeof makeDocument>;
let lock: WakeLockHandle;

function mount(): WakeLockHandle {
  doc = makeDocument();
  vi.stubGlobal("document", doc);
  lock = react.mount(() => useScreenWakeLock());
  return lock;
}

async function act(fn: () => Promise<unknown>): Promise<void> {
  await fn();
  lock = react.settle() as WakeLockHandle;
}

beforeEach(() => {
  vi.stubGlobal("navigator", {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("API availability", () => {
  it("explains the missing API instead of throwing", async () => {
    mount();
    expect(lock.supported).toBe(false);
    await act(() => lock.toggle());
    expect(lock.on).toBe(false);
    expect(lock.message).toContain("no Screen Wake Lock API");
  });

  it("treats a non-requesting wakeLock object as unsupported", () => {
    for (const value of [null, {}, { request: 42 }]) {
      vi.stubGlobal("navigator", { wakeLock: value });
      mount();
      expect(lock.supported).toBe(false);
    }
  });

  it("handles a server-side render where navigator is undefined", () => {
    vi.stubGlobal("navigator", undefined);
    mount();
    expect(lock.supported).toBe(false);
  });

  it("probes support once mounted", () => {
    vi.stubGlobal("navigator", { wakeLock: { request: vi.fn() } });
    mount();
    expect(lock.supported).toBe(true);
    expect(lock.on).toBe(false);
    expect(lock.message).toBeNull();
  });
});

describe("acquiring and releasing", () => {
  it("reports an active lock and clears it when the browser drops it", async () => {
    const held = sentinel();
    const request = vi.fn(async () => held);
    vi.stubGlobal("navigator", { wakeLock: { request } });
    mount();

    await act(() => lock.toggle());

    expect(request).toHaveBeenCalledWith("screen");
    expect(lock.on).toBe(true);
    expect(lock.supported).toBe(true);
    expect(lock.message).toBe("Screen stays awake while this tab is visible.");

    const onRelease = held.addEventListener!.mock.calls[0]![1] as () => void;
    onRelease();
    lock = react.settle() as WakeLockHandle;
    expect(lock.on).toBe(false);
  });

  it("releases the lock when toggled off", async () => {
    const held = sentinel();
    vi.stubGlobal("navigator", { wakeLock: { request: vi.fn(async () => held) } });
    mount();
    await act(() => lock.toggle());

    await act(() => lock.toggle());

    expect(held.release).toHaveBeenCalledTimes(1);
    expect(lock.on).toBe(false);
    expect(lock.message).toContain("Wake lock released");
  });

  it("survives a release that rejects (already dropped by the tab)", async () => {
    const held = sentinel();
    held.release.mockRejectedValue(new Error("already gone"));
    vi.stubGlobal("navigator", { wakeLock: { request: vi.fn(async () => held) } });
    mount();
    await act(() => lock.toggle());

    await act(() => lock.toggle());
    expect(lock.on).toBe(false);
  });

  it("reports a refused request as a refusal, not a crash", async () => {
    vi.stubGlobal("navigator", {
      wakeLock: { request: vi.fn(async () => Promise.reject(new Error("denied"))) },
    });
    mount();

    await act(() => lock.toggle());

    expect(lock.supported).toBe(true);
    expect(lock.on).toBe(false);
    expect(lock.message).toContain("browser refused the wake lock");
  });

  it("works with a sentinel that has no release listener", async () => {
    const held: Sentinel = { release: vi.fn(async () => {}) };
    vi.stubGlobal("navigator", { wakeLock: { request: vi.fn(async () => held) } });
    mount();

    await act(() => lock.toggle());
    expect(lock.on).toBe(true);
  });

  it("releases an in-flight lock when the person toggles it back off", async () => {
    const held = sentinel();
    let resolveRequest!: (value: Sentinel) => void;
    const request = vi.fn(
      () => new Promise<Sentinel>((resolve) => (resolveRequest = resolve)),
    );
    vi.stubGlobal("navigator", { wakeLock: { request } });
    mount();

    const pending = lock.toggle();
    await act(() => lock.toggle());
    resolveRequest(held);
    await act(() => pending);

    expect(request).toHaveBeenCalledTimes(1);
    expect(held.release).toHaveBeenCalledTimes(1);
    expect(lock.on).toBe(false);
  });

  it("also releases the in-flight sentinel when that release rejects", async () => {
    const held = sentinel();
    held.release.mockRejectedValue(new Error("gone"));
    let resolveRequest!: (value: Sentinel) => void;
    const request = vi.fn(
      () => new Promise<Sentinel>((resolve) => (resolveRequest = resolve)),
    );
    vi.stubGlobal("navigator", { wakeLock: { request } });
    mount();

    const pending = lock.toggle();
    await act(() => lock.toggle());
    resolveRequest(held);
    await act(() => pending);

    expect(lock.on).toBe(false);
  });

  it("releases the lock when the cook screen unmounts", async () => {
    const held = sentinel();
    vi.stubGlobal("navigator", { wakeLock: { request: vi.fn(async () => held) } });
    mount();
    await act(() => lock.toggle());

    react.unmount();

    expect(held.release).toHaveBeenCalledTimes(1);
  });
});

describe("visibility changes", () => {
  it("re-takes a lock the browser dropped while the tab was hidden", async () => {
    const first = sentinel();
    const second = sentinel();
    const request = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    vi.stubGlobal("navigator", { wakeLock: { request } });
    mount();
    await act(() => lock.toggle());

    // The browser drops the lock when the tab hides.
    const onRelease = first.addEventListener!.mock.calls[0]![1] as () => void;
    onRelease();
    lock = react.settle() as WakeLockHandle;
    expect(lock.on).toBe(false);

    doc.visibilityState = "hidden";
    doc.fire("visibilitychange");
    expect(request).toHaveBeenCalledTimes(1);

    doc.visibilityState = "visible";
    doc.fire("visibilitychange");
    // The listener re-acquires asynchronously (`void acquire()`).
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(request).toHaveBeenCalledTimes(2);
    expect(lock.on).toBe(true);
  });

  it("does not re-acquire when the person never wanted the lock", () => {
    const request = vi.fn();
    vi.stubGlobal("navigator", { wakeLock: { request } });
    mount();

    doc.visibilityState = "visible";
    doc.fire("visibilitychange");
    expect(request).not.toHaveBeenCalled();
  });

  it("unregisters the visibility listener on unmount", () => {
    vi.stubGlobal("navigator", { wakeLock: { request: vi.fn() } });
    mount();
    expect(doc.listenerCount("visibilitychange")).toBe(1);
    react.unmount();
    expect(doc.listenerCount("visibilitychange")).toBe(0);
  });
});
