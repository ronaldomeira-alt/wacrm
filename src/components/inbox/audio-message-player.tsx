"use client";

import { useEffect, useId, useMemo, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { Play, Pause } from "lucide-react";
import { cn } from "@/lib/utils";
import { useResolvedMediaSrc } from "@/lib/inbox/use-resolved-media-src";
import { useAudioPlaybackSpeed } from "@/lib/inbox/use-audio-playback-speed";
import {
  PAUSE_ALL_AUDIO_EVENT,
  AUDIO_PLAYING_EVENT,
  type AudioPlayingDetail,
  notifyAudioPlaying,
} from "@/lib/inbox/audio-playback-coordinator";

interface AudioMessagePlayerProps {
  url: string;
  isAgent: boolean;
  time: string;
  status: ReactNode;
  playLabel: string;
  pauseLabel: string;
}

const BAR_COUNT = 40;

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Deterministic pseudo-waveform seeded from the media url. There's no
 * server-side peak/amplitude data for voice notes (nothing decodes or
 * stores it), and pulling in real audio analysis just for a decorative
 * bar pattern would be the "complex" solution the task explicitly says
 * to avoid — this reproduces WhatsApp's varied-bar look deterministically
 * per message instead. Only playback/seek need to be accurate, and those
 * run off the real `<audio>` element below.
 */
function useWaveformBars(seed: string) {
  return useMemo(() => {
    let h = 0;
    for (let i = 0; i < seed.length; i++) {
      h = (h * 31 + seed.charCodeAt(i)) | 0;
    }
    const bars: number[] = [];
    for (let i = 0; i < BAR_COUNT; i++) {
      h = (h * 1103515245 + 12345) | 0;
      const r = ((h >>> 0) % 1000) / 1000;
      bars.push(0.25 + r * 0.75);
    }
    return bars;
  }, [seed]);
}

/**
 * WhatsApp-style voice message player embedded directly in the bubble —
 * play/pause, a seekable waveform, elapsed/total time, and a 1x/1.5x/2x
 * speed control. The native `<audio>` element still does the actual
 * decoding/playback (kept in the DOM, just visually hidden); everything
 * visible is custom so no browser media-control chrome ever shows.
 */
export function AudioMessagePlayer({
  url,
  isAgent,
  time,
  status,
  playLabel,
  pauseLabel,
}: AudioMessagePlayerProps) {
  const { src } = useResolvedMediaSrc(url);
  const audioRef = useRef<HTMLAudioElement>(null);
  const waveformRef = useRef<HTMLDivElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const fallbackCtxRef = useRef<AudioContext | null>(null);
  const fallbackSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const fallbackBufferRef = useRef<AudioBuffer | null>(null);
  const fallbackStartedAtRef = useRef<number>(0);
  const fallbackOffsetRef = useRef<number>(0);
  const [usingWebAudioFallback, setUsingWebAudioFallback] = useState(false);
  const { speed, speedLabel, cycleSpeed } = useAudioPlaybackSpeed();
  const speedRef = useRef(speed);
  useEffect(() => {
    speedRef.current = speed;
  }, [speed]);
  const [trackedSrc, setTrackedSrc] = useState(src);
  if (trackedSrc !== src) {
    setTrackedSrc(src);
    setUsingWebAudioFallback(false);
  }
  const bars = useWaveformBars(url);
  const generatedId = useId();
  const playerIdRef = useRef<string>(generatedId);

  const stopWebAudioFallback = (resetOffset = false) => {
    const srcNode = fallbackSourceRef.current;
    if (srcNode) {
      fallbackSourceRef.current = null;
      try {
        srcNode.onended = null;
        srcNode.stop();
      } catch {}
      try {
        srcNode.disconnect();
      } catch {}
    }
    if (resetOffset) {
      fallbackOffsetRef.current = 0;
      setCurrentTime(0);
    }
  };

  // Reset Web Audio buffer cleanly whenever resolved `src` changes
  useEffect(() => {
    const srcNode = fallbackSourceRef.current;
    if (srcNode) {
      fallbackSourceRef.current = null;
      try {
        srcNode.onended = null;
        srcNode.stop();
        srcNode.disconnect();
      } catch {}
    }
    fallbackOffsetRef.current = 0;
    fallbackBufferRef.current = null;
  }, [src]);

  // Pause playback whenever all audio is requested to stop (e.g. mic recording started)
  // or whenever another audio player begins playing; tear down elements on unmount only.
  useEffect(() => {
    const audioEl = audioRef.current;
    const handlePauseAll = () => {
      const audio = audioRef.current;
      if (audio && !audio.paused) {
        audio.pause();
      }
      if (fallbackSourceRef.current) {
        fallbackOffsetRef.current = Math.min(
          fallbackBufferRef.current?.duration ?? 0,
          fallbackOffsetRef.current +
            (fallbackCtxRef.current ? fallbackCtxRef.current.currentTime - fallbackStartedAtRef.current : 0) *
              speedRef.current,
        );
        stopWebAudioFallback(false);
      }
      setIsPlaying(false);
    };

    const handleOtherPlaying = (e: Event) => {
      const customEvent = e as CustomEvent<AudioPlayingDetail>;
      if (customEvent.detail && customEvent.detail.playerId !== playerIdRef.current) {
        handlePauseAll();
      }
    };

    window.addEventListener(PAUSE_ALL_AUDIO_EVENT, handlePauseAll);
    window.addEventListener(AUDIO_PLAYING_EVENT, handleOtherPlaying);

    return () => {
      window.removeEventListener(PAUSE_ALL_AUDIO_EVENT, handlePauseAll);
      window.removeEventListener(AUDIO_PLAYING_EVENT, handleOtherPlaying);
      stopWebAudioFallback(true);
      if (fallbackCtxRef.current) {
        void fallbackCtxRef.current.close().catch(() => {});
        fallbackCtxRef.current = null;
      }
      if (audioEl) {
        try {
          audioEl.pause();
          audioEl.removeAttribute("src");
          audioEl.load();
        } catch {
          // Ignore unmount error
        }
      }
    };
  }, []);

  // Keep audio.playbackRate in sync with the user's preferred speed
  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.playbackRate = speed;
    }
    if (fallbackSourceRef.current) {
      fallbackSourceRef.current.playbackRate.value = speed;
    }
  }, [speed]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onTime = () => setCurrentTime(audio.currentTime);
    const onLoaded = () => {
      setDuration(audio.duration || 0);
      audio.playbackRate = speed;
    };
    const onPlay = () => {
      notifyAudioPlaying(playerIdRef.current);
      audio.playbackRate = speed;
    };
    const onEnded = () => {
      setIsPlaying(false);
      setCurrentTime(0);
    };
    const onError = () => {
      // iOS < 18.4 WebKit may refuse native <audio> playback of OGG/Opus;
      // defer cleanly to Web Audio decodeAudioData on demand when Play is pressed.
      if (src) {
        setUsingWebAudioFallback(true);
      }
    };
    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("loadedmetadata", onLoaded);
    audio.addEventListener("play", onPlay);
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("error", onError);
    return () => {
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("loadedmetadata", onLoaded);
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("error", onError);
    };
  }, [src, speed]);

  // `timeupdate` fires as infrequently as 4x/sec (worse on Safari/iOS PWA),
  // which reads as the waveform progress "jumping" between bars instead of
  // sliding. Polling the same `audio.currentTime` every animation frame
  // while playing gives the same real playback position, just sampled
  // smoothly — no separate animation/timer that could drift out of sync.
  useEffect(() => {
    if (!isPlaying) return;
    let rafId: number;
    const tick = () => {
      if (fallbackSourceRef.current && fallbackCtxRef.current) {
        const elapsed =
          fallbackOffsetRef.current +
          (fallbackCtxRef.current.currentTime - fallbackStartedAtRef.current) * speed;
        const total = fallbackBufferRef.current?.duration ?? duration;
        setCurrentTime(total > 0 ? Math.min(total, elapsed) : elapsed);
      } else {
        const audio = audioRef.current;
        if (audio) setCurrentTime(audio.currentTime);
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [isPlaying, speed, duration]);

  const playWithWebAudioFallback = async () => {
    if (!src || typeof AudioContext === "undefined") return;
    try {
      const ctx = fallbackCtxRef.current ?? new AudioContext();
      fallbackCtxRef.current = ctx;
      if (ctx.state === "suspended") await ctx.resume();
      if (!fallbackBufferRef.current) {
        const res = await fetch(src);
        const arr = await res.arrayBuffer();
        fallbackBufferRef.current = await ctx.decodeAudioData(arr);
        setDuration(fallbackBufferRef.current.duration || 0);
      }
      const buf = fallbackBufferRef.current;
      if (!buf) return;
      stopWebAudioFallback(false);
      const source = ctx.createBufferSource();
      source.buffer = buf;
      source.playbackRate.value = speed;
      source.connect(ctx.destination);
      const offset = fallbackOffsetRef.current >= buf.duration ? 0 : fallbackOffsetRef.current;
      fallbackOffsetRef.current = offset;
      fallbackStartedAtRef.current = ctx.currentTime;
      source.onended = () => {
        if (fallbackSourceRef.current === source) {
          fallbackSourceRef.current = null;
          fallbackOffsetRef.current = 0;
          setIsPlaying(false);
          setCurrentTime(0);
        }
      };
      fallbackSourceRef.current = source;
      notifyAudioPlaying(playerIdRef.current);
      source.start(0, offset);
      setIsPlaying(true);
    } catch {
      setIsPlaying(false);
    }
  };

  const togglePlay = () => {
    if (usingWebAudioFallback) {
      if (isPlaying) {
        if (fallbackCtxRef.current) {
          fallbackOffsetRef.current +=
            (fallbackCtxRef.current.currentTime - fallbackStartedAtRef.current) * speed;
        }
        stopWebAudioFallback(false);
        setIsPlaying(false);
      } else {
        void playWithWebAudioFallback();
      }
      return;
    }

    const audio = audioRef.current;
    if (!audio) return;
    if (isPlaying) {
      audio.pause();
      setIsPlaying(false);
    } else {
      notifyAudioPlaying(playerIdRef.current);
      audio.playbackRate = speed;
      void audio.play().catch(() => {
        setUsingWebAudioFallback(true);
        void playWithWebAudioFallback();
      });
      setIsPlaying(true);
    }
  };

  const handleCycleSpeed = () => {
    const nextSpeed = cycleSpeed();
    if (audioRef.current) audioRef.current.playbackRate = nextSpeed;
  };

  const seekToRatio = (ratio: number) => {
    const audio = audioRef.current;
    if (!audio || !duration) return;
    const next = Math.min(Math.max(ratio, 0), 1) * duration;
    audio.currentTime = next;
    setCurrentTime(next);
  };

  const seekFromClientX = (clientX: number) => {
    const el = waveformRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    seekToRatio((clientX - rect.left) / rect.width);
  };

  const handlePointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    seekFromClientX(e.clientX);
  };
  const handlePointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (e.buttons !== 1) return;
    seekFromClientX(e.clientX);
  };

  const progress = duration > 0 ? currentTime / duration : 0;
  const hasStarted = isPlaying || currentTime > 0;
  const mutedBar = isAgent ? "bg-primary-foreground/30" : "bg-muted-foreground/30";
  const activeBar = isAgent ? "bg-primary-foreground" : "bg-primary";

  return (
    // `mt-2` — reserves clearance in the bubble's top-right corner for
    // message-actions.tsx's corner chevron. Without it the waveform band
    // below starts almost flush with the bubble's own top edge, leaving
    // no room for even a small trigger without sitting on top of the
    // bars — same idea as the `pr-8` reserved for wrapped text in
    // message-bubble.tsx, just on the top edge instead of the right one.
    <div className="mt-2 flex w-52 items-center gap-2">
      <audio ref={audioRef} src={src ?? undefined} preload="metadata" className="hidden" />
      <button
        type="button"
        onClick={togglePlay}
        aria-label={isPlaying ? pauseLabel : playLabel}
        className={cn(
          "order-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-full",
          isAgent
            ? "bg-primary-foreground/20 text-primary-foreground"
            : "bg-primary/15 text-primary-on-soft",
        )}
      >
        {isPlaying ? (
          <Pause className="h-4 w-4 fill-current text-white" />
        ) : (
          <Play className="ml-0.5 h-4 w-4 fill-current text-white" />
        )}
      </button>

      {/* Speed control lives beside the waveform (not inside its band) so it
          gets its own tap area instead of competing with the bars for space.
          Mobile: sent audio left of the waveform, received audio right of
          it — same `isAgent` flag the rest of the bubble already uses for
          left/right alignment, no separate direction logic. Desktop
          (lg+) instead pins it to the right of the waveform always,
          per request — overridden with lg: so mobile is untouched. */}
      {hasStarted && (
        <button
          type="button"
          onClick={handleCycleSpeed}
          aria-label={speedLabel}
          className={cn(
            "flex h-8 min-w-[2.75rem] shrink-0 items-center justify-center rounded-full px-2 text-[11px] font-semibold leading-none text-white",
            isAgent ? "order-2" : "order-3",
            "lg:order-3",
            isAgent ? "bg-primary-foreground/20" : "bg-primary/10",
          )}
        >
          {speedLabel}
        </button>
      )}

      {/* Fixed-height band so the waveform can be centered by construction
          (top-1/2 -translate-y-1/2) instead of by stacking it above the
          info row in a column — that stacking left the waveform's own
          midpoint ~10px above the bubble's actual vertical center, since
          only the info row's height pulled the block's center down. Anchoring
          the info row to the band's bottom edge keeps it clear of the
          waveform without affecting the waveform's centering. */}
      <div className={cn("relative h-14 min-w-0 flex-1", isAgent ? "order-3" : "order-2", "lg:order-2")}>
        {/* Two identical bar layers, same width/positions — the top one is
            clipped to the play progress instead of recoloring bars one at a
            time, so the color edge slides continuously (down to the pixel)
            instead of jumping bar-by-bar. */}
        <div
          ref={waveformRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          className="absolute inset-x-0 top-1/2 h-5 -translate-y-1/2 cursor-pointer touch-none"
        >
          <div className="absolute inset-0 flex items-center justify-between">
            {bars.map((barHeight, i) => (
              <span
                key={i}
                className={cn("w-[2px] shrink-0 rounded-full", mutedBar)}
                style={{ height: `${barHeight * 100}%` }}
              />
            ))}
          </div>
          <div
            className="absolute inset-0 flex items-center justify-between"
            style={{ clipPath: `inset(0 ${100 - progress * 100}% 0 0)` }}
          >
            {bars.map((barHeight, i) => (
              <span
                key={i}
                className={cn("w-[2px] shrink-0 rounded-full", activeBar)}
                style={{ height: `${barHeight * 100}%` }}
              />
            ))}
          </div>
        </div>
        <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-2">
          <span
            className={cn(
              "text-[10px] tabular-nums",
              isAgent ? "text-primary-foreground/70" : "text-muted-foreground",
            )}
          >
            {formatTime(hasStarted ? currentTime : duration)}
          </span>
          <span
            className={cn(
              "flex shrink-0 items-center gap-1 text-[10px]",
              isAgent ? "text-primary-foreground/70" : "text-muted-foreground",
            )}
          >
            {time}
            {status}
          </span>
        </div>
      </div>
    </div>
  );
}
