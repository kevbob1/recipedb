/**
 * THROWAWAY PROTOTYPE — issue #17.
 *
 * Stubbed/stubbed-out Screen Wake Lock helper. The real API exists in Chromium;
 * Safari/Firefox and some battery-saver states reject or lack it, so every
 * failure falls back to an explanatory message instead of throwing.
 */
import { useCallback, useEffect, useRef, useState } from "react";

interface WakeLockSentinelLike {
  release: () => Promise<void>;
  addEventListener?: (type: "release", listener: () => void) => void;
}

interface WakeLockNavigator {
  wakeLock?: { request: (type: "screen") => Promise<WakeLockSentinelLike> };
}

export interface WakeLockState {
  /** Whether this tab currently holds a screen wake lock. */
  on: boolean;
  /** False when the browser has no Screen Wake Lock API at all. */
  supported: boolean;
  /** Human-readable status for the prototype's state readout. */
  message: string | null;
  toggle: () => Promise<void>;
}

function getWakeLock(): WakeLockNavigator["wakeLock"] {
  if (typeof navigator === "undefined") return undefined;
  return (navigator as Navigator & WakeLockNavigator).wakeLock;
}

export function useWakeLock(): WakeLockState {
  const [on, setOn] = useState(false);
  const [supported, setSupported] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const sentinelRef = useRef<WakeLockSentinelLike | null>(null);

  useEffect(() => {
    setSupported(Boolean(getWakeLock()?.request));
  }, []);

  useEffect(() => {
    return () => {
      const sentinel = sentinelRef.current;
      sentinelRef.current = null;
      if (sentinel) void sentinel.release().catch(() => undefined);
    };
  }, []);

  const toggle = useCallback(async () => {
    if (on) {
      const sentinel = sentinelRef.current;
      sentinelRef.current = null;
      setOn(false);
      setMessage("Wake lock released.");
      if (sentinel) {
        try {
          await sentinel.release();
        } catch {
          /* releasing a lost lock is not interesting for a prototype */
        }
      }
      return;
    }

    const wakeLock = getWakeLock();
    if (!wakeLock?.request) {
      setSupported(false);
      setOn(false);
      setMessage("Wake lock is not available in this browser — keep the screen on manually.");
      return;
    }

    try {
      const sentinel = await wakeLock.request("screen");
      sentinelRef.current = sentinel;
      sentinel.addEventListener?.("release", () => {
        sentinelRef.current = null;
        setOn(false);
      });
      setOn(true);
      setMessage("Screen will stay awake while this tab is visible.");
    } catch {
      setOn(false);
      setMessage("Wake lock was refused (browser or battery saver) — keep the screen on manually.");
    }
  }, [on]);

  return { on, supported, message, toggle };
}
