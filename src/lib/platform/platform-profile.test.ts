import { describe, expect, it, afterEach } from "vitest";
import { getPlatformProfile } from "./platform-profile";

describe("getPlatformProfile", () => {
  const originalWindow = global.window;

  afterEach(() => {
    global.window = originalWindow;
  });

  it("returns desktop profile by default in node / SSR", () => {
    const profile = getPlatformProfile();
    expect(profile.platform).toBe("desktop");
    expect(profile.isDesktop).toBe(true);
    expect(profile.isIPhone).toBe(false);
    expect(profile.maxInboxLeads).toBeNull();
    expect(profile.maxInitialMessages).toBeNull();
    expect(profile.allowOlderHistoryLoad).toBe(true);
    expect(profile.aggressiveResourceCleanup).toBe(false);
    expect(profile.maxCachedConversations).toBe(10);
  });

  it("detects iPhone user agent and returns mobile profile", () => {
    global.window = {
      navigator: {
        userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
        platform: "iPhone",
      },
      matchMedia: () => ({ matches: false }),
      location: { search: "" },
      sessionStorage: {
        getItem: () => null,
        setItem: () => {},
      },
    } as unknown as Window & typeof globalThis;

    const profile = getPlatformProfile();
    expect(profile.platform).toBe("iphone");
    expect(profile.isIPhone).toBe(true);
    expect(profile.maxInboxLeads).toBe(50);
    expect(profile.maxInitialMessages).toBe(30);
    expect(profile.maxCachedConversations).toBe(3);
    expect(profile.maxCachedMessagesPerConv).toBe(30);
    expect(profile.allowOlderHistoryLoad).toBe(false);
    expect(profile.aggressiveResourceCleanup).toBe(true);
  });
});
