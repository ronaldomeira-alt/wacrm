import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  stopAllAudioPlayback,
  notifyAudioPlaying,
  PAUSE_ALL_AUDIO_EVENT,
  AUDIO_PLAYING_EVENT,
} from "./audio-playback-coordinator";

describe("audio-playback-coordinator", () => {
  const eventListeners: Record<string, ((e: Event) => void)[]> = {};

  beforeEach(() => {
    for (const key of Object.keys(eventListeners)) {
      delete eventListeners[key];
    }

    vi.stubGlobal("window", {
      dispatchEvent: vi.fn((e: Event) => {
        const listeners = eventListeners[e.type] || [];
        for (const l of listeners) l(e);
        return true;
      }),
      addEventListener: vi.fn((type: string, listener: (e: Event) => void) => {
        if (!eventListeners[type]) eventListeners[type] = [];
        eventListeners[type].push(listener);
      }),
      removeEventListener: vi.fn((type: string, listener: (e: Event) => void) => {
        if (!eventListeners[type]) return;
        eventListeners[type] = eventListeners[type].filter((l) => l !== listener);
      }),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stopAllAudioPlayback pauses DOM audio elements and dispatches PAUSE_ALL_AUDIO_EVENT", () => {
    const pause1 = vi.fn();
    const pause2 = vi.fn();

    vi.stubGlobal("document", {
      querySelectorAll: vi.fn(() => [
        { paused: false, pause: pause1 },
        { paused: true, pause: vi.fn() },
        { paused: false, pause: pause2 },
      ]),
    });

    let pauseAllDispatched = false;
    window.addEventListener(PAUSE_ALL_AUDIO_EVENT, () => {
      pauseAllDispatched = true;
    });

    stopAllAudioPlayback();

    expect(pause1).toHaveBeenCalledTimes(1);
    expect(pause2).toHaveBeenCalledTimes(1);
    expect(pauseAllDispatched).toBe(true);
  });

  it("notifyAudioPlaying dispatches AUDIO_PLAYING_EVENT with playerId", () => {
    let capturedDetail: unknown = null;
    window.addEventListener(AUDIO_PLAYING_EVENT, (e) => {
      capturedDetail = (e as CustomEvent).detail;
    });

    notifyAudioPlaying("player-123");

    expect(capturedDetail).toEqual({
      playerId: "player-123",
    });
  });
});
