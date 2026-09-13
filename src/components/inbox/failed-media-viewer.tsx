"use client";

import { useEffect, useState } from "react";
import { AlertCircle, Eye, ImageOff, Play, RotateCw, VideoOff, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useResolvedMediaSrc } from "@/lib/inbox/use-resolved-media-src";
import { getLocalVideoThumbnail } from "@/lib/media/video-thumbnail";
import type { Message } from "@/types";

export interface FailedMediaViewerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  failedMessages: Message[];
  onRetryMessage?: (message: Message) => void;
}

function CleanMediaViewer({ message }: { message: Message }) {
  const url = message.media_url || "";
  const isVideo = message.content_type === "video";
  const { src, loading, error } = useResolvedMediaSrc(url);
  const [loadError, setLoadError] = useState(false);

  const rawThumbnail = (message.metadata as Record<string, unknown> | undefined)?.thumbnail_url;
  const thumbnailUrl = typeof rawThumbnail === "string" ? rawThumbnail : null;
  const { src: resolvedThumbnailSrc } = useResolvedMediaSrc(
    thumbnailUrl && !thumbnailUrl.startsWith("data:") ? thumbnailUrl : undefined
  );
  const poster =
    (thumbnailUrl?.startsWith("data:") ? thumbnailUrl : resolvedThumbnailSrc) ||
    (url ? getLocalVideoThumbnail(url) : null) ||
    getLocalVideoThumbnail(message.id) ||
    undefined;

  if (error || loadError) {
    return (
      <div className="flex h-full w-full items-center justify-center">
        {isVideo ? (
          <VideoOff className="h-10 w-10 text-muted-foreground" />
        ) : (
          <ImageOff className="h-10 w-10 text-muted-foreground" />
        )}
      </div>
    );
  }

  if (loading || !src) {
    return (
      <div className="flex h-full w-full items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  if (isVideo) {
    return (
      <video
        src={src}
        poster={poster}
        controls
        playsInline
        onError={() => setLoadError(true)}
        className="max-h-full max-w-full object-contain rounded-sm"
      />
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      draggable={false}
      onError={() => setLoadError(true)}
      className="max-h-full max-w-full object-contain rounded-sm"
    />
  );
}

function FailedThumbnail({ message }: { message: Message }) {
  const url = message.media_url || "";
  const isVideo = message.content_type === "video";
  const { src, loading, error } = useResolvedMediaSrc(url);

  const rawThumbnail = (message.metadata as Record<string, unknown> | undefined)?.thumbnail_url;
  const thumbnailUrl = typeof rawThumbnail === "string" ? rawThumbnail : null;
  const { src: resolvedThumbnailSrc } = useResolvedMediaSrc(
    thumbnailUrl && !thumbnailUrl.startsWith("data:") ? thumbnailUrl : undefined
  );
  const poster =
    (thumbnailUrl?.startsWith("data:") ? thumbnailUrl : resolvedThumbnailSrc) ||
    (url ? getLocalVideoThumbnail(url) : null) ||
    getLocalVideoThumbnail(message.id) ||
    null;

  const displaySrc = isVideo ? (poster || src) : src;

  if (error && !poster) {
    return (
      <div className="flex h-full w-full items-center justify-center">
        {isVideo ? (
          <VideoOff className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ImageOff className="h-4 w-4 text-muted-foreground" />
        )}
      </div>
    );
  }

  if ((loading || !displaySrc) && !poster) {
    return (
      <div className="flex h-full w-full items-center justify-center">
        <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="relative h-full w-full overflow-hidden">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={displaySrc || poster || ""}
        alt=""
        draggable={false}
        className="h-full w-full object-cover"
      />
      {isVideo && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/30">
          <Play className="h-3.5 w-3.5 fill-white text-white" />
        </div>
      )}
    </div>
  );
}

export function FailedMediaViewer({
  open,
  onOpenChange,
  failedMessages,
  onRetryMessage,
}: FailedMediaViewerProps) {
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null);

  // Auto-close dialog if all failed items were retried or removed externally
  useEffect(() => {
    if (open && failedMessages.length === 0) {
      onOpenChange(false);
    }
  }, [open, failedMessages.length, onOpenChange]);

  if (!open || failedMessages.length === 0) {
    return null;
  }

  const isMulti = failedMessages.length > 1;
  const selectedMessage = selectedMessageId
    ? failedMessages.find((m) => m.id === selectedMessageId) ?? null
    : null;

  // Case A: 1 failed image -> direct single clean view
  // Case B: multiple failed images -> single view only when an item was explicitly selected
  const targetMessage = isMulti ? selectedMessage : failedMessages[0];
  const showSingle = Boolean(targetMessage);

  const handleDialogChange = (next: boolean) => {
    if (!next) {
      setSelectedMessageId(null);
      onOpenChange(false);
    }
  };

  if (showSingle && targetMessage) {
    const handleCloseSingle = () => {
      if (isMulti) {
        setSelectedMessageId(null);
      } else {
        handleDialogChange(false);
      }
    };

    const handleRetrySingle = () => {
      onRetryMessage?.(targetMessage);
      setSelectedMessageId(null);
      if (failedMessages.length <= 1) {
        handleDialogChange(false);
      }
    };

    return (
      <Dialog open={open} onOpenChange={handleDialogChange}>
        <DialogContent
          showCloseButton={false}
          className="fixed inset-0 top-0 left-0 z-50 flex h-full max-h-screen w-full max-w-none translate-x-0 translate-y-0 flex-col items-center justify-center rounded-none border-none bg-black/95 p-0 text-white shadow-none ring-0 focus:outline-none select-none sm:max-w-none"
        >
          <DialogTitle className="sr-only">Visualizar mídia com falha</DialogTitle>
          <DialogDescription className="sr-only">
            Visualização limpa da mídia com falha no envio
          </DialogDescription>

          {/* Top Bar: discrete close button */}
          <div
            className="absolute top-0 right-0 left-0 z-20 flex items-center justify-end p-4 pointer-events-none"
            style={{ paddingTop: "calc(1rem + env(safe-area-inset-top))" }}
          >
            <button
              type="button"
              onClick={handleCloseSingle}
              aria-label="Fechar"
              className="pointer-events-auto rounded-full bg-black/50 p-2.5 text-white/80 backdrop-blur-sm transition-colors hover:bg-black/70 hover:text-white active:scale-95 cursor-pointer"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          {/* Clean center media */}
          <div className="relative flex flex-1 h-full w-full items-center justify-center p-4 overflow-hidden select-none">
            <CleanMediaViewer message={targetMessage} />
          </div>

          {/* Footer: Exactly 2 buttons */}
          <div
            className="absolute bottom-0 left-0 right-0 z-20 flex items-center justify-center gap-3 p-4 pointer-events-auto select-none"
            style={{ paddingBottom: "calc(1.5rem + env(safe-area-inset-bottom))" }}
          >
            <Button
              type="button"
              onClick={handleRetrySingle}
              className="flex items-center gap-2 rounded-full bg-primary hover:bg-primary/90 text-primary-foreground px-5 py-2.5 text-sm font-medium shadow-lg transition active:scale-95"
            >
              <RotateCw className="h-4 w-4" />
              <span>Enviar novamente</span>
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={handleCloseSingle}
              className="flex items-center gap-2 rounded-full px-5 py-2.5 text-sm font-medium shadow-md transition active:scale-95 bg-white/15 hover:bg-white/25 text-white border-0"
            >
              <span>Cancelar</span>
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  // Case B: Dedicated modal for multiple failed photos
  return (
    <Dialog open={open} onOpenChange={handleDialogChange}>
      <DialogContent
        showCloseButton={true}
        className="w-full max-w-md p-5 rounded-2xl sm:max-w-md bg-popover text-popover-foreground shadow-2xl border border-border"
      >
        <DialogHeader className="space-y-1.5 text-left pb-2">
          <DialogTitle className="text-base font-semibold flex items-center gap-2">
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <AlertCircle className="h-3.5 w-3.5" />
            </span>
            <span>
              {failedMessages.some((m) => m.content_type === "video")
                ? `Mídias com falha (${failedMessages.length})`
                : `Fotos com falha (${failedMessages.length})`}
            </span>
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            As mídias abaixo não puderam ser enviadas. Você pode visualizá-las ou reenviá-las individualmente.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2 max-h-[60vh] overflow-y-auto pr-1 py-1 -mr-1">
          {failedMessages.map((msg, index) => {
            const slotNumber =
              typeof msg.album_index === "number"
                ? msg.album_index + 1
                : index + 1;
            const isVideo = msg.content_type === "video";

            return (
              <div
                key={msg.id}
                className="flex items-center justify-between gap-3 rounded-xl border border-border/60 bg-muted/30 p-2.5 transition hover:bg-muted/60"
              >
                <button
                  type="button"
                  onClick={() => setSelectedMessageId(msg.id)}
                  className="group relative h-14 w-14 shrink-0 overflow-hidden rounded-lg bg-muted/80 border border-border/50 cursor-pointer"
                  title={`Visualizar ${isVideo ? "vídeo" : "foto"}`}
                  aria-label={`Visualizar ${isVideo ? "vídeo" : "foto"} ${slotNumber}`}
                >
                  <FailedThumbnail message={msg} />
                  <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors flex items-center justify-center">
                    <Eye className="h-4 w-4 text-white opacity-0 group-hover:opacity-100 transition-opacity drop-shadow-sm" />
                  </div>
                </button>

                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="text-sm font-medium text-foreground truncate">
                    {isVideo ? "Vídeo " : "Foto "} {slotNumber}
                  </span>
                </div>

                <div className="flex items-center gap-1.5 shrink-0">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setSelectedMessageId(msg.id)}
                    className="h-8 gap-1.5 px-2.5 text-xs font-medium text-muted-foreground hover:text-foreground"
                  >
                    <Eye className="h-3.5 w-3.5" />
                    <span>Visualizar</span>
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      onRetryMessage?.(msg);
                      if (failedMessages.length <= 1) {
                        handleDialogChange(false);
                      }
                    }}
                    className="h-8 gap-1.5 px-3 text-xs font-medium"
                  >
                    <RotateCw className="h-3.5 w-3.5 text-muted-foreground" />
                    <span>Reenviar</span>
                  </Button>
                </div>
              </div>
            );
          })}
        </div>

        <DialogFooter className="pt-2 sm:justify-end">
          <Button
            type="button"
            variant="secondary"
            onClick={() => handleDialogChange(false)}
            className="w-full sm:w-auto"
          >
            Fechar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
