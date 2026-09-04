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
import { ScrollArea } from '@/components/ui/scroll-area';
import { MessageBubble } from './message-bubble';
import { MessageActions } from './message-actions';
import { MessageAlbum, computeAlbumGroups } from './message-album';
import {
  MessageComposer,
  CHAT_MEDIA_BUCKET,
  type SendMediaPayload,
} from './message-composer';
import { deleteAccountMedia } from '@/lib/storage/upload-media';
import { getPendingAudio } from '@/lib/inbox/pending-audio-db';
import { runPendingAudio, discardPendingAudio } from '@/lib/inbox/pending-audio-sync';
import { markConversationUnread } from '@/lib/inbox/conversations';
import { TemplatePicker, type TemplateSendValues } from './template-picker';
import { AiThreadBanner } from './ai-thread-banner';
import { CtwaOrigin } from './ctwa-origin';
import { getCtwaFepStatus } from '@/lib/whatsapp/ctwa-fep';
import { buildReplyPreview } from './reply-quote';
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

interface ReplyDraft {
  id: string;
  authorLabel: string;
  preview: string;
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
  reply: { authorLabel: string; preview: string } | null;
  reactions: MessageReaction[] | undefined;
  currentUserId: string | undefined;
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
  onReply,
  onReact,
  onDelete,
  onTranscribe,
  onToggleReaction,
  transcriptRevealed,
  onRetryAudio,
}: MessageRowProps) {
  return (
    <MessageActions
      message={message}
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
        />
      )}
    </MessageActions>
  );
});

interface MessageThreadProps {
  conversation: Conversation | null;
  contact: Contact | null;
  messages: Message[];
  onMessagesLoaded: (messages: Message[]) => void;
  onNewMessage: (message: Message) => void;
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
    const day = format(new Date(msg.created_at), 'yyyy-MM-dd');
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

    const supabase = createClient();
    let cancelled = false;

    (async () => {
      setLoading(true);

      const { data, error } = await supabase
        .from('messages')
        .select('*')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: true });

      if (cancelled) return;

      if (error) {
        console.error('Failed to fetch messages:', error);
      } else {
        onMessagesLoadedRef.current(data ?? []);
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

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (scrollRef.current) {
      const el = scrollRef.current;
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  // Whether the user is currently at (near) the bottom of the thread —
  // read by the keyboard-follow effect below so opening the composer
  // only pulls the view down when that's where the user already was;
  // someone scrolled up reading older messages keeps their position.
  const isNearBottomRef = useRef(true);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const NEAR_BOTTOM_PX = 80;
    const onScroll = () => {
      isNearBottomRef.current =
        el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    };
    onScroll();
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [conversationId]);

  // Keep the last message visible as the iOS keyboard opens/closes and
  // resizes the app shell (--app-height, use-app-height.ts) — which
  // cascades down through ordinary flexbox to this container's own
  // rendered height. A `ResizeObserver` on the container itself is what
  // that resize actually *is*, regardless of what caused it (keyboard,
  // orientation change, the contact drawer, anything) — more direct and
  // reliable than inferring it from a `visualViewport` event, whose
  // firing/ordering relative to the layout reflow isn't guaranteed. No-op
  // whenever the user wasn't already at the bottom (`isNearBottomRef`).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    // The shell's own height now animates smoothly over ~250ms
    // (dashboard-shell.tsx's `transition-[height]`) rather than jumping
    // in one or two steps, so this container's size changes on every
    // frame of that transition, not just once or twice. Coalescing into
    // a single rAF-scheduled write per frame (instead of forcing a
    // synchronous scrollHeight read + scrollTop write on every single
    // ResizeObserver tick) keeps this from fighting the transition and
    // causing the very stutter it's meant to avoid.
    let rafId: number | null = null;
    const ro = new ResizeObserver(() => {
      if (!isNearBottomRef.current || rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        el.scrollTop = el.scrollHeight;
      });
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [conversationId]);

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
    [conversation, onNewMessage, onUpdateMessage, user?.id]
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
          void deleteAccountMedia(CHAT_MEDIA_BUCKET, payload.path).catch(
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
        void deleteAccountMedia(CHAT_MEDIA_BUCKET, payload.path).catch((err) =>
          console.error('Failed to GC orphaned media after send failure:', err)
        );
      }
    },
    [conversation, onNewMessage, onUpdateMessage, user?.id]
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

      const result = await runPendingAudio(recordId, {
        onMediaUrl: (url) => onUpdateMessage(tempId, { media_url: url }),
      });
      onUpdateMessage(tempId, { status: result.ok ? 'sent' : 'failed' });
      if (!result.ok) {
        console.error('Failed to send voice note:', result.error);
        toast.error(`Failed to send: ${result.error}`);
      }
    },
    [conversation, onNewMessage, onUpdateMessage, user?.id]
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
      // stops the object from orphaning in the chat-media bucket.
      const path = extractStoragePath(msg.media_url, CHAT_MEDIA_BUCKET);
      if (path) {
        void deleteAccountMedia(CHAT_MEDIA_BUCKET, path).catch(() => {});
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
    [conversation, onNewMessage, onUpdateMessage, user?.id]
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
  const albumGroups = useMemo(() => computeAlbumGroups(messages), [messages]);

  // Pre-computed reply-quote info per message, keyed by message id — moved
  // out of the render loop below so a message's `reply` prop keeps the
  // same object reference across renders where `messages`/`contact`
  // haven't changed, letting MessageRow's memo() actually skip it (REACT-1).
  // Same authorLabel/preview logic as before, just computed once here
  // instead of inline per message on every render.
  const replyPreviewByMessageId = useMemo(() => {
    const map = new Map<string, { authorLabel: string; preview: string }>();
    for (const m of messages) {
      if (!m.reply_to_message_id) continue;
      const parent = messagesById.get(m.reply_to_message_id);
      if (!parent) continue;
      map.set(m.id, {
        authorLabel:
          parent.sender_type === 'agent' || parent.sender_type === 'bot'
            ? t('me')
            : contact?.name || contact?.phone || 'Unknown',
        preview: buildReplyPreview(parent, tQuote),
      });
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, messagesById, contact, tQuote]);

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
      });
    },
    [authorLabelFor]
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

  // Empty state — same WhatsApp-style doodle background as the active
  // thread below, so swapping between empty/selected doesn't change the
  // pattern under the user's eye.
  if (!conversation || !contact) {
    return (
      <div
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
  const messageGroups = groupMessagesByDate(messages);
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

        <div className="flex items-center gap-2">
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
          className="h-full overflow-y-auto px-4 py-4"
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
            <div className="space-y-4">
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
                            key={album.id}
                            messages={album.messages}
                            currentUserId={user?.id}
                            reactions={reactionsByMessageId.get(
                              album.messages[0].id
                            )}
                            onReply={handleStartReply}
                            onReact={postReaction}
                            onDelete={handleDeleteMessage}
                            onToggleReaction={handleReactionToggle}
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
                          onReply={handleStartReply}
                          onReact={postReaction}
                          onDelete={handleDeleteMessage}
                          onTranscribe={handleTranscribe}
                          onToggleReaction={handleReactionToggle}
                          transcriptRevealed={revealedTranscriptIds.has(msg.id)}
                          onRetryAudio={handleRetryAudio}
                        />
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* AI auto-reply banner — take over an active bot, or resume it
          after a handoff. Renders nothing unless the account has
          auto-reply configured. */}
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

      {/* Composer */}
      <MessageComposer
        sessionExpired={sessionInfo.expired}
        conversationId={conversation.id}
        onSend={handleSend}
        onSendMedia={handleSendMedia}
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
