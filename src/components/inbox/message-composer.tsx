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
  X,
  Loader2,
  AlertCircle,
} from "lucide-react";
import { GatedButton } from "@/components/ui/gated-button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { useCan } from "@/hooks/use-can";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
  uploadAccountMedia,
  deleteAccountMedia,
  resolveAccountId,
  MEDIA_MAX_BYTES_BY_KIND,
  ALLOWED_MIME_TYPES_BY_KIND,
  CHAT_MEDIA_BUCKET,
} from "@/lib/storage/upload-media";
import {
  isQuickTimeVideo,
  convertMovToMp4ViaWebCodecs,
} from "@/lib/media/transcode-mov-webcodecs";
import { ReplyQuote } from "./reply-quote";
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
import { audioLog, audioLogError } from "@/lib/inbox/pending-audio-log";

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

interface ReplyDraft {
  /** Internal UUID of the message being replied to — sent back through onSend. */
  id: string;
  authorLabel: string;
  preview: string;
}

// Mirrors the chat-media bucket's allowed_mime_types (migration 023) for
// the file picker so unsupported files are rejected before upload rather
// than failing with a confusing Storage error. Audio has no picker — it's
// captured via the recorder and, unlike the other kinds, never goes
// through the staged-draft preview below (see the recording state
// machine further down).
const PICKER_ACCEPT: Record<"image" | "video" | "document", string> = {
  image: "image/png,image/jpeg,image/webp",
  // video/quicktime + .mov: iPhone recordings are transcoded to MP4
  // client-side before upload (see transcode-mov.ts) — listed here so
  // they don't get filtered out of the OS picker in the first place.
  video: "video/mp4,video/3gpp,video/quicktime,.mov",
  document:
    "application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/plain",
};

interface MediaDraft {
  kind: Exclude<ComposerMediaKind, "audio">;
  mediaUrl: string;
  /** Storage path — used to GC the object if the draft is discarded. */
  path: string;
  filename: string;
  caption: string;
}

interface MessageComposerProps {
  sessionExpired: boolean;
  /** Scopes the pending-voice-note IndexedDB store (a conversation switch
   *  rehydrates whatever unresolved recording that conversation left
   *  behind — see the mount effect below). */
  conversationId: string;
  onSend: (text: string, replyToId?: string) => void;
  onSendMedia: (payload: SendMediaPayload) => void;
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

/** Worker that encodes mic input to Ogg/Opus entirely in the browser
 *  (vendored from opus-recorder into /public). Recording client-side in a
 *  Meta-accepted format means no server ffmpeg / transcode step. */
const OPUS_ENCODER_PATH = "/opus/encoderWorker.min.js";

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

// Touch-only arming delay before a recording is allowed to start —
// desktop mice skip this entirely (see handleMicPointerDown) and start on
// the first click. Set to 0 so a tap arms it on the very next tick, same
// as WhatsApp on iPhone (an immediate press-and-hold, not a perceptible
// long-press). Kept as a real timer (rather than calling
// startRecordingGesture synchronously) so the scroll-cancel check in
// handleMicPointerMove still has a tick to run.
const LONG_PRESS_MS = 0;

// Movement (px) during the LONG_PRESS_MS window that cancels the pending
// long-press — distinct from LOCK_THRESHOLD_PX above, which only applies
// once a recording is already underway. Small on purpose: only meant to
// catch a real scroll gesture, not natural finger jitter on a stationary hold.
const TOUCH_MOVE_CANCEL_PX = 8;

// "sending" is now purely the brief, LOCAL recorder-stop → encoder-flush
// window (bounded by opus-recorder finishing its last frame — no network
// involved) — never "waiting on the upload", which is what used to leave
// this stuck forever on iOS. "failed" covers both a real upload/send
// failure and a rehydrated take found left over from a previous session
// (see the mount effect below) whose true outcome is unknown either way.
type MicPhase = "idle" | "recording" | "paused" | "sending" | "failed";

export function MessageComposer({
  sessionExpired,
  conversationId,
  onSend,
  onSendMedia,
  onRecordAudio,
  onOpenTemplates,
  replyTo,
  onClearReply,
  initialText,
  pdfPreviewContainerRef,
}: MessageComposerProps) {
  const t = useTranslations("Inbox.composer");

  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Only re-runs when the draft string itself changes — this seeds the
  // field once and never fights with the agent's own typing afterwards.
  useEffect(() => {
    if (initialText) {
      setText(initialText);
      textareaRef.current?.focus();
    }
  }, [initialText]);

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
  const imageInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const documentInputRef = useRef<HTMLInputElement>(null);
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
    void deleteAccountMedia(CHAT_MEDIA_BUCKET, path).catch(() => {});
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
  // Holds the Screen Wake Lock exactly while the mic is actively capturing
  // — see use-wake-lock.ts. Without it, iOS's own inactivity timer dims
  // and locks the screen mid-recording (most visibly during a locked/
  // hands-free take, where the agent may not touch the screen for a
  // while), which backgrounds the page and cuts the mic.
  useWakeLock(micPhase === "recording");
  const [locked, setLocked] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const recorderRef = useRef<import("opus-recorder").default | null>(null);
  // The in-flight beginCapture() promise. Any stop request awaits this
  // before touching recorderRef — otherwise a stop arriving while the
  // recorder is still being constructed (dynamic import + getUserMedia +
  // encoder init) finds recorderRef.current still null, no-ops silently,
  // and the recorder ends up starting *after* the UI already moved past
  // "recording" with nothing left to ever stop it.
  const captureReadyRef = useRef<Promise<void> | null>(null);
  const cancelledRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Id of the pending-audio-db.ts record backing the current "paused" or
  // "failed" bar — Send/Discard/Retry all act on whichever record this
  // points at. Null whenever there's nothing recorded-but-undecided.
  const pendingRecordIdRef = useRef<string | null>(null);
  // Set (only while still `micPhase === "recording"`) when the agent taps
  // Send on a locked, hands-free take — finalizeRecording checks this the
  // moment the encoder actually finishes and queues the send immediately,
  // instead of the old pattern of waiting on an in-progress upload.
  const sendOnStopRef = useRef(false);
  // Failure reason for the rehydrated/failed bar — display-only.
  const [failedError, setFailedError] = useState<string | undefined>(undefined);
  const micButtonRef = useRef<HTMLButtonElement>(null);
  const lockHintRef = useRef<HTMLDivElement>(null);
  const gestureRef = useRef<{ startY: number } | null>(null);
  // Touch-only long-press timer + its start position (for the scroll-cancel
  // check above) — both null whenever no long-press is currently pending.
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressStartRef = useRef<{ x: number; y: number } | null>(null);

  // Viewers (read-only role) can browse the inbox but never send.
  // For solo users this is always true — single-owner accounts pass
  // every capability — so the disabled branch is a no-op there.
  const canSend = useCan("send-messages");
  const readOnly = !canSend;
  // Media (like free-form text) is only allowed inside the 24h window.
  const inputsDisabled = readOnly || sessionExpired;

  // Rehydrate on mount / conversation switch: if this conversation has a
  // voice note left over from an interrupted previous attempt (upload or
  // send that never resolved because the PWA was killed or backgrounded
  // mid-request — the exact class of bug this whole pipeline exists for),
  // surface it as "failed" so the agent can retry or discard it instead
  // of it silently sitting invisible in IndexedDB forever. Only the most
  // recent one is shown here (one mic bar); the app-wide sweep in
  // inbox/page.tsx still processes every pending record regardless.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
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
  }, [conversationId]);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const clearLongPressTimer = useCallback(() => {
    if (longPressTimerRef.current !== null) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    // Max 4 lines (~96px)
    el.style.height = `${Math.min(el.scrollHeight, 96)}px`;
  }, []);

  const handleSend = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed || sending || sessionExpired) return;

    setSending(true);
    try {
      onSend(trimmed, replyTo?.id);
      setText("");
      setSlashToken(null);
      if (textareaRef.current) {
        textareaRef.current.style.height = "auto";
        textareaRef.current.focus();
      }
    } finally {
      setSending(false);
    }
  }, [text, sending, sessionExpired, onSend, replyTo?.id]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const value = e.target.value;
      setText(value);
      adjustHeight();
      setSlashToken(findSlashToken(value, e.target.selectionStart ?? value.length));
      setActiveSuggestion(0);
    },
    [adjustHeight]
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
        handleSend();
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
      if (kind === "video" && isQuickTimeVideo(file)) {
        setBusy(true);
        try {
          file = await convertMovToMp4ViaWebCodecs(file);
        } catch (err) {
          setBusy(false);
          toast.error(err instanceof Error ? err.message : t("unsupportedVideoType"));
          return;
        }
      }
      // Per-kind ceiling mirrors Meta's caps (image 5 MB, etc.) so we
      // reject before upload rather than orphaning an object that Meta
      // would then refuse at send.
      const max = MEDIA_MAX_BYTES_BY_KIND[kind];
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
      const allowed = ALLOWED_MIME_TYPES_BY_KIND[kind] as readonly string[];
      if (!allowed.includes(file.type)) {
        toast.error(
          kind === "video" ? t("unsupportedVideoType") : t("unsupportedFileType"),
        );
        return;
      }
      setBusy(true);
      try {
        const { publicUrl, path } = await uploadAccountMedia(CHAT_MEDIA_BUCKET, file);
        // Replacing an existing draft? GC the previous object first.
        removeStaged(draftRef.current?.path);
        setDraft({ kind, mediaUrl: publicUrl, path, filename: file.name, caption: "" });
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
  //
  // `accountId` is resolved once by the batch caller (handlePicked) and
  // threaded through here to skip the auth.getUser()+profiles round-trip
  // uploadAccountMedia would otherwise repeat for every file — pure
  // network-cost elimination, doesn't touch upload order/timing/content.
  const uploadAndSend = useCallback(
    async (
      kind: Exclude<ComposerMediaKind, "audio">,
      pickedFile: File,
      accountId: string,
    ) => {
      let file = pickedFile;
      if (kind === "video" && isQuickTimeVideo(file)) {
        try {
          file = await convertMovToMp4ViaWebCodecs(file);
        } catch (err) {
          toast.error(err instanceof Error ? err.message : t("unsupportedVideoType"));
          return;
        }
      }
      const max = MEDIA_MAX_BYTES_BY_KIND[kind];
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
      if (!allowed.includes(file.type)) {
        toast.error(kind === "video" ? t("unsupportedVideoType") : t("unsupportedFileType"));
        return;
      }
      try {
        const { publicUrl, path } = await uploadAccountMedia(CHAT_MEDIA_BUCKET, file, accountId);
        onSendMedia({
          kind,
          mediaUrl: publicUrl,
          path,
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

      // Exactly one file — unchanged behavior: stage it as a draft with
      // a caption field, wait for an explicit Send tap. (stageUpload
      // resolves its own account id — a single file has nothing to
      // amortize the lookup across.)
      if (files.length === 1) {
        void stageUpload(kind, files[0]);
        return;
      }

      // Multiple files — no per-file caption step, so upload and send
      // each one as soon as it's ready. Sequential (not Promise.all): on
      // iOS Safari/PWA (WKWebView) running several uploads — and
      // possible .mov→.mp4 transcodes — at once is the kind of thing
      // that's flaky on-device; one at a time is slower but reliable
      // everywhere, and keeps messages landing in the order they were
      // picked. `busy` covers the whole batch, same as it does for a
      // single staged upload — disables the attach button/shows the
      // spinner until every file has been handled.
      //
      // account_id is resolved once here, up front, and reused for every
      // file in the loop below (instead of each uploadAndSend/
      // uploadAccountMedia call repeating that same auth+profile lookup)
      // — the loop itself stays exactly as sequential as before.
      setBusy(true);
      void (async () => {
        try {
          const accountId = await resolveAccountId();
          for (const file of files) {
            await uploadAndSend(kind, file, accountId);
          }
        } catch (err) {
          toast.error(err instanceof Error ? err.message : "Upload failed.");
        } finally {
          setBusy(false);
        }
      })();
    },
    [stageUpload, uploadAndSend],
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
    async (bytes: Uint8Array) => {
      // Uint8Array is a valid BlobPart at runtime; the cast sidesteps the
      // lib.dom ArrayBufferLike-vs-ArrayBuffer generic mismatch.
      const file = new File([bytes as unknown as BlobPart], `voice-${Date.now()}.ogg`, {
        type: "audio/ogg",
      });
      audioLog("recording:stopped", { sizeBytes: file.size });
      if (file.size === 0) {
        // Cancelled / empty take — nothing to do.
        sendOnStopRef.current = false;
        setMicPhase("idle");
        setLocked(false);
        return;
      }
      if (file.size > MEDIA_MAX_BYTES_BY_KIND.audio) {
        toast.error(t("recordingTooLong"));
        sendOnStopRef.current = false;
        setMicPhase("idle");
        setLocked(false);
        return;
      }

      const id =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `audio-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const record: PendingAudioRecord = {
        id,
        conversationId,
        replyToId: replyTo?.id,
        blob: file,
        mimeType: file.type,
        sizeBytes: file.size,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        status: "uploading",
        attempts: 0,
      };

      try {
        // Persisted BEFORE anything else touches the network — even if
        // the upload hangs, gets interrupted, or the PWA is killed a
        // moment later, the recording itself is never lost.
        await putPendingAudio(record);
        audioLog("recording:saved-local", { id });
      } catch (err) {
        // IndexedDB itself failing (private browsing, quota, disabled) —
        // rare, but don't let it strand the recording: fall through and
        // hand it off anyway. The downstream pipeline will just fail to
        // re-read it from IndexedDB on a retry if this ever happens; the
        // *current* send attempt is unaffected either way.
        audioLogError("recording:save-local-failed", err, { id });
      }

      if (sendOnStopRef.current) {
        sendOnStopRef.current = false;
        pendingRecordIdRef.current = null;
        setMicPhase("idle");
        setLocked(false);
        onRecordAudio(id, replyTo?.id);
        onClearReply?.();
        return;
      }

      // No decision yet — sit in "paused" with the trash/send bar; the
      // handlers below act on `id` directly once tapped.
      pendingRecordIdRef.current = id;
      setMicPhase("paused");
      setLocked(false);
    },
    [conversationId, onRecordAudio, replyTo?.id, onClearReply, t],
  );

  // Actual mic/encoder setup — deliberately kept separate from the
  // pointerdown handler below, which flips the UI to "recording"
  // *before* awaiting any of this, so the bar appears instantly instead
  // of waiting on getUserMedia + the encoder worker load. On failure
  // this rolls the optimistic UI back.
  const beginCapture = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia || typeof AudioContext === "undefined") {
      toast.error(t("recordingNotSupported"));
      clearTimer();
      setMicPhase("idle");
      setLocked(false);
      return;
    }
    try {
      // Lazy-load the encoder (≈400 KB worker) only when the user records,
      // keeping it out of the main bundle.
      const { default: Recorder } = await import("opus-recorder");
      const recorder = new Recorder({
        encoderPath: OPUS_ENCODER_PATH,
        numberOfChannels: 1,
        encoderApplication: 2048, // VOIP — tuned for speech
        encoderSampleRate: 48000,
        streamPages: false, // one callback with the complete file on stop
      });
      cancelledRef.current = false;
      recorder.ondataavailable = (bytes) => {
        if (cancelledRef.current) return;
        void finalizeRecording(bytes);
      };
      recorderRef.current = recorder;
      await recorder.start();
    } catch {
      // Same AudioContext leak as stopRecorder() below, just on the
      // failure path (e.g. start() rejects because the mic permission was
      // denied) — close() releases it too, chained so it still runs even
      // if stop() itself rejects.
      const recorder = recorderRef.current;
      recorderRef.current = null;
      void recorder
        ?.stop()
        .catch(() => {})
        .then(() => recorder.close())
        .catch(() => {});
      clearTimer();
      setMicPhase("idle");
      setLocked(false);
      toast.error(t("recordingPermissionDenied"));
    }
  }, [clearTimer, finalizeRecording, t]);

  // Every "stop the mic" action funnels through here instead of touching
  // recorderRef directly, so it always waits out any in-flight
  // beginCapture() first — see captureReadyRef above for why.
  //
  // stop() alone only releases the mic stream — it leaves the
  // AudioContext (and encoder worker) open. close() is what the
  // opus-recorder API actually closes both on (README: "close will close
  // the audioContext, destroy the workers... A new Recorder instance
  // will be required for additional recordings" — already true here,
  // beginCapture() always constructs a fresh Recorder). Without this,
  // every recording leaked an AudioContext that was never released until
  // the whole PWA process was killed — iOS Safari/WKWebView caps how
  // many can be alive at once, so after enough recordings in one PWA
  // session the next one would silently hang (audioContext never
  // resumes, ondataavailable never fires, upload never starts).
  const stopRecorder = useCallback(async () => {
    try {
      await captureReadyRef.current;
    } catch {
      // beginCapture() never actually rejects (it handles its own failure
      // path internally) — guarded anyway so a stop request can't hang.
    }
    const recorder = recorderRef.current;
    if (!recorder) return;
    try {
      await recorder.stop();
    } catch {
      // stop() rejecting doesn't change that close() below still needs
      // to run to release the AudioContext.
    }
    void recorder.close().catch(() => {});
    if (recorderRef.current === recorder) recorderRef.current = null;
  }, []);

  // ---- Mic pointer gesture ---------------------------------------------
  //
  // Pointer Events (not separate touch/mouse handlers) so one set of
  // handlers drives both input types — but the *behavior* they implement
  // now differs by `e.pointerType`, branched at the top of each handler:
  //
  //   mouse → plain click-to-toggle (no hold, no drag-to-lock).
  //   touch/pen → unchanged press-and-hold + drag-up-to-lock, gated behind
  //               a LONG_PRESS_MS timer so a tap/scroll can't arm it.
  //
  // Every path funnels through these two functions — nothing else is
  // allowed to flip micPhase into/out of "recording" — so no matter which
  // event (mouse click, completed long-press, the in-bar stop button) asks
  // to start or stop, the guard here is the single source of truth and a
  // duplicate request from a second event is always a no-op.
  const startRecordingGesture = useCallback(() => {
    if (micPhase !== "idle") return;
    setLocked(false);
    setRecordSeconds(0);
    // Optimistic — the bar shows immediately; beginCapture (mic
    // permission + encoder init) runs in the background and rolls
    // this back on failure.
    setMicPhase("recording");
    clearTimer();
    timerRef.current = setInterval(() => setRecordSeconds((s) => s + 1), 1000);
    // Stored so any stop request (below) can wait for this specific
    // capture attempt to finish initializing before touching the
    // recorder — see captureReadyRef / stopRecorder.
    captureReadyRef.current = beginCapture();
  }, [micPhase, clearTimer, beginCapture]);

  const stopRecordingGesture = useCallback(() => {
    if (micPhase !== "recording") return;
    clearTimer();
    setMicPhase("paused");
    void stopRecorder();
  }, [micPhase, clearTimer, stopRecorder]);

  const handleMicPointerDown = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      if (inputsDisabled || busy) return;

      if (e.pointerType === "mouse") {
        // Desktop: 1 click starts. The button itself is hidden the moment
        // recording begins (swapped for the recording bar below), so the
        // matching "1 click stops" happens on the bar's own stop button,
        // not a second pointerdown here — both call stopRecordingGesture.
        if (micPhase !== "idle") return;
        e.preventDefault();
        startRecordingGesture();
        return;
      }

      // Touch/pen: don't start yet — arm a long-press timer. Guard against
      // a second touch arming an overlapping timer while this one is
      // still pending (micPhase only flips once the timer actually fires).
      if (micPhase !== "idle" || longPressTimerRef.current !== null) return;
      e.preventDefault();
      micButtonRef.current?.setPointerCapture(e.pointerId);
      gestureRef.current = { startY: e.clientY };
      longPressStartRef.current = { x: e.clientX, y: e.clientY };
      longPressTimerRef.current = setTimeout(() => {
        longPressTimerRef.current = null;
        startRecordingGesture();
      }, LONG_PRESS_MS);
    },
    [inputsDisabled, busy, micPhase, startRecordingGesture],
  );

  const handleMicPointerMove = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      if (e.pointerType === "mouse") return;

      // Still waiting out the long-press: a scroll-sized movement cancels
      // it outright so brushing/scrolling over the button can never arm
      // the recorder.
      if (longPressTimerRef.current !== null) {
        const start = longPressStartRef.current;
        if (!start) return;
        const dx = e.clientX - start.x;
        const dy = e.clientY - start.y;
        if (Math.hypot(dx, dy) > TOUCH_MOVE_CANCEL_PX) {
          clearLongPressTimer();
        }
        return;
      }

      // Recording already started (long-press completed) — unchanged
      // drag-up-to-lock gesture.
      const gesture = gestureRef.current;
      if (!gesture || locked || micPhase !== "recording") return;
      const dy = gesture.startY - e.clientY; // positive = dragged up
      if (lockHintRef.current) {
        // Ease-out (not a 1:1 linear follow): the hint travels faster
        // at the start of the drag and settles as it nears the top —
        // a natural deceleration, closer to how WhatsApp's own lock
        // indicator moves than a rigid ruler-straight mapping. Scale
        // and opacity build up alongside it, so the *whole* icon
        // visibly grows more confident as the gesture continues
        // instead of just sitting there until an abrupt flip.
        const progress = Math.min(1, Math.max(0, dy / LOCK_THRESHOLD_PX));
        const eased = 1 - (1 - progress) * (1 - progress);
        lockHintRef.current.style.transform = `translateY(${-(eased * LOCK_THRESHOLD_PX)}px) scale(${0.85 + eased * 0.35})`;
        lockHintRef.current.style.opacity = String(0.55 + eased * 0.45);
      }
      if (dy > LOCK_THRESHOLD_PX) {
        setLocked(true);
      }
    },
    [locked, micPhase, clearLongPressTimer],
  );

  // Touch/pen release (or the gesture getting cancelled by the platform,
  // e.g. an incoming call) — mouse never reaches here (handled entirely on
  // pointerdown above). Two distinct outcomes depending on where the
  // gesture was when it ended:
  //   - long-press still pending → just a tap/scroll, cancel the timer,
  //     no recording was ever started.
  //   - already recording → stop, unless locked (locking is exactly what
  //     makes the finger-lift a no-op, same as before).
  const handleMicPointerEnd = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      if (e.pointerType === "mouse") return;
      micButtonRef.current?.releasePointerCapture(e.pointerId);
      gestureRef.current = null;
      if (longPressTimerRef.current !== null) {
        clearLongPressTimer();
        return;
      }
      if (locked) return;
      stopRecordingGesture();
    },
    [locked, clearLongPressTimer, stopRecordingGesture],
  );

  const handleDiscardRecording = useCallback(() => {
    if (micPhase === "recording") {
      // Still actively capturing (held or locked) — full cancel, mirrors
      // the pre-existing cancel behaviour: mark cancelled so
      // finalizeRecording's ondataavailable callback skips saving/sending
      // entirely once the recorder actually stops.
      cancelledRef.current = true;
      clearTimer();
      setMicPhase("idle");
      setLocked(false);
      void stopRecorder();
      return;
    }
    if (micPhase === "paused" || micPhase === "failed") {
      const id = pendingRecordIdRef.current;
      pendingRecordIdRef.current = null;
      setMicPhase("idle");
      setLocked(false);
      setFailedError(undefined);
      if (id) {
        // Deletes the IndexedDB record and, if it had already made it to
        // Storage, GCs that object too. Fire-and-forget: nothing in the
        // UI is waiting on this, and a failure here is a storage nit, not
        // something the agent needs to see (mirrors deleteAccountMedia's
        // existing best-effort GC calls elsewhere in this file).
        void discardPendingAudio(id);
      }
    }
  }, [micPhase, clearTimer, stopRecorder]);

  const handleSendRecording = useCallback(() => {
    if (micPhase === "recording") {
      // Only reachable while locked (send isn't shown unless the bar is
      // up, and the bar only stays up hands-free once locked). Stop the
      // recorder now; finalizeRecording sees sendOnStopRef and queues the
      // send itself the moment the encoder finishes flushing — a local,
      // sub-second wait, not a network one.
      clearTimer();
      sendOnStopRef.current = true;
      setMicPhase("sending");
      void stopRecorder();
      return;
    }
    if (micPhase === "paused" || micPhase === "failed") {
      const id = pendingRecordIdRef.current;
      pendingRecordIdRef.current = null;
      setMicPhase("idle");
      setLocked(false);
      setFailedError(undefined);
      if (id) {
        onRecordAudio(id, replyTo?.id);
        onClearReply?.();
      }
    }
  }, [micPhase, clearTimer, onRecordAudio, replyTo?.id, onClearReply, stopRecorder]);

  // Auto-stop at the cap so a forgotten recording can't blow the upload
  // size limit — pauses exactly like an unlocked release (keeps what was
  // captured, doesn't discard or auto-send).
  useEffect(() => {
    if (micPhase === "recording" && recordSeconds >= MAX_RECORDING_SECONDS) {
      clearTimer();
      setMicPhase("paused");
      void stopRecorder();
    }
  }, [micPhase, recordSeconds, clearTimer, stopRecorder]);

  // Tear down any live recording + timer on unmount so a mid-record
  // navigation doesn't leak the mic, and GC any staged-but-unsent
  // image/video/document draft so it doesn't orphan in the bucket. A
  // paused/failed voice note is deliberately NOT GC'd here — it's already
  // durable in pending-audio-db.ts and is meant to survive a conversation
  // switch or unmount, so the mount effect above can rehydrate it later.
  useEffect(() => {
    return () => {
      clearTimer();
      clearLongPressTimer();
      cancelledRef.current = true;
      // stop() releases the mic stream + audio context inside opus-recorder.
      void stopRecorder();
      removeStaged(draftRef.current?.path);
    };
  }, [clearTimer, clearLongPressTimer, removeStaged, stopRecorder]);

  // ---- Draft send / discard (image/video/document) --------------------

  const sendDraft = useCallback(() => {
    if (!draft || busy) return;
    onSendMedia({
      kind: draft.kind,
      mediaUrl: draft.mediaUrl,
      path: draft.path,
      caption: draft.caption.trim() || undefined,
      filename: draft.kind === "document" ? draft.filename : undefined,
      replyToId: replyTo?.id,
    });
    // The object is now owned by the sent message — clear without GC.
    setDraft(null);
    onClearReply?.();
  }, [draft, busy, onSendMedia, replyTo?.id, onClearReply]);

  // Discard GCs the staged object — it was uploaded but never sent.
  const discardDraft = useCallback(() => {
    removeStaged(draft?.path);
    setDraft(null);
  }, [draft?.path, removeStaged]);

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
    <div className="border-t border-border bg-card px-3 py-[6px] pb-[calc(6px+var(--composer-safe-bottom,env(safe-area-inset-bottom)))]">
      {replyTo && (
        <div className="mb-2">
          <ReplyQuote
            authorLabel={replyTo.authorLabel}
            preview={replyTo.preview}
            onDismiss={onClearReply}
          />
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

      {/* Hidden file inputs driven by the attach menu. `multiple` lets
          the OS picker (Photos/Files on iOS Safari + the installed PWA,
          the native picker on Chrome/desktop) return more than one file;
          handlePicked reads every entry off e.target.files, not just
          the first. */}
      <input
        ref={imageInputRef}
        type="file"
        multiple
        accept={PICKER_ACCEPT.image}
        className="hidden"
        onChange={(e) => {
          handlePicked("image", e.target.files);
          e.target.value = "";
        }}
      />
      <input
        ref={videoInputRef}
        type="file"
        multiple
        accept={PICKER_ACCEPT.video}
        className="hidden"
        onChange={(e) => {
          handlePicked("video", e.target.files);
          e.target.value = "";
        }}
      />
      <input
        ref={documentInputRef}
        type="file"
        multiple
        accept={PICKER_ACCEPT.document}
        className="hidden"
        onChange={(e) => {
          handlePicked("document", e.target.files);
          e.target.value = "";
        }}
      />

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
        // whole row exactly as if it were a swap.
        <div className="relative">
          <div
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
            <DropdownMenu>
              <DropdownMenuTrigger
                disabled={inputsDisabled || busy}
                title={
                  readOnly
                    ? t("readOnlyTitle")
                    : inputsDisabled
                      ? undefined
                      : t("attachMedia")
                }
                className="inline-flex h-[47px] w-[47px] shrink-0 items-center justify-center rounded-md p-0 text-muted-foreground transition-[transform,border-radius,background-color] duration-150 ease-out hover:text-foreground active:scale-[0.97] active:rounded-full active:bg-primary/15 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy ? (
                  <Loader2 className="h-[21px] w-[21px] animate-spin" />
                ) : (
                  <Paperclip className="h-[21px] w-[21px]" />
                )}
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="min-w-[165px] border-border bg-popover p-[5.5px] ring-foreground/5 duration-150 zoom-in-96 zoom-out-96"
              >
                <DropdownMenuItem
                  onClick={() => imageInputRef.current?.click()}
                  className="gap-[13px] px-[8.5px] py-[5px] text-[16.75px] font-normal transition-colors duration-150 ease-out active:bg-primary/15"
                >
                  <ImageIcon className="mr-[11px] size-[19px] text-muted-foreground" strokeWidth={1.75} />
                  {t("photo")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => videoInputRef.current?.click()}
                  className="gap-[13px] px-[8.5px] py-[5px] text-[16.75px] font-normal transition-colors duration-150 ease-out active:bg-primary/15"
                >
                  <Video className="mr-[11px] size-[19px] text-muted-foreground" strokeWidth={1.75} />
                  {t("video")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => documentInputRef.current?.click()}
                  className="gap-[13px] px-[8.5px] py-[5px] text-[16.75px] font-normal transition-colors duration-150 ease-out active:bg-primary/15"
                >
                  <FileText className="mr-[11px] size-[19px] text-muted-foreground" strokeWidth={1.75} />
                  {t("document")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            {/* Center — the text field takes all remaining width. Font
                size is 16px (text-base): below that, focusing an <input>/
                <textarea> on iOS Safari auto-zooms the viewport, which is
                exactly the "screen jumps around while typing" behavior
                WhatsApp/Telegram/iMessage don't have. */}
            <div className="relative flex-1">
              <textarea
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
              ref={micButtonRef}
              type="button"
              disabled={inputsDisabled || busy}
              title={readOnly ? undefined : t("voiceNote")}
              aria-label={t("voiceNote")}
              onPointerDown={handleMicPointerDown}
              onPointerMove={handleMicPointerMove}
              onPointerUp={handleMicPointerEnd}
              onPointerCancel={handleMicPointerEnd}
              className="flex h-[47px] w-[47px] shrink-0 touch-none select-none items-center justify-center rounded-md p-0 text-muted-foreground transition-[transform,border-radius,background-color] duration-150 ease-out hover:text-foreground active:scale-[0.97] active:rounded-full active:bg-primary/15 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Mic className="h-[21px] w-[21px]" />
            </button>

            <GatedButton
              size="sm"
              canAct={!readOnly}
              gateReason="enviar mensagens"
              disabled={!text.trim() || sessionExpired || sending}
              onPointerDown={(e) => e.preventDefault()}
              onMouseDown={(e) => e.preventDefault()}
              onClick={handleSend}
              className="h-9 w-9 shrink-0 bg-primary p-0 hover:bg-primary/90 disabled:opacity-40"
            >
              <Send className="h-4 w-4" />
            </GatedButton>
          </div>

          {micActive && (
            <div
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
                onClick={handleDiscardRecording}
                aria-label={t("discardRecording")}
                disabled={micPhase === "sending"}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:pointer-events-none disabled:opacity-40"
              >
                <Trash2 className="h-4 w-4" />
              </button>

              {/* Desktop's "click again to stop": the mic button itself is
                  hidden the instant recording starts (see the `invisible`
                  row above), so this is the reachable second click —
                  same centralized stopRecordingGesture a touch release
                  calls. Only meaningful while actively capturing (not
                  once already paused, and not while locked — a locked
                  hands-free take still stops here on an explicit click,
                  only the passive finger-release ignores `locked`). */}
              {micPhase === "recording" && (
                <button
                  type="button"
                  onClick={stopRecordingGesture}
                  aria-label={t("stopRecording")}
                  title={t("stopRecording")}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-red-500 transition-colors hover:bg-red-500/10"
                >
                  <Mic className="h-4 w-4" />
                </button>
              )}

              <div className="flex flex-1 items-center justify-center gap-2.5">
                {locked && (
                  // The above-bar hint just disappears the instant this
                  // mounts (locked flips true) — this pop-in is what
                  // actually carries the "locked!" confirmation moment.
                  <Lock className="h-3.5 w-3.5 shrink-0 animate-in text-primary zoom-in-50 duration-200" />
                )}
                {micPhase === "sending" ? (
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
                ) : micPhase === "failed" ? (
                  <AlertCircle className="h-4 w-4 shrink-0 text-red-500" />
                ) : (
                  <RecordingIndicator active={micPhase === "recording"} />
                )}
                <span
                  className={cn(
                    "text-sm font-medium tabular-nums",
                    micPhase === "failed" ? "text-red-500" : "text-foreground",
                  )}
                >
                  {micPhase === "failed" ? t("recordingFailed") : formatDuration(recordSeconds)}
                </span>
              </div>

              <GatedButton
                size="sm"
                canAct={!readOnly}
                gateReason="enviar mensagens"
                disabled={micPhase === "sending"}
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
          url={draft.mediaUrl}
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
              src={draft.mediaUrl}
              alt={draft.filename}
              className="max-h-40 rounded-lg object-cover"
            />
          )}
          {draft.kind === "video" && (
            <video src={draft.mediaUrl} controls className="max-h-40 rounded-lg" />
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
