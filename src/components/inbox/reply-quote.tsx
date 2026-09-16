"use client";

import { FileText, MapPin, Mic, Play, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ContentType, Message } from "@/types";
import { useTranslations } from "next-intl";
import { useResolvedMediaSrc } from "@/lib/inbox/use-resolved-media-src";

/** What ReplyQuote needs to render a thumbnail for the quoted message.
 *  Caller resolves this from the parent Message — the quote component
 *  never sees the parent Message itself. */
export interface ReplyQuoteMedia {
  type: ContentType;
  /** Image: the image itself. Video/document: a pre-generated preview
   *  image (metadata.thumbnail_url / document_thumbnail_url) — never the
   *  raw video/document URL, which useResolvedMediaSrc can't thumbnail. */
  thumbnailUrl?: string | null;
}

interface ReplyQuoteProps {
  /** Sender label of the quoted message: "You" for our own messages,
   *  contact name for customer-sent messages. Caller resolves this — the
   *  quote component doesn't see the parent Message. */
  authorLabel: string;
  /** Compact text preview. Falls back to a placeholder for media types. */
  preview: string;
  /** Present → renders the composer-chip variant with an X button. Absent →
   *  renders the embedded-in-bubble variant. */
  onDismiss?: () => void;
  /** True when embedded inside an outbound (primary-filled) bubble, so the
   *  quote must read against the primary surface rather than the neutral
   *  foreground — otherwise it goes low-contrast in light mode. */
  onPrimary?: boolean;
  /** Media info for the quoted message, when it has any — renders a small
   *  thumbnail (or type icon when there's no image to show) to the left
   *  of the text, WhatsApp-style. */
  media?: ReplyQuoteMedia | null;
  /** Present → the whole quote becomes a button that jumps to and
   *  highlights the original message in the thread. Absent (e.g. the
   *  composer's "replying to" chip) → plain non-interactive quote. */
  onClick?: () => void;
}

/** Small 40x40 preview tile shown at the left of the quote. Image messages
 *  resolve `thumbnailUrl` (their own media_url) through the R2 proxy cache
 *  like any other inbound image; video/document thumbnails are already
 *  plain URLs (server-generated previews) and render directly. Content
 *  types with no visual preview (audio/location/template/text) fall back
 *  to a small type icon so the quote still reads as "this was media."
 */
function QuoteThumbnail({ media }: { media: ReplyQuoteMedia }) {
  const isImage = media.type === "image";
  const { src } = useResolvedMediaSrc(isImage ? media.thumbnailUrl ?? undefined : undefined);

  const resolvedUrl = isImage ? src : media.thumbnailUrl;

  if (resolvedUrl) {
    return (
      <div className="relative h-10 w-10 shrink-0 overflow-hidden rounded">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={resolvedUrl}
          alt=""
          className="h-full w-full object-cover"
        />
        {media.type === "video" && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/25">
            <Play className="h-3.5 w-3.5 fill-white text-white" />
          </div>
        )}
      </div>
    );
  }

  const Icon =
    media.type === "audio"
      ? Mic
      : media.type === "document"
        ? FileText
        : media.type === "location"
          ? MapPin
          : null;

  if (!Icon) return null;

  return (
    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded bg-foreground/10">
      <Icon className="h-4 w-4 text-foreground/60" />
    </div>
  );
}

export function ReplyQuote({
  authorLabel,
  preview,
  onDismiss,
  onPrimary = false,
  media,
  onClick,
}: ReplyQuoteProps) {
  const t = useTranslations("Inbox.replyQuote");
  const isChip = !!onDismiss;
  const isInteractive = !!onClick;

  const content = (
    <>
      {media && <QuoteThumbnail media={media} />}
      <div className="min-w-0 flex-1 overflow-hidden">
        <div
          className={cn(
            "truncate text-[11px] font-medium",
            onPrimary ? "text-primary-foreground" : "text-primary",
          )}
        >
          {authorLabel}
        </div>
        {/* Wrap the preview instead of truncating to a single line.
         *  `truncate` (white-space: nowrap) forced the quote onto one
         *  impossibly-wide line and — because the parent flex chain
         *  lacked `min-w-0` at every step — pushed the entire inbox
         *  layout wider, shoving the contact sidebar off-screen.
         *  `break-words` also wraps long URLs that have no whitespace
         *  to break on. Issue #165. */}
        <div className="whitespace-pre-wrap break-words text-xs text-foreground/80">
          {preview}
        </div>
      </div>
    </>
  );

  const wrapperClassName = cn(
    "flex items-center gap-2 border-l-2 px-2 py-1 text-left",
    onPrimary ? "border-primary-foreground/50" : "border-primary",
    isChip
      ? "rounded-md bg-muted/80"
      : onPrimary
        ? "mb-1.5 rounded-md bg-primary-foreground/15"
        : "mb-1.5 rounded-md bg-background/20",
    isInteractive && "w-full cursor-pointer transition-colors hover:brightness-95",
  );

  return (
    <div className="flex items-start gap-1">
      {isInteractive ? (
        <button type="button" onClick={onClick} className={wrapperClassName}>
          {content}
        </button>
      ) : (
        <div className={wrapperClassName}>{content}</div>
      )}
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t("cancelReply")}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

/** Build the one-line preview text shown inside a reply quote. */
export function buildReplyPreview(message: Message, t: ReturnType<typeof useTranslations>): string {
  if (message.content_text) return message.content_text;
  switch (message.content_type) {
    case "image":
      return t("photo");
    case "video":
      return t("video");
    case "audio":
      return t("audio");
    case "document":
      return t("document");
    case "location":
      return t("location");
    case "template":
      return t("template");
    default:
      return t("message");
  }
}

/** Build the thumbnail descriptor for a reply quote from the parent
 *  Message — null when the type has no meaningful preview to show. */
export function buildReplyMedia(message: Message): ReplyQuoteMedia | null {
  switch (message.content_type) {
    case "image":
      return message.media_url
        ? { type: "image", thumbnailUrl: message.media_url }
        : null;
    case "video":
      return {
        type: "video",
        thumbnailUrl: (message.metadata?.thumbnail_url as string) || null,
      };
    case "document":
      return { type: "document", thumbnailUrl: message.document_thumbnail_url };
    case "audio":
      return { type: "audio" };
    case "location":
      return { type: "location" };
    default:
      return null;
  }
}
