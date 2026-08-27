"use client";

import { useEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { Play, Pause } from "lucide-react";
import { cn } from "@/lib/utils";
import { useResolvedMediaSrc } from "@/lib/inbox/use-resolved-media-src";

interface AudioMessagePlayerProps {
  url: string;
  isAgent: boolean;
  time: string;
  status: ReactNode;
  playLabel: string;
  pauseLabel: string;
}

const BAR_COUNT = 40;
const SPEEDS = [1, 1.5, 2] as const;
const SPEED_LABELS: Record<(typeof SPEEDS)[number], string> = {
  1: "1x",
  1.5: "1.5x",
  2: "2x",
};

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
  const [speedIndex, setSpeedIndex] = useState(0);
  const bars = useWaveformBars(url);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onTime = () => setCurrentTime(audio.currentTime);
    const onLoaded = () => setDuration(audio.duration || 0);
    const onEnded = () => {
      setIsPlaying(false);
      setCurrentTime(0);
    };
    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("loadedmetadata", onLoaded);
    audio.addEventListener("ended", onEnded);
    return () => {
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("loadedmetadata", onLoaded);
      audio.removeEventListener("ended", onEnded);
    };
  }, [src]);

  // `timeupdate` fires as infrequently as 4x/sec (worse on Safari/iOS PWA),
  // which reads as the waveform progress "jumping" between bars instead of
  // sliding. Polling the same `audio.currentTime` every animation frame
  // while playing gives the same real playback position, just sampled
  // smoothly — no separate animation/timer that could drift out of sync.
  useEffect(() => {
    if (!isPlaying) return;
    let rafId: number;
    const tick = () => {
      const audio = audioRef.current;
      if (audio) setCurrentTime(audio.currentTime);
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [isPlaying]);

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (isPlaying) {
      audio.pause();
      setIsPlaying(false);
    } else {
      void audio.play();
      setIsPlaying(true);
    }
  };

  const cycleSpeed = () => {
    const next = (speedIndex + 1) % SPEEDS.length;
    setSpeedIndex(next);
    if (audioRef.current) audioRef.current.playbackRate = SPEEDS[next];
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
    <div className="flex w-52 items-center gap-2">
      <audio ref={audioRef} src={src ?? undefined} preload="metadata" className="hidden" />
      <button
        type="button"
        onClick={togglePlay}
        aria-label={isPlaying ? pauseLabel : playLabel}
        className={cn(
          "order-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-full",
          isAgent
            ? "bg-primary-foreground/20 text-primary-foreground"
            : "bg-primary/15 text-primary",
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
          Sent audio: left of the waveform. Received audio: right of it —
          same `isAgent` flag the rest of the bubble already uses for
          left/right alignment, no separate direction logic. */}
      {hasStarted && (
        <button
          type="button"
          onClick={cycleSpeed}
          aria-label={SPEED_LABELS[SPEEDS[speedIndex]]}
          className={cn(
            "flex h-8 min-w-[2.75rem] shrink-0 items-center justify-center rounded-full px-2 text-[11px] font-semibold leading-none text-white",
            isAgent ? "order-2" : "order-3",
            isAgent ? "bg-primary-foreground/20" : "bg-primary/10",
          )}
        >
          {SPEED_LABELS[SPEEDS[speedIndex]]}
        </button>
      )}

      {/* Fixed-height band so the waveform can be centered by construction
          (top-1/2 -translate-y-1/2) instead of by stacking it above the
          info row in a column — that stacking left the waveform's own
          midpoint ~10px above the bubble's actual vertical center, since
          only the info row's height pulled the block's center down. Anchoring
          the info row to the band's bottom edge keeps it clear of the
          waveform without affecting the waveform's centering. */}
      <div className={cn("relative h-14 min-w-0 flex-1", isAgent ? "order-3" : "order-2")}>
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
