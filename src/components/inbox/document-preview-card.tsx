"use client";

import type { ReactNode } from "react";
import { FileText } from "lucide-react";
import { cn } from "@/lib/utils";

interface DocumentPreviewCardProps {
  url: string;
  filename: string;
  isAgent: boolean;
  thumbnailUrl: string | null;
  fileSize: number | null;
  time: string;
  status: ReactNode;
  verLabel: string;
  baixarLabel: string;
  /** Already-formatted ("40 páginas") by the caller — next-intl's ICU
   *  interpolation must run at the `t()` call site, not here. Null when
   *  the page count isn't known yet. */
  pagesLabel: string | null;
}

function formatFileSize(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 0.1) return `${mb.toFixed(mb >= 10 ? 0 : 1)} MB`;
  const kb = bytes / 1024;
  return `${Math.max(1, Math.round(kb))} KB`;
}

/**
 * Forces a real download instead of just opening the PDF in a new tab.
 * A plain cross-origin `<a download>` is silently ignored by the
 * browser (the `download` attribute only takes effect same-origin) —
 * chat-media is a separate Supabase Storage host, so without this the
 * "Baixar" button would behave identically to "Ver". The bucket serves
 * public objects with a permissive CORS policy, so fetching as a blob
 * and downloading that (same-origin blob: URL) works reliably.
 */
async function downloadFile(url: string, filename: string) {
  try {
    const response = await fetch(url);
    const blob = await response.blob();
    const blobUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = blobUrl;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(blobUrl);
  } catch {
    // Fall back to just opening it — better than a dead click.
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

/** WhatsApp-style document card: a full-width thumbnail of the PDF's
 *  first page, then a footer with the filename, page count + size, and
 *  Ver/Baixar actions — themed to match the bubble it's in (not a
 *  literal clone of WhatsApp's own green), per the chosen visual
 *  direction. Only rendered once `thumbnailUrl` has landed (see
 *  MessageBubble's document case); until then, and for any non-PDF
 *  document, the existing plain pill is what renders instead. */
export function DocumentPreviewCard({
  url,
  filename,
  isAgent,
  thumbnailUrl,
  fileSize,
  time,
  status,
  verLabel,
  baixarLabel,
  pagesLabel,
}: DocumentPreviewCardProps) {
  const metaParts = [pagesLabel, "PDF", fileSize ? formatFileSize(fileSize) : null].filter(
    Boolean,
  );

  return (
    <div
      className={cn(
        "max-w-72 overflow-hidden rounded-lg border",
        isAgent ? "border-primary-foreground/20" : "border-border",
      )}
    >
      {thumbnailUrl && (
        // Fixed, deliberately short band (~35-45% of the card's total
        // height, not the full first page at its native aspect ratio) —
        // a quick preview strip, not the card's main event, same
        // proportions as WhatsApp's own document card. `object-cover` +
        // `object-top` crops to fill the band edge-to-edge, anchored on
        // the page's top (its most identifying content) — matches
        // WhatsApp's own thumbnail behavior exactly, so a portrait page
        // (the common case for contracts/tables) never shows blank
        // space on the sides the way `object-contain` would in a band
        // this short. The bg fallback only shows on a slow image load.
        <div
          className={cn(
            "h-24 w-full overflow-hidden",
            isAgent ? "bg-primary-foreground/10" : "bg-muted",
          )}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={thumbnailUrl}
            alt=""
            className="h-full w-full object-cover object-top"
          />
        </div>
      )}
      <div
        className={cn(
          "space-y-2.5 px-3.5 py-3",
          isAgent ? "bg-primary-foreground/10" : "bg-muted/60",
        )}
      >
        <div className="flex items-start gap-2.5">
          <div
            className={cn(
              "mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md",
              isAgent ? "bg-primary-foreground/15" : "bg-red-500/10",
            )}
          >
            <FileText
              className={cn(
                "h-5 w-5",
                isAgent ? "text-primary-foreground" : "text-red-600",
              )}
            />
          </div>
          <div className="min-w-0 flex-1">
            <p
              className={cn(
                "line-clamp-2 text-sm font-semibold leading-snug",
                isAgent ? "text-primary-foreground" : "text-foreground",
              )}
            >
              {filename}
            </p>
            <p
              className={cn(
                "truncate text-xs",
                isAgent ? "text-primary-foreground/80" : "text-muted-foreground",
              )}
            >
              {metaParts.join(" • ")}
            </p>
          </div>
        </div>
        <div className="flex items-center justify-end gap-1 text-[10px]">
          <span
            className={cn(
              "flex items-center gap-1",
              isAgent ? "text-primary-foreground/70" : "text-muted-foreground",
            )}
          >
            {time}
            {status}
          </span>
        </div>
        <div
          className={cn(
            "flex items-center gap-2 border-t pt-2.5 text-sm font-medium",
            isAgent ? "border-primary-foreground/20" : "border-border/60",
          )}
        >
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(
              "flex-1 rounded-md py-1 text-center",
              isAgent
                ? "text-primary-foreground hover:bg-primary-foreground/10"
                : "text-primary-on-soft hover:bg-primary/10",
            )}
          >
            {verLabel}
          </a>
          <button
            type="button"
            onClick={() => downloadFile(url, filename)}
            className={cn(
              "flex-1 rounded-md py-1 text-center",
              isAgent
                ? "text-primary-foreground hover:bg-primary-foreground/10"
                : "text-primary-on-soft hover:bg-primary/10",
            )}
          >
            {baixarLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
