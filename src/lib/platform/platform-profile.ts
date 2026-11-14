"use client";

import { useEffect, useState } from "react";

export interface PlatformProfile {
  platform: "iphone" | "desktop";
  isIPhone: boolean;
  isDesktop: boolean;
  /** Max leads queried from DB for the inbox (50 on iPhone, null/unlimited on desktop) */
  maxInboxLeads: number | null;
  /** Max messages initially queried when opening a conversation (30 on iPhone, null/unlimited on desktop) */
  maxInitialMessages: number | null;
  /** Max conversations kept in memory cache (3 on iPhone, 10 on desktop) */
  maxCachedConversations: number;
  /** Max messages kept per cached conversation (30 on iPhone, null/unlimited on desktop) */
  maxCachedMessagesPerConv: number | null;
  /** Whether to allow unbounded older history loading (false on iPhone, true on desktop) */
  allowOlderHistoryLoad: boolean;
  /** Whether audio blobs and heavy media are aggressively pruned on unmount (true on iPhone) */
  aggressiveResourceCleanup: boolean;
}

const IPHONE_PROFILE: PlatformProfile = {
  platform: "iphone",
  isIPhone: true,
  isDesktop: false,
  maxInboxLeads: 50,
  maxInitialMessages: 30,
  maxCachedConversations: 3,
  maxCachedMessagesPerConv: 30,
  allowOlderHistoryLoad: false,
  aggressiveResourceCleanup: true,
};

const DESKTOP_PROFILE: PlatformProfile = {
  platform: "desktop",
  isIPhone: false,
  isDesktop: true,
  maxInboxLeads: null,
  maxInitialMessages: null,
  maxCachedConversations: 10,
  maxCachedMessagesPerConv: null,
  allowOlderHistoryLoad: true,
  aggressiveResourceCleanup: false,
};

/**
 * Resolves the active platform profile.
 * Detects iPhone/Safari/PWA or mobile standalone vs Windows/Desktop.
 * Also supports an explicit URL/session override for auditing and automated testing.
 */
export function getPlatformProfile(): PlatformProfile {
  if (typeof window === "undefined") {
    // Default to desktop during SSR to avoid hydration flash on desktop
    return DESKTOP_PROFILE;
  }

  // 1. Check URL or SessionStorage override (for automated testing or QA switch)
  try {
    const urlParams = new URLSearchParams(window.location.search);
    const urlOverride = urlParams.get("platform");
    if (urlOverride === "iphone") {
      sessionStorage.setItem("wacrm_platform_override", "iphone");
      return IPHONE_PROFILE;
    }
    if (urlOverride === "desktop") {
      sessionStorage.setItem("wacrm_platform_override", "desktop");
      return DESKTOP_PROFILE;
    }

    const sessionOverride = sessionStorage.getItem("wacrm_platform_override");
    if (sessionOverride === "iphone") return IPHONE_PROFILE;
    if (sessionOverride === "desktop") return DESKTOP_PROFILE;
  } catch {
    // Ignore storage errors in private browsing
  }

  // 2. Detect iOS / iPhone / iPad Safari / PWA
  const ua = window.navigator.userAgent || "";
  const isIos =
    /iPhone|iPad|iPod/i.test(ua) ||
    (window.navigator.platform === "MacIntel" && window.navigator.maxTouchPoints > 1);

  // 3. Detect standalone PWA mode
  const isStandalone =
    ("standalone" in window.navigator && Boolean((window.navigator as unknown as { standalone: boolean }).standalone)) ||
    window.matchMedia("(display-mode: standalone)").matches;

  // 4. Detect mobile viewport & touch
  const isMobileViewport = window.matchMedia("(max-width: 1023px)").matches;
  const isMobileUA = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua);

  // iPhone Safari / PWA / Mobile profile criteria:
  if (isIos || isStandalone || (isMobileViewport && isMobileUA)) {
    return IPHONE_PROFILE;
  }

  // Default: Windows / Desktop full experience
  return DESKTOP_PROFILE;
}

/**
 * React hook that returns the active platform profile and subscribes to viewport changes.
 */
export function usePlatformProfile(): PlatformProfile {
  const [profile, setProfile] = useState<PlatformProfile>(() => getPlatformProfile());

  useEffect(() => {
    const update = () => setProfile(getPlatformProfile());
    update();

    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  return profile;
}
