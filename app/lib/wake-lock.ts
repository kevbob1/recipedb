/**
 * Screen Wake Lock for the cook screen (issue #18).
 *
 * Cooking means both hands busy: the phone must not sleep mid-recipe. Every
 * way that promise can break ends in a message a person can act on instead of
 * a thrown error or a toggle stuck "on":
 *
 *   - the Screen Wake Lock API is missing (Safari, Firefox) -> explain, ask
 *     for a manual screen-on
 *   - `request()` is refused (battery saver, permissions) -> explain
 *   - the browser silently drops the lock when the tab goes hidden -> the
 *     handler re-requests it if the person still wants it
 *
 * The types below are structural on purpose: `lib.dom` does not agree across
 * TypeScript versions on whether the Wake Lock API exists, so this reads
 * `navigator.wakeLock` defensively at runtime rather than relying on the
 * ambient declaration.
 */
import { useCallback, useEffect, useRef, useState } from "react";

interface WakeLockSentinelLike {
  release(): Promise<void>;
  /** Fired by the browser when it drops the lock (e.g. the tab hid). */
  addEventListener?: (type: "release", listener: () => void) => void;
}

interface ScreenWakeLockLike {
  request(type: "screen"): Promise<WakeLockSentinelLike>;
}

export interface WakeLockHandle {
  /** True while this tab actually holds a screen wake lock. */
  on: boolean;
  /**
   * Whether the browser exposes the API at all. `null` before the first
   * effect run, so SSR and the first client render agree.
   */
  supported: boolean | null;
  /** Human-readable status, or null when there is nothing to say. */
  message: string | null;
  toggle: () => Promise<void>;
}

const REFUSED_MESSAGE =
  "The browser refused the wake lock (battery saver?) — keep the screen on manually.";

const UNAVAILABLE_MESSAGE =
  "This browser has no Screen Wake Lock API — keep the screen on manually (or raise the auto-lock timeout).";

function isScreenWakeLock(value: unknown): value is ScreenWakeLockLike {
  if (typeof value !== "object" || value === null) return false;
  return typeof (value as { request?: unknown }).request === "function";
}

function getScreenWakeLock(): ScreenWakeLockLike | undefined {
  if (typeof navigator === "undefined") return undefined;
  const candidate = (navigator as { wakeLock?: unknown }).wakeLock;
  return isScreenWakeLock(candidate) ? candidate : undefined;
}

/**
 * Wake-lock toggle with a fallback message for every failure mode.
 *
 * What the person asked for ("wanted") is tracked separately from what the
 * browser currently grants ("on"), because the OS revokes the lock whenever
 * the tab is hidden but the user's intent did not change.
 */
export function useScreenWakeLock(): WakeLockHandle {
  const [on, setOn] = useState(false);
  const [supported, setSupported] = useState<boolean | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const sentinelRef = useRef<WakeLockSentinelLike | null>(null);
  const wantedRef = useRef(false);

  const acquire = useCallback(async (): Promise<void> => {
    const wakeLock = getScreenWakeLock();
    if (!wakeLock) {
      wantedRef.current = false;
      setSupported(false);
      setOn(false);
      setMessage(UNAVAILABLE_MESSAGE);
      return;
    }
    try {
      const sentinel = await wakeLock.request("screen");
      if (!wantedRef.current) {
        // The person turned it back off while the request was in flight.
        void sentinel.release().catch(() => undefined);
        return;
      }
      sentinelRef.current = sentinel;
      sentinel.addEventListener?.("release", () => {
        sentinelRef.current = null;
        setOn(false);
      });
      setSupported(true);
      setOn(true);
      setMessage("Screen stays awake while this tab is visible.");
    } catch {
      wantedRef.current = false;
      setSupported(true);
      setOn(false);
      setMessage(REFUSED_MESSAGE);
    }
  }, []);

  const release = useCallback(async (): Promise<void> => {
    wantedRef.current = false;
    const sentinel = sentinelRef.current;
    sentinelRef.current = null;
    setOn(false);
    setMessage("Wake lock released — the screen may sleep again.");
    if (!sentinel) return;
    try {
      await sentinel.release();
    } catch {
      // Already released (or the tab lost it first): nothing to recover.
    }
  }, []);

  const toggle = useCallback(async (): Promise<void> => {
    if (wantedRef.current) {
      await release();
      return;
    }
    if (sentinelRef.current) {
      await release();
      return;
    }
    wantedRef.current = true;
    setMessage(null);
    await acquire();
  }, [acquire, release]);

  // Probe the API once mounted: doing it in render would break SSR
  // (navigator is undefined on the server) and cause a hydration mismatch.
  useEffect(() => {
    setSupported(Boolean(getScreenWakeLock()));
  }, []);

  // Coming back to a hidden tab, re-take the lock the browser dropped.
  useEffect(() => {
    function onVisibilityChange() {
      if (document.visibilityState !== "visible") return;
      if (!wantedRef.current || sentinelRef.current) return;
      void acquire();
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [acquire]);

  // Leaving the cook screen must not leave the screen pinned awake.
  useEffect(() => {
    return () => {
      const sentinel = sentinelRef.current;
      sentinelRef.current = null;
      wantedRef.current = false;
      if (sentinel) void sentinel.release().catch(() => undefined);
    };
  }, []);

  return { on, supported, message, toggle };
}
