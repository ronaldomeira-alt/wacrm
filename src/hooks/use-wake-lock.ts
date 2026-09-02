"use client";

import { useEffect, useRef } from "react";

/**
 * Screen Wake Lock API (https://developer.mozilla.org/docs/Web/API/Screen_Wake_Lock_API)
 * — holds `navigator.wakeLock` for as long as `active` is true, so the OS
 * doesn't dim/lock the screen on its own inactivity timer. Supported in
 * Safari/WKWebView, including an installed iOS home-screen PWA, since
 * iOS/iPadOS 16.4; older iOS and browsers without the API just no-op —
 * nothing that depends on `active` should ever require this to succeed.
 *
 * Doesn't (and can't) override the physical side-button lock — no web API
 * can; this only cancels the OS's own idle-timeout dimming/lock.
 */
export function useWakeLock(active: boolean) {
  const sentinelRef = useRef<WakeLockSentinel | null>(null);

  useEffect(() => {
    if (!active || typeof navigator === "undefined" || !("wakeLock" in navigator)) {
      return;
    }

    let cancelled = false;

    const acquire = async () => {
      try {
        const sentinel = await navigator.wakeLock.request("screen");
        if (cancelled) {
          // `active` already flipped false (or this effect re-ran) before
          // the request resolved — release right away instead of leaving
          // a lock held for a recording that's no longer running.
          void sentinel.release().catch(() => {});
          return;
        }
        sentinelRef.current = sentinel;
      } catch {
        // Request can reject (backgrounded document, low battery, no
        // transient activation left, etc.) — voice recording itself never
        // depends on this, so failures here are silent.
      }
    };

    void acquire();

    // The platform force-releases the sentinel the instant the document
    // goes hidden (e.g. the agent switches apps mid-recording) — this is
    // the one case `active` alone won't catch, since it hasn't changed.
    // Re-request the moment the page is visible again, for as long as
    // `active` still holds.
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible" && sentinelRef.current === null) {
        void acquire();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      const sentinel = sentinelRef.current;
      sentinelRef.current = null;
      if (sentinel) void sentinel.release().catch(() => {});
    };
  }, [active]);
}
