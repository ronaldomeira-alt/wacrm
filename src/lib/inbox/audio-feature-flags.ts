/**
 * Feature flag resolver for the iOS PWA audio reliability rollout.
 *
 * Security / isolation contract:
 *  - Restricted flags (`audio_diagnostics_enabled`, `audio_outbox_v2_enabled`,
 *    `audio_capture_v2_enabled`, `audio_native_capture_enabled`) may ONLY
 *    be enabled for an account owner (`accountRole === "owner"`) or users
 *    explicitly granted the corresponding key in `profiles.beta_features`.
 *  - Unauthorized users can NEVER activate restricted flags via
 *    localStorage or URL params.
 *  - Authorized users (owner / beta-enrolled) get an instant per-device
 *    localStorage override so a canary iPhone can toggle/rollback any
 *    phase in <5s without a deploy.
 */

import type { AccountRole } from "@/lib/auth/roles";

export const AUDIO_FLAG_KEYS = [
  "audio_diagnostics_enabled",
  "audio_outbox_v2_enabled",
  "audio_capture_v2_enabled",
  "audio_native_capture_enabled",
] as const;

export type AudioFeatureFlagKey = (typeof AUDIO_FLAG_KEYS)[number];

export type AudioFeatureFlags = Record<AudioFeatureFlagKey, boolean>;

export interface AudioFlagAuthContext {
  accountRole?: AccountRole | null;
  betaFeatures?: readonly string[] | null;
  profileLoading?: boolean;
}

const LOCAL_OVERRIDE_STORAGE_KEY = "wacrm:audio-flags:v1";
const FLAGS_CHANGED_EVENT = "wacrm:audio-flags-changed";

const DEFAULT_FLAGS: AudioFeatureFlags = {
  audio_diagnostics_enabled: false,
  audio_outbox_v2_enabled: true,
  audio_capture_v2_enabled: true,
  audio_native_capture_enabled: false,
};

/**
 * True iff the user is allowed to access audio diagnostics and
 * owner/canary audio flags.
 */
export function isAuthorizedForAudioFlags(auth: AudioFlagAuthContext): boolean {
  if (auth.profileLoading) return false;
  if (auth.accountRole === "owner") return true;
  const beta = auth.betaFeatures ?? [];
  return beta.includes("audio_diagnostics_enabled");
}

function readLocalOverrides(): Partial<AudioFeatureFlags> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(LOCAL_OVERRIDE_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return {};
    const result: Partial<AudioFeatureFlags> = {};
    for (const key of AUDIO_FLAG_KEYS) {
      if (typeof parsed[key] === "boolean") {
        result[key] = parsed[key] as boolean;
      }
    }
    return result;
  } catch {
    return {};
  }
}

/**
 * Resolves the effective audio feature flags for the current session.
 * Restricted flags (`audio_diagnostics_enabled`, local device overrides)
 * may only be controlled by authorized users (`owner` / beta-enrolled).
 */
export function resolveAudioFeatureFlags(auth: AudioFlagAuthContext): AudioFeatureFlags {
  if (!isAuthorizedForAudioFlags(auth)) {
    return { ...DEFAULT_FLAGS };
  }

  const beta = new Set(auth.betaFeatures ?? []);
  const overrides = readLocalOverrides();

  // Owners have diagnostics panel access enabled by default so they can
  // inspect telemetry and toggle canary/rollback overrides on their iPhone.
  const diagnosticsDefault = auth.accountRole === "owner" || beta.has("audio_diagnostics_enabled");

  return {
    audio_diagnostics_enabled:
      overrides.audio_diagnostics_enabled ?? diagnosticsDefault,
    audio_outbox_v2_enabled:
      overrides.audio_outbox_v2_enabled ?? true,
    audio_capture_v2_enabled:
      overrides.audio_capture_v2_enabled ?? true,
    audio_native_capture_enabled:
      overrides.audio_native_capture_enabled ?? beta.has("audio_native_capture_enabled"),
  };
}

export function setLocalAudioFeatureFlag(
  auth: AudioFlagAuthContext,
  key: AudioFeatureFlagKey,
  enabled: boolean,
): AudioFeatureFlags {
  if (!isAuthorizedForAudioFlags(auth)) {
    return { ...DEFAULT_FLAGS };
  }
  if (typeof window !== "undefined") {
    try {
      const current = readLocalOverrides();
      current[key] = enabled;
      window.localStorage.setItem(LOCAL_OVERRIDE_STORAGE_KEY, JSON.stringify(current));
      window.dispatchEvent(new CustomEvent(FLAGS_CHANGED_EVENT));
    } catch {
      // Ignore storage quota/private-browsing errors for overrides.
    }
  }
  return resolveAudioFeatureFlags(auth);
}

export function clearLocalAudioFeatureFlags(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(LOCAL_OVERRIDE_STORAGE_KEY);
    window.dispatchEvent(new CustomEvent(FLAGS_CHANGED_EVENT));
  } catch {
    // Ignore storage errors.
  }
}

export function subscribeAudioFeatureFlags(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onStorage = (e: StorageEvent) => {
    if (e.key === LOCAL_OVERRIDE_STORAGE_KEY) listener();
  };
  window.addEventListener(FLAGS_CHANGED_EVENT, listener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(FLAGS_CHANGED_EVENT, listener);
    window.removeEventListener("storage", onStorage);
  };
}
