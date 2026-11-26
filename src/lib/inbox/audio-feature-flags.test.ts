import { beforeEach, describe, expect, it } from "vitest";
import {
  clearLocalAudioFeatureFlags,
  isAuthorizedForAudioFlags,
  resolveAudioFeatureFlags,
  setLocalAudioFeatureFlag,
} from "./audio-feature-flags";

function installMemoryLocalStorage() {
  const store = new Map<string, string>();
  const mockWindow = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
    },
    dispatchEvent: () => true,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  (globalThis as unknown as { window?: unknown }).window = mockWindow;
  (globalThis as unknown as { CustomEvent?: unknown }).CustomEvent = class {
    constructor(public type: string) {}
  };
  return store;
}

describe("audio-feature-flags", () => {
  beforeEach(() => {
    installMemoryLocalStorage();
    clearLocalAudioFeatureFlags();
  });

  it("never grants restricted flags to unauthorized roles or while loading", () => {
    const store = installMemoryLocalStorage();
    store.set(
      "wacrm:audio-flags:v1",
      JSON.stringify({
        audio_diagnostics_enabled: true,
        audio_outbox_v2_enabled: true,
        audio_capture_v2_enabled: true,
        audio_native_capture_enabled: true,
      }),
    );

    expect(isAuthorizedForAudioFlags({ accountRole: "agent", betaFeatures: [] })).toBe(false);
    expect(isAuthorizedForAudioFlags({ accountRole: "viewer", betaFeatures: [] })).toBe(false);
    expect(
      isAuthorizedForAudioFlags({
        accountRole: "owner",
        betaFeatures: [],
        profileLoading: true,
      }),
    ).toBe(false);

    const agentFlags = resolveAudioFeatureFlags({ accountRole: "agent", betaFeatures: [] });
    expect(agentFlags).toEqual({
      audio_diagnostics_enabled: false,
      audio_outbox_v2_enabled: false,
      audio_capture_v2_enabled: false,
      audio_native_capture_enabled: false,
    });
  });

  it("allows owner to enable diagnostics by default and toggle canary flags locally", () => {
    const ownerCtx = { accountRole: "owner" as const, betaFeatures: [] };
    expect(isAuthorizedForAudioFlags(ownerCtx)).toBe(true);
    expect(resolveAudioFeatureFlags(ownerCtx).audio_diagnostics_enabled).toBe(true);
    expect(resolveAudioFeatureFlags(ownerCtx).audio_outbox_v2_enabled).toBe(false);

    const updated = setLocalAudioFeatureFlag(ownerCtx, "audio_outbox_v2_enabled", true);
    expect(updated.audio_outbox_v2_enabled).toBe(true);

    const rolledBack = setLocalAudioFeatureFlag(ownerCtx, "audio_outbox_v2_enabled", false);
    expect(rolledBack.audio_outbox_v2_enabled).toBe(false);
  });

  it("allows beta-enrolled diagnostics user to use flags", () => {
    const betaCtx = {
      accountRole: "admin" as const,
      betaFeatures: ["audio_diagnostics_enabled", "audio_outbox_v2_enabled"],
    };
    const flags = resolveAudioFeatureFlags(betaCtx);
    expect(flags.audio_diagnostics_enabled).toBe(true);
    expect(flags.audio_outbox_v2_enabled).toBe(true);
    expect(flags.audio_capture_v2_enabled).toBe(false);
  });
});
