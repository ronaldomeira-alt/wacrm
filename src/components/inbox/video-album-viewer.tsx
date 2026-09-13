"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Play, RotateCw, VideoOff, X } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useResolvedMediaSrc, useResolvedMediaSrcs } from "@/lib/inbox/use-resolved-media-src";
import { getLocalVideoThumbnail } from "@/lib/media/video-thumbnail";
import type { Message } from "@/types";

export interface VideoAlbumViewerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  messages: Message[];
  initialIndex?: number;
  onRetryMessage?: (message: Message) => void;
}

function VideoSlot({
  message,
  src: propSrc,
  isActive,
}: {
  message: Message;
  src?: string;
  isActive: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  // Self-resolve video src if propSrc is empty or still resolving
  const { src: selfResolvedSrc } = useResolvedMediaSrc(message.media_url);

  // Thumbnail / poster resolution using the same priority as MessageBubble & MessageAlbum
  const rawThumbnail = (message.metadata as Record<string, unknown> | undefined)?.thumbnail_url;
  const thumbnailUrl = typeof rawThumbnail === "string" ? rawThumbnail : null;
  const { src: resolvedThumbnailSrc } = useResolvedMediaSrc(
    thumbnailUrl && !thumbnailUrl.startsWith("data:") ? thumbnailUrl : undefined
  );
  const poster =
    (thumbnailUrl?.startsWith("data:") ? thumbnailUrl : resolvedThumbnailSrc) ||
    (message.media_url ? getLocalVideoThumbnail(message.media_url) : null) ||
    getLocalVideoThumbnail(message.id) ||
    undefined;

  // Safe valid playable source: must be http, https, blob, or data URL
  const candidateSrc = propSrc || selfResolvedSrc;
  const validSrc =
    candidateSrc &&
    (candidateSrc.startsWith("http://") ||
      candidateSrc.startsWith("https://") ||
      candidateSrc.startsWith("blob:") ||
      candidateSrc.startsWith("data:"))
      ? candidateSrc
      : undefined;

  const hasError = !!validSrc && failedSrc === validSrc;

  // Auto-pause video when scrolled out of view
  useEffect(() => {
    if (!isActive && videoRef.current && !videoRef.current.paused) {
      videoRef.current.pause();
    }
  }, [isActive]);

  const handlePlayClick = () => {
    if (videoRef.current) {
      videoRef.current.play().catch(() => {});
      setIsPlaying(true);
    }
  };

  if (hasError) {
    return (
      <div className="relative flex h-full w-full max-h-[85vh] max-w-[90vw] md:max-h-[88vh] md:max-w-[85vw] items-center justify-center m-auto">
        {poster && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={poster}
            alt="Prévia do vídeo"
            className="max-h-[85vh] max-w-[90vw] md:max-h-[88vh] md:max-w-[85vw] rounded-xl object-contain opacity-40 m-auto select-none pointer-events-none"
          />
        )}
        <div className="absolute flex flex-col items-center justify-center gap-2 rounded-xl bg-black/75 p-6 text-center text-white/90 backdrop-blur-md">
          <VideoOff className="h-10 w-10 text-muted-foreground" />
          <p className="text-xs">Não foi possível reproduzir este vídeo</p>
          {validSrc && (
            <a
              href={validSrc}
              target="_blank"
              rel="noopener noreferrer"
              download
              className="mt-2 text-xs text-primary underline underline-offset-2 cursor-pointer"
            >
              Baixar vídeo
            </a>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex h-full w-full max-h-[85vh] max-w-[90vw] md:max-h-[88vh] md:max-w-[85vw] items-center justify-center m-auto">
      {validSrc ? (
        <div className="relative flex h-full w-full items-center justify-center">
          <video
            ref={videoRef}
            src={validSrc}
            poster={poster}
            controls
            playsInline
            preload="auto"
            onError={() => setFailedSrc(validSrc ?? null)}
            onPlay={() => setIsPlaying(true)}
            onPause={() => setIsPlaying(false)}
            onClick={(e) => e.stopPropagation()}
            className="max-h-[85vh] max-w-[90vw] md:max-h-[88vh] md:max-w-[85vw] rounded-xl object-contain shadow-2xl m-auto select-none"
          />

          {/* Central play overlay before user starts playback */}
          {!isPlaying && (
            <button
              type="button"
              onClick={handlePlayClick}
              aria-label="Reproduzir vídeo"
              className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 flex h-16 w-16 items-center justify-center rounded-full bg-black/60 text-white backdrop-blur-sm transition hover:scale-110 hover:bg-black/80 active:scale-95 shadow-xl cursor-pointer pointer-events-auto"
            >
              <Play className="h-8 w-8 fill-white ml-1" />
            </button>
          )}
        </div>
      ) : (
        <div className="relative flex h-full w-full max-h-[85vh] max-w-[90vw] items-center justify-center">
          {poster && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={poster}
              alt="Prévia do vídeo"
              className="max-h-[85vh] max-w-[90vw] md:max-h-[88vh] md:max-w-[85vw] rounded-xl object-contain opacity-50 m-auto select-none pointer-events-none"
            />
          )}
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="h-10 w-10 animate-spin rounded-full border-3 border-primary border-t-transparent" />
          </div>
        </div>
      )}
    </div>
  );
}

export function VideoAlbumViewer({
  open,
  onOpenChange,
  messages,
  initialIndex = 0,
  onRetryMessage,
}: VideoAlbumViewerProps) {
  const [index, setIndex] = useState(initialIndex);
  const urls = useMemo(() => messages.map((m) => m.media_url || ""), [messages]);
  const { urls: resolvedUrls } = useResolvedMediaSrcs(urls);

  const albumScrollRef = useRef<HTMLDivElement>(null);
  const albumScrollRafRef = useRef<number | null>(null);

  // Sync with initialIndex when opening
  useEffect(() => {
    if (!open) return;
    const raf = requestAnimationFrame(() => {
      setIndex(initialIndex);
      const el = albumScrollRef.current;
      if (el) {
        el.scrollTop = initialIndex * el.clientHeight;
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [open, initialIndex]);

  // Clean-up rAF
  useEffect(() => {
    return () => {
      if (albumScrollRafRef.current !== null) {
        cancelAnimationFrame(albumScrollRafRef.current);
      }
    };
  }, []);

  // Continuous vertical scroll-snap detection (identical to photo lightbox)
  const handleAlbumScroll = useCallback(() => {
    if (albumScrollRafRef.current !== null) return;
    albumScrollRafRef.current = requestAnimationFrame(() => {
      albumScrollRafRef.current = null;
      const el = albumScrollRef.current;
      if (!el || el.clientHeight <= 0) return;
      const next = Math.min(
        Math.max(Math.round(el.scrollTop / el.clientHeight), 0),
        messages.length - 1
      );
      setIndex((prev) => (prev === next ? prev : next));
    });
  }, [messages.length]);

  const currentMessage = messages[index];
  const isCurrentFailed =
    currentMessage?.status === "failed" &&
    !Boolean((currentMessage?.metadata as Record<string, unknown> | undefined)?.cancelled);
  const isCurrentSending = currentMessage?.status === "sending";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="inset-0 top-0 left-0 h-[100dvh] w-screen max-w-none translate-x-0 translate-y-0 rounded-none border-none bg-black/95 p-0 ring-0 sm:max-w-none z-50 flex flex-col items-center justify-center overflow-hidden select-none"
      >
        <DialogTitle className="sr-only">Visualizador de Álbum de Vídeos</DialogTitle>
        <DialogDescription className="sr-only">
          Visualização em carrossel vertical dos vídeos agrupados
        </DialogDescription>

        {/* Top bar: Close button */}
        <button
          type="button"
          onClick={() => onOpenChange(false)}
          aria-label="Fechar visualizador"
          className="absolute right-4 z-30 flex h-10 w-10 items-center justify-center rounded-full bg-black/50 text-white/90 hover:bg-black/75 backdrop-blur-sm cursor-pointer transition-colors"
          style={{ top: "calc(0.75rem + env(safe-area-inset-top))" }}
        >
          <X className="h-5 w-5" />
        </button>

        {/* Top bar: Index counter badge */}
        {messages.length > 1 && (
          <div
            className="absolute left-1/2 z-30 -translate-x-1/2 rounded-full bg-black/50 backdrop-blur-sm px-3.5 py-1 text-xs font-medium text-white/90 shadow-md pointer-events-none"
            style={{ top: "calc(0.75rem + env(safe-area-inset-top))" }}
          >
            {index + 1} / {messages.length}
          </div>
        )}

        {/* Vertical scroll-snap container */}
        <div
          ref={albumScrollRef}
          onScroll={handleAlbumScroll}
          className="h-full w-full snap-y snap-mandatory overflow-y-auto overscroll-y-contain flex flex-col"
        >
          {messages.map((m, i) => (
            <div
              key={m.id || i}
              className="relative flex h-full min-h-[100dvh] w-full snap-start snap-always items-center justify-center p-4 sm:p-8 shrink-0"
              onClick={() => {
                // Clicking outside the video player closes the dialog
                onOpenChange(false);
              }}
            >
              <div onClick={(e) => e.stopPropagation()} className="flex items-center justify-center">
                <VideoSlot
                  message={m}
                  src={resolvedUrls[i]}
                  isActive={index === i}
                />
              </div>
            </div>
          ))}
        </div>

        {/* Bottom Floating Action Bar for Failed Video */}
        {isCurrentFailed && (
          <div
            className="absolute left-1/2 z-30 -translate-x-1/2 flex items-center gap-3 rounded-full bg-black/80 backdrop-blur-xl border border-white/15 px-4 py-2 text-white shadow-2xl animate-in fade-in slide-in-from-bottom-2 duration-200 select-none max-w-[90vw] whitespace-nowrap"
            style={{ bottom: "calc(1.5rem + env(safe-area-inset-bottom))" }}
          >
            <div className="flex items-center gap-1.5 text-xs text-white/90">
              <AlertCircle className="h-4 w-4 text-rose-400 shrink-0" />
              <span className="font-medium">Falha no envio do vídeo {index + 1}</span>
            </div>
            {onRetryMessage && currentMessage && (
              <button
                type="button"
                onClick={() => onRetryMessage(currentMessage)}
                className="flex items-center gap-1.5 rounded-full bg-primary hover:bg-primary/90 active:scale-95 px-3 py-1 text-xs font-medium text-primary-foreground shadow transition shrink-0 cursor-pointer"
              >
                <RotateCw className="h-3.5 w-3.5" />
                <span>Reenviar</span>
              </button>
            )}
          </div>
        )}

        {/* Bottom Floating status indicator when sending/retrying */}
        {isCurrentSending && (
          <div
            className="absolute left-1/2 z-30 -translate-x-1/2 flex items-center gap-2 rounded-full bg-black/85 backdrop-blur-md px-4 py-2 text-white/90 border border-white/20 shadow-2xl text-xs font-medium animate-in fade-in duration-200 select-none"
            style={{ bottom: "calc(1.5rem + env(safe-area-inset-bottom))" }}
          >
            <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            <span>Enviando vídeo {index + 1}...</span>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
