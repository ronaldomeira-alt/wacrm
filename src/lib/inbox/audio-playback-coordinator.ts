"use client";

export const PAUSE_ALL_AUDIO_EVENT = "wacrm:pause-all-audio";
export const AUDIO_PLAYING_EVENT = "wacrm:audio-playing";

export interface AudioPlayingDetail {
  playerId: string;
}

/**
 * Immediately pauses all audio elements across the document
 * and dispatches a global event so React players update their state.
 */
export function stopAllAudioPlayback(): void {
  if (typeof window === "undefined") return;

  // Direct DOM pause for any active HTMLAudioElement (0ms latency)
  if (typeof document !== "undefined") {
    document.querySelectorAll("audio").forEach((audio) => {
      try {
        if (!audio.paused) {
          audio.pause();
        }
      } catch (err) {
        console.warn("Error pausing audio element:", err);
      }
    });
  }

  // Notify all React AudioMessagePlayer components to reset isPlaying state
  window.dispatchEvent(new CustomEvent(PAUSE_ALL_AUDIO_EVENT));
}

/**
 * Notifies the system that an audio player has started playing,
 * causing all other audio players to pause.
 */
export function notifyAudioPlaying(playerId: string): void {
  if (typeof window === "undefined") return;

  window.dispatchEvent(
    new CustomEvent<AudioPlayingDetail>(AUDIO_PLAYING_EVENT, {
      detail: { playerId },
    })
  );
}
