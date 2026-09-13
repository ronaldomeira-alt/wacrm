import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  parseAudioSpeed,
  getStoredAudioSpeed,
  setStoredAudioSpeed,
  AUDIO_SPEEDS,
  AUDIO_SPEED_LABELS,
} from "./use-audio-playback-speed";

describe("useAudioPlaybackSpeed helper functions", () => {
  let mockStorage: Record<string, string> = {};
  const eventListeners: Record<string, ((e: Event) => void)[]> = {};

  beforeEach(() => {
    mockStorage = {};
    for (const key of Object.keys(eventListeners)) {
      delete eventListeners[key];
    }

    vi.stubGlobal("localStorage", {
      getItem: vi.fn((key: string) => mockStorage[key] ?? null),
      setItem: vi.fn((key: string, value: string) => {
        mockStorage[key] = value;
      }),
      removeItem: vi.fn((key: string) => {
        delete mockStorage[key];
      }),
      clear: vi.fn(() => {
        mockStorage = {};
      }),
    });

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

  it("parses valid speeds and falls back to 1 for invalid values", () => {
    expect(parseAudioSpeed("1")).toBe(1);
    expect(parseAudioSpeed("1.5")).toBe(1.5);
    expect(parseAudioSpeed("2")).toBe(2);
    expect(parseAudioSpeed("3")).toBe(1);
    expect(parseAudioSpeed("invalid")).toBe(1);
    expect(parseAudioSpeed(null)).toBe(1);
  });

  it("stores and retrieves speeds per user independently (e.g. Ronaldo vs Thatianna)", () => {
    const ronaldoId = "user-ronaldo-123";
    const thatiannaId = "user-thatianna-456";

    // Defaults to 1x when nothing stored
    expect(getStoredAudioSpeed(ronaldoId)).toBe(1);
    expect(getStoredAudioSpeed(thatiannaId)).toBe(1);

    // Ronaldo sets 1.5x
    setStoredAudioSpeed(1.5, ronaldoId);
    expect(getStoredAudioSpeed(ronaldoId)).toBe(1.5);
    // Thatianna remains 1x
    expect(getStoredAudioSpeed(thatiannaId)).toBe(1);

    // Thatianna sets 2x
    setStoredAudioSpeed(2, thatiannaId);
    expect(getStoredAudioSpeed(ronaldoId)).toBe(1.5);
    expect(getStoredAudioSpeed(thatiannaId)).toBe(2);

    // Ronaldo changes to 2x
    setStoredAudioSpeed(2, ronaldoId);
    expect(getStoredAudioSpeed(ronaldoId)).toBe(2);
  });

  it("dispatches custom event on window when speed is set", () => {
    let capturedDetail: unknown = null;
    const listener = (e: Event) => {
      capturedDetail = (e as CustomEvent).detail;
    };
    window.addEventListener("wacrm:audio-playback-speed-change", listener);

    setStoredAudioSpeed(1.5, "user-ronaldo-123");

    expect(capturedDetail).toEqual({
      userId: "user-ronaldo-123",
      speed: 1.5,
    });

    window.removeEventListener("wacrm:audio-playback-speed-change", listener);
  });

  it("has correct speed constants and labels", () => {
    expect(AUDIO_SPEEDS).toEqual([1, 1.5, 2]);
    expect(AUDIO_SPEED_LABELS[1]).toBe("1x");
    expect(AUDIO_SPEED_LABELS[1.5]).toBe("1.5x");
    expect(AUDIO_SPEED_LABELS[2]).toBe("2x");
  });
});
