"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import {
  resolveAudioFeatureFlags,
  subscribeAudioFeatureFlags,
  type AudioFeatureFlags,
} from "./audio-feature-flags";

/**
 * React hook subscribing to audio feature flags (`audio-feature-flags.ts`),
 * updating immediately if an owner toggles a canary/rollback switch in
 * `AudioDiagnosticsDrawer`.
 */
export function useAudioFeatureFlags(): AudioFeatureFlags {
  const { accountRole, profile, profileLoading } = useAuth();
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    return subscribeAudioFeatureFlags(() => setRevision((r) => r + 1));
  }, []);

  void revision;
  return resolveAudioFeatureFlags({
    accountRole,
    betaFeatures: profile?.beta_features,
    profileLoading,
  });
}
