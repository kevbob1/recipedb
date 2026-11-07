/**
 * useSaveDraft: the single client entry point for persisting review state.
 *
 * The fetch boundary is stubbed; the JSON-vs-multipart decision, the error
 * mapping and the saving/error state machine are the real code. `react` is
 * replaced with the same synchronous hook runtime used by wake-lock.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const react = vi.hoisted(() => {
  const h = {
    state: [] as unknown[],
    cursor: 0,
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

  function useCallback<T>(fn: T): T {
    h.cursor++;
    return fn;
  }

  function renderOnce(): void {
    h.cursor = 0;
    h.latest = h.body!();
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
    h.body = body;
    return settle() as T;
  }

  return { useState, useCallback, mount, settle };
});

vi.mock("react", () => ({
  useState: react.useState,
  useCallback: react.useCallback,
}));

import { blankDraft, type RecipeDraft } from "./draft";
import { SaveDraftError, useSaveDraft, type UseSaveDraft } from "./use-save-draft";

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));

let hook: UseSaveDraft;

function mount(recipeId?: number): UseSaveDraft {
  hook = react.mount(() => useSaveDraft({ recipeId }));
  return hook;
}

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  };
}

function draft(): RecipeDraft {
  return { ...blankDraft(), title: "Soup", category: "soup" };
}

beforeEach(() => {
  react.mount(() => null);
  vi.stubGlobal("fetch", mocks.fetch);
  mocks.fetch.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("save", () => {
  it("posts the draft as JSON and resolves with the recipe id", async () => {
    mocks.fetch.mockResolvedValue(jsonResponse({ recipeId: 42 }));
    mount(7);

    await expect(hook.save(draft())).resolves.toBe(42);
    hook = react.settle() as UseSaveDraft;

    expect(mocks.fetch).toHaveBeenCalledWith("/api/save-draft", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: expect.any(String),
    });
    const body = JSON.parse(mocks.fetch.mock.calls[0]![1]!.body as string);
    expect(body.draft.title).toBe("Soup");
    expect(body.recipeId).toBe(7);
    expect(hook.saving).toBe(false);
    expect(hook.error).toBeNull();
  });

  it("omits recipeId when creating a new recipe", async () => {
    mocks.fetch.mockResolvedValue(jsonResponse({ recipeId: 1 }));
    mount();

    await hook.save(draft());

    const body = JSON.parse(mocks.fetch.mock.calls[0]![1]!.body as string);
    expect(body).not.toHaveProperty("recipeId");
  });

  it("sends multipart when the original capture rides along", async () => {
    mocks.fetch.mockResolvedValue(jsonResponse({ recipeId: 9 }));
    mount(3);
    const file = new File([new Uint8Array([1, 2, 3])], "capture.png", {
      type: "image/png",
    });

    await hook.save(draft(), file);

    const init = mocks.fetch.mock.calls[0]![1]!;
    expect(init.headers).toBeUndefined();
    const form = init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("recipeId")).toBe("3");
    expect(JSON.parse(form.get("draft") as string).title).toBe("Soup");
    const sent = form.get("image") as File;
    expect(sent.name).toBe("capture.png");
    expect(sent.type).toBe("image/png");
  });

  it("defaults the multipart filename for an unnamed capture", async () => {
    mocks.fetch.mockResolvedValue(jsonResponse({ recipeId: 9 }));
    mount();
    const file = new File([new Uint8Array([1])], "", { type: "image/png" });

    await hook.save(draft(), file);

    const form = mocks.fetch.mock.calls[0]![1]!.body as FormData;
    expect((form.get("image") as File).name).toBe("capture.png");
  });

  it("exposes the in-flight saving state", async () => {
    let resolve!: (value: unknown) => void;
    mocks.fetch.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    mount();

    const pending = hook.save(draft());
    hook = react.settle() as UseSaveDraft;
    expect(hook.saving).toBe(true);

    resolve(jsonResponse({ recipeId: 2 }));
    await pending;
    hook = react.settle() as UseSaveDraft;
    expect(hook.saving).toBe(false);
  });

  it("maps a failed response to a displayable message and code", async () => {
    mocks.fetch.mockResolvedValue(
      jsonResponse({ error: "bad-draft", message: "A title is required." }, { ok: false, status: 400 }),
    );
    mount();

    const error = await hook.save(draft()).catch((err: unknown) => err);
    hook = react.settle() as UseSaveDraft;

    expect(error).toBeInstanceOf(SaveDraftError);
    expect(error).toMatchObject({ message: "A title is required.", code: "bad-draft" });
    expect(hook.error).toBe("A title is required.");
    expect(hook.saving).toBe(false);
  });

  it("falls back to the error code when the server sends no message", async () => {
    mocks.fetch.mockResolvedValue(
      jsonResponse({ error: "forbidden" }, { ok: false, status: 403 }),
    );
    mount();

    await expect(hook.save(draft())).rejects.toMatchObject({
      message: "forbidden",
      code: "forbidden",
    });
  });

  it("handles an unparseable body", async () => {
    mocks.fetch.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error("not json");
      },
    });
    mount();

    await expect(hook.save(draft())).rejects.toMatchObject({
      message: "Couldn't save.",
      code: "save-failed",
    });
  });

  it("rejects an ok response that has no numeric recipe id", async () => {
    mocks.fetch.mockResolvedValue(jsonResponse({ recipeId: "nope" }));
    mount();

    await expect(hook.save(draft())).rejects.toMatchObject({
      message: "Couldn't save.",
      code: "save-failed",
    });
  });

  it("still throws non-Error failures and shows a generic message", async () => {
    mocks.fetch.mockRejectedValue("offline");
    mount();

    await expect(hook.save(draft())).rejects.toBe("offline");
    hook = react.settle() as UseSaveDraft;
    expect(hook.error).toBe("Couldn't save.");
  });
});

describe("remove", () => {
  it("refuses to delete without a recipe id", async () => {
    mount();

    await expect(hook.remove()).rejects.toMatchObject({
      message: "No recipe to delete.",
      code: "bad-recipe-id",
    });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("posts the delete intent for the current recipe", async () => {
    mocks.fetch.mockResolvedValue(jsonResponse({ recipeId: 11 }));
    mount(11);

    await hook.remove();

    const [url, init] = mocks.fetch.mock.calls[0]!;
    expect(url).toBe("/api/save-draft");
    expect(JSON.parse(init!.body as string)).toEqual({ recipeId: 11, intent: "delete" });
    hook = react.settle() as UseSaveDraft;
    expect(hook.saving).toBe(false);
    expect(hook.error).toBeNull();
  });

  it("sets the error state when delete fails", async () => {
    mocks.fetch.mockResolvedValue(
      jsonResponse({ error: "delete-failed", message: "Couldn't delete it." }, { ok: false }),
    );
    mount(11);

    await expect(hook.remove()).rejects.toBeInstanceOf(SaveDraftError);
    hook = react.settle() as UseSaveDraft;
    expect(hook.error).toBe("Couldn't delete it.");
  });
});

describe("clearError", () => {
  it("clears a displayed error", async () => {
    mocks.fetch.mockResolvedValue(
      jsonResponse({ error: "save-failed", message: "Nope" }, { ok: false }),
    );
    mount();
    await hook.save(draft()).catch(() => undefined);
    hook = react.settle() as UseSaveDraft;
    expect(hook.error).toBe("Nope");

    hook.clearError();
    hook = react.settle() as UseSaveDraft;
    expect(hook.error).toBeNull();
  });
});
