"use client";

import {
  useState,
  useRef,
  useCallback,
  useEffect,
  useMemo,
  KeyboardEvent,
  type RefObject,
} from "react";
import {
  Send,
  LayoutTemplate,
  Paperclip,
  Image as ImageIcon,
  Video,
  FileText,
  Mic,
  Trash2,
  Lock,
  Play,
  Pause,
  X,
  Loader2,
  AlertCircle,
} from "lucide-react";
import { GatedButton } from "@/components/ui/gated-button";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { useCan } from "@/hooks/use-can";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
  MEDIA_MAX_BYTES,
  MEDIA_MAX_BYTES_BY_KIND,
  ALLOWED_MIME_TYPES_BY_KIND,
  CHAT_MEDIA_BUCKET,
} from "@/lib/storage/upload-media";
import { presignAndUpload, deleteR2Media, resolveClientFileMime } from "@/lib/storage/upload-media-r2";
import {
  shouldTranscodeVideo,
  convertMovToMp4ViaWebCodecs,
} from "@/lib/media/transcode-mov-webcodecs";
import { isHeicFile, normalizeImageForUpload } from "@/lib/media/image-compat";
import { ReplyQuote, type ReplyQuoteMedia } from "./reply-quote";
import { DocumentFullscreenPreview } from "./document-fullscreen-preview";
import { useTranslations } from "next-intl";
import type { QuickReply } from "@/types";
import { useWakeLock } from "@/hooks/use-wake-lock";
import {
  putPendingAudio,
  listPendingAudioByConversation,
  type PendingAudioRecord,
} from "@/lib/inbox/pending-audio-db";
import { discardPendingAudio } from "@/lib/inbox/pending-audio-sync";
import {
  buildPlayableAudioBlob,
  getOutboxEntry,
  listOutboxJobsByConversation,
  persistAudioToOutbox,
} from "@/lib/inbox/audio-outbox-db";
import { discardOutboxAudioJob } from "@/lib/inbox/audio-outbox-sync";
import { useAudioFeatureFlags } from "@/lib/inbox/use-audio-feature-flags";
import { validateCapturedAudio } from "@/lib/inbox/audio-validation";
import {
  AudioCaptureController,
  type CaptureControllerPhase,
  type CaptureDataPayload,
  type CapturePhaseMeta,
} from "@/lib/inbox/audio-capture-controller";
import { audioLog, audioLogError } from "@/lib/inbox/pending-audio-log";
import {
  updateAudioDiagnosticSession,
  updateLiveRecorderResources,
  type AudioFailureCategory,
} from "@/lib/inbox/audio-telemetry";
import { pollNormalizationStatus } from "@/lib/media/batch-upload-pool";
import {
  registerLocalMediaBlob,
  scheduleRevokeLocalMediaBlob,
  revokeLocalMediaBlobImmediately,
} from "@/lib/inbox/use-resolved-media-src";
import { stopAllAudioPlayback } from "@/lib/inbox/audio-playback-coordinator";
import { forensic } from "@/lib/media/forensic-tracer";

/** Media content types an agent can send from the composer. */
export type ComposerMediaKind = "image" | "video" | "document" | "audio";

/** Re-exported for existing callers (e.g. message-thread.tsx) — canonical
 *  definition now lives in upload-media.ts, see its own doc comment. */
export { CHAT_MEDIA_BUCKET };

/** Meta caps media captions at 1024 chars. Enforced here and in the send route. */
export const MEDIA_CAPTION_MAX = 1024;

/** Hard cap on a single voice recording so it can't blow the upload/
 *  transcode limits — auto-stops the recorder when reached. */
const MAX_RECORDING_SECONDS = 5 * 60;

export interface SendMediaPayload {
  kind: ComposerMediaKind;
  /** Public chat-media URL Meta fetches at send time. */
  mediaUrl: string;
  /** Storage object path — lets the caller GC the object if the send fails. */
  path: string;
  /** Optional caption (image/video/document only). */
  caption?: string;
  /** Original file name — surfaced to the recipient for documents. */
  filename?: string;
  replyToId?: string;
}

export interface SendMediaBatchItem {
  kind: "image";
  mediaUrl: string;
  path: string;
  localPreviewUrl: string;
  filename: string;
  caption?: string;
}

export interface SendMediaBatchPayload {
  kind?: "image" | "video";
  albumId?: string;
  files?: File[];
  items?: SendMediaBatchItem[];
  caption?: string;
  replyToId?: string;
}

interface ReplyDraft {
  /** Internal UUID of the message being replied to — sent back through onSend. */
  id: string;
  authorLabel: string;
  preview: string;
  media?: ReplyQuoteMedia | null;
}

// Mirrors the chat-media bucket's allowed_mime_types (migration 023) for
// the file picker so unsupported files are rejected before upload rather
// than failing with a confusing Storage error. Audio has no picker — it's
// captured via the recorder and, unlike the other kinds, never goes
// through the staged-draft preview below (see the recording state
// machine further down).
const PICKER_ACCEPT: Record<"image" | "video" | "document", string> = {
  image: "image/png,image/jpeg,image/webp,image/heic,image/heif,.heic,.heif,.webp",
  // video/quicktime + .mov: iPhone recordings are transcoded to MP4
  // client-side before upload (see transcode-mov.ts) — listed here so
  // they don't get filtered out of the OS picker in the first place.
  video: "video/mp4,video/3gpp,video/quicktime,.mov,.mp4,.3gp,.3gpp,.m4v",
  document:
    "application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/plain,video/*,.mp4,.mov,.avi,.mkv,.wmv,.3gp,.3gpp,.webm,.m4v",
};

interface MediaDraft {
  kind: Exclude<ComposerMediaKind, "audio">;
  /** Local `blob:` URL (URL.createObjectURL) for the pre-send preview
   *  only — the file is already in browser memory, so this needs no
   *  round trip to resolve. Never sent anywhere; revoked whenever the
   *  draft is replaced, discarded, sent, or the component unmounts. */
  previewUrl: string;
  /** R2 object key from the completed upload — used to GC the object
   *  if the draft is discarded, and as the real value sent as
   *  SendMediaPayload.mediaUrl/path once the draft is sent. */
  path: string;
  filename: string;
  caption: string;
}

/** Best-effort revoke — no-op for anything that isn't a blob: URL
 *  (guards against double-revoking or revoking a value that was never
 *  a local preview in the first place). */
function revokeStagedPreview(url: string | undefined): void {
  if (url?.startsWith("blob:")) URL.revokeObjectURL(url);
}

interface MessageComposerProps {
  sessionExpired: boolean;
  /** Scopes the pending-voice-note IndexedDB store (a conversation switch
   *  rehydrates whatever unresolved recording that conversation left
   *  behind — see the mount effect below). */
  conversationId: string;
  onSend: (text: string, replyToId?: string) => void;
  onSendMedia: (payload: SendMediaPayload) => void;
  onSendMediaBatch?: (payload: SendMediaBatchPayload) => void;
  /**
   * A voice note has been recorded and the agent committed to sending it
   * (or it was queued hands-free via lock+send). The composer has
   * already persisted it to pending-audio-db.ts under `recordId` and
   * returns to "idle" immediately after calling this — all the actual
   * upload + WhatsApp-send network work happens in the caller
   * (message-thread.tsx's handleQueuedAudio, backed by
   * pending-audio-sync.ts), which is what lets the composer never block
   * on the network for audio.
   */
  onRecordAudio: (recordId: string, replyToId?: string) => void;
  onOpenTemplates: () => void;
  replyTo?: ReplyDraft | null;
  onClearReply?: () => void;
  /**
   * One-shot draft to seed the text field with (BLOCO 3/4: a follow-up
   * message "loaded but not sent" from the Central de IA). Only seeds
   * on change, never overwrites what the agent is actively typing — the
   * caller is responsible for only setting this once per conversation.
   */
  initialText?: string;
  /**
   * The thread's own scrollable message-list container — passed straight
   * through to the pre-send PDF viewer (see DocumentFullscreenPreview) so
   * it confines itself there instead of covering the full viewport.
   * Optional so this component doesn't hard-depend on a caller that
   * supplies it; the viewer falls back to a full-screen dialog when
   * omitted.
   */
  pdfPreviewContainerRef?: RefObject<HTMLDivElement | null>;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// Accent/case-insensitive comparison for shortcut matching ("apres" must
// match "apresentação").
function normalizeForMatch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

function stripLeadingSlash(value: string): string {
  return value.startsWith("/") ? value.slice(1) : value;
}

// Filename-extension check — mirrors looksLikePdf's fallback branch in
// generate-document-preview.ts (not imported from there: that module
// pulls in supabaseAdmin(), a service-role client that has no business
// in the browser bundle). Only PDFs get the full-screen page-by-page
// viewer below; any other document kind (docx/xlsx/pptx/txt) keeps
// today's plain filename card unchanged.
function isPdfDraft(filename: string): boolean {
  return filename.toLowerCase().endsWith(".pdf");
}

/** Finds the "/shortcut" token touching the caret, if any — mirrors
 *  WhatsApp Business: the slash must start a word (string start or right
 *  after whitespace) and nothing between it and the caret may contain
 *  whitespace, otherwise it's just a literal "/" in running text. */
function findSlashToken(
  value: string,
  caret: number,
): { start: number; query: string } | null {
  let i = caret - 1;
  while (i >= 0) {
    const ch = value[i];
    if (ch === "/") {
      const before = i === 0 ? undefined : value[i - 1];
      if (before === undefined || /\s/.test(before)) {
        return { start: i, query: value.slice(i, caret) };
      }
      return null;
    }
    if (/\s/.test(ch)) return null;
    i--;
  }
  return null;
}

// Vertical drag distance (px) that arms "locked" (hands-free) recording —
// same idea as WhatsApp's own slide-up-to-lock gesture. Slightly more
// than a hair-trigger tap needs, on purpose: the progressive visual
// buildup below (the hint growing/brightening as it approaches this) is
// what should carry the "am I close?" feeling, not a razor-thin
// threshold — this just guards against arming on a barely-there twitch.
//
// Deliberately vertical-only, with no horizontal check at all: a
// natural upward swipe always drifts sideways some, and penalizing
// that (requiring a perfectly straight line) is exactly what reads as
// "mechanical" instead of a natural continuation of the press. A
// diagonal drag locks exactly as readily as a straight one.
const LOCK_THRESHOLD_PX = 80;

// "initializing" is shown while microphone permission / encoder startup runs
// (with a spinner and 0:00 timer paused — NEVER pretending audio is live yet).
// "sending" is purely the brief, LOCAL recorder-stop -> encoder-flush window
// (never waiting on network upload). "failed" covers a rehydrated failed take.
type MicPhase = "idle" | "initializing" | "recording" | "paused" | "sending" | "failed";

export function MessageComposer({
  sessionExpired,
  conversationId,
  onSend,
  onSendMedia,
  onSendMediaBatch,
  onRecordAudio,
  onOpenTemplates,
  replyTo,
  onClearReply,
  initialText,
  pdfPreviewContainerRef,
}: MessageComposerProps) {
  const t = useTranslations("Inbox.composer");

  const [text, setText] = useState("");
  const textRef = useRef("");
  const [pendingInitialText, setPendingInitialText] = useState<string | null>(null);
  const lastTrackedConvIdRef = useRef(conversationId);
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Only used to mask the single-line/multi-line layout swap below (see
  // adjustHeight's crossfade) — `flex-wrap`/`order`/`width: 100%` on
  // [data-composer-capsule] aren't animatable, so that reflow always
  // snaps instantly regardless of any height transition. A brief opacity
  // dip right as it happens reads as an intentional fade instead of a jump.
  const capsuleRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    textRef.current = text;
  }, [text]);

  // Se o corretor já estiver digitando algo quando um novo rascunho chegar,
  // preserva o texto atual e oferece escolha explícita em vez de sobrescrever.
  useEffect(() => {
    if (lastTrackedConvIdRef.current !== conversationId) {
      lastTrackedConvIdRef.current = conversationId;
      setPendingInitialText(null);
    }
    if (!initialText) return;
    if (textRef.current.trim().length === 0) {
      setText(initialText);
      setPendingInitialText(null);
      textareaRef.current?.focus();
    } else if (textRef.current !== initialText) {
      setPendingInitialText(initialText);
    }
  }, [conversationId, initialText]);

  // ---- "/shortcut" quick-reply autocomplete ---------------------------
  //
  // Only `kind === "text"` replies are eligible: their content is a plain
  // string that can drop straight into the textarea. Interactive quick
  // replies (buttons/list payloads) have no scalar text form and the
  // composer's onSend contract only carries a string, so they're left out
  // of suggestions rather than lossily flattened into text.
  const [quickReplies, setQuickReplies] = useState<QuickReply[]>([]);
  const [slashToken, setSlashToken] = useState<{ start: number; query: string } | null>(
    null,
  );
  const [activeSuggestion, setActiveSuggestion] = useState(0);
  // Caret position to restore after a suggestion is inserted — the text
  // update itself is async (setState), so the actual focus/selection call
  // happens in the effect below once the new value has committed to the DOM.
  const pendingCaretRef = useRef<number | null>(null);
  const isSubmittingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/quick-replies", { cache: "no-store" });
        const data = await res.json().catch(() => ({}));
        if (!cancelled && res.ok) {
          setQuickReplies((data.quick_replies as QuickReply[]) ?? []);
        }
      } catch {
        // Best-effort — the composer works fine without suggestions.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const suggestions = useMemo(() => {
    if (!slashToken) return [];
    // A bare "/" (nothing typed yet) shouldn't dump every quick reply —
    // only start suggesting once there's at least one character to filter by.
    if (slashToken.query.length < 2) return [];
    const query = normalizeForMatch(stripLeadingSlash(slashToken.query));
    return quickReplies
      .filter(
        (qr) =>
          qr.kind === "text" &&
          !!qr.content_text &&
          normalizeForMatch(stripLeadingSlash(qr.title)).startsWith(query),
      )
      .slice(0, 8);
  }, [slashToken, quickReplies]);

  // Media attachment state. `draft` holds an uploaded-but-not-yet-sent
  // image/video/document; `busy` covers the upload window. Voice notes
  // never populate this — see the recording state machine below, which
  // has its own inline discard/send bar instead of routing through the
  // draft preview.
  const [draft, setDraft] = useState<MediaDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const attachMenuRef = useRef<HTMLDivElement>(null);
  const attachWrapperRef = useRef<HTMLDivElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const documentInputRef = useRef<HTMLInputElement>(null);

  // Closes attachment popup on outside interaction, Escape, or file picker cancel
  useEffect(() => {
    if (!attachMenuOpen) return;
    const handleOutside = (e: MouseEvent | TouchEvent) => {
      if (attachWrapperRef.current && !attachWrapperRef.current.contains(e.target as Node)) {
        setAttachMenuOpen(false);
      }
    };
    const handleKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        setAttachMenuOpen(false);
      }
    };
    const handleCancel = () => {
      setAttachMenuOpen(false);
    };

    const imgEl = imageInputRef.current;
    const vidEl = videoInputRef.current;
    const docEl = documentInputRef.current;

    imgEl?.addEventListener("cancel", handleCancel);
    vidEl?.addEventListener("cancel", handleCancel);
    docEl?.addEventListener("cancel", handleCancel);
    document.addEventListener("pointerdown", handleOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      imgEl?.removeEventListener("cancel", handleCancel);
      vidEl?.removeEventListener("cancel", handleCancel);
      docEl?.removeEventListener("cancel", handleCancel);
      document.removeEventListener("pointerdown", handleOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [attachMenuOpen]);

  // Mirror of `draft` for the unmount cleanup, which can't read render
  // state. Kept in sync below so navigating away with a staged-but-unsent
  // attachment GCs the orphaned object.
  const draftRef = useRef<MediaDraft | null>(null);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  // Best-effort GC of a staged object the user never sent. Fire-and-forget.
  const removeStaged = useCallback((path: string | undefined) => {
    if (!path) return;
    void deleteR2Media(path).catch(() => {});
  }, []);

  // ---- Voice recording ------------------------------------------------
  //
  // Press-and-hold, WhatsApp-style. State machine:
  //   idle       → nothing recording, normal composer row shown.
  //   recording  → mic is live (holding, or holding-then-locked); timer
  //                ticking. `locked` (separate flag) tracks whether the
  //                finger can be lifted without stopping the capture.
  //   paused     → capture has stopped (released without locking, or hit
  //                the max-duration cap) but the agent hasn't decided
  //                trash vs send yet. The bytes are already durable (see
  //                finalizeRecording → pending-audio-db.ts) — nothing is
  //                uploading yet, so there's no async result to wait on.
  //   sending    → the recorder is stopping and flushing its last encoded
  //                frame (opus-recorder), a purely local, sub-second
  //                step — NOT a network wait. Only reachable via
  //                handleSendRecording's "recording" branch (tapped send
  //                on a locked, hands-free take); finalizeRecording flips
  //                back to "idle" the moment the bytes are ready and
  //                hands them to `onRecordAudio`.
  //   failed     → either a real upload/send failure, or a take rehydrated
  //                on mount that was left over from an interrupted
  //                previous attempt (see the rehydration effect above).
  //                Trash discards it; Send retries it — both act on
  //                `pendingRecordIdRef.current`.
  //
  // Deliberately NOT modeled here: waiting on the network. The old
  // version of this state machine had "sending" mean "uploading to
  // Storage", which is exactly what could hang forever on iOS Safari/
  // WKWebView — see finalizeRecording's doc comment. All of that network
  // work now happens outside this component entirely (message-thread.tsx
  // + pending-audio-sync.ts), so nothing here ever awaits it.
  //
  // The bar shown for every non-idle phase is the same trash/timer/send
  // layout — only the icon/text in the middle and the lock indicator differ.
  const [micPhase, setMicPhase] = useState<MicPhase>("idle");
  // Holds the Screen Wake Lock while capturing or initializing mic hardware
  useWakeLock(micPhase === "recording" || micPhase === "initializing");
  const [locked, setLocked] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const micPhaseRef = useRef<MicPhase>(micPhase);
  useEffect(() => {
    micPhaseRef.current = micPhase;
  }, [micPhase]);

  // Pre-load opus-recorder constructor on mount so recording starts without
  // waiting on an extra dynamic module fetch when tapped.
  const recorderModuleRef = useRef<{ new (config: unknown): import("opus-recorder").default } | null>(null);
  useEffect(() => {
    import("opus-recorder")
      .then((m) => {
        recorderModuleRef.current = m.default as unknown as { new (config: unknown): import("opus-recorder").default };
      })
      .catch((err) => {
        console.warn("[audio] Failed to pre-warm opus-recorder:", err);
      });
  }, []);

  const captureControllerRef = useRef<AudioCaptureController | null>(null);
  const finalizationInFlightRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Id of the pending-audio-db.ts / outbox record backing the current "paused" or
  // "failed" bar — Send/Discard/Retry all act on whichever record this points at.
  const pendingRecordIdRef = useRef<string | null>(null);
  // Set when the agent taps Send while actively recording — finalizeRecording
  // reads this when the encoded audio finishes flushing.
  const sendOnStopRef = useRef(false);
  // Failure reason for the rehydrated/failed bar — display-only.
  const [failedError, setFailedError] = useState<string | undefined>(undefined);
  const { accountId, user } = useAuth();
  const audioFlags = useAudioFeatureFlags();
  const [draftAudioUrl, setDraftAudioUrl] = useState<string | null>(null);
  const draftAudioUrlRef = useRef<string | null>(null);
  const draftPreviewAudioRef = useRef<HTMLAudioElement | null>(null);
  const [draftPlaying, setDraftPlaying] = useState(false);

  const setManagedDraftAudioUrl = useCallback((nextUrl: string | null) => {
    if (draftAudioUrlRef.current && draftAudioUrlRef.current !== nextUrl) {
      URL.revokeObjectURL(draftAudioUrlRef.current);
    }
    draftAudioUrlRef.current = nextUrl;
    setDraftAudioUrl(nextUrl);
    if (!nextUrl) setDraftPlaying(false);
  }, []);

  const micButtonRef = useRef<HTMLButtonElement>(null);
  const lockHintRef = useRef<HTMLDivElement>(null);
  const gestureRef = useRef<{ startY: number } | null>(null);

  // Viewers (read-only role) can browse the inbox but never send.
  // For solo users this is always true — single-owner accounts pass
  // every capability — so the disabled branch is a no-op there.
  const canSend = useCan("send-messages");
  const readOnly = !canSend;
  // Media (like free-form text) is only allowed inside the 24h window.
  const inputsDisabled = readOnly || sessionExpired;

  // Rehydrate on mount / conversation switch:
  // - Outbox v2: ONLY restore unauthorized `saved_draft` recordings into the
  //   composer's "paused" review bar. Authorized/failed sends belong exclusively
  //   to MessageThread bubbles so the composer NEVER locks across conversations.
  // - Legacy v1 fallback: preserve existing rehydration if Outbox v2 is toggled off.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (audioFlags.audio_outbox_v2_enabled && accountId && user?.id) {
        try {
          const jobs = await listOutboxJobsByConversation({
            accountId,
            userId: user.id,
            conversationId,
          });
          if (cancelled) return;
          const draftJob = jobs
            .filter((j) => j.status === "saved_draft" && !j.sendAuthorized)
            .sort((a, b) => b.createdAt - a.createdAt)[0];
          if (!draftJob) {
            pendingRecordIdRef.current = null;
            setFailedError(undefined);
            setManagedDraftAudioUrl(null);
            setLocked(false);
            setMicPhase((prev) =>
              prev === "initializing" || prev === "recording" || prev === "sending" ? prev : "idle",
            );
            return;
          }
          const entry = await getOutboxEntry(draftJob.id, { accountId, userId: user.id });
          if (cancelled || !entry?.blob || entry.blob.data.byteLength === 0) return;
          const playable = buildPlayableAudioBlob(entry.blob);
          const url = URL.createObjectURL(playable);
          pendingRecordIdRef.current = draftJob.id;
          setRecordSeconds(Math.max(1, Math.round((entry.blob.durationMs || 1000) / 1000)));
          setManagedDraftAudioUrl(url);
          setFailedError(undefined);
          setMicPhase("paused");
          audioLog("recording:rehydrated-draft", { id: draftJob.id, status: draftJob.status });
        } catch (err) {
          audioLogError("recording:rehydrate-failed", err, { conversationId });
        }
        return;
      }

      try {
        const records = await listPendingAudioByConversation(conversationId);
        if (cancelled || records.length === 0) return;
        const latest = records.sort((a, b) => b.createdAt - a.createdAt)[0];
        pendingRecordIdRef.current = latest.id;
        setFailedError(latest.lastError);
        setMicPhase("failed");
        audioLog("recording:rehydrated", { id: latest.id, status: latest.status });
      } catch (err) {
        audioLogError("recording:rehydrate-failed", err, { conversationId });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    conversationId,
    accountId,
    user?.id,
    audioFlags.audio_outbox_v2_enabled,
    setManagedDraftAudioUrl,
  ]);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // `flex-wrap`/`order`/`width: 100%` on [data-composer-capsule] (globals.css,
  // the iPhone-PWA-only "ChatGPT style" block) aren't animatable — the
  // single-line <-> multi-line reflow they drive always snaps instantly no
  // matter what transition is set on height/padding. Masks that snap with a
  // brief opacity dip on the capsule, timed to the exact moment the reflow
  // happens, so it reads as a quick fade instead of a jump. No-ops outside
  // that CSS block (capsuleRef is always attached, but the opacity dip is
  // invisible when nothing else about the layout is changing).
  const fadeCapsuleOnModeSwitch = useCallback(() => {
    const capsule = capsuleRef.current;
    if (!capsule) return;
    capsule.style.opacity = "0.55";
    requestAnimationFrame(() => {
      capsule.style.opacity = "1";
    });
  }, []);

  const measureAndApplyHeight = useCallback((el: HTMLTextAreaElement) => {
    const wasMultiline = el.hasAttribute("data-multiline");
    const startHeight = el.offsetHeight;

    // Reset height to auto first so scrollHeight accurately measures content
    el.style.height = "auto";

    const hasNewlines = el.value.includes("\n");
    const isEmpty = el.value.length === 0;

    if (isEmpty) {
      el.removeAttribute("data-multiline");
      el.style.height = "auto";
      if (wasMultiline) fadeCapsuleOnModeSwitch();
      return;
    }

    if (hasNewlines) {
      el.setAttribute("data-multiline", "");
    } else {
      // Determine if 1-line text wraps in single-row mode:
      // temporarily remove data-multiline and check single-row scrollHeight
      el.removeAttribute("data-multiline");
      el.style.height = "auto";
      const cs = getComputedStyle(el);
      const singleLineHeight =
        (parseFloat(cs.lineHeight) || 24) +
        parseFloat(cs.paddingTop) +
        parseFloat(cs.paddingBottom);

      if (el.scrollHeight > singleLineHeight + 1) {
        el.setAttribute("data-multiline", "");
      }
    }

    if (el.hasAttribute("data-multiline") !== wasMultiline) fadeCapsuleOnModeSwitch();

    // Measure final height under the chosen layout mode
    el.style.height = "auto";
    const csFinal = getComputedStyle(el);
    const lineH = parseFloat(csFinal.lineHeight) || 24;
    const padV = parseFloat(csFinal.paddingTop) + parseFloat(csFinal.paddingBottom);
    // Cap at exactly 4 visible lines; lines 5+ scroll internally
    const maxHeight = Math.round(lineH * 4 + padV);
    const targetHeight = Math.min(el.scrollHeight, maxHeight);

    // The `height: auto` reset above already forced the box to its new
    // (unanimated) natural size the instant `el.scrollHeight` was read —
    // by this point the element has already snapped to targetHeight, so
    // assigning the same number again is a zero-delta change and the CSS
    // `height` transition never has anything to animate. Explicitly
    // restore the pre-measurement height, force a layout flush, and only
    // then assign the target so the browser sees a real old->new delta.
    el.style.height = `${startHeight}px`;
    void el.offsetHeight;
    el.style.height = `${targetHeight}px`;
  }, [fadeCapsuleOnModeSwitch]);

  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;

    // The measuring below collapses the textarea to `height: auto` and
    // forces layout (scrollHeight/offsetHeight reads) several times before
    // the final height is written. Without this pin, the composer really
    // did get shorter for those forced layouts, the thread's scroll box
    // (its flex sibling) grew, and WebKit clamped the thread's scrollTop
    // to the new, smaller max — a clamp that is NOT undone when the
    // composer is restored right after. Net effect on every keystroke:
    // the last bubble dropped 60-115px behind the composer, then got
    // dragged back a few frames later. Freezing the shell's box for the
    // duration keeps those transient layouts invisible to the thread.
    const shell = el.closest<HTMLElement>("[data-composer-shell]");
    if (shell) shell.style.height = `${shell.offsetHeight}px`;
    try {
      measureAndApplyHeight(el);
    } finally {
      if (shell) shell.style.height = "";
    }
  }, [measureAndApplyHeight]);


  const handleSend = useCallback(async () => {
    if (isSubmittingRef.current || sending || sessionExpired) return;
    isSubmittingRef.current = true;

    try {
      const trimmed = text.trim();
      if (!trimmed) return;

      setSending(true);
      try {
        onSend(trimmed, replyTo?.id);
        setText("");
        setSlashToken(null);
        if (textareaRef.current) {
          textareaRef.current.removeAttribute("data-multiline");
          textareaRef.current.style.height = "auto";
          textareaRef.current.focus();
        }
      } finally {
        setSending(false);
      }
    } finally {
      setTimeout(() => {
        isSubmittingRef.current = false;
      }, 400);
    }
  }, [text, sending, sessionExpired, onSend, replyTo?.id]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const value = e.target.value;
      setText(value);
      // adjustHeight() runs once from the [text] effect below — calling it
      // here too used to race it: this call would kick off the CSS height
      // transition, then the effect's own adjustHeight() (queued by the
      // setText above) ran a moment later and opened with
      // `el.style.height = "auto"`, which instantly kills any in-flight
      // height transition (height can't animate to/from "auto"). Every
      // keystroke was starting and immediately aborting its own
      // transition, which is why the composer never visibly animated in
      // either direction no matter how the transition itself was tuned.
      setSlashToken(findSlashToken(value, e.target.selectionStart ?? value.length));
      setActiveSuggestion(0);
    },
    []
  );

  // Replaces just the "/shortcut" token with the saved content, leaving
  // everything before/after it untouched — the caret lands right after
  // the inserted text so the agent can keep editing before sending.
  const applySuggestion = useCallback(
    (qr: QuickReply) => {
      if (!slashToken) return;
      const insertion = qr.content_text ?? "";
      const before = text.slice(0, slashToken.start);
      const after = text.slice(slashToken.start + slashToken.query.length);
      pendingCaretRef.current = before.length + insertion.length;
      setText(`${before}${insertion}${after}`);
      setSlashToken(null);
      setActiveSuggestion(0);
    },
    [slashToken, text],
  );

  // Re-measures height and restores the caret after a suggestion insert —
  // deferred here (rather than inline in applySuggestion) because the
  // textarea's DOM value only reflects the new text after this effect
  // runs, one render after the setText() call above.
  useEffect(() => {
    adjustHeight();
    if (pendingCaretRef.current !== null) {
      const pos = pendingCaretRef.current;
      pendingCaretRef.current = null;
      const el = textareaRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(pos, pos);
      }
    }
  }, [text, adjustHeight]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (slashToken && suggestions.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setActiveSuggestion((i) => (i + 1) % suggestions.length);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setActiveSuggestion((i) => (i - 1 + suggestions.length) % suggestions.length);
          return;
        }
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          applySuggestion(suggestions[activeSuggestion]);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setSlashToken(null);
          return;
        }
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void handleSend();
      }
    },
    [slashToken, suggestions, activeSuggestion, applySuggestion, handleSend]
  );

  // Upload a captured file to chat-media and stage it as a draft.
  const stageUpload = useCallback(
    async (kind: Exclude<ComposerMediaKind, "audio">, pickedFile: File) => {
      // iPhone .mov (QuickTime/HEVC by default since iOS 11): neither
      // the chat-media bucket's MIME whitelist nor Meta's outbound video
      // codec requirement (H.264/AAC in MP4/3GPP) accept it. Transcode
      // to a real .mp4 client-side first, so every check and the upload
      // itself below run completely unchanged, exactly as for a native
      // .mp4 — see transcode-mov-webcodecs.ts (native WebCodecs, not
      // ffmpeg.wasm — validated live on iPhone: a 41s/116MB 4K HEVC
      // clip converted in 24.9s; the old ffmpeg.wasm path could hang
      // indefinitely on the same class of file).
      let file = pickedFile;
      const isHeic = kind === "image" && isHeicFile(file);
      if (kind === "image") {
        if (!isHeic) {
          setBusy(true);
          try {
            const normResult = await normalizeImageForUpload(file);
            file = normResult.file;
          } catch (err) {
            setBusy(false);
            toast.error(err instanceof Error ? err.message : t("unsupportedFileType"));
            return;
          }
        }
      } else if (kind === "video") {
        const needsTranscode = await shouldTranscodeVideo(file);
        if (needsTranscode) {
          setBusy(true);
          try {
            file = await convertMovToMp4ViaWebCodecs(file);
          } catch (err) {
            setBusy(false);
            toast.error(err instanceof Error ? err.message : t("unsupportedVideoType"));
            return;
          }
        }
      }
      // Per-kind ceiling mirrors Meta's caps (image 5 MB, etc.) so we
      // reject before upload rather than orphaning an object that Meta
      // would then refuse at send. HEIC allows MEDIA_MAX_BYTES (16MB) directly to R2.
      const max = isHeic ? MEDIA_MAX_BYTES : MEDIA_MAX_BYTES_BY_KIND[kind];
      if (file.size > max) {
        // Was a hardcoded English string — silent to a non-English-reading
        // agent, who'd just see "attaching didn't work" with no clue it
        // was a size cap. Localized + explicit so a large document (a
        // common real-estate PDF catalog, easily >16 MB) reads as
        // "too big", not as a mystery failure.
        toast.error(
          t("fileTooLarge", {
            sizeMb: (file.size / 1024 / 1024).toFixed(1),
            // "image"'s label key is "photo", not "image" — the other two
            // kinds happen to share their key name with themselves.
            kind: t(kind === "image" ? "photo" : kind),
            limitMb: Math.round(max / 1024 / 1024),
          }),
        );
        return;
      }
      // Mirrors the chat-media bucket's allowed_mime_types (migration
      // 023). The picker's `accept` attribute is only a hint — iOS in
      // particular still lets the user pick a QuickTime/HEVC (.mov)
      // video through "Browse"/Files, which Storage then rejects with a
      // raw, untranslated error. Catching it here gives an actionable
      // message instead.
      const clientMime = resolveClientFileMime(file);
      const allowed = ALLOWED_MIME_TYPES_BY_KIND[kind] as readonly string[];
      const isAllowed =
        allowed.includes(clientMime) ||
        isHeic ||
        (kind === "document" &&
          (clientMime.startsWith("video/") || clientMime === "application/octet-stream"));
      if (!isAllowed) {
        toast.error(
          kind === "video" ? t("unsupportedVideoType") : t("unsupportedFileType"),
        );
        return;
      }
      setBusy(true);
      try {
        const { key, requiresProcessing } = await presignAndUpload("chat-attachment", kind, file);
        let finalKey = key;
        let previewUrl = URL.createObjectURL(file);
        if (isHeic && (!file.type || file.type === "application/octet-stream")) {
          try {
            previewUrl = URL.createObjectURL(new Blob([file], { type: "image/heic" }));
          } catch {
            previewUrl = URL.createObjectURL(file);
          }
        }
        if (requiresProcessing) {
          toast.info("Processando foto...");
          const normResult = await pollNormalizationStatus(key);
          finalKey = normResult.normalizedKey;
          if (normResult.resolvedUrl) {
            previewUrl = normResult.resolvedUrl;
          }
        }
        // Local preview only — the file is already in memory, so this
        // needs no network round trip (unlike resolving a private R2
        // key, which is for *sent* media, not a draft nobody's seen yet).
        // Replacing an existing draft? GC the previous object + revoke
        // its preview first.
        removeStaged(draftRef.current?.path);
        revokeStagedPreview(draftRef.current?.previewUrl);
        if (previewUrl?.startsWith("blob:")) {
          registerLocalMediaBlob(finalKey, previewUrl);
          if (key !== finalKey) {
            registerLocalMediaBlob(key, previewUrl);
          }
        }
        setDraft({ kind, previewUrl, path: finalKey, filename: file.name, caption: "" });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Upload failed.");
      } finally {
        setBusy(false);
      }
    },
    [removeStaged, t],
  );

  // Upload + send a single file immediately, bypassing the draft/caption
  // step above. Used only when multiple files are picked at once — a
  // per-file caption UI doesn't apply to a batch, so each file just goes
  // out as its own message as soon as it's uploaded. Mirrors stageUpload's
  // validation exactly (same size cap, same MIME whitelist, same .mov
  // transcode), kept as a separate function so the existing single-file
  // draft/caption/send flow above is completely untouched.
  const uploadAndSend = useCallback(
    async (kind: Exclude<ComposerMediaKind, "audio">, pickedFile: File) => {
      let file = pickedFile;
      const isHeic = kind === "image" && isHeicFile(file);
      if (kind === "image") {
        if (!isHeic) {
          try {
            const normResult = await normalizeImageForUpload(file);
            file = normResult.file;
          } catch (err) {
            toast.error(err instanceof Error ? err.message : t("unsupportedFileType"));
            return;
          }
        }
      } else if (kind === "video") {
        const needsTranscode = await shouldTranscodeVideo(file);
        if (needsTranscode) {
          try {
            file = await convertMovToMp4ViaWebCodecs(file);
          } catch (err) {
            toast.error(err instanceof Error ? err.message : t("unsupportedVideoType"));
            return;
          }
        }
      }
      const max = isHeic ? MEDIA_MAX_BYTES : MEDIA_MAX_BYTES_BY_KIND[kind];
      if (file.size > max) {
        toast.error(
          t("fileTooLarge", {
            sizeMb: (file.size / 1024 / 1024).toFixed(1),
            kind: t(kind === "image" ? "photo" : kind),
            limitMb: Math.round(max / 1024 / 1024),
          }),
        );
        return;
      }
      const allowed = ALLOWED_MIME_TYPES_BY_KIND[kind] as readonly string[];
      const isAllowed =
        !file.type ||
        allowed.includes(file.type) ||
        isHeic ||
        (kind === "document" &&
          (file.type.startsWith("video/") || file.type === "application/octet-stream"));
      if (!isAllowed) {
        toast.error(kind === "video" ? t("unsupportedVideoType") : t("unsupportedFileType"));
        return;
      }
      try {
        const { key, requiresProcessing } = await presignAndUpload("chat-attachment", kind, file);
        let finalKey = key;
        if (requiresProcessing) {
          const normResult = await pollNormalizationStatus(key);
          finalKey = normResult.normalizedKey;
        }
        onSendMedia({
          kind,
          mediaUrl: finalKey,
          path: finalKey,
          filename: kind === "document" ? file.name : undefined,
        });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Upload failed.");
      }
    },
    [onSendMedia, t],
  );

  const handlePicked = useCallback(
    (kind: "image" | "video" | "document", fileList: FileList | null) => {
      if (!fileList || fileList.length === 0) return;
      const files = Array.from(fileList);

      // WhatsApp Model: Images and Videos (single or multiple) are dispatched directly in 0ms,
      // without ANY intermediate staging bar or second send click!
      if (kind === "image" || kind === "video") {
        const caption = text.trim() || undefined;
        setText("");
        setSlashToken(null);
        if (textareaRef.current) {
          textareaRef.current.removeAttribute("data-multiline");
          textareaRef.current.style.height = "auto";
        }
        if (onSendMediaBatch) {
          onSendMediaBatch({
            kind,
            files,
            caption,
            replyToId: replyTo?.id,
          });
        }
        onClearReply?.();
        return;
      }

      // Exactly one non-media file (document) — stage draft
      if (files.length === 1) {
        void stageUpload(kind, files[0]);
        return;
      }

      // Multiple non-media files (documents): keep sequential behavior
      setBusy(true);
      void (async () => {
        try {
          for (const file of files) {
            await uploadAndSend(kind, file);
          }
        } catch (err) {
          toast.error(err instanceof Error ? err.message : "Upload failed.");
        } finally {
          setBusy(false);
        }
      })();
    },
    [onClearReply, onSendMediaBatch, replyTo?.id, stageUpload, text, uploadAndSend],
  );

  // The encoded Ogg/Opus bytes from opus-recorder, the instant the
  // recorder actually stops. This used to also kick off the Storage
  // upload right here and `await` it before ever returning — on iOS
  // Safari/WKWebView a fetch that's in flight when the PWA gets
  // backgrounded (screen lock, app switch) can be suspended by the OS and
  // never settle (neither resolve nor reject), which left this promise —
  // and with it `micPhase === "sending"`'s Trash/Send buttons, both
  // `disabled={micPhase === "sending"}` — stuck forever. The only escape
  // was force-quitting the whole PWA. Root cause + full writeup in the
  // audio-pipeline investigation; the fix is architectural, not a patch:
  // no network call happens in this component at all anymore. The bytes
  // are saved to pending-audio-db.ts (IndexedDB) synchronously below,
  // then handed off to `onRecordAudio` (message-thread.tsx's
  // handleQueuedAudio, backed by pending-audio-sync.ts) which owns the
  // actual upload+send — every step of it timeout-bounded and retried —
  // entirely outside this component's render lifecycle. This function
  // itself now never awaits the network, so it always returns fast.
  const finalizeRecording = useCallback(
    async (payload: CaptureDataPayload) => {
      const {
        recordingId: id,
        bytes,
        mimeType: capturedMimeType,
        captureDurationMs,
        sendOnStop,
        rmsPeak,
        analyserSamples,
        replyToId,
      } = payload;

      if (finalizationInFlightRef.current) {
        audioLog("recording:dataavailable:duplicate", { traceId: id, sizeBytes: bytes.byteLength });
        return;
      }
      finalizationInFlightRef.current = true;
      const baseMime = (capturedMimeType || "audio/ogg").split(";")[0].toLowerCase().trim();
      const ext = baseMime === "audio/mp4" ? "m4a" : baseMime === "audio/webm" ? "webm" : "ogg";
      const effectiveReplyToId = replyToId ?? replyTo?.id;

      audioLog("recording:dataavailable", { traceId: id, sizeBytes: bytes.byteLength, mimeType: baseMime });

      const validation = audioFlags.audio_capture_v2_enabled
        ? validateCapturedAudio({
            bytes,
            mimeType: baseMime,
            durationMs: captureDurationMs,
            rmsPeak,
            analyserSamples,
            maxBytes: MEDIA_MAX_BYTES_BY_KIND.audio,
          })
        : null;

      const file = new File([bytes as unknown as BlobPart], `voice-${Date.now()}.${ext}`, {
        type: baseMime,
      });
      audioLog("recording:file-created", { traceId: id, sizeBytes: file.size, mimeType: file.type });
      audioLog("recording:stopped", { traceId: id, sizeBytes: file.size });

      if (validation && !validation.ok) {
        const failureCat: AudioFailureCategory =
          validation.reason === "file-too-large"
            ? "file_too_large"
            : validation.reason === "silent-capture-interrupted"
              ? "silent_capture_interrupted"
              : "empty_or_silent_capture";
        updateAudioDiagnosticSession(
          id,
          (prev) => ({
            ...prev,
            stage:
              validation.reason === "file-too-large"
                ? "validation_failed_too_large"
                : "validation_failed_empty",
            recorderState: "failed",
            captureDurationMs,
            fragmentCount: validation.pageCount || 1,
            fileSizeBytes: file.size,
            format: file.type || "audio/ogg",
            codec: ext === "ogg" ? "opus" : "aac",
            rmsPeak,
            validationResult: {
              ok: false,
              reason: validation.reason,
              hasOggMagic: validation.hasOggMagic,
              hasEosPage: validation.hasEosPage,
            },
            failureCategory: failureCat,
            errorDetail: validation.detail,
          }),
          { flush: true },
        );
        updateLiveRecorderResources({ micPhase: "idle" });
        if (validation.reason === "file-too-large") {
          toast.error(t("recordingTooLong"));
        } else if (validation.reason === "silent-capture-interrupted") {
          toast.error("Áudio sem som capturado (microfone interrompido pelo sistema). Tente gravar novamente.");
        } else if (validation.reason === "invalid-ogg-header") {
          toast.error("Gravação corrompida ao finalizar. Tente novamente.");
        }
        sendOnStopRef.current = false;
        setMicPhase("idle");
        setLocked(false);
        finalizationInFlightRef.current = false;
        audioLog("recording:error", { traceId: id, reason: validation.reason, sizeBytes: file.size });
        return;
      }

      const hasOggMagic =
        validation?.ok
          ? validation.hasOggMagic
          : bytes.byteLength >= 4 &&
            bytes[0] === 0x4f &&
            bytes[1] === 0x67 &&
            bytes[2] === 0x67 &&
            bytes[3] === 0x53;

      if (!validation && file.size < 200) {
        updateAudioDiagnosticSession(
          id,
          (prev) => ({
            ...prev,
            stage: "validation_failed_empty",
            recorderState: "failed",
            captureDurationMs,
            fragmentCount: 1,
            fileSizeBytes: file.size,
            format: file.type || "audio/ogg",
            codec: "opus",
            validationResult: { ok: false, reason: "empty-file", hasOggMagic },
            failureCategory: "empty_or_silent_capture",
            errorDetail: `Empty/header-only file (${file.size} bytes)`,
          }),
          { flush: true },
        );
        updateLiveRecorderResources({ micPhase: "idle" });
        sendOnStopRef.current = false;
        setMicPhase("idle");
        setLocked(false);
        finalizationInFlightRef.current = false;
        audioLog("recording:error", { traceId: id, reason: "empty-file", sizeBytes: file.size });
        return;
      }
      if (!validation && file.size > MEDIA_MAX_BYTES_BY_KIND.audio) {
        updateAudioDiagnosticSession(
          id,
          (prev) => ({
            ...prev,
            stage: "validation_failed_too_large",
            recorderState: "failed",
            captureDurationMs,
            fragmentCount: 1,
            fileSizeBytes: file.size,
            validationResult: { ok: false, reason: "file-too-large", hasOggMagic },
            failureCategory: "file_too_large",
          }),
          { flush: true },
        );
        updateLiveRecorderResources({ micPhase: "idle" });
        toast.error(t("recordingTooLong"));
        sendOnStopRef.current = false;
        setMicPhase("idle");
        setLocked(false);
        finalizationInFlightRef.current = false;
        audioLog("recording:error", { traceId: id, reason: "file-too-large", sizeBytes: file.size });
        return;
      }

      const shouldSendNow = sendOnStop || sendOnStopRef.current;

      updateAudioDiagnosticSession(id, (prev) => ({
        ...prev,
        stage: "validated_persisting",
        recorderState: "finalizing",
        captureDurationMs,
        fragmentCount: validation?.pageCount || 1,
        fileSizeBytes: file.size,
        format: file.type || "audio/ogg",
        codec: ext === "ogg" ? "opus" : "aac",
        rmsPeak,
        validationResult: {
          ok: true,
          hasOggMagic,
          hasEosPage: validation?.hasEosPage,
        },
      }));

      const persistStart = Date.now();
      const useOutboxV2 = Boolean(audioFlags.audio_outbox_v2_enabled && accountId && user?.id);

      if (useOutboxV2 && accountId && user?.id) {
        try {
          const exactBuffer = bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
          ) as ArrayBuffer;
          const outboxRes = await persistAudioToOutbox({
            id,
            accountId,
            userId: user.id,
            conversationId,
            replyToId: effectiveReplyToId,
            arrayBuffer: exactBuffer,
            mimeType: file.type || "audio/ogg",
            codec: ext === "ogg" ? "opus" : "aac",
            durationMs: captureDurationMs,
            rmsPeak,
            sendAuthorized: Boolean(shouldSendNow),
          });
          audioLog("recording:saved-local", {
            id,
            traceId: id,
            persistedInIdb: outboxRes.persistedInIdb,
          });
          updateAudioDiagnosticSession(id, (prev) => ({
            ...prev,
            stage: "persisted_local",
            persistenceResult: {
              ok: true,
              storage: outboxRes.persistedInIdb ? "idb_v2" : "ram_vault",
              latencyMs: Date.now() - persistStart,
              error: outboxRes.error,
            },
          }));
          if (!outboxRes.persistedInIdb) {
            toast.warning(
              "Armazenamento local indisponível — áudio mantido em memória até concluir o envio.",
            );
          }
        } catch (err) {
          audioLogError("recording:save-local-failed", err, { id });
          updateAudioDiagnosticSession(
            id,
            (prev) => ({
              ...prev,
              stage: "persist_failed",
              persistenceResult: {
                ok: false,
                storage: "none",
                latencyMs: Date.now() - persistStart,
                error: err instanceof Error ? err.message : String(err),
              },
              failureCategory: "idb_persist_failed",
              errorDetail: err instanceof Error ? err.message : String(err),
            }),
            { flush: true },
          );
        }
      } else {
        const record: PendingAudioRecord = {
          id,
          conversationId,
          replyToId: effectiveReplyToId,
          blob: file,
          mimeType: file.type,
          sizeBytes: file.size,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          status: "uploading",
          attempts: 0,
        };

        try {
          await putPendingAudio(record);
          audioLog("recording:saved-local", { id, traceId: id });
          updateAudioDiagnosticSession(id, (prev) => ({
            ...prev,
            stage: "persisted_local",
            persistenceResult: {
              ok: true,
              storage: "idb_v1",
              latencyMs: Date.now() - persistStart,
            },
          }));
        } catch (err) {
          audioLogError("recording:save-local-failed", err, { id });
          updateAudioDiagnosticSession(
            id,
            (prev) => ({
              ...prev,
              stage: "persist_failed",
              persistenceResult: {
                ok: false,
                storage: "none",
                latencyMs: Date.now() - persistStart,
                error: err instanceof Error ? err.message : String(err),
              },
              failureCategory: "idb_persist_failed",
              errorDetail: err instanceof Error ? err.message : String(err),
            }),
            { flush: true },
          );
        }
      }

      if (shouldSendNow) {
        sendOnStopRef.current = false;
        pendingRecordIdRef.current = null;
        setManagedDraftAudioUrl(null);
        setMicPhase("idle");
        setLocked(false);
        updateLiveRecorderResources({ micPhase: "idle" });
        onRecordAudio(id, effectiveReplyToId);
        onClearReply?.();
        audioLog("recording:finalized", { id, traceId: id, mode: "send-on-stop" });
        finalizationInFlightRef.current = false;
        return;
      }

      // No decision yet — sit in "paused" with the trash/preview/send bar;
      // local preview lets the agent listen before authorizing send.
      try {
        const previewUrl = URL.createObjectURL(file);
        setManagedDraftAudioUrl(previewUrl);
      } catch {
        setManagedDraftAudioUrl(null);
      }
      pendingRecordIdRef.current = id;
      setMicPhase("paused");
      setLocked(false);
      updateAudioDiagnosticSession(id, (prev) => ({
        ...prev,
        stage: "paused_in_composer",
        recorderState: "paused",
      }));
      updateLiveRecorderResources({ micPhase: "paused" });
      audioLog("recording:finalized", { id, traceId: id, mode: "paused" });
      finalizationInFlightRef.current = false;
    },
    [
      conversationId,
      onRecordAudio,
      replyTo?.id,
      onClearReply,
      t,
      audioFlags.audio_outbox_v2_enabled,
      audioFlags.audio_capture_v2_enabled,
      accountId,
      user?.id,
      setManagedDraftAudioUrl,
    ],
  );

  const finalizeRecordingRef = useRef(finalizeRecording);
  useEffect(() => {
    finalizeRecordingRef.current = finalizeRecording;
  }, [finalizeRecording]);

  const handlePhaseChangeRef = useRef<(phase: CaptureControllerPhase, meta?: CapturePhaseMeta) => void>(() => {});
  handlePhaseChangeRef.current = (phase, meta) => {
    if (phase === "initializing") {
      clearTimer();
      setRecordSeconds(0);
      setFailedError(undefined);
      setLocked(false);
      setMicPhase("initializing");
      return;
    }
    if (phase === "recording") {
      clearTimer();
      setRecordSeconds(0);
      setMicPhase("recording");
      timerRef.current = setInterval(() => {
        captureControllerRef.current?.sampleRms();
        setRecordSeconds((s) => s + 1);
      }, 1000);
      return;
    }
    if (phase === "finalizing") {
      clearTimer();
      setMicPhase(sendOnStopRef.current ? "sending" : "paused");
      return;
    }
    if (phase === "failed") {
      clearTimer();
      finalizationInFlightRef.current = false;
      sendOnStopRef.current = false;
      setLocked(false);
      if (meta?.reason === "unsupported") {
        toast.error(t("recordingNotSupported"));
      } else if (meta?.category === "permission_denied") {
        toast.error(t("recordingPermissionDenied"));
      } else if (meta?.category === "recorder_timeout") {
        toast.error("Microfone demorou para responder. Toque novamente para gravar.");
      } else {
        toast.error("Não foi possível inicializar o gravador neste navegador. Tente novamente.");
      }
      if (!pendingRecordIdRef.current) {
        setFailedError(undefined);
        setMicPhase("idle");
        updateLiveRecorderResources({ micPhase: "idle" });
      } else {
        setFailedError(meta?.errorDetail);
        setMicPhase("failed");
      }
      return;
    }
    clearTimer();
    finalizationInFlightRef.current = false;
    sendOnStopRef.current = false;
    setLocked(false);
    setMicPhase("idle");
  };

  const getCaptureController = useCallback(() => {
    if (!captureControllerRef.current) {
      captureControllerRef.current = new AudioCaptureController({
        onPhaseChange: (phase, meta) => handlePhaseChangeRef.current(phase, meta),
        onDataReady: (payload) => finalizeRecordingRef.current(payload),
        onWarning: (msg) => toast.warning(msg),
      });
    }
    return captureControllerRef.current;
  }, []);

  // ---- Mic pointer gesture ---------------------------------------------
  const startRecordingGesture = useCallback(() => {
    if (micPhaseRef.current !== "idle") return;
    pendingRecordIdRef.current = null;
    finalizationInFlightRef.current = false;
    sendOnStopRef.current = false;
    setFailedError(undefined);
    setManagedDraftAudioUrl(null);
    setLocked(false);
    setRecordSeconds(0);
    getCaptureController().startGesture({
      captureV2Enabled: audioFlags.audio_capture_v2_enabled,
      nativeCaptureEnabled: audioFlags.audio_native_capture_enabled,
      prewarmedRecorderClass: recorderModuleRef.current,
      replyToId: replyTo?.id,
    });
  }, [
    audioFlags.audio_capture_v2_enabled,
    audioFlags.audio_native_capture_enabled,
    getCaptureController,
    replyTo?.id,
    setManagedDraftAudioUrl,
  ]);

  const stopRecordingGesture = useCallback(() => {
    const phase = micPhaseRef.current;
    if (phase !== "recording" && phase !== "initializing") return;
    clearTimer();
    void getCaptureController().stop({ sendOnStop: false });
  }, [clearTimer, getCaptureController]);

  // If iOS locks the screen or switches apps mid-recording, preserve what was
  // spoken so far locally as `saved_draft` (`paused`) — NEVER auto-send.
  useEffect(() => {
    if (!audioFlags.audio_capture_v2_enabled) return;
    const handleBackgroundSave = () => {
      void captureControllerRef.current?.handleVisibilityInterruption();
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        handleBackgroundSave();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", handleBackgroundSave);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", handleBackgroundSave);
    };
  }, [audioFlags.audio_capture_v2_enabled]);

  const handleMicPointerDown = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      if (inputsDisabled || busy) return;
      if (micPhaseRef.current !== "idle") return;

      e.preventDefault();
      // Start synchronously inside pointerdown for BOTH mouse and touch/pen so
      // iOS WebKit preserves userActivation for AudioContext.resume() and getUserMedia().
      if (e.pointerType !== "mouse") {
        try {
          micButtonRef.current?.setPointerCapture(e.pointerId);
        } catch {}
        gestureRef.current = { startY: e.clientY };
      }
      startRecordingGesture();
    },
    [inputsDisabled, busy, startRecordingGesture],
  );

  const handleMicPointerMove = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      if (e.pointerType === "mouse") return;
      const gesture = gestureRef.current;
      const phase = micPhaseRef.current;
      if (!gesture || locked || (phase !== "recording" && phase !== "initializing")) return;
      const dy = gesture.startY - e.clientY; // positive = dragged up
      if (lockHintRef.current) {
        const progress = Math.min(1, Math.max(0, dy / LOCK_THRESHOLD_PX));
        const eased = 1 - (1 - progress) * (1 - progress);
        lockHintRef.current.style.transform = `translateY(${-(eased * LOCK_THRESHOLD_PX)}px) scale(${0.85 + eased * 0.35})`;
        lockHintRef.current.style.opacity = String(0.55 + eased * 0.45);
      }
      if (dy > LOCK_THRESHOLD_PX) {
        setLocked(true);
      }
    },
    [locked],
  );

  const handleMicPointerEnd = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      if (e.pointerType === "mouse") return;
      e.preventDefault();
      try {
        micButtonRef.current?.releasePointerCapture(e.pointerId);
      } catch {}
      gestureRef.current = null;
      if (locked) return;
      stopRecordingGesture();
    },
    [locked, stopRecordingGesture],
  );

  const handleDiscardRecording = useCallback(() => {
    try {
      draftPreviewAudioRef.current?.pause();
    } catch {}
    setManagedDraftAudioUrl(null);
    if (micPhase === "initializing" || micPhase === "recording") {
      clearTimer();
      sendOnStopRef.current = false;
      setLocked(false);
      void getCaptureController().cancel("user_discarded");
      return;
    }
    if (micPhase === "paused" || micPhase === "failed") {
      const id = pendingRecordIdRef.current;
      pendingRecordIdRef.current = null;
      setMicPhase("idle");
      setLocked(false);
      setFailedError(undefined);
      if (id) {
        if (audioFlags.audio_outbox_v2_enabled) {
          void discardOutboxAudioJob(id);
        } else {
          void discardPendingAudio(id);
        }
      }
    }
  }, [
    micPhase,
    clearTimer,
    getCaptureController,
    audioFlags.audio_outbox_v2_enabled,
    setManagedDraftAudioUrl,
  ]);

  const handleSendRecording = useCallback(() => {
    if (finalizationInFlightRef.current) return;
    if (micPhase === "initializing" || micPhase === "sending") return;
    audioLog("recording:send-click", {
      traceId: captureControllerRef.current?.getActiveRecordingId() ?? pendingRecordIdRef.current,
    });
    try {
      draftPreviewAudioRef.current?.pause();
    } catch {}
    if (micPhase === "recording") {
      clearTimer();
      sendOnStopRef.current = true;
      setMicPhase("sending");
      void getCaptureController().stop({ sendOnStop: true });
      return;
    }
    if (micPhase === "paused" || micPhase === "failed") {
      const id = pendingRecordIdRef.current;
      pendingRecordIdRef.current = null;
      setManagedDraftAudioUrl(null);
      setMicPhase("idle");
      setLocked(false);
      setFailedError(undefined);
      if (id) {
        onRecordAudio(id, replyTo?.id);
        onClearReply?.();
      }
    }
  }, [
    micPhase,
    clearTimer,
    getCaptureController,
    onRecordAudio,
    replyTo?.id,
    onClearReply,
    setManagedDraftAudioUrl,
  ]);

  // Auto-stop at the cap so a forgotten recording can't blow the upload
  // size limit — pauses exactly like an unlocked release (keeps what was
  // captured, doesn't discard or auto-send).
  useEffect(() => {
    if (micPhase === "recording" && recordSeconds >= MAX_RECORDING_SECONDS) {
      clearTimer();
      void getCaptureController().stop({ sendOnStop: false });
    }
  }, [micPhase, recordSeconds, clearTimer, getCaptureController]);

  // Tear down ONLY on true component unmount (empty dependency array).
  // Re-renders or parent callback changes must NEVER cancel an active recording.
  const unmountCleanupRef = useRef<() => void>(() => {});
  unmountCleanupRef.current = () => {
    clearTimer();
    if (draftAudioUrlRef.current?.startsWith("blob:")) {
      URL.revokeObjectURL(draftAudioUrlRef.current);
      draftAudioUrlRef.current = null;
    }
    void captureControllerRef.current?.destroy();
    removeStaged(draftRef.current?.path);
    revokeStagedPreview(draftRef.current?.previewUrl);
  };
  useEffect(() => {
    return () => {
      unmountCleanupRef.current();
    };
  }, []);

  // ---- Draft send / discard (image/video/document) --------------------

  const sendDraft = useCallback(() => {
    if (!draft || busy) return;
    forensic.log(22, "envio", "ok", {
      mode: "single-draft",
      path: draft.path,
      kind: draft.kind,
      caption: draft.caption.trim() || undefined,
    });
    onSendMedia({
      kind: draft.kind,
      // The real R2 key — never the local preview blob, which is
      // meaningless outside this browser tab.
      mediaUrl: draft.path,
      path: draft.path,
      caption: draft.caption.trim() || undefined,
      filename: draft.kind === "document" ? draft.filename : undefined,
      replyToId: replyTo?.id,
    });
    // Keep local preview blob alive in localBlobRegistry for smooth optimistic display
    if (draft.previewUrl?.startsWith("blob:")) {
      registerLocalMediaBlob(draft.path, draft.previewUrl);
      scheduleRevokeLocalMediaBlob(draft.path, 300_000);
    }
    // The object is now owned by the sent message — clear without GC.
    setDraft(null);
    onClearReply?.();
  }, [draft, busy, onSendMedia, replyTo?.id, onClearReply]);

  // Discard GCs the staged object — it was uploaded but never sent.
  const discardDraft = useCallback(() => {
    if (draft?.path) {
      revokeLocalMediaBlobImmediately(draft.path);
    }
    removeStaged(draft?.path);
    revokeStagedPreview(draft?.previewUrl);
    setDraft(null);
  }, [draft?.path, draft?.previewUrl, removeStaged]);

  const setCaption = useCallback((caption: string) => {
    setDraft((d) => (d ? { ...d, caption } : d));
  }, []);

  // ---- Render --------------------------------------------------------

  const micActive = micPhase !== "idle";

  return (
    // `px-3 py-2` (not `p-3`) — the bar was a bit taller than it needed
    // to be, leaving more empty padding above the safe-area buffer than
    // the actual input row needed (2026-08-07, parte 15 fine-tune). The
    // bottom padding overrides just that side: the same 0.5rem as the
    // other three, plus the device's safe-area inset (home indicator /
    // gesture bar) on top of that — unchanged mechanism, just a smaller
    // base amount. `env()` resolves to 0 on devices without one (desktop,
    // older phones), so this is a no-op there. Requires `viewport-fit=cover`
    // (see app/layout.tsx), otherwise iOS never reports a nonzero inset.
    // py-[9px] (was py-2/8px, ~15% more): the enlarged Attach/Mic buttons
    // (h-[47px], up from h-9/36px) need a touch more breathing room in the
    // bar itself — bottom mirrors it, on top of the safe-area inset.
    // `--composer-safe-bottom` (falls back to the raw inset wherever
    // use-app-height.ts's hook is a no-op — desktop, Android, a regular
    // Safari tab) collapses to 0 while the keyboard is open in a
    // standalone iOS PWA, where the inset otherwise keeps reserving
    // home-indicator space the keyboard has already covered.
    // `data-composer-shell` is a plain structural hook — no conditional
    // logic attached to it here, it's always present. Consumed only by
    // the iPhone-PWA-scoped CSS block in globals.css (see the
    // `@supports (-webkit-touch-callout: none)` composer section there),
    // which is the sole place any platform branching happens.
    <div
      data-composer-shell
      className="border-t border-border bg-card px-3 py-[6px] pb-[calc(6px+var(--composer-safe-bottom,env(safe-area-inset-bottom)))]"
    >
      {replyTo && (
        <div className="mb-2">
          <ReplyQuote
            authorLabel={replyTo.authorLabel}
            preview={replyTo.preview}
            media={replyTo.media}
            onDismiss={onClearReply}
          />
        </div>
      )}
      {pendingInitialText && (
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-primary/30 bg-primary/10 px-3 py-1.5 text-xs">
          <span className="text-foreground">
            Existe texto em edição. Deseja substituir pelo rascunho preparado?
          </span>
          <div className="flex items-center gap-1.5">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => setPendingInitialText(null)}
            >
              Manter atual
            </Button>
            <Button
              type="button"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={() => {
                setText(pendingInitialText);
                setPendingInitialText(null);
                textareaRef.current?.focus();
              }}
            >
              Usar rascunho
            </Button>
          </div>
        </div>
      )}
      {sessionExpired && (
        <div className="mb-2 flex items-center justify-between rounded-lg bg-amber-500/10 px-3 py-2">
          <p className="text-xs text-amber-400">
            {t("sessionExpiredHint")}
          </p>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs text-amber-400 hover:text-amber-300"
            onClick={onOpenTemplates}
          >
            <LayoutTemplate className="mr-1 h-3 w-3" />
            {t("templates")}
          </Button>
        </div>
      )}

      {draft ? (
        <MediaDraftPreview
          draft={draft}
          busy={busy}
          readOnly={readOnly}
          onCaptionChange={setCaption}
          onDiscard={discardDraft}
          onSend={sendDraft}
          t={t}
          pdfPreviewContainerRef={pdfPreviewContainerRef}
        />
      ) : (
        // `relative` wrapper keeps the mic button mounted (just made
        // invisible + taken out of flow) for the whole recording gesture
        // instead of unmounting it — removing an element mid-gesture
        // would drop its pointer capture and break drag-to-lock. The
        // recording bar overlays in its place, visually replacing the
        // whole row exactly as if it were a swap. */}
        <div className="relative">
          <div
            // `data-composer-capsule` — structural hook only, always
            // present regardless of `micActive`; does not participate in
            // the `cn()` conditional below. The `invisible absolute
            // inset-0` mic-recording swap (see the comment above this
            // block) is untouched — the hook rides alongside it, never
            // replaces it.
            data-composer-capsule
            ref={capsuleRef}
            className={cn(
              // items-center (was items-end): Attach/Mic are taller
              // (h-[47px]) than Send (h-9) and the textarea's own
              // single-line height sits in between — bottom-aligning
              // those different box heights put each icon at a different
              // distance from its own box's center, reading as
              // "misaligned" even though the boxes' bottoms lined up.
              // Centering the row instead puts every icon (each already
              // centered within its own box) on the same line regardless
              // of how tall its box is.
              "flex items-center gap-2",
              micActive && "invisible absolute inset-0",
            )}
          >
            {/* Left — attach media: photo / video / document. */}
            <div ref={attachWrapperRef} data-composer-attach-wrapper className="relative inline-flex shrink-0">
              <button
                type="button"
                data-composer-attach
                disabled={inputsDisabled || busy}
                title={
                  readOnly
                    ? t("readOnlyTitle")
                    : inputsDisabled
                      ? undefined
                      : t("attachMedia")
                }
                aria-label={t("attachMedia")}
                aria-expanded={attachMenuOpen}
                onClick={() => {
                  if (inputsDisabled || busy) return;
                  if (document.activeElement instanceof HTMLElement) {
                    document.activeElement.blur();
                  }
                  setAttachMenuOpen((prev) => !prev);
                }}
                className="inline-flex h-[47px] w-[47px] shrink-0 items-center justify-center rounded-md p-0 text-muted-foreground transition-[transform,border-radius,background-color] duration-150 ease-out hover:text-foreground active:scale-[0.97] active:rounded-full active:bg-primary/15 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy ? (
                  <Loader2 className="h-[21px] w-[21px] animate-spin" />
                ) : (
                  <Paperclip className="h-[21px] w-[21px]" />
                )}
              </button>

              {attachMenuOpen && (
                <div
                  ref={attachMenuRef}
                  role="menu"
                  aria-label={t("attachMedia")}
                  className="absolute bottom-full left-0 z-20 mb-2 w-[190px] rounded-lg border border-border bg-popover p-[6.5px] shadow-lg"
                >
                  <label
                    role="menuitem"
                    className="flex w-full cursor-pointer items-center gap-[13px] rounded-md px-[8.5px] py-[5px] text-[16.75px] font-normal text-popover-foreground transition-colors duration-150 ease-out hover:bg-accent hover:text-accent-foreground active:bg-primary/15"
                  >
                    <input
                      ref={imageInputRef}
                      type="file"
                      multiple
                      tabIndex={-1}
                      aria-hidden="true"
                      accept={PICKER_ACCEPT.image}
                      className="sr-only"
                      onChange={(e) => {
                        setAttachMenuOpen(false);
                        forensic.log(2, "evento change", "info", {
                          targetFilesCount: e.target.files?.length ?? 0,
                          hasFiles: !!e.target.files,
                        });
                        handlePicked("image", e.target.files);
                        e.target.value = "";
                      }}
                    />
                    <ImageIcon className="mr-[11px] size-[19px] text-muted-foreground" strokeWidth={1.75} />
                    {t("photo")}
                  </label>
                  <label
                    role="menuitem"
                    className="flex w-full cursor-pointer items-center gap-[13px] rounded-md px-[8.5px] py-[5px] text-[16.75px] font-normal text-popover-foreground transition-colors duration-150 ease-out hover:bg-accent hover:text-accent-foreground active:bg-primary/15"
                  >
                    <input
                      ref={videoInputRef}
                      type="file"
                      multiple
                      tabIndex={-1}
                      aria-hidden="true"
                      accept={PICKER_ACCEPT.video}
                      className="sr-only"
                      onChange={(e) => {
                        setAttachMenuOpen(false);
                        handlePicked("video", e.target.files);
                        e.target.value = "";
                      }}
                    />
                    <Video className="mr-[11px] size-[19px] text-muted-foreground" strokeWidth={1.75} />
                    {t("video")}
                  </label>
                  <label
                    role="menuitem"
                    className="flex w-full cursor-pointer items-center gap-[13px] rounded-md px-[8.5px] py-[5px] text-[16.75px] font-normal text-popover-foreground transition-colors duration-150 ease-out hover:bg-accent hover:text-accent-foreground active:bg-primary/15"
                  >
                    <input
                      ref={documentInputRef}
                      type="file"
                      multiple
                      tabIndex={-1}
                      aria-hidden="true"
                      accept={PICKER_ACCEPT.document}
                      className="sr-only"
                      onChange={(e) => {
                        setAttachMenuOpen(false);
                        handlePicked("document", e.target.files);
                        e.target.value = "";
                      }}
                    />
                    <FileText className="mr-[11px] size-[19px] text-muted-foreground" strokeWidth={1.75} />
                    {t("document")}
                  </label>
                </div>
              )}
            </div>

            {/* Center — the text field takes all remaining width. Font
                size is 16px (text-base): below that, focusing an <input>/
                <textarea> on iOS Safari auto-zooms the viewport, which is
                exactly the "screen jumps around while typing" behavior
                WhatsApp/Telegram/iMessage don't have. */}
            <div className="relative flex-1">
              <textarea
                data-composer-textarea
                ref={textareaRef}
                value={text}
                onChange={handleChange}
                onKeyDown={handleKeyDown}
                // Losing focus without picking a suggestion (e.g. tapping
                // elsewhere) closes the dropdown. A suggestion click itself
                // uses onMouseDown+preventDefault below, so it never gets
                // here — the textarea never actually blurs in that case.
                onBlur={() => setSlashToken(null)}
                // Empty when there's nothing to type into — no placeholder
                // text sits in the field itself, matching WhatsApp/Telegram/
                // iMessage. The read-only/session-expired placeholders stay:
                // those aren't decorative, they're the only way the agent
                // learns *why* the field is disabled.
                placeholder={
                  readOnly
                    ? t("readOnlyPlaceholder")
                    : sessionExpired
                      ? t("sessionExpiredPlaceholder")
                      : undefined
                }
                disabled={sessionExpired || readOnly}
                rows={1}
                // Textarea keeps its own inline title — the GatedButton
                // wrapping pattern doesn't apply to non-button inputs.
                // The placeholder text also surfaces the read-only state.
                title={readOnly ? t("readOnlyTitle") : undefined}
                className={cn(
                  // Height transition itself lives in globals.css on
                  // [data-composer-textarea] (!important, tuned together
                  // with the capsule's own padding/border-radius
                  // transition) — this class only covers color/border.
                  "w-full resize-none rounded-xl border border-border bg-muted px-4 py-2.5 text-base text-foreground placeholder-muted-foreground outline-none transition-colors focus:border-primary/50",
                  // Scrollbar hidden visually only — scrolling itself
                  // (wheel/touch/keyboard) is untouched, this just drops
                  // the native scrollbar chrome (WebKit + Firefox + legacy
                  // Edge) so a multi-line draft doesn't show a scroll track
                  // inside the rounded input.
                  "[scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden",
                  (sessionExpired || readOnly) && "cursor-not-allowed opacity-50"
                )}
              />

              {/* "/shortcut" quick-reply suggestions — anchored above the
                  field so it never covers the messages above. */}
              {slashToken && suggestions.length > 0 && (
                <div className="absolute bottom-full left-0 z-20 mb-2 max-h-56 w-full max-w-sm overflow-y-auto rounded-lg border border-border bg-popover shadow-lg">
                  {suggestions.map((qr, index) => (
                    <button
                      key={qr.id}
                      type="button"
                      // mousedown (not click) + preventDefault so the tap
                      // never blurs the textarea first — the onBlur above
                      // would otherwise close this dropdown before the
                      // click even registers.
                      onMouseDown={(e) => {
                        e.preventDefault();
                        applySuggestion(qr);
                      }}
                      className={cn(
                        "flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left",
                        index === activeSuggestion
                          ? "bg-accent text-accent-foreground"
                          : "text-foreground hover:bg-muted"
                      )}
                    >
                      <span className="text-sm font-medium">{qr.title}</span>
                      <span className="line-clamp-1 text-xs text-muted-foreground">
                        {qr.content_text}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Right — record audio. Press-and-hold (Pointer Events cover
                touch + mouse identically), drag up to lock. */}
            <button
              data-composer-mic
              ref={micButtonRef}
              type="button"
              disabled={inputsDisabled || busy}
              title={readOnly ? undefined : t("voiceNote")}
              aria-label={t("voiceNote")}
              onPointerDown={handleMicPointerDown}
              onMouseDown={(e) => e.preventDefault()}
              onPointerMove={handleMicPointerMove}
              onPointerUp={handleMicPointerEnd}
              onPointerCancel={handleMicPointerEnd}
              className="flex h-[47px] w-[47px] shrink-0 touch-none select-none items-center justify-center rounded-md p-0 text-muted-foreground transition-[transform,border-radius,background-color] duration-150 ease-out hover:text-foreground active:scale-[0.97] active:rounded-full active:bg-primary/15 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Mic className="h-[21px] w-[21px]" />
            </button>

            <GatedButton
              data-composer-send
              size="sm"
              canAct={!readOnly}
              gateReason="enviar mensagens"
              disabled={!text.trim() || sessionExpired || sending}
              onPointerDown={(e) => e.preventDefault()}
              onMouseDown={(e) => e.preventDefault()}
              onClick={handleSend}
              className="h-9 w-9 shrink-0 bg-primary p-0 hover:bg-primary/90 disabled:opacity-40"
              title={readOnly ? undefined : t("send")}
            >
              <Send className="h-4 w-4" />
            </GatedButton>
          </div>

          {micActive && (
            <div
              data-composer-recording-bar
              className={cn(
                "relative flex items-center gap-3 rounded-xl border px-3 py-2.5",
                micPhase === "failed" ? "border-red-500/40 bg-red-500/5" : "border-border bg-muted",
              )}
              title={micPhase === "failed" ? failedError : undefined}
            >
              {/* Drag-up-to-lock hint — only while still holding and not
                  yet locked. Position/scale/opacity are all written
                  live (via ref, not state) during the gesture in
                  handleMicPointerMove, eased rather than 1:1, so it
                  builds up progressively instead of just sitting there
                  until an abrupt flip — zero re-render overhead either way. */}
              {micPhase === "recording" && !locked && (
                <div
                  ref={lockHintRef}
                  // Resting classes match what handleMicPointerMove
                  // computes at progress=0 (scale 0.85, opacity 0.55) —
                  // so there's no flash-of-full-strength before the
                  // first pointermove event lands.
                  className="pointer-events-none absolute -top-12 right-2 flex scale-[0.85] flex-col items-center gap-1 rounded-full border border-border bg-popover px-2 py-1.5 text-muted-foreground opacity-55 shadow-md"
                >
                  <Lock className="h-3.5 w-3.5" />
                </div>
              )}

              <button
                type="button"
                onPointerDown={(e) => e.preventDefault()}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  handleDiscardRecording();
                }}
                aria-label={t("discardRecording")}
                disabled={micPhase === "sending"}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:pointer-events-none disabled:opacity-40"
              >
                <Trash2 className="h-4 w-4" />
              </button>

              <div className="flex flex-1 items-center justify-center gap-2.5">
                {locked && (
                  // The above-bar hint just disappears the instant this
                  // mounts (locked flips true) — this pop-in is what
                  // actually carries the "locked!" confirmation moment.
                  <Lock className="h-3.5 w-3.5 shrink-0 animate-in text-primary zoom-in-50 duration-200" />
                )}
                {micPhase === "paused" && draftAudioUrl && (
                  <>
                    <audio
                      ref={draftPreviewAudioRef}
                      src={draftAudioUrl}
                      preload="metadata"
                      onEnded={() => setDraftPlaying(false)}
                      onPause={() => setDraftPlaying(false)}
                      onPlay={() => setDraftPlaying(true)}
                      className="hidden"
                    />
                    <button
                      type="button"
                      onPointerDown={(e) => e.preventDefault()}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        const el = draftPreviewAudioRef.current;
                        if (!el) return;
                        if (draftPlaying) {
                          el.pause();
                        } else {
                          stopAllAudioPlayback();
                          void el.play().catch(() => {});
                        }
                      }}
                      aria-label={draftPlaying ? "Pausar rascunho" : "Ouvir rascunho"}
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary transition-colors hover:bg-primary/25"
                    >
                      {draftPlaying ? (
                        <Pause className="h-3.5 w-3.5" />
                      ) : (
                        <Play className="ml-0.5 h-3.5 w-3.5" />
                      )}
                    </button>
                  </>
                )}
                {micPhase === "sending" ? (
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
                ) : micPhase === "initializing" ? (
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
                ) : micPhase === "failed" ? (
                  <AlertCircle className="h-4 w-4 shrink-0 text-red-500" />
                ) : (
                  <RecordingIndicator active={micPhase === "recording"} />
                )}
                <span
                  className={cn(
                    "text-sm font-medium tabular-nums",
                    micPhase === "failed"
                      ? "text-red-500"
                      : micPhase === "initializing"
                        ? "text-muted-foreground"
                        : "text-foreground",
                  )}
                >
                  {micPhase === "failed"
                    ? t("recordingFailed")
                    : micPhase === "initializing"
                      ? t("recordingInitializing")
                      : formatDuration(recordSeconds)}
                </span>
              </div>

              <GatedButton
                size="sm"
                canAct={!readOnly}
                gateReason="enviar mensagens"
                disabled={micPhase === "sending" || micPhase === "initializing"}
                onPointerDown={(e) => e.preventDefault()}
                onMouseDown={(e) => e.preventDefault()}
                onClick={handleSendRecording}
                aria-label={micPhase === "failed" ? t("retryRecording") : t("sendRecording")}
                title={micPhase === "failed" ? t("retryRecording") : undefined}
                className="h-8 w-8 shrink-0 bg-primary p-0 hover:bg-primary/90 disabled:opacity-40"
              >
                <Send className="h-4 w-4" />
              </GatedButton>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Small "audio is capturing" cue — a pulsing dot plus a 3-bar equalizer
 * that bounces at staggered delays. Swaps to a plain static dot once the
 * capture has actually stopped (paused, waiting on a trash/send tap) so
 * it doesn't keep implying audio is still being recorded.
 */
function RecordingIndicator({ active }: { active: boolean }) {
  return (
    <span className="flex shrink-0 items-center gap-2">
      <span
        className={cn(
          "h-2.5 w-2.5 rounded-full bg-red-500",
          active && "animate-pulse",
        )}
      />
      {active && (
        // The waveform keyframe lives in globals.css, not a component-
        // scoped <style jsx> block — see the comment there for why.
        <span className="flex items-end gap-0.5" aria-hidden>
          <span className="h-2 w-0.5 animate-[waveform_1s_ease-in-out_infinite] rounded-full bg-red-500" />
          <span className="h-3 w-0.5 animate-[waveform_1s_ease-in-out_infinite_0.15s] rounded-full bg-red-500" />
          <span className="h-1.5 w-0.5 animate-[waveform_1s_ease-in-out_infinite_0.3s] rounded-full bg-red-500" />
        </span>
      )}
    </span>
  );
}

/**
 * Staged-attachment preview with caption + send/discard. Declared at
 * module scope (not nested in MessageComposer) so React keeps it mounted
 * across the parent's re-renders — a nested component would remount the
 * caption input on every keystroke and drop focus.
 */
function MediaDraftPreview({
  draft,
  busy,
  readOnly,
  onCaptionChange,
  onDiscard,
  onSend,
  t,
  pdfPreviewContainerRef,
}: {
  draft: MediaDraft;
  busy: boolean;
  readOnly: boolean;
  onCaptionChange: (caption: string) => void;
  onDiscard: () => void;
  onSend: () => void;
  t: ReturnType<typeof useTranslations>;
  pdfPreviewContainerRef?: RefObject<HTMLDivElement | null>;
}) {
  // A staged PDF opens its full-screen page-by-page viewer automatically
  // (see DocumentFullscreenPreview) — this card still renders underneath
  // unchanged, it's just covered until the viewer closes. `draft.path` is
  // the key (not just `draft.kind`) because a single-file re-pick while
  // this same component instance is still mounted replaces `draft` in
  // place (see stageUpload) rather than unmounting/remounting — without
  // keying on path, the viewer wouldn't reopen for the newly-picked file.
  //
  // Reopening on a path change is done as a render-phase state adjustment
  // (React's documented pattern for "reset state when a prop changes"),
  // not a `setState`-in-`useEffect` — the latter costs an extra
  // wasted-render/commit cycle and trips the set-state-in-effect lint
  // rule.
  const isPdf = draft.kind === "document" && isPdfDraft(draft.filename);
  const [pdfPreviewOpen, setPdfPreviewOpen] = useState(isPdf);
  const [lastPath, setLastPath] = useState(draft.path);
  if (draft.path !== lastPath) {
    setLastPath(draft.path);
    if (isPdf) setPdfPreviewOpen(true);
  }

  return (
    <div className="rounded-xl border border-border bg-muted/40 p-3">
      {isPdf && (
        <DocumentFullscreenPreview
          open={pdfPreviewOpen}
          url={draft.previewUrl}
          filename={draft.filename}
          onCancel={onDiscard}
          containerRef={pdfPreviewContainerRef}
        />
      )}
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          {draft.kind === "image" && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={draft.previewUrl}
              alt={draft.filename}
              className="max-h-40 rounded-lg object-cover"
            />
          )}
          {draft.kind === "video" && (
            <video src={draft.previewUrl} controls className="max-h-40 rounded-lg" />
          )}
          {draft.kind === "document" && (
            <div className="flex items-center gap-2 text-sm text-foreground">
              <FileText className="h-5 w-5 shrink-0 text-muted-foreground" />
              <span className="truncate">{draft.filename}</span>
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={onDiscard}
          aria-label={t("removeAttachment")}
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="mt-2 flex items-end gap-2">
        <input
          value={draft.caption}
          maxLength={MEDIA_CAPTION_MAX}
          onChange={(e) => onCaptionChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSend();
            }
          }}
          placeholder={t("addCaption")}
          // text-base (16px), same reasoning as the main textarea —
          // keeps iOS Safari from auto-zooming the viewport on focus.
          className="flex-1 rounded-xl border border-border bg-muted px-4 py-2.5 text-base text-foreground placeholder-muted-foreground outline-none transition-colors focus:border-primary/50"
        />
        <GatedButton
          size="sm"
          canAct={!readOnly}
          gateReason="enviar mensagens"
          disabled={busy}
          onClick={onSend}
          className="h-9 w-9 shrink-0 bg-primary p-0 hover:bg-primary/90 disabled:opacity-40"
        >
          <Send className="h-4 w-4" />
        </GatedButton>
      </div>
    </div>
  );
}
