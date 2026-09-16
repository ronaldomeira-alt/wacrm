'use client';

import { useState, useEffect, useCallback, useRef, useMemo, memo } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { usePresence } from '@/hooks/use-presence';
import { PresenceDot } from '@/components/presence/presence-dot';
import { presenceLabel } from '@/lib/presence';
import { cn } from '@/lib/utils';
import type {
  Conversation,
  Message,
  MessageReaction,
  Contact,
  ConversationStatus,
  MessageTemplate,
  Profile,
} from '@/types';
import {
  MessageSquare,
  UserPlus,
  Check,
  Clock,
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  PanelRightOpen,
  PanelRightClose,
  Megaphone,
  MoreVertical,
  StickyNote,
  CalendarPlus,
  Images,
  Kanban,
  ListChecks,
} from 'lucide-react';
import { format, isToday, isYesterday, differenceInHours } from 'date-fns';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { MessageBubble } from './message-bubble';
import { MessageErrorBoundary } from './message-error-boundary';
import { MessageActions } from './message-actions';
import { MessageAlbum, computeAlbumGroups } from './message-album';
import {
  MessageComposer,
  CHAT_MEDIA_BUCKET,
  type SendMediaPayload,
  type SendMediaBatchPayload,
  type SendMediaBatchItem,
} from './message-composer';
import { deleteAccountMedia } from '@/lib/storage/upload-media';
import { deleteR2Media, presignAndUpload } from '@/lib/storage/upload-media-r2';
import { isR2MediaKey } from '@/lib/storage/media-url-kind';
import {
  resolveMediaKeys,
  getCachedMediaSrc,
  registerLocalMediaBlob,
  getLocalMediaBlob,
  seedMediaResolution,
  scheduleRevokeLocalMediaBlob,
} from '@/lib/inbox/use-resolved-media-src';
import { pollNormalizationStatus } from '@/lib/media/batch-upload-pool';
import { isHeicFile, normalizeImageForUpload } from '@/lib/media/image-compat';
import { shouldTranscodeVideo, convertMovToMp4ViaWebCodecs } from '@/lib/media/transcode-mov-webcodecs';
import {
  extractVideoThumbnail,
  getLocalVideoThumbnail,
  registerLocalVideoThumbnail,
} from '@/lib/media/video-thumbnail';
import { createOptimisticAlbum } from '@/lib/inbox/optimistic-album';
import { getPendingAudio } from '@/lib/inbox/pending-audio-db';
import { runPendingAudio, discardPendingAudio } from '@/lib/inbox/pending-audio-sync';
import { markConversationUnread } from '@/lib/inbox/conversations';
import { TemplatePicker, type TemplateSendValues } from './template-picker';
import { AiThreadBanner } from './ai-thread-banner';
import { CtwaOrigin } from './ctwa-origin';
import { getCtwaFepStatus } from '@/lib/whatsapp/ctwa-fep';
import { buildReplyPreview, buildReplyMedia, type ReplyQuoteMedia } from './reply-quote';
import { toast } from 'sonner';
import {
  consumeFollowupDraft,
  type FollowupDraft,
} from '@/lib/inbox/followup-draft';
import { ContactNotesPanel } from './contact-notes-panel';
import { ContactSidebar } from './contact-sidebar';
import { MediaGallery } from './media-gallery';
import { useDrawerGesture } from '@/hooks/use-drawer-gesture';
import { AppointmentFormDialog } from '@/components/appointments/appointment-form-dialog';
import { AddToActionCenterDialog } from '@/components/action-items/add-to-action-center-dialog';
import { FollowupRequirementDialog } from '@/components/action-items/followup-requirement-dialog';
import { ArchiveDealDialog } from '@/components/pipelines/archive-deal-dialog';
import { useLeadPipelineStage } from '@/hooks/use-lead-pipeline-stage';
import { useFollowupGate } from '@/hooks/use-followup-gate';
import {
  getCachedMessages,
  setCachedMessages,
} from '@/lib/inbox/message-cache';

interface ReplyDraft {
  id: string;
  authorLabel: string;
  preview: string;
  media?: ReplyQuoteMedia | null;
}

// iPhone/iPad only — WebKit's hardware video decoder + per-tab memory
// budget is the actual scarce resource the video batch pipeline below
// protects (Jetsam/OOM risk with 2+ videos). Desktop browsers aren't
// under that constraint, so gating every mitigation behind this check
// keeps desktop at full throughput instead of inheriting iPhone-only
// caution for no reason.
const isIOSDevice =
  typeof navigator !== "undefined" && /iPad|iPhone|iPod/.test(navigator.userAgent);

// One macrotask tick — enough for the JS engine to reclaim the previous
// video's hash ArrayBuffer / decode buffers before the next one
// allocates its own. Cheap no-op skip on desktop, where that memory
// pressure isn't the bottleneck.
function yieldToReleaseMemory(): Promise<void> {
  if (!isIOSDevice) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Uploads a locally-generated video thumbnail (small JPEG data: URL,
 * ~480px/quality 0.8 from extractVideoThumbnail) to R2 as a private
 * chat-attachment image, returning the R2 key to persist on the
 * message. Best-effort: failure here must never block the video's own
 * send — every caller treats `undefined` as "no persisted thumbnail
 * this time", same as before this existed (the in-memory-only
 * behavior). Reuses the exact same upload path as any other image
 * attachment, so it gets dedup/hash for free at negligible cost (a
 * thumbnail this size is a rounding error next to a video's own hash).
 */
async function persistVideoThumbnail(dataUrl: string): Promise<string | undefined> {
  try {
    const blob = await fetch(dataUrl).then((r) => r.blob());
    const file = new File([blob], `thumb-${Date.now()}.jpg`, { type: "image/jpeg" });
    const result = await presignAndUpload("chat-attachment", "image", file);
    return result.normalizedKey || result.key;
  } catch {
    return undefined;
  }
}

/** Resolves `promise` or `undefined` after `ms`, whichever comes first
 *  — bounds how long the heavy video pipeline waits on thumbnail work
 *  before proceeding without it. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(undefined);
      },
    );
  });
}

interface TransferSubmenuProps {
  profiles: Profile[];
  assignedAgentId: string | null;
  currentUserId: string | undefined;
  meLabel: string;
  noTeammatesLabel: string;
  unassignLabel: string;
  onAssign: (agentId: string | null) => void;
}

/**
 * Isolated so `usePresence`'s ~15s "now" tick only re-renders this small
 * submenu, not the whole `MessageThread` (and its full message list) —
 * presence data (getPresence/getRow/now) is only ever consumed here.
 */
function TransferSubmenu({
  profiles,
  assignedAgentId,
  currentUserId,
  meLabel,
  noTeammatesLabel,
  unassignLabel,
  onAssign,
}: TransferSubmenuProps) {
  const { getPresence, getRow, now } = usePresence();

  return (
    <>
      {profiles.length === 0 ? (
        <DropdownMenuItem disabled className="text-muted-foreground text-sm">
          {noTeammatesLabel}
        </DropdownMenuItem>
      ) : (
        profiles.map((p) => {
          const isSelected = p.user_id === assignedAgentId;
          const presence = getPresence(p.user_id);
          return (
            <DropdownMenuItem
              key={p.id}
              onClick={() => onAssign(p.user_id)}
              className={cn(
                'text-sm',
                isSelected ? 'text-primary' : 'text-popover-foreground'
              )}
            >
              <PresenceDot
                status={presence}
                label={presenceLabel(
                  presence,
                  getRow(p.user_id)?.last_seen_at ?? null,
                  now
                )}
                className="mr-2"
              />
              <span className="flex-1">
                {p.full_name}
                {p.user_id === currentUserId ? meLabel : ''}
              </span>
              {isSelected && <Check className="ml-2 h-3 w-3" />}
            </DropdownMenuItem>
          );
        })
      )}
      {assignedAgentId && (
        <>
          <DropdownMenuSeparator className="bg-border" />
          <DropdownMenuItem
            onClick={() => onAssign(null)}
            className="text-muted-foreground text-sm"
          >
            {unassignLabel}
          </DropdownMenuItem>
        </>
      )}
    </>
  );
}

function renderTemplateBody(body: string, params: string[]): string {
  return body.replace(/\{\{(\d+)\}\}/g, (_, raw) => {
    const idx = Number(raw) - 1;
    return params[idx] ?? `{{${raw}}}`;
  });
}

interface MessageRowProps {
  message: Message;
  reply: {
    authorLabel: string;
    preview: string;
    media: ReplyQuoteMedia | null;
    onClick: () => void;
  } | null;
  reactions: MessageReaction[] | undefined;
  currentUserId: string | undefined;
  currentContactId?: string;
  onReply: (message: Message) => void;
  onReact: (messageId: string, emoji: string) => void;
  onDelete: (message: Message) => Promise<void> | void;
  onTranscribe: (message: Message) => Promise<void> | void;
  onToggleReaction: (messageId: string, emoji: string) => void;
  /** Has the agent explicitly asked to see this message's transcript
   *  (via "Transcrever")? See MessageBubble's own doc for why the
   *  background-transcribed `transcript_text` isn't shown on its own. */
  transcriptRevealed: boolean;
  /** Resend a voice note that failed to upload/send — see MessageBubble's own doc. */
  onRetryAudio: (message: Message) => void;
  onRetryMedia?: (message: Message) => void;
}

/**
 * One row (actions wrapper + bubble) per message, memoized as its own
 * unit. `<MessageBubble>` is passed as JSX children to `<MessageActions>`
 * at the call site below — a fresh element every render regardless of
 * `MessageBubble`'s own `memo()` — so wrapping this composition, instead
 * of each piece separately, is what lets React actually skip re-rendering
 * a message whose own props haven't changed (REACT-1).
 */
const MessageRow = memo(function MessageRow({
  message,
  reply,
  reactions,
  currentUserId,
  currentContactId,
  onReply,
  onReact,
  onDelete,
  onTranscribe,
  onToggleReaction,
  transcriptRevealed,
  onRetryAudio,
  onRetryMedia,
}: MessageRowProps) {
  return (
    <MessageErrorBoundary messageId={message.id}>
      <MessageActions
        message={message}
        currentContactId={currentContactId}
        onReply={onReply}
        onReact={onReact}
        onDelete={onDelete}
        onTranscribe={onTranscribe}
      >
        {(cornerAction) => (
          <MessageBubble
            message={message}
            reply={reply}
            reactions={reactions}
            currentUserId={currentUserId}
            onToggleReaction={onToggleReaction}
            transcriptRevealed={transcriptRevealed}
            cornerAction={cornerAction}
            onRetryAudio={onRetryAudio}
            onRetryMedia={onRetryMedia}
          />
        )}
      </MessageActions>
    </MessageErrorBoundary>
  );
});

interface MessageThreadProps {
  conversation: Conversation | null;
  contact: Contact | null;
  messages: Message[];
  onMessagesLoaded: (messages: Message[]) => void;
  onNewMessage: (message: Message) => void;
  onNewMessages?: (messages: Message[]) => void;
  onUpdateMessage: (id: string, updates: Partial<Message>) => void;
  /** Removes a message from local state — fired after the DB delete
   *  succeeds, and again (as a no-op) when the realtime DELETE echoes
   *  back for any other connected client. */
  onDeleteMessage: (id: string) => void;
  onStatusChange: (conversationId: string, status: ConversationStatus) => void;
  /**
   * Manual "mark as unread" — sets the conversation's unread_count back
   * to a nonzero value. Independent of `status`: a conversation can be
   * pending and read at the same time, so this is its own callback
   * rather than piggy-backing on onStatusChange.
   */
  onMarkUnread: (conversationId: string) => void;
  onAssignChange: (
    conversationId: string,
    assignedAgentId: string | null
  ) => void;
  /**
   * On mobile, the thread is shown full-screen with the conversation list
   * hidden. This callback lets the page deselect the active conversation
   * and reveal the list again. Rendered as a back-arrow in the header on
   * mobile only.
   */
  onBack?: () => void;
  /**
   * Increment to force the messages + reactions fetch effects to refire.
   * Parent bumps this on realtime reconnect / tab visibility → visible
   * so the open thread catches up on any events sent while the WS was
   * disconnected or the tab was throttled. Optional so existing callers
   * keep working.
   */
  resyncToken?: number;
  /**
   * Desktop-only contact-panel toggle. The page owns the open/closed
   * state (it's the one that renders the sidebar), so the thread just
   * reflects it and asks the page to flip it. Both optional so existing
   * callers keep working; the toggle button only renders when
   * `onToggleContactPanel` is wired up.
   */
  contactPanelOpen?: boolean;
  onToggleContactPanel?: () => void;
}

/**
 * The `messages` table only stores the public URL (no separate `path`
 * column), so deleting an agent-sent attachment has to recover the
 * Storage object path from it. Supabase's `getPublicUrl` always shapes
 * URLs as `.../object/public/<bucket>/<path>` — anything after the
 * bucket segment is the path. Returns null for URLs that aren't hosted
 * in that bucket (e.g. a customer's inbound media, proxied through
 * `/api/whatsapp/media/`), which is also every case we'd ever attempt
 * this for, since deletion is agent-messages-only.
 */
// Local-only id prefix for a voice-note bubble that has no DB row yet —
// handleQueuedAudio creates it optimistically the moment the composer
// commits to sending, and it never gets superseded by a realtime INSERT
// the way a normal `temp-*` id does: a message only ever carries this id
// while pending-audio-sync.ts's upload/send pipeline is still running (or
// has failed) for it. The suffix is the pending-audio-db.ts record id, so
// handleRetryAudio / handleDeleteMessage can recover it.
export const LOCAL_AUDIO_PREFIX = 'local-audio-';

function extractStoragePath(
  mediaUrl: string | undefined,
  bucket: string
): string | null {
  if (!mediaUrl) return null;
  const marker = `/${bucket}/`;
  const idx = mediaUrl.indexOf(marker);
  if (idx === -1) return null;
  return mediaUrl.slice(idx + marker.length);
}

function formatDateSeparator(
  dateStr: string,
  t: ReturnType<typeof useTranslations>
): string {
  const date = new Date(dateStr);
  if (isToday(date)) return t('today');
  if (isYesterday(date)) return t('yesterday');
  return format(date, 'MMMM d, yyyy');
}

function groupMessagesByDate(messages: Message[]) {
  const groups: { date: string; messages: Message[] }[] = [];
  let currentDate = '';

  for (const msg of messages) {
    const day = msg.created_at ? msg.created_at.slice(0, 10) : '';
    if (day !== currentDate) {
      currentDate = day;
      groups.push({ date: msg.created_at, messages: [msg] });
    } else {
      groups[groups.length - 1].messages.push(msg);
    }
  }

  return groups;
}

/**
 * WhatsApp-style doodle background applied to the chat area (both the
 * active thread and the empty state). The SVG tile lives at
 * `/public/inbox-doodle.svg`; the slate-950 colour sits underneath so
 * the doodles read as a subtle pattern rather than a stark grid.
 *
 * Defined once at module scope so the two render paths can't drift —
 * if we ever switch the asset, both spots update together.
 */
const DOODLE_BG_CLASSES =
  "bg-background bg-[url('/inbox-doodle.svg')] bg-repeat";

export function MessageThread({
  conversation,
  contact,
  messages,
  onMessagesLoaded,
  onNewMessage,
  onNewMessages,
  onUpdateMessage,
  onDeleteMessage,
  onStatusChange,
  onMarkUnread,
  onAssignChange,
  onBack,
  resyncToken = 0,
  contactPanelOpen,
  onToggleContactPanel,
}: MessageThreadProps) {
  const t = useTranslations('Inbox.messageThread');
  const tTimer = useTranslations('Inbox.sessionTimer');
  const tCtwaFep = useTranslations('Inbox.ctwaFep');
  const tQuote = useTranslations('Inbox.replyQuote');

  const { user } = useAuth();
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  // The actual message-list content, one level inside scrollRef — its
  // own rendered height is what grows/shrinks as media loads (see the
  // content-resize auto-scroll effect below); scrollRef's box itself
  // stays a fixed viewport size.
  const contentRef = useRef<HTMLDivElement>(null);
  const bottomMarkerRef = useRef<HTMLDivElement>(null);
  // Non-scrolling wrapper around the messages area — the confinement
  // target for the pre-send PDF preview (see document-fullscreen-
  // preview.tsx). `absolute inset-0` inside `scrollRef` itself would
  // position against that element's full *scrolled* content box, not
  // its visible viewport slice — floating off-screen by however far the
  // thread is scrolled. This wrapper never scrolls, so an absolutely
  // positioned child of it always lines up with what's actually visible.
  const messagesAreaRef = useRef<HTMLDivElement>(null);
  const [templateModalOpen, setTemplateModalOpen] = useState(false);

  // BLOCO 3/4 — a follow-up draft primed from the Central de IA
  // ("Enviar pelo CRM"). `followupPrimeRef` mirrors the state into a
  // ref so the memoized send handlers below can read the current value
  // without needing it in their dependency arrays.
  const [followupPrime, setFollowupPrime] = useState<FollowupDraft | null>(
    null
  );
  const followupPrimeRef = useRef<FollowupDraft | null>(null);
  useEffect(() => {
    followupPrimeRef.current = followupPrime;
  }, [followupPrime]);
  const [followupTemplateSelection, setFollowupTemplateSelection] = useState<{
    template: MessageTemplate;
    values: TemplateSendValues;
  } | null>(null);

  useEffect(() => {
    if (!conversation) return;
    const draft = consumeFollowupDraft(conversation.id);
    if (!draft) return;
    setFollowupPrime(draft);
    if (draft.mode === 'template' && draft.templateId) {
      const supabase = createClient();
      supabase
        .from('message_templates')
        .select('*')
        .eq('id', draft.templateId)
        .maybeSingle()
        .then(({ data }) => {
          if (!data) return;
          setFollowupTemplateSelection({
            template: data as MessageTemplate,
            values: draft.values ?? { body: [] },
          });
          setTemplateModalOpen(true);
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation?.id]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [reactions, setReactions] = useState<MessageReaction[]>([]);
  // Message ids whose transcript the agent has explicitly revealed via
  // "Transcrever" — see handleTranscribe below and MessageBubble's own
  // doc comment for why this can't just be `!!message.transcript_text`.
  const [revealedTranscriptIds, setRevealedTranscriptIds] = useState<Set<string>>(
    () => new Set()
  );
  const [replyTo, setReplyTo] = useState<ReplyDraft | null>(null);
  // The 3 dialogs opened from the header's "⋮" menu — Transfer stays a
  // DropdownMenuSub (it's just the old Assign dropdown's content, one
  // level deeper), these three are substantial enough to want a real
  // dialog surface instead.
  const [notesDialogOpen, setNotesDialogOpen] = useState(false);
  const [appointmentDialogOpen, setAppointmentDialogOpen] = useState(false);
  const [mediaGalleryOpen, setMediaGalleryOpen] = useState(false);
  const [actionCenterOpen, setActionCenterOpen] = useState(false);
  const [archiveDialogOpen, setArchiveDialogOpen] = useState(false);

  // Mobile contact-info drawer — reuses the exact same ContactSidebar the
  // desktop panel renders (below), just presented as a fixed right-edge
  // overlay via useDrawerGesture (side="right") instead of a flex-width
  // column. Reset on every conversation switch via the render-time
  // "adjusting state when a prop changes" pattern (same technique
  // contact-sidebar.tsx's own optimistic toggles already use) rather than
  // an effect, so a leftover open drawer never leaks into the next lead.
  const [mobileContactPanelOpen, setMobileContactPanelOpen] = useState(false);
  const [mobileContactPanelConvId, setMobileContactPanelConvId] = useState(
    conversation?.id
  );
  if (conversation?.id !== mobileContactPanelConvId) {
    setMobileContactPanelConvId(conversation?.id);
    setMobileContactPanelOpen(false);
  }
  const threadRootRef = useRef<HTMLDivElement>(null);
  const mobileContactPanelRef = useRef<HTMLDivElement>(null);
  const mobileContactBackdropRef = useRef<HTMLButtonElement>(null);
  useDrawerGesture({
    open: mobileContactPanelOpen,
    onOpenChange: setMobileContactPanelOpen,
    containerRef: threadRootRef,
    panelRef: mobileContactPanelRef,
    backdropRef: mobileContactBackdropRef,
    side: 'right',
  });
  // Same lock/Escape behavior as the mobile nav drawer (Sidebar) while
  // this one is open — belt-and-suspenders alongside the backdrop, which
  // already blocks every touch from reaching the conversation underneath.
  useEffect(() => {
    if (!mobileContactPanelOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMobileContactPanelOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [mobileContactPanelOpen]);
  // "Mover para" submenu — same hook the sidebar's "Etapa da Pipeline"
  // card uses (contact-sidebar.tsx), so both entry points share one
  // fetch/update implementation and stay in sync with each other.
  const {
    deal: pipelineDeal,
    stages: pipelineStages,
    moveToStage,
  } = useLeadPipelineStage(contact?.id);
  const followupGate = useFollowupGate();

  // Profiles are bounded by RLS to rows the current user is allowed to
  // see — today that's just the current user, but the dropdown keeps the
  // shape ready for shared-team workspaces without a refactor.
  useEffect(() => {
    let cancelled = false;
    const supabase = createClient();
    supabase
      .from('profiles')
      .select('*')
      .order('full_name')
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          console.error('Failed to fetch profiles:', error);
          return;
        }
        setProfiles((data as Profile[]) ?? []);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 24-hour session timer
  const sessionInfo = useMemo(() => {
    if (!messages.length) return { expired: false, remaining: '' };

    // Find last customer message
    const lastCustomerMsg = [...messages]
      .reverse()
      .find((m) => m.sender_type === 'customer');

    if (!lastCustomerMsg)
      return { expired: true, remaining: 'No customer messages' };

    const hoursSince = differenceInHours(
      new Date(),
      new Date(lastCustomerMsg.created_at)
    );
    const expired = hoursSince >= 24;

    if (expired) {
      return { expired: true, remaining: tTimer('expired') };
    }

    const hoursLeft = 24 - hoursSince;
    const remaining =
      hoursLeft >= 1
        ? tTimer('xhRemaining', { hours: Math.floor(hoursLeft) })
        : tTimer('xmRemaining', { minutes: Math.floor(hoursLeft * 60) });

    return { expired, remaining };
  }, [messages, tTimer]);

  // CTWA Free Entry Point 72h — independent of the 24h session timer
  // above (never derived from it, never affects it). Purely a display
  // concern: current active/expired state is always computed from
  // ctwa_fep_expires_at vs. now, not the historical ctwa_fep_active
  // flag — see getCtwaFepStatus. Null when this isn't a CTWA lead, or
  // the FEP was never activated (business hasn't replied yet).
  const ctwaFepInfo = useMemo(() => {
    if (!conversation?.ctwa_referral) return null;
    const status = getCtwaFepStatus(conversation);
    if (!status.expiresAt) return null; // never activated

    if (!status.active) {
      return { active: false, remaining: tCtwaFep('ended') };
    }
    const hoursLeft =
      (status.expiresAt.getTime() - Date.now()) / (1000 * 60 * 60);
    const remaining =
      hoursLeft >= 1
        ? tCtwaFep('xhRemaining', { hours: Math.floor(hoursLeft) })
        : tCtwaFep('xmRemaining', {
            minutes: Math.max(0, Math.floor(hoursLeft * 60)),
          });
    return { active: true, remaining };
  }, [conversation, tCtwaFep]);

  // Store latest callback in a ref so fetchMessages doesn't need to
  // depend on `onMessagesLoaded` — otherwise parent re-renders cause
  // fetchMessages to change → useEffect re-fires → refetch → realtime
  // UPDATE on conversations.unread_count → parent re-renders → LOOP.
  // The ref is written inside an effect so the mutation doesn't happen
  // during render (React 19 refs rule); consumers only read `.current`
  // inside the async fetch completion, which runs after the render.
  const onMessagesLoadedRef = useRef(onMessagesLoaded);
  useEffect(() => {
    onMessagesLoadedRef.current = onMessagesLoaded;
  });

  const conversationId = conversation?.id;
  const hasUnread = (conversation?.unread_count ?? 0) > 0;

  // Fetch messages whenever the selected conversation changes. Kept
  // separate from the unread-reset effect so that incoming messages
  // arriving while the thread is open don't trigger a full refetch —
  // they only flip hasUnread, which only the reset effect listens to.
  useEffect(() => {
    if (!conversationId) return;

    const cached = getCachedMessages(conversationId);
    const hasCached = Boolean(cached && cached.length > 0);
    if (!hasCached) {
      setLoading(true);
    }

    const supabase = createClient();
    let cancelled = false;

    (async () => {
      const { data, error } = await supabase
        .from('messages')
        .select('*')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: true });

      if (cancelled) return;

      if (error) {
        console.error('Failed to fetch messages:', error);
      } else {
        const loaded = data ?? [];

        // Pre-resolve any uncached R2 media keys in batch BEFORE exposing messages to UI
        const uncachedR2Keys = loaded
          .map((m) => m.media_url)
          .filter(
            (url): url is string =>
              Boolean(url && isR2MediaKey(url) && !getCachedMediaSrc(url))
          );

        if (uncachedR2Keys.length > 0) {
          try {
            await resolveMediaKeys(uncachedR2Keys);
          } catch (err) {
            console.warn('[message-thread] Pre-resolving media keys failed:', err);
          }
        }

        if (cancelled) return;

        setCachedMessages(conversationId, loaded);
        onMessagesLoadedRef.current(loaded);
      }

      if (!cancelled) setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
    // `resyncToken` is included so the parent can force a refetch when
    // the realtime channel reconnects or the tab regains focus —
    // realtime is best-effort and any message events sent while the WS
    // was disconnected or throttled are otherwise lost.
  }, [conversationId, resyncToken]);

  // Reactions fetch — pulls the current state from the DB. Kept separate
  // from the channel subscription below so a `resyncToken` bump just
  // refetches the rows without also tearing down and rebuilding the
  // realtime channel.
  useEffect(() => {
    if (!conversationId) {
      setReactions([]);
      return;
    }
    const supabase = createClient();
    let cancelled = false;

    (async () => {
      const { data, error } = await supabase
        .from('message_reactions')
        .select('*')
        .eq('conversation_id', conversationId);
      if (cancelled) return;
      if (error) {
        console.error('Failed to fetch reactions:', error);
        return;
      }
      setReactions((data as MessageReaction[]) ?? []);
    })();

    return () => {
      cancelled = true;
    };
  }, [conversationId, resyncToken]);

  // Reactions realtime subscription per conversation. Subscribing here
  // (not at the page level) keeps the channel scoped to the visible
  // conversation and avoids cross-conversation chatter on a busy inbox.
  useEffect(() => {
    if (!conversationId) return;
    const supabase = createClient();

    const channel = supabase
      .channel(`reactions:${conversationId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'message_reactions',
          filter: `conversation_id=eq.${conversationId}`,
        },
        (payload) => {
          const row = payload.new as MessageReaction;
          setReactions((prev) => {
            if (prev.some((r) => r.id === row.id)) return prev;
            // Swap any matching optimistic temp row for the real one so
            // the pill doesn't double up after a successful POST.
            const tempIdx = prev.findIndex(
              (r) =>
                r.id.startsWith('temp-') &&
                r.message_id === row.message_id &&
                r.actor_type === row.actor_type &&
                r.actor_id === row.actor_id
            );
            if (tempIdx >= 0) {
              const copy = prev.slice();
              copy[tempIdx] = row;
              return copy;
            }
            return [...prev, row];
          });
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'message_reactions',
          filter: `conversation_id=eq.${conversationId}`,
        },
        (payload) => {
          const row = payload.new as MessageReaction;
          setReactions((prev) => prev.map((r) => (r.id === row.id ? row : r)));
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'DELETE',
          schema: 'public',
          table: 'message_reactions',
          filter: `conversation_id=eq.${conversationId}`,
        },
        (payload) => {
          const old = payload.old as Partial<MessageReaction>;
          if (!old?.id) return;
          setReactions((prev) => prev.filter((r) => r.id !== old.id));
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [conversationId]);

  // Clear any in-progress reply draft when the active conversation changes —
  // a quote pulled from conversation A shouldn't bleed into conversation B.
  useEffect(() => {
    setReplyTo(null);
  }, [conversationId]);

  // Reset the server-side unread_count to 0 whenever an unread count
  // surfaces on the active conversation — covers both (a) opening a
  // conversation that had unread messages and (b) new messages arriving
  // while the user is already viewing the thread (webhook server-bumps
  // unread_count to N+1; the realtime UPDATE propagates it into the
  // client, which re-runs this effect and flips it back to 0).
  //
  // Guarding on hasUnread prevents the eq-update loop: once unread_count
  // is 0 the condition is false, so no further UPDATE is issued.
  useEffect(() => {
    if (!conversationId || !hasUnread) return;
    const supabase = createClient();
    supabase
      .from('conversations')
      .update({ unread_count: 0 })
      .eq('id', conversationId)
      .then(({ error }) => {
        if (error) console.error('Failed to reset unread_count:', error);
      });
  }, [conversationId, hasUnread]);

  // Whether the viewport is pinned to the bottom of the conversation
  const isPinnedToBottomRef = useRef(true);
  // Track whether the user is actively touching or dragging the scroll container
  const isUserTouchingRef = useRef(false);
  // Timestamp of the last touchend/pointerup/wheel-idle — gives iOS's
  // post-lift momentum/kinetic scroll a grace window before the WKWebView
  // compensation loop below is allowed to resume forcing scrollTop back to
  // bottom. Without it, `isUserTouchingRef` flips to false the instant the
  // finger lifts while momentum scrolling is still carrying the view away
  // from the bottom — the loop would snap it straight back on the very next
  // frame, reading as the thread being frozen on the last message.
  const lastInteractionEndRef = useRef(0);
  // Track whether the current scroll movement was triggered programmatically
  const isProgrammaticScrollRef = useRef(false);
  const programmaticTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track initial conversation load to ensure we land at the bottom once rendered
  const isInitialLoadRef = useRef(true);
  // Track last measured scrollTop to detect manual upward drag in real-time
  const lastScrollTopRef = useRef(0);
  // Timestamp the conversation was (re)opened. Avatars and media thumbnails
  // keep loading asynchronously for a bit after the first paint, growing
  // contentEl and re-triggering the pinned-to-bottom ResizeObserver/rAF
  // loops below. If the user's very first touch on the list lands in that
  // window, a light drag may be too small for the scrollTop-delta unpin
  // check to catch before one of those loops re-asserts scrollTop — read
  // as a flicker back to the last bubble on the first scroll only (once
  // settled, nothing races it again). Any touch during this window is
  // unambiguously scroll intent (this listener is on the list itself),
  // so unpin unconditionally rather than waiting on a measurable delta.
  const conversationOpenedAtRef = useRef(0);
  const INITIAL_SETTLE_MS = 2000;

  const markProgrammaticScroll = useCallback(() => {
    isProgrammaticScrollRef.current = true;
    if (programmaticTimerRef.current) {
      clearTimeout(programmaticTimerRef.current);
    }
    programmaticTimerRef.current = setTimeout(() => {
      isProgrammaticScrollRef.current = false;
    }, 120);
  }, []);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (programmaticTimerRef.current) clearTimeout(programmaticTimerRef.current);
    };
  }, []);

  // Unified, high-resilience scroll-to-bottom helper.
  // Directly operates on scrollRef without scrollIntoView (preventing Safari iOS ancestor shifts).
  const scrollToBottom = useCallback((force = false) => {
    const el = scrollRef.current;
    if (!el) return;
    if (force) {
      isPinnedToBottomRef.current = true;
    }
    if (!isPinnedToBottomRef.current && !force) return;

    markProgrammaticScroll();
    el.scrollTop = el.scrollHeight;

    requestAnimationFrame(() => {
      if (scrollRef.current && (isPinnedToBottomRef.current || force)) {
        markProgrammaticScroll();
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
    });
  }, [markProgrammaticScroll]);

  // All messages of the conversation are rendered stably to prevent layout shifts/jumps
  const visibleMessages = messages;

  // Track user touch/pointer/wheel interaction to never fight user gestures
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const onTouchStart = () => {
      isUserTouchingRef.current = true;
      lastScrollTopRef.current = el.scrollTop;
      if (Date.now() - conversationOpenedAtRef.current < INITIAL_SETTLE_MS) {
        isPinnedToBottomRef.current = false;
      }
    };
    const onTouchEnd = () => {
      isUserTouchingRef.current = false;
      lastInteractionEndRef.current = Date.now();
    };
    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' || e.pointerType === 'touch' || e.pointerType === 'pen') {
        isUserTouchingRef.current = true;
        lastScrollTopRef.current = el.scrollTop;
        if (Date.now() - conversationOpenedAtRef.current < INITIAL_SETTLE_MS) {
          isPinnedToBottomRef.current = false;
        }
      }
    };
    const onPointerUp = () => {
      isUserTouchingRef.current = false;
      lastInteractionEndRef.current = Date.now();
    };
    let wheelTimer: ReturnType<typeof setTimeout> | null = null;
    const onWheel = () => {
      isUserTouchingRef.current = true;
      lastScrollTopRef.current = el.scrollTop;
      if (wheelTimer) clearTimeout(wheelTimer);
      wheelTimer = setTimeout(() => {
        isUserTouchingRef.current = false;
        lastInteractionEndRef.current = Date.now();
      }, 150);
    };

    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchend', onTouchEnd, { passive: true });
    el.addEventListener('touchcancel', onTouchEnd, { passive: true });
    el.addEventListener('pointerdown', onPointerDown, { passive: true });
    el.addEventListener('pointerup', onPointerUp, { passive: true });
    el.addEventListener('pointercancel', onPointerUp, { passive: true });
    el.addEventListener('wheel', onWheel, { passive: true });

    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchEnd);
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('pointerup', onPointerUp);
      el.removeEventListener('pointercancel', onPointerUp);
      el.removeEventListener('wheel', onWheel);
      if (wheelTimer) clearTimeout(wheelTimer);
    };
  }, []);

  // Track whether user scrolled up to read history vs stayed at bottom.
  // Implements strict hysteresis: once unpinned, NEVER passively re-pins.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const onScroll = () => {
      const currentScrollTop = el.scrollTop;
      const distanceFromBottom =
        el.scrollHeight - currentScrollTop - el.clientHeight;

      // ── INVARIANTE 1, 3 & 7: PREVALÊNCIA ABSOLUTA DO GESTO MANUAL DO USUÁRIO ──
      // Se o usuário está ativamente tocando ou arrastando, o gesto manual sempre
      // vence qualquer lock programático residual (inclusive o primeiro gesto após abrir a conversa).
      if (isUserTouchingRef.current) {
        if (
          currentScrollTop < lastScrollTopRef.current ||
          distanceFromBottom > 8
        ) {
          // Despina imediatamente e cancela qualquer bloqueio programático
          isPinnedToBottomRef.current = false;
          isProgrammaticScrollRef.current = false;
        } else if (
          currentScrollTop > lastScrollTopRef.current &&
          distanceFromBottom <= 2
        ) {
          // Rearme MANUAL legítimo: o usuário arrastou ativamente para baixo e encostou no fundo real
          isPinnedToBottomRef.current = true;
        }

        lastScrollTopRef.current = currentScrollTop;
        return;
      }

      // ── SE NÃO HÁ TOQUE MANUAL ATIVO: ──

      // Rolagem programática legítima autorizada (ex: scrollToBottom forçado, envio de mensagem)
      if (isProgrammaticScrollRef.current) {
        isPinnedToBottomRef.current = true;
        lastScrollTopRef.current = currentScrollTop;
        return;
      }

      // ── INVARIANTE 2 & 5: HISTERESE ESTRITA (NENHUM REARME PASSIVO) ──
      // Durante momentum do Safari iOS, repouso, inércia ou redimensionamento:
      // - Se já estava despinado, PERMANECE despinado. Proximidade passiva não é intenção.
      // - Se estava pinned, só desmarca se o scroll natural se afastou do fundo.
      if (!isPinnedToBottomRef.current) {
        // Mantém despinado com trava de saída. Não religa o pin.
      } else {
        if (distanceFromBottom > 24) {
          isPinnedToBottomRef.current = false;
        }
      }

      lastScrollTopRef.current = currentScrollTop;
    };

    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  // Reset flags when switching conversation
  useEffect(() => {
    isPinnedToBottomRef.current = true;
    isInitialLoadRef.current = true;
    lastScrollTopRef.current = 0;
    conversationOpenedAtRef.current = Date.now();
  }, [conversationId]);

  // Initial load auto-positioning:
  // When messages are ready and rendered, pin to bottom across layout frames.
  useEffect(() => {
    if (loading || messages.length === 0) return;
    if (isInitialLoadRef.current) {
      scrollToBottom(true);
      const r1 = requestAnimationFrame(() => {
        if (!isUserTouchingRef.current && isPinnedToBottomRef.current) {
          scrollToBottom(true);
        }
        const r2 = requestAnimationFrame(() => {
          if (!isUserTouchingRef.current && isPinnedToBottomRef.current) {
            scrollToBottom(true);
          }
          isInitialLoadRef.current = false;
        });
        return () => cancelAnimationFrame(r2);
      });
      return () => cancelAnimationFrame(r1);
    }
  }, [conversationId, loading, messages.length, scrollToBottom]);

  // Realtime/subsequent new messages: scroll to bottom if user is pinned
  useEffect(() => {
    if (loading || isInitialLoadRef.current) return;
    if (isPinnedToBottomRef.current) {
      scrollToBottom();
    }
  }, [messages.length, loading, scrollToBottom]);

  // Two different things need two different mechanisms — conflating them
  // (or driving both off the same async notification queue) is what
  // caused the conversation to visibly lag behind the composer on every
  // 1<->2/2<->3/3<->4 line transition:
  //
  //   scrollEl itself (the viewport box) — resizes on *every rendered
  //   frame* while the composer's approved CSS height transition runs,
  //   since scrollEl and the composer are flex siblings and scrollEl is
  //   `flex-1` (see the composer's own render below). scrollEl has
  //   `[overflow-anchor:none]` (deliberate, see that className), so
  //   nothing compensates scrollTop automatically as clientHeight
  //   shrinks/grows. This used to be driven off ResizeObserver — correct
  //   math (compensate scrollTop by the exact pixel delta), wrong trigger:
  //   ResizeObserver's callback is queued *after* layout, on its own
  //   notification queue, and nothing in the spec guarantees one
  //   invocation per rendered frame — inside an iOS WKWebView PWA a
  //   single continuous transition can get coalesced into just a couple
  //   of notifications instead of ~60/s. That's what read as "composer
  //   grows on top of the message, then it catches up in a lagged slide"
  //   — not a timing delay we can tune away, a structural one: the
  //   notification and the frame it describes aren't the same tick.
  //   Fixed by polling scrollEl's own clientHeight from inside our *own*
  //   requestAnimationFrame callback and writing scrollTop in that same
  //   callback — read and write happen in the same frame, before paint,
  //   every single frame, with no notification queue in between at all.
  //
  //   contentEl (the messages themselves) — resizes in discrete steps (a
  //   new message inserted, an image/video thumbnail finishing load),
  //   not as a continuous animation — ResizeObserver is the right tool
  //   here, debounced snap-to-bottom unchanged from before.
  //
  //   One refinement on top of that rAF loop: it used to track a
  //   remembered `lastHeight` and apply only the incremental delta each
  //   frame (`scrollTop += delta`). That's fragile by construction — if
  //   any single frame's `clientHeight` read landed a hair before the
  //   engine had propagated that frame's transition step to layout (the
  //   ordering between "advance CSS transitions" and "run rAF callbacks"
  //   isn't identically guaranteed across engines), that frame's delta
  //   came up short, and being incremental, the shortfall stayed
  //   accumulated until a later frame closed it — read as the last
  //   bubble yielding a few px behind the composer before catching up.
  //   Re-asserting the *absolute* correct position every frame
  //   (`scrollHeight - clientHeight`, i.e. "scrolled all the way down")
  //   instead of an incremental delta is self-correcting by
  //   construction: there's no remembered value that can drift out of
  //   sync — every frame computes fresh from current real values, so
  //   even a single stale read is fully caught up by the very next
  //   frame (8-16ms later) with nothing left over to visibly settle.
  useEffect(() => {
    // iOS WKWebView-only compensation loop —
    // It exists solely to counter Safari's ResizeObserver notification
    // coalescing during the composer's CSS height transition.
    // Strictly conditioned to actual clientHeight changes (composer resizing).
    // If clientHeight is stable, this loop NEVER touches scrollTop!
    if (!isIOSDevice) return;

    const scrollEl = scrollRef.current;
    if (!scrollEl) return;

    let lastClientHeight = scrollEl.clientHeight;
    const TOUCH_END_GRACE_MS = 250;
    const SCROLL_EPSILON_PX = 1;

    let rafId = requestAnimationFrame(function tick() {
      const el = scrollRef.current;
      if (el) {
        const currentClientHeight = el.clientHeight;
        const heightDelta = currentClientHeight - lastClientHeight;
        lastClientHeight = currentClientHeight;

        const withinGrace = Date.now() - lastInteractionEndRef.current < TOUCH_END_GRACE_MS;

        // CRITICAL: Only compensate when clientHeight has actually changed (active layout transition,
        // e.g. composer expanding/shrinking between 1-4 lines), AND the user is not touching,
        // AND the user is legitimately pinned to bottom.
        // If clientHeight is stable, this loop NEVER mutates scrollTop!
        if (
          Math.abs(heightDelta) > 0.5 &&
          !isUserTouchingRef.current &&
          !withinGrace &&
          isPinnedToBottomRef.current
        ) {
          const target = el.scrollHeight - currentClientHeight;
          if (Math.abs(el.scrollTop - target) > SCROLL_EPSILON_PX) {
            el.scrollTop = target;
          }
        }
      }
      rafId = requestAnimationFrame(tick);
    });

    return () => cancelAnimationFrame(rafId);
  }, [conversationId]);

  useEffect(() => {
    const contentEl = contentRef.current;
    if (!contentEl || typeof ResizeObserver === 'undefined') return;

    let contentDebounceId: ReturnType<typeof setTimeout> | null = null;
    const ro = new ResizeObserver(() => {
      // INVARIANTE 8: Se o usuário estiver navegando/despinado, cancela qualquer agendamento e aborta
      if (!isPinnedToBottomRef.current) {
        if (contentDebounceId !== null) {
          clearTimeout(contentDebounceId);
          contentDebounceId = null;
        }
        return;
      }

      const withinGrace = Date.now() - lastInteractionEndRef.current < 250;
      if (isUserTouchingRef.current || withinGrace) return;
      if (contentDebounceId !== null) clearTimeout(contentDebounceId);
      contentDebounceId = setTimeout(() => {
        contentDebounceId = null;
        const withinGraceDebounced = Date.now() - lastInteractionEndRef.current < 250;
        if (
          !isUserTouchingRef.current &&
          !withinGraceDebounced &&
          isPinnedToBottomRef.current &&
          scrollRef.current
        ) {
          markProgrammaticScroll();
          scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
      }, 80);
    });

    ro.observe(contentEl);

    return () => {
      ro.disconnect();
      if (contentDebounceId !== null) clearTimeout(contentDebounceId);
    };
  }, [conversationId, loading, markProgrammaticScroll]);

  const handleSend = useCallback(
    async (text: string, replyToId?: string) => {
      if (!conversation) return;

      const tempId = `temp-${Date.now()}`;

      // Optimistic update — shows the message immediately with "sending" status
      const optimisticMsg: Message = {
        id: tempId,
        conversation_id: conversation.id,
        sender_type: 'agent',
        sender_id: user?.id,
        content_type: 'text',
        content_text: text,
        status: 'sending',
        created_at: new Date().toISOString(),
        reply_to_message_id: replyToId,
      };
      onNewMessage(optimisticMsg);
      scrollToBottom(true);
      setReplyTo(null);

      // One-shot: a message going out on a thread primed from a
      // follow-up tags that specific send so the suggestion resolves
      // automatically (see /api/whatsapp/send). Consumed here so a
      // later, unrelated send in the same thread doesn't re-tag it.
      const followupSuggestionId = followupPrimeRef.current?.suggestionId;
      setFollowupPrime(null);

      try {
        const res = await fetch('/api/whatsapp/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            conversation_id: conversation.id,
            message_type: 'text',
            content_text: text,
            reply_to_message_id: replyToId,
            ...(followupSuggestionId
              ? { followup_suggestion_id: followupSuggestionId }
              : {}),
          }),
        });

        const payload = await res.json().catch(() => ({}));

        if (!res.ok) {
          const reason = payload?.error || `HTTP ${res.status}`;
          console.error('Failed to send message:', reason);
          toast.error(`Failed to send: ${reason}`);
          // Mark the optimistic bubble as failed so the user sees what happened
          onUpdateMessage(tempId, { status: 'failed' });
          return;
        }

        // Success — the realtime INSERT event will replace the temp bubble
        // with the real DB row. If realtime hasn't arrived yet, at least
        // flip status to 'sent' so the UI stops showing "sending".
        onUpdateMessage(tempId, { status: 'sent' });
      } catch (err) {
        console.error('Failed to send message:', err);
        const reason = err instanceof Error ? err.message : 'network error';
        toast.error(`Failed to send: ${reason}`);
        onUpdateMessage(tempId, { status: 'failed' });
      }
    },
    [conversation, onNewMessage, onUpdateMessage, scrollToBottom, user?.id]
  );

  const handleSendMedia = useCallback(
    async (payload: SendMediaPayload) => {
      if (!conversation) return;

      // Documents show their filename in our own bubble (and to the
      // recipient as the Meta caption when no caption was typed); other
      // kinds use the caption as-is. Audio carries no caption.
      const contentText =
        payload.kind === 'document'
          ? payload.caption || payload.filename || 'Document'
          : payload.caption;

      const tempId = `temp-${Date.now()}`;
      const optimisticMsg: Message = {
        id: tempId,
        conversation_id: conversation.id,
        sender_type: 'agent',
        sender_id: user?.id,
        content_type: payload.kind,
        content_text: contentText,
        media_url: payload.mediaUrl,
        status: 'sending',
        created_at: new Date().toISOString(),
        reply_to_message_id: payload.replyToId,
      };
      onNewMessage(optimisticMsg);
      scrollToBottom(true);
      setReplyTo(null);

      try {
        const res = await fetch('/api/whatsapp/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            conversation_id: conversation.id,
            message_type: payload.kind,
            media_url: payload.mediaUrl,
            content_text: contentText,
            filename: payload.filename,
            reply_to_message_id: payload.replyToId,
          }),
        });

        const data = await res.json().catch(() => ({}));

        if (!res.ok) {
          const reason = data?.error || `HTTP ${res.status}`;
          console.error('Failed to send media:', reason);
          toast.error(`Failed to send: ${reason}`);
          onUpdateMessage(tempId, { status: 'failed' });
          // The upload never reached the recipient — GC the orphaned
          // object rather than leaving it in the public bucket forever.
          // Logged (not silently swallowed): if this delete itself fails,
          // that's a real orphaned-storage-object nit worth seeing in the
          // console, distinct from the send failure already toasted above.
          void deleteR2Media(payload.path).catch(
            (err) =>
              console.error(
                'Failed to GC orphaned media after send failure:',
                err
              )
          );
          return;
        }

        onUpdateMessage(tempId, { status: 'sent' });
      } catch (err) {
        console.error('Failed to send media:', err);
        const reason = err instanceof Error ? err.message : 'network error';
        toast.error(`Failed to send: ${reason}`);
        onUpdateMessage(tempId, { status: 'failed' });
        void deleteR2Media(payload.path).catch((err) =>
          console.error('Failed to GC orphaned media after send failure:', err)
        );
      }
    },
    [conversation, onNewMessage, onUpdateMessage, scrollToBottom, user?.id]
  );

  const batchRetryMapRef = useRef<
    Map<
      string,
      {
        file?: File;
        item?: SendMediaBatchItem;
        replyToId?: string;
        caption?: string;
        albumId?: string;
        albumIndex?: number;
        kind?: 'image' | 'video';
      }
    >
  >(new Map());

  const batchControllersRef = useRef<
    Map<string, { abort: AbortController; albumId?: string }>
  >(new Map());

  // Per-video thumbnail pipeline: local extraction (data: URL, instant)
  // chained into a background R2 upload of that small JPEG, keyed by
  // the optimistic message id. The heavy hash/transcode step below
  // awaits this (bounded) both to avoid decoding the same file twice
  // at once (thumbnail extraction + hash both touch the video's bytes)
  // and to have the persisted key ready for the WhatsApp send payload.
  const thumbnailUploadRef = useRef<Map<string, Promise<string | undefined>>>(new Map());

  // Aborts any video/image batch still uploading in the background if
  // the thread itself unmounts (e.g. the agent navigates away from the
  // inbox entirely) — conversation switches don't remount this
  // component (no `key` on <MessageThread>), so this only fires on a
  // genuine teardown, not on every conversation change.
  useEffect(() => {
    const controllers = batchControllersRef.current;
    return () => {
      for (const entry of controllers.values()) {
        entry.abort.abort();
      }
      controllers.clear();
    };
  }, []);

  const handleSendMediaBatch = useCallback(
    async (payload: SendMediaBatchPayload) => {
      if (!conversation) return;

      const hasFiles = payload.files && payload.files.length > 0;
      const hasItems = payload.items && payload.items.length > 0;
      if (!hasFiles && !hasItems) return;

      const batchBaseTime = Date.now();

      // 1. WhatsApp Instant Video Send (when payload.kind === 'video')
      if (hasFiles && payload.kind === 'video') {
        const files = payload.files!;
        // 2+ videos get grouped into a visual album — same mechanism
        // images already use (shared album_id, computeAlbumGroups) — so
        // the thread shows one grid with one central progress ring
        // instead of N separate bubbles each animating on its own.
        // A single video keeps today's plain bubble (no album_id at all).
        const videoAlbumId =
          files.length >= 2
            ? (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
                ? crypto.randomUUID()
                : `video-album-${batchBaseTime}-${Math.random().toString(36).slice(2, 8)}`)
            : undefined;
        const optimisticMsgs: Message[] = files.map((file, idx) => {
          const tempId = `temp-video-${batchBaseTime}-${idx}`;
          const localBlobUrl = URL.createObjectURL(file);
          registerLocalMediaBlob(tempId, localBlobUrl);
          return {
            id: tempId,
            conversation_id: conversation.id,
            sender_type: 'agent',
            sender_id: user?.id,
            content_type: 'video',
            content_text: idx === 0 ? payload.caption : undefined,
            media_url: localBlobUrl,
            status: 'sending',
            created_at: new Date(batchBaseTime + idx * 10).toISOString(),
            reply_to_message_id: payload.replyToId,
            album_id: videoAlbumId,
            album_index: videoAlbumId ? idx : undefined,
            client_ref: tempId,
            metadata: videoAlbumId ? { album_id: videoAlbumId, album_index: idx, client_ref: tempId } : { client_ref: tempId },
          };
        });

        for (const msg of optimisticMsgs) {
          const controller = new AbortController();
          batchControllersRef.current.set(msg.id, { abort: controller, albumId: videoAlbumId });
        }

        // Save to retry map
        for (let i = 0; i < optimisticMsgs.length; i++) {
          const entry = {
            file: files[i],
            replyToId: payload.replyToId,
            caption: i === 0 ? payload.caption : undefined,
            kind: 'video' as const,
            albumId: videoAlbumId,
            albumIndex: videoAlbumId ? i : undefined,
          };
          batchRetryMapRef.current.set(optimisticMsgs[i].id, entry);
          if (optimisticMsgs[i].client_ref) {
            batchRetryMapRef.current.set(optimisticMsgs[i].client_ref!, entry);
          }
        }

        // Inject optimistic messages in one atomic update (0ms perceived speed)
        if (onNewMessages) {
          onNewMessages(optimisticMsgs);
        } else {
          for (const msg of optimisticMsgs) {
            onNewMessage(msg);
          }
        }
        scrollToBottom(true);
        setReplyTo(null);

        // Instantly extract video thumbnail in background to display in optimistic bubble (0ms perceived speed)
        files.forEach((file, idx) => {
          const tempId = optimisticMsgs[idx].id;
          const blobUrl = optimisticMsgs[idx].media_url;
          const thumbPromise = extractVideoThumbnail(file, tempId)
            .then((thumb) => {
              if (!thumb) return undefined;
              registerLocalVideoThumbnail(tempId, thumb);
              if (blobUrl) registerLocalVideoThumbnail(blobUrl, thumb);
              onUpdateMessage(tempId, {
                metadata: { thumbnail_url: thumb },
              });
              // Background-persist to R2 so this thumbnail survives a
              // conversation reload — see message-bubble.tsx's poster
              // resolution, which reads this same R2 key back once the
              // message round-trips through the DB.
              return persistVideoThumbnail(thumb);
            })
            .catch(() => undefined);
          thumbnailUploadRef.current.set(tempId, thumbPromise);
        });

        // Background upload & send queue for videos
        const queue = optimisticMsgs.map((msg, idx) => ({
          msg,
          file: files[idx],
          index: idx,
        }));

        // Heavy processing (transcode + upload) runs sequentially on
        // iPhone/iPad (concurrency 1) to protect Safari iOS WebKit
        // memory from Jetsam/OOM termination and guarantee exact
        // message arrival order in WhatsApp. Desktop isn't under that
        // memory constraint, so it gets real concurrency — same value
        // already used for the image batch queue below.
        const UPLOAD_CONCURRENCY = isIOSDevice ? 1 : 3;
        let activeUploads = 0;
        let nextIdx = 0;

        const pumpUploadQueue = () => {
          while (activeUploads < UPLOAD_CONCURRENCY && nextIdx < queue.length) {
            const task = queue[nextIdx++];
            activeUploads++;

            const taskContentText = task.index === 0 ? payload.caption : undefined;

            (async () => {
              let uploadedKey: string | null = null;
              let uploadSlotReleased = false;
              const ctrlEntry = batchControllersRef.current.get(task.msg.id);
              const signal = ctrlEntry?.abort.signal;

              const releaseUploadSlot = () => {
                if (!uploadSlotReleased) {
                  uploadSlotReleased = true;
                  activeUploads--;
                  pumpUploadQueue();
                }
              };

              try {
                if (signal?.aborted) {
                  releaseUploadSlot();
                  return;
                }

                // A0. Wait (briefly, bounded) for this file's own thumbnail
                // extraction to finish before starting hash/transcode —
                // both touch the same video's decode pipeline, and letting
                // them race is exactly the kind of double resource-use a
                // 2-video batch doesn't need. Cheap in practice: thumbnail
                // extraction is a metadata-seek, typically well under a
                // second, so this rarely actually waits.
                const thumbnailKey = await withTimeout(
                  thumbnailUploadRef.current.get(task.msg.id) ?? Promise.resolve(undefined),
                  8_000,
                );

                if (signal?.aborted) {
                  releaseUploadSlot();
                  return;
                }

                // A. QuickTime transcode if .mov
                let fileToUpload = task.file;

                // .m4v is standard MPEG-4 Part 14 — directly compatible as MP4, no transcode needed
                if (/\.m4v$/i.test(fileToUpload.name)) {
                  fileToUpload = new File([fileToUpload], fileToUpload.name.replace(/\.m4v$/i, '.mp4'), {
                    type: 'video/mp4',
                  });
                }

                const needsTranscode = await shouldTranscodeVideo(fileToUpload);
                if (needsTranscode) {
                  try {
                    fileToUpload = await convertMovToMp4ViaWebCodecs(fileToUpload);
                    const mp4Blob = URL.createObjectURL(fileToUpload);
                    registerLocalMediaBlob(task.msg.id, mp4Blob);
                  } catch (transcodeErr) {
                    console.error('Failed to transcode video:', transcodeErr);
                    const reason = transcodeErr instanceof Error ? transcodeErr.message : 'Falha ao processar vídeo.';
                    toast.error(`Falha ao converter vídeo: ${reason}`);
                    onUpdateMessage(task.msg.id, { status: 'failed' });
                    releaseUploadSlot();
                    return;
                  }
                }

                if (signal?.aborted) {
                  releaseUploadSlot();
                  return;
                }

                // WhatsApp Cloud API enforces a strict 16MB limit for video attachments
                if (fileToUpload.size > 16 * 1024 * 1024) {
                  const sizeMb = (fileToUpload.size / (1024 * 1024)).toFixed(1);
                  console.error('Video exceeds WhatsApp 16MB limit:', fileToUpload.size);
                  toast.error(`O vídeo "${fileToUpload.name}" tem ${sizeMb} MB e excede o limite de 16 MB do WhatsApp.`);
                  onUpdateMessage(task.msg.id, { status: 'failed' });
                  releaseUploadSlot();
                  return;
                }

                await yieldToReleaseMemory();

                // B. Upload directly to R2 (this hashes the file first —
                // see hash-file.ts — then streams the PUT itself)
                const uploadResult = await presignAndUpload('chat-attachment', 'video', fileToUpload);
                uploadedKey = uploadResult.key;

                releaseUploadSlot();

                if (signal?.aborted) {
                  if (uploadedKey) void deleteR2Media(uploadedKey).catch(() => {});
                  return;
                }

                await yieldToReleaseMemory();

                const finalKey = uploadResult.key;
                if (uploadResult.resolvedUrl) {
                  seedMediaResolution(uploadResult.key, uploadResult.resolvedUrl);
                }

                const localBlob = getLocalMediaBlob(task.msg.id);
                if (localBlob) {
                  registerLocalMediaBlob(finalKey, localBlob);
                }

                // C. Dispatch to WhatsApp API
                const res = await fetch('/api/whatsapp/send', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    conversation_id: conversation.id,
                    message_type: 'video',
                    media_url: finalKey,
                    content_text: taskContentText,
                    filename: fileToUpload.name,
                    reply_to_message_id: payload.replyToId,
                    client_ref: task.msg.id,
                    // R2 key of the small JPEG thumbnail (undefined if
                    // extraction/upload didn't finish in time) — persisted
                    // server-side so it survives a reload. See
                    // send-message.ts and message-bubble.tsx's poster
                    // resolution.
                    thumbnail_url: thumbnailKey,
                    // Persists the album grouping server-side (same fields
                    // the image batch already sends) so a reload still
                    // renders this as part of the grid instead of falling
                    // back to a standalone bubble — see computeAlbumGroups.
                    album_id: videoAlbumId,
                    album_index: videoAlbumId ? task.index : undefined,
                  }),
                  signal,
                });

                const data = await res.json().catch(() => ({}));
                if (!res.ok) {
                  const reason = data?.error || `HTTP ${res.status}`;
                  console.error('Failed to send video:', reason);
                  toast.error(`Falha ao enviar vídeo: ${reason}`);
                  onUpdateMessage(task.msg.id, { status: 'failed' });
                  if (uploadedKey) void deleteR2Media(uploadedKey).catch(() => {});
                  return;
                }

                batchControllersRef.current.delete(task.msg.id);
                thumbnailUploadRef.current.delete(task.msg.id);

                // D. Succeeded. Prefer the persisted R2 key (survives
                // reload) over the raw local data: URL for the metadata
                // this session keeps — the local registry below still
                // covers instant same-session display either way.
                const localThumb = getLocalVideoThumbnail(task.msg.id) || getLocalVideoThumbnail(task.msg.media_url);
                if (localThumb) {
                  registerLocalVideoThumbnail(finalKey, localThumb);
                }

                onUpdateMessage(task.msg.id, {
                  status: 'sent',
                  media_url: finalKey,
                  client_ref: task.msg.id,
                  metadata: thumbnailKey
                    ? { thumbnail_url: thumbnailKey }
                    : localThumb
                      ? { thumbnail_url: localThumb }
                      : undefined,
                });

                // The original blob is never actually displayed once
                // `status` leaves "sending" (MediaVideo shows the R2-
                // resolved src, not the local preview) — a short buffer
                // for any in-flight re-render is enough, instead of the
                // 60-90s this used to hold onto full-size video blobs,
                // which is real memory pressure across a multi-video batch.
                scheduleRevokeLocalMediaBlob(task.msg.id, 10_000);
                if (finalKey) scheduleRevokeLocalMediaBlob(finalKey, 15_000);
              } catch (err: unknown) {
                releaseUploadSlot();
                if (signal?.aborted || (err as { name?: string })?.name === 'AbortError') {
                  if (uploadedKey) void deleteR2Media(uploadedKey).catch(() => {});
                  return;
                }
                console.error('Error sending video:', err);
                const errMsg = err instanceof Error ? err.message : 'Falha ao enviar vídeo.';
                toast.error(errMsg);
                onUpdateMessage(task.msg.id, { status: 'failed' });
                if (uploadedKey) void deleteR2Media(uploadedKey).catch(() => {});
              } finally {
                releaseUploadSlot();
                batchControllersRef.current.delete(task.msg.id);
                thumbnailUploadRef.current.delete(task.msg.id);
              }
            })();
          }
        };

        pumpUploadQueue();
        return;
      }

      const totalCount = hasFiles ? payload.files!.length : payload.items!.length;
      const albumId =
        payload.albumId ||
        (totalCount >= 2
          ? (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
              ? crypto.randomUUID()
              : `album-${batchBaseTime}-${Math.random().toString(36).slice(2, 8)}`)
          : undefined);

      // 2. WhatsApp Instant Album Model (when payload.files is provided for images)
      if (hasFiles) {
        const files = payload.files!;
        const { messages: optimisticMsgs } = createOptimisticAlbum({
          conversationId: conversation.id,
          files,
          caption: payload.caption,
          replyToId: payload.replyToId,
          userId: user?.id,
          albumId,
          baseTime: batchBaseTime,
        });

        for (const msg of optimisticMsgs) {
          const controller = new AbortController();
          batchControllersRef.current.set(msg.id, { abort: controller, albumId });
        }

        // Save to retry map
        for (let i = 0; i < optimisticMsgs.length; i++) {
          const entry = {
            file: files[i],
            replyToId: payload.replyToId,
            caption: i === 0 ? payload.caption : undefined,
            albumId,
            albumIndex: i,
          };
          batchRetryMapRef.current.set(optimisticMsgs[i].id, entry);
          if (optimisticMsgs[i].client_ref) {
            batchRetryMapRef.current.set(optimisticMsgs[i].client_ref!, entry);
          }
        }

        // Inject optimistic messages in one atomic update (0ms perceived speed)
        if (onNewMessages) {
          onNewMessages(optimisticMsgs);
        } else {
          for (const msg of optimisticMsgs) {
            onNewMessage(msg);
          }
        }
        setReplyTo(null);
        scrollToBottom(true);

        // Background upload & send queue with concurrency = 3 for R2 network upload
        // Crucial decoupling: The upload concurrency slot is released IMMEDIATELY once
        // presignAndUpload finishes. Normalization polling (for HEIC) and WhatsApp send
        // run completely independently per image in the background without holding up the upload queue!
        const queue = optimisticMsgs.map((msg, idx) => ({
          msg,
          file: files[idx],
          index: idx,
        }));

        const UPLOAD_CONCURRENCY = 3;
        let activeUploads = 0;
        let nextIdx = 0;

        const pumpUploadQueue = () => {
          while (activeUploads < UPLOAD_CONCURRENCY && nextIdx < queue.length) {
            const task = queue[nextIdx++];
            activeUploads++;

            const taskContentText =
              task.index === 0 ? payload.caption : undefined;

            (async () => {
              let uploadedKey: string | null = null;
              let uploadSlotReleased = false;
              const ctrlEntry = batchControllersRef.current.get(task.msg.id);
              const signal = ctrlEntry?.abort.signal;

              const releaseUploadSlot = () => {
                if (!uploadSlotReleased) {
                  uploadSlotReleased = true;
                  activeUploads--;
                  pumpUploadQueue();
                }
              };

              try {
                if (signal?.aborted) {
                  releaseUploadSlot();
                  return;
                }

                // A. Client-side auto-orient if not HEIC
                let fileToUpload = task.file;
                if (!isHeicFile(fileToUpload)) {
                  try {
                    const norm = await normalizeImageForUpload(fileToUpload);
                    fileToUpload = norm.file;
                  } catch {
                    // proceed with original
                  }
                }

                if (signal?.aborted) {
                  releaseUploadSlot();
                  return;
                }

                // B. Upload directly to R2
                const uploadResult = await presignAndUpload('chat-attachment', 'image', fileToUpload);
                uploadedKey = uploadResult.key;

                // IMMEDIATELY RELEASE the upload slot so the next file in queue can start uploading to R2 right away!
                // Fast images will NEVER wait for slow HEIC normalization or WhatsApp send!
                releaseUploadSlot();

                if (signal?.aborted) {
                  if (uploadedKey) void deleteR2Media(uploadedKey).catch(() => {});
                  return;
                }

                let finalKey = uploadResult.key;
                if (uploadResult.requiresProcessing) {
                  // Poll server for normalized JPEG key in background without holding upload slot
                  const { normalizedKey, resolvedUrl } = await pollNormalizationStatus(uploadResult.key);
                  finalKey = normalizedKey;
                  if (resolvedUrl) seedMediaResolution(normalizedKey, resolvedUrl);
                } else if (uploadResult.resolvedUrl) {
                  seedMediaResolution(uploadResult.key, uploadResult.resolvedUrl);
                }

                if (signal?.aborted) {
                  if (uploadedKey) void deleteR2Media(uploadedKey).catch(() => {});
                  return;
                }

                // Pre-register local blob for the final key so the transition is 100% seamless (0ms flash)
                const localBlob = getLocalMediaBlob(task.msg.id);
                if (localBlob) {
                  registerLocalMediaBlob(finalKey, localBlob);
                  if (uploadedKey && uploadedKey !== finalKey) {
                    registerLocalMediaBlob(uploadedKey, localBlob);
                  }
                }

                // C. Dispatch to WhatsApp
                const res = await fetch('/api/whatsapp/send', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    conversation_id: conversation.id,
                    message_type: 'image',
                    media_url: finalKey,
                    content_text: taskContentText,
                    filename: task.file.name,
                    reply_to_message_id: payload.replyToId,
                    client_ref: task.msg.id,
                    album_id: albumId,
                    album_index: task.index,
                  }),
                  signal,
                });

                const data = await res.json().catch(() => ({}));
                if (!res.ok) {
                  const reason = data?.error || `HTTP ${res.status}`;
                  console.error('Failed to send media batch item:', reason);
                  toast.error(`Falha ao enviar foto ${task.index + 1}: ${reason}`);
                  onUpdateMessage(task.msg.id, { status: 'failed' });
                  if (uploadedKey) void deleteR2Media(uploadedKey).catch(() => {});
                  return;
                }

                batchControllersRef.current.delete(task.msg.id);

                // D. Succeeded! Smoothly update message status and remote key
                onUpdateMessage(task.msg.id, {
                  status: 'sent',
                  media_url: finalKey,
                  client_ref: task.msg.id,
                  album_id: albumId,
                  album_index: task.index,
                  metadata: { album_id: albumId, album_index: task.index },
                });
              } catch (err: unknown) {
                releaseUploadSlot();
                if (signal?.aborted || (err as { name?: string })?.name === 'AbortError') {
                  if (uploadedKey) void deleteR2Media(uploadedKey).catch(() => {});
                  return;
                }
                console.error('Network error sending media batch item:', err);
                toast.error(`Falha de rede ao enviar foto ${task.index + 1}`);
                onUpdateMessage(task.msg.id, { status: 'failed' });
                if (uploadedKey) void deleteR2Media(uploadedKey).catch(() => {});
              } finally {
                releaseUploadSlot();
                batchControllersRef.current.delete(task.msg.id);
              }
            })();
          }
        };

        pumpUploadQueue();
        return;
      }

      // 2. Legacy items path (backward-compatibility for existing tests)
      const items = payload.items!;
      const optimisticMsgs: Message[] = items.map((item, idx) => {
        const tempId = `temp-${batchBaseTime}-${idx}`;
        if (item.localPreviewUrl?.startsWith('blob:')) {
          registerLocalMediaBlob(item.path, item.localPreviewUrl);
        }
        return {
          id: tempId,
          conversation_id: conversation.id,
          sender_type: 'agent',
          sender_id: user?.id,
          content_type: 'image',
          content_text: idx === 0 ? (payload.caption || item.caption) : item.caption,
          media_url: item.path,
          status: 'sending',
          created_at: new Date(batchBaseTime + idx * 10).toISOString(),
          reply_to_message_id: payload.replyToId,
          album_id: albumId,
          metadata: { album_id: albumId, album_index: idx },
        };
      });

      for (let i = 0; i < optimisticMsgs.length; i++) {
        batchRetryMapRef.current.set(optimisticMsgs[i].id, {
          item: items[i],
          replyToId: payload.replyToId,
          caption: i === 0 ? (payload.caption || items[i].caption) : items[i].caption,
          albumId,
        });
      }

      if (onNewMessages) {
        onNewMessages(optimisticMsgs);
      } else {
        for (const msg of optimisticMsgs) {
          onNewMessage(msg);
        }
      }
      setReplyTo(null);
      scrollToBottom(true);

      const queue = optimisticMsgs.map((msg, idx) => ({
        msg,
        item: items[idx],
        index: idx,
      }));

      let active = 0;
      let nextIdx = 0;

      const sendNext = () => {
        while (active < 3 && nextIdx < queue.length) {
          const task = queue[nextIdx++];
          active++;

          const taskContentText =
            task.index === 0
              ? payload.caption || task.item.caption
              : task.item.caption;

          fetch('/api/whatsapp/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              conversation_id: conversation.id,
              message_type: 'image',
              media_url: task.item.mediaUrl,
              content_text: taskContentText,
              filename: task.item.filename,
              reply_to_message_id: payload.replyToId,
              album_id: albumId,
            }),
          })
            .then(async (res) => {
              const data = await res.json().catch(() => ({}));
              if (!res.ok) {
                const reason = data?.error || `HTTP ${res.status}`;
                console.error('Failed to send media batch item:', reason);
                toast.error(`Falha ao enviar foto ${task.index + 1}: ${reason}`);
                onUpdateMessage(task.msg.id, { status: 'failed' });
                void deleteR2Media(task.item.path).catch(() => {});
                return;
              }
              onUpdateMessage(task.msg.id, {
                status: 'sent',
                media_url: task.item.mediaUrl,
                album_id: albumId,
                metadata: { album_id: albumId, album_index: task.index },
              });
            })
            .catch((err) => {
              console.error('Network error sending media batch item:', err);
              toast.error(`Falha de rede ao enviar foto ${task.index + 1}`);
              onUpdateMessage(task.msg.id, { status: 'failed' });
              void deleteR2Media(task.item.path).catch(() => {});
            })
            .finally(() => {
              active--;
              sendNext();
            });
        }
      };

      sendNext();
    },
    [conversation, onNewMessages, onNewMessage, onUpdateMessage, user?.id, scrollToBottom]
  );

  const handleCancelMediaMessage = useCallback(
    (message: Message) => {
      const entry = batchControllersRef.current.get(message.id);
      if (entry) {
        entry.abort.abort();
        batchControllersRef.current.delete(message.id);
      }
      onUpdateMessage(message.id, {
        status: 'failed',
        metadata: {
          ...(typeof message.metadata === 'object' && message.metadata !== null ? message.metadata : {}),
          cancelled: true,
        },
      });
      toast.info('Envio da foto cancelado.');
    },
    [onUpdateMessage]
  );

  const handleCancelMediaAlbum = useCallback(
    (albumId: string) => {
      let count = 0;
      const cancelledIds = new Set<string>();

      for (const [msgId, entry] of Array.from(batchControllersRef.current.entries())) {
        if (entry.albumId === albumId) {
          entry.abort.abort();
          batchControllersRef.current.delete(msgId);
          cancelledIds.add(msgId);
          onUpdateMessage(msgId, {
            status: 'failed',
            metadata: { cancelled: true },
          });
          count++;
        }
      }

      for (const m of messages) {
        if (cancelledIds.has(m.id)) continue;
        const msgAlbumId =
          m.album_id ||
          (typeof m.metadata === 'object' && m.metadata !== null
            ? (m.metadata as { album_id?: string }).album_id
            : undefined);
        if (msgAlbumId === albumId && m.status === 'sending') {
          cancelledIds.add(m.id);
          onUpdateMessage(m.id, {
            status: 'failed',
            metadata: {
              ...(typeof m.metadata === 'object' && m.metadata !== null ? m.metadata : {}),
              cancelled: true,
            },
          });
          count++;
        }
      }

      if (count > 0) {
        toast.info('Envio do lote cancelado.');
      }
    },
    [messages, onUpdateMessage]
  );

  const handleRetryMediaMessage = useCallback(
    async (message: Message) => {
      if (!conversation) return;
      const retryData =
        batchRetryMapRef.current.get(message.id) ||
        (message.client_ref ? batchRetryMapRef.current.get(message.client_ref) : undefined);

      if (!retryData && !message.media_url) {
        toast.error('Não foi possível reenviar: foto indisponível.');
        return;
      }

      const albumId = retryData?.albumId || message.album_id || undefined;
      const albumIndex =
        retryData?.albumIndex ??
        message.album_index ??
        (typeof message.metadata === 'object' && message.metadata !== null
          ? (message.metadata as { album_index?: number }).album_index
          : undefined);
      const clientRef = message.client_ref || message.id;

      const controller = new AbortController();
      batchControllersRef.current.set(message.id, { abort: controller, albumId });

      onUpdateMessage(message.id, {
        status: 'sending',
        metadata: {
          ...(typeof message.metadata === 'object' && message.metadata !== null ? message.metadata : {}),
          cancelled: false,
        },
      });

      // If retrying a video
      if (retryData?.kind === 'video' || (!retryData?.kind && message.content_type === 'video')) {
        let uploadedKey: string | null = null;
        try {
          if (controller.signal.aborted) return;
          let fileToUpload = retryData?.file;
          if (!fileToUpload && message.media_url?.startsWith('blob:')) {
            try {
              const bRes = await fetch(message.media_url);
              const blob = await bRes.blob();
              fileToUpload = new File([blob], 'video.mp4', { type: blob.type || 'video/mp4' });
            } catch {}
          }
          if (fileToUpload) {
            if (/\.m4v$/i.test(fileToUpload.name)) {
              fileToUpload = new File([fileToUpload], fileToUpload.name.replace(/\.m4v$/i, '.mp4'), {
                type: 'video/mp4',
              });
            }
            const needsTranscode = await shouldTranscodeVideo(fileToUpload);
            if (needsTranscode) {
              try {
                fileToUpload = await convertMovToMp4ViaWebCodecs(fileToUpload);
                const mp4Blob = URL.createObjectURL(fileToUpload);
                registerLocalMediaBlob(message.id, mp4Blob);
              } catch (transcodeErr) {
                console.error('Failed to transcode video on retry:', transcodeErr);
                const reason = transcodeErr instanceof Error ? transcodeErr.message : 'Falha ao processar vídeo.';
                toast.error(`Falha ao converter vídeo: ${reason}`);
                onUpdateMessage(message.id, { status: 'failed' });
                return;
              }
            }
            if (controller.signal.aborted) return;
            // WhatsApp Cloud API enforces a strict 16MB limit for video attachments
            if (fileToUpload.size > 16 * 1024 * 1024) {
              console.error('Video exceeds WhatsApp 16MB limit:', fileToUpload.size);
              toast.error('O vídeo excede o limite de 16 MB permitido pelo WhatsApp.');
              onUpdateMessage(message.id, { status: 'failed' });
              return;
            }
            const uploadResult = await presignAndUpload('chat-attachment', 'video', fileToUpload);
            uploadedKey = uploadResult.key;
            if (uploadResult.resolvedUrl) {
              seedMediaResolution(uploadResult.key, uploadResult.resolvedUrl);
            }
            const localBlob = getLocalMediaBlob(message.id);
            if (localBlob) {
              registerLocalMediaBlob(uploadedKey, localBlob);
            }
            const res = await fetch('/api/whatsapp/send', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                conversation_id: conversation.id,
                message_type: 'video',
                media_url: uploadedKey,
                content_text: retryData?.caption || message.content_text,
                filename: fileToUpload.name,
                reply_to_message_id: retryData?.replyToId || message.reply_to_message_id,
                client_ref: clientRef,
                album_id: albumId,
                album_index: albumIndex,
              }),
              signal: controller.signal,
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
              const reason = data?.error || `HTTP ${res.status}`;
              toast.error(`Falha ao reenviar: ${reason}`);
              onUpdateMessage(message.id, { status: 'failed' });
              if (uploadedKey) void deleteR2Media(uploadedKey).catch(() => {});
              return;
            }
            const localThumb = getLocalVideoThumbnail(message.id) || getLocalVideoThumbnail(message.media_url);
            if (localThumb && uploadedKey) {
              registerLocalVideoThumbnail(uploadedKey, localThumb);
            }
            batchControllersRef.current.delete(message.id);
            onUpdateMessage(message.id, {
              status: 'sent',
              media_url: uploadedKey,
              client_ref: clientRef,
              metadata: localThumb ? { thumbnail_url: localThumb } : undefined,
            });
            scheduleRevokeLocalMediaBlob(message.id, 60_000);
            if (uploadedKey) scheduleRevokeLocalMediaBlob(uploadedKey, 90_000);
            return;
          } else if (message.media_url) {
            const res = await fetch('/api/whatsapp/send', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                conversation_id: conversation.id,
                message_type: 'video',
                media_url: message.media_url,
                content_text: retryData?.caption || message.content_text,
                filename: 'video.mp4',
                reply_to_message_id: retryData?.replyToId || message.reply_to_message_id,
                client_ref: clientRef,
              }),
              signal: controller.signal,
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
              const reason = data?.error || `HTTP ${res.status}`;
              toast.error(`Falha ao reenviar: ${reason}`);
              onUpdateMessage(message.id, { status: 'failed' });
              return;
            }
            batchControllersRef.current.delete(message.id);
            onUpdateMessage(message.id, {
              status: 'sent',
              client_ref: clientRef,
            });
            return;
          }
        } catch (err: unknown) {
          if (controller.signal.aborted || (err as { name?: string })?.name === 'AbortError') {
            if (uploadedKey) void deleteR2Media(uploadedKey).catch(() => {});
            return;
          }
          toast.error('Erro de conexão ao reenviar vídeo.');
          onUpdateMessage(message.id, { status: 'failed' });
          if (uploadedKey) void deleteR2Media(uploadedKey).catch(() => {});
        } finally {
          batchControllersRef.current.delete(message.id);
        }
        return;
      }

      let fileToUpload = retryData?.file;
      if (!fileToUpload && message.media_url?.startsWith('blob:')) {
        try {
          const bRes = await fetch(message.media_url);
          const blob = await bRes.blob();
          fileToUpload = new File([blob], 'image.jpg', { type: blob.type || 'image/jpeg' });
        } catch {}
      }

      // If retryData has raw file or recovered blob, run the upload and send pipeline
      if (fileToUpload) {
        let uploadedKey: string | null = null;
        try {
          if (controller.signal.aborted) return;
          if (!isHeicFile(fileToUpload)) {
            try {
              const norm = await normalizeImageForUpload(fileToUpload);
              fileToUpload = norm.file;
            } catch {}
          }

          if (controller.signal.aborted) return;
          const uploadResult = await presignAndUpload('chat-attachment', 'image', fileToUpload);
          uploadedKey = uploadResult.key;

          let finalKey = uploadResult.key;
          if (uploadResult.requiresProcessing) {
            const { normalizedKey, resolvedUrl } = await pollNormalizationStatus(uploadResult.key);
            finalKey = normalizedKey;
            if (resolvedUrl) seedMediaResolution(normalizedKey, resolvedUrl);
          } else if (uploadResult.resolvedUrl) {
            seedMediaResolution(uploadResult.key, uploadResult.resolvedUrl);
          }

          if (controller.signal.aborted) {
            if (uploadedKey) void deleteR2Media(uploadedKey).catch(() => {});
            return;
          }

          const localBlob = getLocalMediaBlob(message.id);
          if (localBlob) {
            registerLocalMediaBlob(finalKey, localBlob);
            if (uploadedKey && uploadedKey !== finalKey) {
              registerLocalMediaBlob(uploadedKey, localBlob);
            }
          }

          const res = await fetch('/api/whatsapp/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              conversation_id: conversation.id,
              message_type: 'image',
              media_url: finalKey,
              content_text: retryData?.caption || message.content_text,
              filename: fileToUpload.name,
              reply_to_message_id: retryData?.replyToId || message.reply_to_message_id,
              client_ref: clientRef,
              album_id: albumId,
              album_index: albumIndex,
            }),
            signal: controller.signal,
          });

          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            const reason = data?.error || `HTTP ${res.status}`;
            toast.error(`Falha ao reenviar: ${reason}`);
            onUpdateMessage(message.id, { status: 'failed' });
            if (uploadedKey) void deleteR2Media(uploadedKey).catch(() => {});
            return;
          }

          batchControllersRef.current.delete(message.id);
          onUpdateMessage(message.id, {
            status: 'sent',
            media_url: finalKey,
            client_ref: clientRef,
            album_id: albumId,
            album_index: albumIndex,
            metadata: {
              ...(typeof message.metadata === 'object' && message.metadata !== null ? message.metadata : {}),
              album_id: albumId,
              album_index: albumIndex,
              cancelled: false,
            },
          });
        } catch (err: unknown) {
          if (controller.signal.aborted || (err as { name?: string })?.name === 'AbortError') {
            if (uploadedKey) void deleteR2Media(uploadedKey).catch(() => {});
            return;
          }
          toast.error('Erro de conexão ao reenviar foto.');
          onUpdateMessage(message.id, { status: 'failed' });
          if (uploadedKey) void deleteR2Media(uploadedKey).catch(() => {});
        } finally {
          batchControllersRef.current.delete(message.id);
        }
        return;
      }

      // Legacy item retry fallback or already-uploaded media_url fallback
      const fallbackUrl = retryData?.item?.mediaUrl || message.media_url;
      if (fallbackUrl) {
        try {
          const res = await fetch('/api/whatsapp/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              conversation_id: conversation.id,
              message_type: 'image',
              media_url: fallbackUrl,
              content_text: retryData?.caption,
              filename: retryData?.item?.filename || 'image.jpg',
              reply_to_message_id: retryData?.replyToId,
              client_ref: clientRef,
              album_id: albumId,
              album_index: albumIndex,
            }),
            signal: controller.signal,
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            const reason = data?.error || `HTTP ${res.status}`;
            toast.error(`Falha ao reenviar: ${reason}`);
            onUpdateMessage(message.id, { status: 'failed' });
            return;
          }
          batchControllersRef.current.delete(message.id);
          onUpdateMessage(message.id, {
            status: 'sent',
            media_url: fallbackUrl,
            client_ref: clientRef,
            album_id: albumId,
            album_index: albumIndex,
            metadata: {
              ...(typeof message.metadata === 'object' && message.metadata !== null ? message.metadata : {}),
              album_id: albumId,
              album_index: albumIndex,
              cancelled: false,
            },
          });
        } catch {
          toast.error('Erro de conexão ao reenviar foto.');
          onUpdateMessage(message.id, { status: 'failed' });
        } finally {
          batchControllersRef.current.delete(message.id);
        }
      }
    },
    [conversation, onUpdateMessage]
  );

  // A voice note the composer just committed to sending (message-
  // composer.tsx's onRecordAudio) — `recordId` points at the durable
  // pending-audio-db.ts record already holding the recorded bytes. Shows
  // an optimistic bubble immediately (using a local blob: preview of the
  // recording, swapped for the real URL once uploaded) and hands the
  // actual upload+send off to pending-audio-sync.ts, which is
  // timeout-bounded and retried at every network step — see that
  // module's doc comment for why this can never hang the way the old
  // inline upload in message-composer.tsx could.
  const handleQueuedAudio = useCallback(
    async (recordId: string, replyToId?: string) => {
      if (!conversation) return;
      const record = await getPendingAudio(recordId);
      if (!record) return;

      const tempId = `${LOCAL_AUDIO_PREFIX}${recordId}`;
      let previewUrl = '';
      try {
        previewUrl = URL.createObjectURL(record.blob);
      } catch {
        // No local preview available — the bubble just shows nothing
        // playable until the real mediaUrl lands; upload/send still proceed.
      }
      const optimisticMsg: Message = {
        id: tempId,
        conversation_id: conversation.id,
        sender_type: 'agent',
        sender_id: user?.id,
        content_type: 'audio',
        media_url: previewUrl || undefined,
        status: 'sending',
        created_at: new Date(record.createdAt).toISOString(),
        reply_to_message_id: replyToId,
      };
      onNewMessage(optimisticMsg);
      scrollToBottom(true);

      const result = await runPendingAudio(recordId, {
        onMediaUrl: (url) => onUpdateMessage(tempId, { media_url: url }),
      });
      onUpdateMessage(tempId, { status: result.ok ? 'sent' : 'failed' });
      if (!result.ok) {
        console.error('Failed to send voice note:', result.error);
        toast.error(`Failed to send: ${result.error}`);
      }
    },
    [conversation, onNewMessage, onUpdateMessage, user?.id, scrollToBottom]
  );

  // Retries a voice note bubble already showing `status: 'failed'` — the
  // recording is still sitting in pending-audio-db.ts (never deleted
  // until the server actually confirms receipt), so this just re-runs
  // the same upload/send pipeline against it, no re-recording needed.
  const handleRetryAudio = useCallback(
    async (message: Message) => {
      if (!message.id.startsWith(LOCAL_AUDIO_PREFIX)) return;
      const recordId = message.id.slice(LOCAL_AUDIO_PREFIX.length);
      onUpdateMessage(message.id, { status: 'sending' });
      const result = await runPendingAudio(recordId, {
        onMediaUrl: (url) => onUpdateMessage(message.id, { media_url: url }),
      });
      onUpdateMessage(message.id, { status: result.ok ? 'sent' : 'failed' });
      if (!result.ok) {
        console.error('Failed to resend voice note:', result.error);
        toast.error(`Failed to send: ${result.error}`);
      }
    },
    [onUpdateMessage]
  );

  // WhatsApp-style delete: only ever called on agent-sent messages (the
  // Trash icon in MessageActions is gated on that already). Waits for
  // the DB delete before touching local state — simpler and safer than
  // optimistic-removal-with-rollback, and still feels instant since
  // this is a single-row delete. Throws on failure so the confirm
  // dialog's catch block can surface the toast.
  const handleDeleteMessage = useCallback(
    async (msg: Message) => {
      // A failed voice note never made it into the `messages` table — it
      // only exists as this optimistic bubble backed by a
      // pending-audio-db.ts record — so there's no DB row to delete here,
      // just the local record (and its Storage object, if the upload had
      // already succeeded before the send itself failed).
      if (msg.id.startsWith(LOCAL_AUDIO_PREFIX)) {
        await discardPendingAudio(msg.id.slice(LOCAL_AUDIO_PREFIX.length));
        onDeleteMessage(msg.id);
        return;
      }

      const supabase = createClient();
      const { error } = await supabase
        .from('messages')
        .delete()
        .eq('id', msg.id);
      if (error) {
        console.error('Failed to delete message:', error);
        throw error;
      }

      onDeleteMessage(msg.id);

      // Best-effort storage cleanup for agent-sent media (image, video,
      // document, voice note) — the row is gone either way; this just
      // stops the object from orphaning in storage. Two possible shapes
      // for `msg.media_url`: a legacy Supabase chat-media URL (older
      // messages, pre-R2), or a bare R2 key (new messages) — never both
      // checks matching at once, so order doesn't matter.
      const path = extractStoragePath(msg.media_url, CHAT_MEDIA_BUCKET);
      if (path) {
        void deleteAccountMedia(CHAT_MEDIA_BUCKET, path).catch(() => {});
      } else if (isR2MediaKey(msg.media_url)) {
        void deleteR2Media(msg.media_url).catch(() => {});
      }
    },
    [onDeleteMessage]
  );

  // Powers the "Transcrever" message action (message-actions.tsx). Most
  // customer voice notes are already transcribed by the time an agent
  // clicks this — the webhook transcribes every inbound one in the
  // background — so this call usually just reads back the cached text;
  // see /api/ai/transcribe's own doc comment for the (rarer) fallback
  // case where it actually runs the provider call here instead.
  const handleTranscribe = useCallback(
    async (msg: Message) => {
      const res = await fetch('/api/ai/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message_id: msg.id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'Failed to transcribe');
      onUpdateMessage(msg.id, { transcript_text: data.transcript as string });
      // The text itself may already have existed (background job) — it's
      // this explicit reveal, not the fetch, that's allowed to show it in
      // the bubble. Local-only and never cleared, so it survives realtime
      // updates to this message and persists for the rest of the session.
      setRevealedTranscriptIds((prev) => {
        if (prev.has(msg.id)) return prev;
        const next = new Set(prev);
        next.add(msg.id);
        return next;
      });
    },
    [onUpdateMessage]
  );

  const handleStatusChange = useCallback(
    async (status: ConversationStatus) => {
      if (!conversation) return;

      const supabase = createClient();
      await supabase
        .from('conversations')
        .update({ status })
        .eq('id', conversation.id);

      onStatusChange(conversation.id, status);
    },
    [conversation, onStatusChange]
  );

  // "Pendente" is a toggle, not a one-way status: clicking it again
  // clears the flag back to "open" (the default/no-marker state).
  // "Aberta" was removed as a manual option — opening the conversation
  // already means it's been read, so there's nothing left to "set".
  const handleTogglePending = useCallback(async () => {
    if (!conversation) return;
    const nextStatus: ConversationStatus =
      conversation.status === 'pending' ? 'open' : 'pending';
    await handleStatusChange(nextStatus);
  }, [conversation, handleStatusChange]);

  // Manual unread marker — independent of `status`. Sets unread_count
  // back to 1 so the badge in the conversation list reappears; the next
  // time this conversation is opened, the reset effect above (hasUnread)
  // clears it again automatically, same as any other unread message.
  const handleMarkUnread = useCallback(async () => {
    if (!conversation) return;
    const supabase = createClient();
    await markConversationUnread(supabase, conversation.id);
    onMarkUnread(conversation.id);
  }, [conversation, onMarkUnread]);

  const handleOpenTemplates = useCallback(() => {
    setTemplateModalOpen(true);
  }, []);

  const handleSendTemplate = useCallback(
    async (
      template: MessageTemplate,
      values: {
        body: string[];
        headerText?: string;
        buttonParams?: Record<number, string>;
      }
    ) => {
      if (!conversation) return;

      const renderedBody = renderTemplateBody(template.body_text, values.body);
      const tempId = `temp-${Date.now()}`;

      const optimisticMsg: Message = {
        id: tempId,
        conversation_id: conversation.id,
        sender_type: 'agent',
        sender_id: user?.id,
        content_type: 'template',
        content_text: renderedBody,
        template_name: template.name,
        status: 'sending',
        created_at: new Date().toISOString(),
      };
      onNewMessage(optimisticMsg);
      scrollToBottom(true);

      const followupSuggestionId = followupPrimeRef.current?.suggestionId;
      setFollowupPrime(null);
      setFollowupTemplateSelection(null);

      try {
        const res = await fetch('/api/whatsapp/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            conversation_id: conversation.id,
            message_type: 'template',
            template_name: template.name,
            template_language: template.language,
            // Structured params drive the new send-builder path
            // (header media + URL button substitution). Body values
            // are mirrored under both shapes so the route can fall
            // back if the template row isn't found locally.
            template_message_params: {
              body: values.body,
              headerText: values.headerText,
              buttonParams: values.buttonParams,
            },
            template_params: values.body,
            content_text: renderedBody,
            ...(followupSuggestionId
              ? { followup_suggestion_id: followupSuggestionId }
              : {}),
          }),
        });

        const payload = await res.json().catch(() => ({}));

        if (!res.ok) {
          const reason = payload?.error || `HTTP ${res.status}`;
          console.error('Failed to send template:', reason);
          toast.error(`Failed to send template: ${reason}`);
          onUpdateMessage(tempId, { status: 'failed' });
          return;
        }

        onUpdateMessage(tempId, { status: 'sent' });
      } catch (err) {
        console.error('Failed to send template:', err);
        const reason = err instanceof Error ? err.message : 'network error';
        toast.error(`Failed to send template: ${reason}`);
        onUpdateMessage(tempId, { status: 'failed' });
      }
    },
    [conversation, onNewMessage, onUpdateMessage, user?.id, scrollToBottom]
  );

  // Build a quick id → Message map so reply quotes can be rendered without
  // an extra fetch — the thread already holds the full conversation.
  const messagesById = useMemo(() => {
    const map = new Map<string, Message>();
    for (const m of messages) map.set(m.id, m);
    return map;
  }, [messages]);

  // Bucket reactions by their target message_id for O(1) per-bubble lookup.
  const reactionsByMessageId = useMemo(() => {
    const map = new Map<string, MessageReaction[]>();
    for (const r of reactions) {
      const bucket = map.get(r.message_id);
      if (bucket) bucket.push(r);
      else map.set(r.message_id, [r]);
    }
    return map;
  }, [reactions]);

  // Visual-only grouping of consecutive same-sender images into an
  // album — see computeAlbumGroups' own doc for the exact rules. Purely
  // a rendering concern: each message stays its own row/messageId/status
  // in the DB and over the wire.
  const albumGroups = useMemo(
    () => computeAlbumGroups(visibleMessages),
    [visibleMessages]
  );

  // Imperative "flash" highlight for reply-quote navigation — a plain
  // classList toggle, never React state, so jumping to a message never
  // re-renders the (memoized, per-row) message list. The animation itself
  // is CSS-driven (globals.css `.message-highlight-flash`) and removes
  // its own class on `animationend`; `classList.remove` + a synchronous
  // reflow read first lets two clicks in a row restart the flash instead
  // of no-oping because the class was already present.
  const flashHighlight = useCallback((el: HTMLElement) => {
    el.classList.remove('message-highlight-flash');
    void el.offsetWidth;
    el.classList.add('message-highlight-flash');
    const clear = () => el.classList.remove('message-highlight-flash');
    el.addEventListener('animationend', clear, { once: true });
  }, []);

  // Same easing-driven scrollTop animation style as scrollToBottom above
  // (direct `scrollTop` writes, no `scrollIntoView`/native smooth-scroll —
  // see that function's own comment on why: Safari iOS ancestor shifts).
  // Deliberately does NOT go through markProgrammaticScroll/
  // isProgrammaticScrollRef — that pair exists to keep "pinned to bottom"
  // state sticky across a bottom-anchored scroll, which is the opposite of
  // what a mid-thread jump wants: the scroll listener's own
  // distanceFromBottom recalculation (message-thread.tsx's onScroll effect)
  // is exactly what should decide isPinnedToBottomRef once we land.
  const animateScrollTop = useCallback((container: HTMLDivElement, targetTop: number) => {
    const startTop = container.scrollTop;
    const delta = targetTop - startTop;
    if (Math.abs(delta) < 1) return;
    const duration = 350;
    const startTime = performance.now();
    const step = (now: number) => {
      const elapsed = now - startTime;
      const progress = Math.min(1, elapsed / duration);
      const eased = 1 - Math.pow(1 - progress, 3); // ease-out-cubic
      container.scrollTop = startTop + delta * eased;
      if (progress < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }, []);

  // Reply-quote "jump to original message". Every message is always
  // mounted (no virtualization — see `visibleMessages` above), so a plain
  // DOM lookup by `data-message-id` always succeeds *except* for an album
  // item beyond the 4 visible tiles (message-album.tsx's `visibleCount`),
  // which has no clickable node of its own — that case lands on the
  // album's container (`data-album-anchor-id`) and asks the album itself
  // (via a DOM CustomEvent, since it owns its own lightbox/video-dialog
  // state) to open the exact photo/video instead of flashing a tile that
  // isn't rendered.
  const scrollToMessage = useCallback(
    (messageId: string) => {
      const container = scrollRef.current;
      if (!container) return;

      const escaped = messageId.replace(/"/g, '\\"');
      let target = container.querySelector<HTMLElement>(`[data-message-id="${escaped}"]`);
      let albumOverflowIndex: number | null = null;

      if (!target) {
        const group = albumGroups.get(messageId);
        if (group) {
          const index = group.messages.findIndex((m) => m.id === messageId);
          if (index !== -1) {
            const anchorId = group.messages[0].id.replace(/"/g, '\\"');
            target = container.querySelector<HTMLElement>(`[data-album-anchor-id="${anchorId}"]`);
            albumOverflowIndex = index;
          }
        }
      }

      if (!target) {
        console.warn('[reply-quote] original message not found in thread:', messageId);
        return;
      }

      isPinnedToBottomRef.current = false;
      const containerRect = container.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const currentOffset = targetRect.top - containerRect.top;
      const targetScrollTop =
        container.scrollTop + currentOffset - container.clientHeight / 2 + targetRect.height / 2;
      animateScrollTop(container, Math.max(0, targetScrollTop));

      if (albumOverflowIndex !== null) {
        window.dispatchEvent(
          new CustomEvent('wacrm:jump-to-album-item', { detail: { messageId } })
        );
      }

      flashHighlight(target);
    },
    [albumGroups, animateScrollTop, flashHighlight]
  );

  // Pre-computed reply-quote info per message, keyed by message id — moved
  // out of the render loop below so a message's `reply` prop keeps the
  // same object reference across renders where `messages`/`contact`
  // haven't changed, letting MessageRow's memo() actually skip it (REACT-1).
  // Same authorLabel/preview logic as before, just computed once here
  // instead of inline per message on every render.
  const replyPreviewByMessageId = useMemo(() => {
    const map = new Map<
      string,
      { authorLabel: string; preview: string; media: ReplyQuoteMedia | null; onClick: () => void }
    >();
    for (const m of messages) {
      if (!m.reply_to_message_id) continue;
      const parent = messagesById.get(m.reply_to_message_id);
      if (!parent) continue;
      const parentId = parent.id;
      map.set(m.id, {
        authorLabel:
          parent.sender_type === 'agent' || parent.sender_type === 'bot'
            ? t('me')
            : contact?.name || contact?.phone || 'Unknown',
        preview: buildReplyPreview(parent, tQuote),
        media: buildReplyMedia(parent),
        onClick: () => scrollToMessage(parentId),
      });
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, messagesById, contact, tQuote, scrollToMessage]);

  const contactDisplayName = contact?.name || contact?.phone || 'Customer';

  // Author label for a quoted message: "You" when we sent the parent,
  // contact name when the customer sent it.
  const authorLabelFor = useCallback(
    (m: Message): string => {
      const isAgentMsg = m.sender_type === 'agent' || m.sender_type === 'bot';
      return isAgentMsg ? 'You' : contactDisplayName;
    },
    [contactDisplayName]
  );

  const handleStartReply = useCallback(
    (msg: Message) => {
      setReplyTo({
        id: msg.id,
        authorLabel: authorLabelFor(msg),
        preview: buildReplyPreview(msg, tQuote),
        media: buildReplyMedia(msg),
      });
    },
    [authorLabelFor, tQuote]
  );

  // Single reaction-set primitive. emoji === "" removes; otherwise adds/swaps.
  // The "toggle" semantic (pill click) is computed at the call site where the
  // current reactions for the bubble are already in scope — keeps this
  // function dependency-free w.r.t. the reaction list.
  const postReaction = useCallback(
    async (messageId: string, emoji: string) => {
      if (!user?.id || !conversation) {
        console.warn('[reactions] missing user or conversation');
        return;
      }
      if (messageId.startsWith('temp-')) {
        toast.error('Wait for the message to finish sending');
        return;
      }

      const convId = conversation.id;
      const userId = user.id;
      let snapshot: MessageReaction[] = [];

      // Functional updater — captures the freshest reactions list, never a
      // stale closure. Snapshot stored for rollback on POST failure.
      setReactions((prev) => {
        snapshot = prev;
        const own = prev.find(
          (r) =>
            r.message_id === messageId &&
            r.actor_type === 'agent' &&
            r.actor_id === userId
        );
        if (emoji === '') return own ? prev.filter((r) => r !== own) : prev;
        if (own) return prev.map((r) => (r === own ? { ...own, emoji } : r));
        return [
          ...prev,
          {
            id: `temp-${Date.now()}`,
            message_id: messageId,
            conversation_id: convId,
            actor_type: 'agent',
            actor_id: userId,
            emoji,
            created_at: new Date().toISOString(),
          },
        ];
      });

      try {
        const res = await fetch('/api/whatsapp/react', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message_id: messageId, emoji }),
        });
        if (!res.ok) {
          const payload = await res.json().catch(() => ({}));
          throw new Error(payload?.error || `HTTP ${res.status}`);
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : 'network error';
        toast.error(`Reaction failed: ${reason}`);
        setReactions(snapshot);
      }
    },
    [conversation, user?.id]
  );

  // Stable wrapper around postReaction for MessageBubble's reaction-pill
  // toggle — MessageBubble now resolves "own"/"next" itself from its own
  // `reactions`/`currentUserId` props (same logic previously computed
  // per-message here), so this can be one function shared by every
  // bubble instead of a closure recreated per message per render.
  const handleReactionToggle = useCallback(
    (messageId: string, emoji: string) => {
      void postReaction(messageId, emoji);
    },
    [postReaction]
  );

  const handleAssignChange = useCallback(
    async (agentId: string | null) => {
      if (!conversation) return;

      const supabase = createClient();
      const { error } = await supabase
        .from('conversations')
        .update({ assigned_agent_id: agentId })
        .eq('id', conversation.id);

      if (error) {
        console.error('Failed to update assignment:', error);
        toast.error('Failed to update assignment');
        return;
      }

      onAssignChange(conversation.id, agentId);
    },
    [conversation, onAssignChange]
  );

  // AGENTS task: moving into "Follow-up" from here requires motivo +
  // prazo, same global gate every other entry point uses — see
  // useFollowupGate. Every other stage stays a plain, immediate move.
  const handleMoveStage = useCallback(
    (stageId: string) => {
      if (!pipelineDeal) return;
      followupGate.guardMove({
        deal: pipelineDeal,
        stages: pipelineStages,
        targetStageId: stageId,
        performMove: async () => {
          const { error } = await moveToStage(stageId);
          if (error) {
            console.error('Failed to update pipeline stage:', error);
            toast.error('Failed to update pipeline stage');
          }
        },
      });
    },
    [pipelineDeal, pipelineStages, followupGate, moveToStage]
  );

  // Group messages by date (unconditional hook before any early return)
  const messageGroups = useMemo(
    () => groupMessagesByDate(visibleMessages),
    [visibleMessages]
  );

  // Empty state — same WhatsApp-style doodle background as the active
  // thread below, so swapping between empty/selected doesn't change the
  // pattern under the user's eye.
  if (!conversation || !contact) {
    return (
      <div
        // `data-inbox-doodle-bg` — structural hook only (no conditional
        // logic here); consumed by the iPhone-PWA-scoped CSS block in
        // globals.css to swap the base colour under the doodle pattern
        // to pure black. Every other platform is untouched.
        data-inbox-doodle-bg
        className={cn(
          'flex flex-1 flex-col items-center justify-center',
          DOODLE_BG_CLASSES
        )}
      >
        <div className="bg-muted flex h-16 w-16 items-center justify-center rounded-full">
          <MessageSquare className="text-muted-foreground h-8 w-8" />
        </div>
        <h3 className="text-muted-foreground mt-4 text-sm font-medium">
          {t('selectConversation')}
        </h3>
        <p className="text-muted-foreground mt-1 text-xs">
          {t('selectConversationHint')}
        </p>
      </div>
    );
  }

  const displayName = contact.name || contact.phone;
  const assignedAgentId = conversation.assigned_agent_id ?? null;

  return (
    // `min-w-0` is load-bearing: the page already puts min-w-0 on the
    // thread's flex *wrapper* (issue #165), but this root keeps the
    // default `min-width: auto`, so a single wide message (long unbroken
    // URL/word) expands the whole thread past its flex share and the chat
    // paints on top of the contact sidebar at lg+ — outgoing bubbles get
    // clipped and the hover toolbar overlaps the Tags panel. Letting the
    // root shrink lets the bubbles' break-words / max-w caps apply.
    // Issue #257.
    <div
      ref={threadRootRef}
      data-inbox-doodle-bg
      className={cn('flex min-w-0 flex-1 flex-col', DOODLE_BG_CLASSES)}
    >
      {/* Header — solid card surface sits on top of the doodle so the
          name/avatar/dropdowns stay legible. */}
      <div className="border-border bg-card flex items-center justify-between gap-2 border-b px-3 py-3 sm:px-4">
        <div className="flex min-w-0 items-center gap-2 sm:gap-3">
          {/* Back-to-list button — mobile only. Hidden on lg+ where the
              conversation list is always visible next to the thread. */}
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              aria-label={t('backToConversations')}
              className="text-muted-foreground hover:bg-muted hover:text-foreground flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md lg:hidden"
            >
              <ArrowLeft className="h-5 w-5" />
            </button>
          )}
          <div className="bg-muted text-foreground flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-sm font-medium">
            {displayName.charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0">
            <h2 className="text-foreground truncate text-sm font-semibold">
              {displayName}
            </h2>
            <p className="text-muted-foreground truncate text-xs">
              {contact.phone}
            </p>
          </div>
          {/* Session timer badge — hidden on the narrowest phones so
              the name + back arrow keep their room. */}
          <Badge
            variant="outline"
            className={cn(
              'border-border ml-1 hidden gap-1 text-[10px] sm:ml-2 sm:inline-flex',
              sessionInfo.expired ? 'text-red-400' : 'text-primary'
            )}
          >
            <Clock className="h-3 w-3" />
            {sessionInfo.remaining}
          </Badge>
          {/* CTWA Free Entry Point badge — only for leads that came
              from a Click-to-WhatsApp ad AND whose FEP was activated
              (business already replied within the first 24h). A
              separate badge, never merged into the one above: the 24h
              badge always means "free-text permission"; this one only
              ever means "CTWA billing benefit", per the spec's explicit
              instruction not to present the 72h as if it were a second
              free-text window. */}
          {ctwaFepInfo && (
            <Badge
              variant="outline"
              className={cn(
                'border-border ml-1 hidden gap-1 text-[10px] sm:ml-1 sm:inline-flex',
                ctwaFepInfo.active ? 'text-primary' : 'text-muted-foreground'
              )}
            >
              <Megaphone className="h-3 w-3" />
              {ctwaFepInfo.remaining}
            </Badge>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          {/* AI auto-reply status circle indicator / toggle */}
          <AiThreadBanner
            conversationId={conversation.id}
            disabled={conversation.ai_autoreply_disabled ?? false}
            handoffSummary={conversation.ai_handoff_summary}
            assignedAgentId={assignedAgentId}
            currentUserId={user?.id}
            onChange={(patch) => {
              if ('assigned_agent_id' in patch) {
                onAssignChange(conversation.id, patch.assigned_agent_id ?? null);
              }
            }}
          />

          {/* Contact-panel toggle — desktop only. The contact sidebar
              eats a chunk of horizontal width that crowds the thread on
              smaller laptops; this lets agents reclaim it when they just
              want to read and reply. Hidden on mobile, where the sidebar
              never renders as a permanent panel anyway. Issue #258. */}
          {onToggleContactPanel && (
            <button
              type="button"
              onClick={onToggleContactPanel}
              aria-label={
                contactPanelOpen ? t('hideContactPanel') : t('showContactPanel')
              }
              title={contactPanelOpen ? t('hideContact') : t('showContact')}
              aria-pressed={contactPanelOpen}
              className={cn(
                'hover:bg-muted hover:text-foreground hidden h-7 w-7 items-center justify-center rounded-md transition-colors lg:inline-flex',
                contactPanelOpen ? 'text-primary' : 'text-muted-foreground'
              )}
            >
              {contactPanelOpen ? (
                <PanelRightClose className="h-4 w-4" />
              ) : (
                <PanelRightOpen className="h-4 w-4" />
              )}
            </button>
          )}

          {/* Contact-panel toggle — mobile only. Same info the desktop
              toggle above reveals, but as a drag-openable overlay drawer
              instead of a permanent column (there's no room for one on a
              phone screen). Discreet chevron per the ask ("botão discreto
              com seta"), flipping direction with the drawer's own state —
              left when closed (swipe/tap this way to bring it in), right
              when open (tap to send it back). */}
          <button
            type="button"
            onClick={() => setMobileContactPanelOpen((prev) => !prev)}
            aria-label={
              mobileContactPanelOpen ? t('hideContact') : t('showContact')
            }
            title={mobileContactPanelOpen ? t('hideContact') : t('showContact')}
            aria-pressed={mobileContactPanelOpen}
            className={cn(
              'hover:bg-muted hover:text-foreground inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors lg:hidden',
              mobileContactPanelOpen ? 'text-primary' : 'text-muted-foreground'
            )}
          >
            {mobileContactPanelOpen ? (
              <ChevronRight className="h-4 w-4" />
            ) : (
              <ChevronLeft className="h-4 w-4" />
            )}
          </button>

          {/* Single overflow menu — replaces the old refresh button +
              Status dropdown + Assign dropdown (WACRM inbox redesign
              task). None of the underlying capabilities were removed:
              status/assignment/refresh-on-reconnect all still work the
              same as before, this just collapses their manual UI
              controls into one "⋮" so the header reads as clean as
              WhatsApp's own. "Pendente" / "Marcar como não lida" moved
              in here too (not part of the requested 4 items, but
              dropping their only UI entry point would be a real
              regression, not a simplification) — same handlers as
              before, `handleTogglePending` / `handleMarkUnread`. */}
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label={t('moreOptions')}
              title={t('moreOptions')}
              className="text-muted-foreground hover:bg-muted hover:text-foreground inline-flex h-7 w-7 items-center justify-center rounded-md"
            >
              <MoreVertical className="h-4 w-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="border-border bg-popover w-56"
            >
              <DropdownMenuSub>
                <DropdownMenuSubTrigger className="text-popover-foreground text-sm">
                  <UserPlus className="h-3.5 w-3.5" />
                  {t('menuTransfer')}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="border-border bg-popover w-56">
                  <TransferSubmenu
                    profiles={profiles}
                    assignedAgentId={assignedAgentId}
                    currentUserId={user?.id}
                    meLabel={t('me')}
                    noTeammatesLabel={t('noTeammates')}
                    unassignLabel={t('unassign')}
                    onAssign={handleAssignChange}
                  />
                </DropdownMenuSubContent>
              </DropdownMenuSub>

              <DropdownMenuSub>
                <DropdownMenuSubTrigger className="text-popover-foreground text-sm">
                  <Kanban className="h-3.5 w-3.5" />
                  {t('menuMoveStage')}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="border-border bg-popover w-56">
                  {pipelineStages.length === 0 ? (
                    <DropdownMenuItem
                      disabled
                      className="text-muted-foreground text-sm"
                    >
                      {t('noPipelineStages')}
                    </DropdownMenuItem>
                  ) : (
                    pipelineStages.map((stage) => {
                      const isSelected = stage.id === pipelineDeal?.stage_id;
                      return (
                        <DropdownMenuItem
                          key={stage.id}
                          onClick={() => handleMoveStage(stage.id)}
                          className={cn(
                            'text-sm',
                            isSelected
                              ? 'text-primary'
                              : 'text-popover-foreground'
                          )}
                        >
                          <span
                            className="mr-2 h-2 w-2 rounded-full"
                            style={{ backgroundColor: stage.color }}
                          />
                          <span className="flex-1">{stage.name}</span>
                          {isSelected && <Check className="ml-2 h-3 w-3" />}
                        </DropdownMenuItem>
                      );
                    })
                  )}
                  <DropdownMenuSeparator className="bg-border" />
                  {/* "Arquivados" — send-only here (no "Restaurar"; that
                      flow lives exclusively in the Pipeline's dedicated
                      Arquivados tab). Same gray used as the neutral/no-
                      stage dot elsewhere (deal-card.tsx's stage-color
                      fallback), so it reads as "off the board" rather
                      than a real stage. */}
                  <DropdownMenuItem
                    disabled={!pipelineDeal}
                    onClick={() => setArchiveDialogOpen(true)}
                    className="text-popover-foreground text-sm"
                  >
                    <span
                      className="mr-2 h-2 w-2 rounded-full"
                      style={{ backgroundColor: '#94a3b8' }}
                    />
                    <span className="flex-1">{t('menuArchived')}</span>
                  </DropdownMenuItem>
                </DropdownMenuSubContent>
              </DropdownMenuSub>

              <DropdownMenuItem
                onClick={() => setActionCenterOpen(true)}
                className="text-popover-foreground text-sm"
              >
                <ListChecks className="h-3.5 w-3.5" />
                {t('menuActionCenter')}
              </DropdownMenuItem>

              <DropdownMenuItem
                onClick={() => setNotesDialogOpen(true)}
                className="text-popover-foreground text-sm"
              >
                <StickyNote className="h-3.5 w-3.5" />
                {t('menuNotes')}
              </DropdownMenuItem>

              <DropdownMenuItem
                onClick={() => setAppointmentDialogOpen(true)}
                className="text-popover-foreground text-sm"
              >
                <CalendarPlus className="h-3.5 w-3.5" />
                {t('menuAppointment')}
              </DropdownMenuItem>

              <DropdownMenuItem
                onClick={() => setMediaGalleryOpen(true)}
                className="text-popover-foreground text-sm"
              >
                <Images className="h-3.5 w-3.5" />
                {t('menuMedia')}
              </DropdownMenuItem>

              <DropdownMenuSeparator className="bg-border" />

              <DropdownMenuCheckboxItem
                checked={conversation.status === 'pending'}
                onCheckedChange={handleTogglePending}
                className="text-sm text-amber-400"
              >
                {t('statusPending')}
              </DropdownMenuCheckboxItem>
              <DropdownMenuItem
                onClick={handleMarkUnread}
                className="text-primary text-sm"
              >
                {t('markAsUnread')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* "Abrir notas" — same `ContactNotesPanel` (contact_notes table)
          `ContactSidebar` uses, in a dialog so it's reachable below the
          `lg` breakpoint too, where the sidebar never renders. */}
      <Dialog open={notesDialogOpen} onOpenChange={setNotesDialogOpen}>
        <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('notesDialogTitle')}</DialogTitle>
          </DialogHeader>
          <ContactNotesPanel contact={contact} hideHeading />
        </DialogContent>
      </Dialog>

      {/* "Criar agendamento" — the existing Agenda dialog (also used by
          `agenda-week.tsx`), just pre-filled with this contact so Google
          Calendar sync (already wired inside the dialog itself) picks up
          the same event it always has. */}
      <AppointmentFormDialog
        open={appointmentDialogOpen}
        onOpenChange={setAppointmentDialogOpen}
        defaultContactId={contact.id}
        defaultClientName={displayName}
        onSaved={() => {}}
      />

      {/* "Adicionar à Central de Ações" — Inbox entry point (AGENTS.md §7). */}
      <AddToActionCenterDialog
        open={actionCenterOpen}
        onOpenChange={setActionCenterOpen}
        contactId={contact.id}
        contactName={displayName}
        conversationId={conversation.id}
      />

      {/* "Arquivados" (Mover para submenu) — same shared confirmation +
          mutation as the Pipeline card's "⋮ → Arquivar" (AGENTS.md:
          reuses `deals.archived_at`, not a parallel implementation).
          Send-only here; restoring stays exclusive to the Pipeline's
          Arquivados tab. */}
      <ArchiveDealDialog
        open={archiveDialogOpen}
        onOpenChange={setArchiveDialogOpen}
        dealId={pipelineDeal?.id ?? null}
        contactId={contact.id}
        dealName={displayName}
        onArchived={() => {
          // useLeadPipelineStage's own sync channel — refetches this
          // instance's `deal`/`stages` (and the contact sidebar's, if
          // mounted) so the header's "Mover para" and the sidebar's
          // stage card both drop the now-archived deal immediately,
          // no page reload.
          window.dispatchEvent(
            new CustomEvent('wacrm:deal-stage-changed', {
              detail: { contactId: contact.id },
            })
          );
        }}
      />

      {/* Global "moving into Follow-up requires motivo+prazo" gate —
          catches the "⋮ → Mover para" submenu entry point. */}
      <FollowupRequirementDialog {...followupGate} />

      {/* "Ver mídias" — derived entirely from `messages`, already loaded
          for this thread; no separate fetch, no new storage. */}
      <MediaGallery
        open={mediaGalleryOpen}
        onOpenChange={setMediaGalleryOpen}
        messages={messages}
        conversationId={conversation.id}
        contactDisplayName={contactDisplayName}
      />

      {/* CTWA ad origin — tappable on every breakpoint, so it's the
          mobile/PWA discovery point ContactSidebar (desktop-only,
          lg:block) can never be. Renders nothing without a referral. */}
      <CtwaOrigin referral={conversation.ctwa_referral} />

      {/* Messages Area. The outer wrapper (messagesAreaRef) is the
          confinement target for the pre-send PDF preview — see
          messagesAreaRef's declaration above for why it has to be this
          non-scrolling wrapper and not scrollRef itself. */}
      <div ref={messagesAreaRef} className="relative flex-1 overflow-hidden">
        <div
          ref={scrollRef}
          // -webkit-overflow-scrolling: touch — hands momentum scrolling
          // off to WebKit's compositor thread on iOS/WKWebView (the PWA
          // shell). Without it, a long drag gesture can fall back to
          // main-thread scrolling, which stutters far more easily
          // whenever the thread is even briefly busy (a message re-render,
          // a ResizeObserver callback, a new realtime message landing).
          // No-op on every other browser (unknown vendor property).
          //
          // overscroll-behavior-y: contain — that same momentum engine
          // also turns on WebKit's native elastic bounce at the scroll
          // boundaries. Pinned to the last bubble (already at the bottom
          // edge) is exactly where a light pull sits inside that bounce
          // region: WebKit stretches and springs it back on its own,
          // outside our pin/unpin logic entirely — read as the thread
          // flickering and snapping back to the last message. `contain`
          // stops that local rubber-band while leaving momentum scrolling
          // for real drags untouched.
          className="h-full overflow-y-auto [overflow-anchor:none] [-webkit-overflow-scrolling:touch] [overscroll-behavior-y:contain] px-4 py-4"
          onPointerDown={() => {
            if (
              document.activeElement instanceof HTMLElement &&
              (document.activeElement.tagName === 'TEXTAREA' ||
                document.activeElement.tagName === 'INPUT')
            ) {
              document.activeElement.blur();
            }
          }}
        >
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <div className="border-primary h-5 w-5 animate-spin rounded-full border-2 border-t-transparent" />
            </div>
          ) : messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12">
              <p className="text-muted-foreground text-sm">
                {t('noMessagesYet')}
              </p>
              <p className="text-muted-foreground text-xs">
                {t('sendTemplateHint')}
              </p>
            </div>
          ) : (
            <div ref={contentRef} className="space-y-4">
              {messageGroups.map((group) => (
                <div key={group.date}>
                  {/* Date separator */}
                  <div className="mb-4 flex items-center justify-center">
                    <span className="bg-muted text-muted-foreground rounded-full px-3 py-1 text-[10px] font-medium">
                      {formatDateSeparator(group.date, t)}
                    </span>
                  </div>
                  {/* Messages */}
                  <div className="space-y-2">
                    {group.messages.map((msg) => {
                      const album = albumGroups.get(msg.id);
                      if (album) {
                        // Every message in the group renders once, as the
                        // album, at the position of its first message —
                        // the rest are skipped here (they're still their
                        // own row/message/status in `messages`, just not
                        // given a second visual row of their own).
                        if (album.messages[0].id !== msg.id) return null;
                        return (
                          <MessageAlbum
                            key={album.albumId || album.id}
                            messages={album.messages}
                            currentUserId={user?.id}
                            currentContactId={contact?.id}
                            reactions={reactionsByMessageId.get(
                              album.messages[0].id
                            )}
                            onReply={handleStartReply}
                            onReact={postReaction}
                            onDelete={handleDeleteMessage}
                            onToggleReaction={handleReactionToggle}
                            onRetryMessage={handleRetryMediaMessage}
                            onCancelMessage={handleCancelMediaMessage}
                            onCancelAlbum={handleCancelMediaAlbum}
                          />
                        );
                      }
                      return (
                        <MessageRow
                          key={msg.id}
                          message={msg}
                          reply={replyPreviewByMessageId.get(msg.id) ?? null}
                          reactions={reactionsByMessageId.get(msg.id)}
                          currentUserId={user?.id}
                          currentContactId={contact?.id}
                          onReply={handleStartReply}
                          onReact={postReaction}
                          onDelete={handleDeleteMessage}
                          onTranscribe={handleTranscribe}
                          onToggleReaction={handleReactionToggle}
                          transcriptRevealed={revealedTranscriptIds.has(msg.id)}
                          onRetryAudio={handleRetryAudio}
                          onRetryMedia={handleRetryMediaMessage}
                        />
                      );
                    })}
                  </div>
                </div>
              ))}
              {/* Invisible bottom marker used for stable scrollIntoView anchor */}
              <div ref={bottomMarkerRef} className="h-px w-full pointer-events-none opacity-0" aria-hidden="true" />
            </div>
          )}
        </div>
      </div>


      {/* Composer */}
      <MessageComposer
        sessionExpired={sessionInfo.expired}
        conversationId={conversation.id}
        onSend={handleSend}
        onSendMedia={handleSendMedia}
        onSendMediaBatch={handleSendMediaBatch}
        onRecordAudio={(recordId, replyToId) => void handleQueuedAudio(recordId, replyToId)}
        onOpenTemplates={handleOpenTemplates}
        replyTo={replyTo}
        onClearReply={() => setReplyTo(null)}
        initialText={
          followupPrime?.mode === 'free' ? followupPrime.text : undefined
        }
        pdfPreviewContainerRef={messagesAreaRef}
      />

      <TemplatePicker
        open={templateModalOpen}
        onOpenChange={(open) => {
          setTemplateModalOpen(open);
          if (!open) setFollowupTemplateSelection(null);
        }}
        onSelect={handleSendTemplate}
        initialSelection={followupTemplateSelection}
        conversationId={conversation?.id ?? null}
      />

      {/* Mobile contact-info drawer — backdrop + sliding panel, same
          fixed-overlay/backdrop pattern as the mobile nav drawer
          (Sidebar), mirrored to the right edge (useDrawerGesture,
          side="right", wired above). Renders the identical ContactSidebar
          the desktop panel uses (AGENTS task: no new component, no
          duplicated data) — only its container differs. Desktop-only
          hidden via `lg:hidden` on both pieces. */}
      <button
        ref={mobileContactBackdropRef}
        type="button"
        aria-label={t('hideContact')}
        onClick={() => setMobileContactPanelOpen(false)}
        className={cn(
          'bg-background/70 fixed inset-0 z-30 backdrop-blur-sm transition-opacity lg:hidden',
          mobileContactPanelOpen
            ? 'pointer-events-auto opacity-100'
            : 'pointer-events-none opacity-0'
        )}
      />
      <div
        ref={mobileContactPanelRef}
        className={cn(
          'fixed inset-y-0 right-0 z-40 h-full w-70 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]',
          'transition-transform duration-200 ease-out will-change-transform lg:hidden',
          mobileContactPanelOpen ? 'translate-x-0' : 'translate-x-full'
        )}
      >
        <ContactSidebar contact={contact} conversation={conversation} />
      </div>
    </div>
  );
}
