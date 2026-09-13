"use client";

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/hooks/use-auth";

export const AUDIO_SPEEDS = [1, 1.5, 2] as const;
export type AudioSpeed = (typeof AUDIO_SPEEDS)[number];

export const AUDIO_SPEED_LABELS: Record<AudioSpeed, string> = {
  1: "1x",
  1.5: "1.5x",
  2: "2x",
};

const STORAGE_PREFIX = "wacrm:audio_playback_speed:";
const SPEED_CHANGE_EVENT = "wacrm:audio-playback-speed-change";

interface SpeedChangeDetail {
  userId: string;
  speed: AudioSpeed;
}

export function parseAudioSpeed(raw: string | null): AudioSpeed {
  const num = Number(raw);
  if (num === 1 || num === 1.5 || num === 2) {
    return num as AudioSpeed;
  }
  return 1;
}

export function getStoredAudioSpeed(userId?: string | null): AudioSpeed {
  if (typeof window === "undefined") return 1;
  const key = `${STORAGE_PREFIX}${userId || "global"}`;
  try {
    return parseAudioSpeed(localStorage.getItem(key));
  } catch {
    return 1;
  }
}

export function setStoredAudioSpeed(speed: AudioSpeed, userId?: string | null): void {
  if (typeof window === "undefined") return;
  const userKey = userId || "global";
  const storageKey = `${STORAGE_PREFIX}${userKey}`;
  try {
    localStorage.setItem(storageKey, String(speed));
  } catch (err) {
    console.warn("Failed to persist audio playback speed to localStorage:", err);
  }

  window.dispatchEvent(
    new CustomEvent<SpeedChangeDetail>(SPEED_CHANGE_EVENT, {
      detail: { userId: userKey, speed },
    })
  );
}

export function useAudioPlaybackSpeed() {
  const { user } = useAuth();
  const userId = user?.id || "global";

  const [speed, setSpeedState] = useState<AudioSpeed>(() => getStoredAudioSpeed(userId));

  // Sync state when userId loads or changes (e.g. login or profile resolution)
  useEffect(() => {
    setSpeedState(getStoredAudioSpeed(userId));
  }, [userId]);

  // Listen for speed changes across other mounted audio players or tabs
  useEffect(() => {
    const onCustomEvent = (e: Event) => {
      const customEvent = e as CustomEvent<SpeedChangeDetail>;
      if (customEvent.detail && customEvent.detail.userId === userId) {
        setSpeedState(customEvent.detail.speed);
      }
    };

    const onStorage = (e: StorageEvent) => {
      if (e.key === `${STORAGE_PREFIX}${userId}`) {
        setSpeedState(parseAudioSpeed(e.newValue));
      }
    };

    window.addEventListener(SPEED_CHANGE_EVENT, onCustomEvent);
    window.addEventListener("storage", onStorage);

    return () => {
      window.removeEventListener(SPEED_CHANGE_EVENT, onCustomEvent);
      window.removeEventListener("storage", onStorage);
    };
  }, [userId]);

  const setSpeed = useCallback(
    (nextSpeed: AudioSpeed) => {
      setSpeedState(nextSpeed);
      setStoredAudioSpeed(nextSpeed, userId);
    },
    [userId]
  );

  const cycleSpeed = useCallback((): AudioSpeed => {
    const currentIndex = AUDIO_SPEEDS.indexOf(speed);
    const nextIndex = (currentIndex + 1) % AUDIO_SPEEDS.length;
    const nextSpeed = AUDIO_SPEEDS[nextIndex];
    setSpeed(nextSpeed);
    return nextSpeed;
  }, [speed, setSpeed]);

  return {
    speed,
    speedLabel: AUDIO_SPEED_LABELS[speed],
    setSpeed,
    cycleSpeed,
  };
}
