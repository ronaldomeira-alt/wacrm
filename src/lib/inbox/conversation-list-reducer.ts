import type { Conversation } from "@/types";
import type { PlatformProfile } from "@/lib/platform/platform-profile";

/**
 * Inserts or moves a conversation to the top of the list (index 0),
 * applying the platform profile limit (e.g. 50 on iPhone, unlimited on desktop).
 *
 * NOTE: The limit is purely on local query/display to keep mobile WebKit lightweight.
 * It NEVER deletes, prunes, or alters data in the Supabase database.
 */
export function prependOrMoveToTop(
  prev: Conversation[],
  conversation: Conversation,
  profile: PlatformProfile
): Conversation[] {
  const existingIdx = prev.findIndex((c) => c.id === conversation.id);
  const next = prev.slice();
  if (existingIdx !== -1) {
    next.splice(existingIdx, 1);
  }
  next.unshift(conversation);
  return profile.maxInboxLeads ? next.slice(0, profile.maxInboxLeads) : next;
}

/**
 * Handles incoming message preview update in the conversation list:
 * - If conversation is already in list: updates preview and moves it to the top (index 0).
 * - If conversation is not in list: returns { needsHydrate: true, conversations: prev } so caller fetches and hydrates it.
 */
export function applyMessageToConversationList(
  prev: Conversation[],
  message: {
    conversation_id: string;
    content_text?: string | null;
    created_at: string;
  },
  activeConversationId: string | null,
  profile: PlatformProfile
): {
  conversations: Conversation[];
  needsHydrate: boolean;
} {
  const idx = prev.findIndex((c) => c.id === message.conversation_id);
  if (idx === -1) {
    return { conversations: prev, needsHydrate: true };
  }
  const updated: Conversation = {
    ...prev[idx],
    last_message_text: message.content_text ?? "",
    last_message_at: message.created_at,
    unread_count:
      activeConversationId === message.conversation_id
        ? 0
        : (prev[idx].unread_count || 0) + 1,
  };
  const next = prev.slice();
  next.splice(idx, 1);
  next.unshift(updated);
  return {
    conversations: profile.maxInboxLeads ? next.slice(0, profile.maxInboxLeads) : next,
    needsHydrate: false,
  };
}

/**
 * Handles incoming conversation UPDATE event:
 * - If conversation is in list: updates fields, moves to top if last_message_at changed.
 * - If not in list: returns { needsHydrate: true, conversations: prev }.
 */
export function applyConversationUpdate(
  prev: Conversation[],
  updatedConv: Conversation,
  activeConversationId: string | null,
  profile: PlatformProfile
): {
  conversations: Conversation[];
  needsHydrate: boolean;
} {
  const idx = prev.findIndex((c) => c.id === updatedConv.id);
  if (idx === -1) {
    return { conversations: prev, needsHydrate: true };
  }
  const isActive = activeConversationId === updatedConv.id;
  const merged: Conversation = {
    ...prev[idx],
    ...updatedConv,
    unread_count: isActive ? 0 : updatedConv.unread_count,
  };
  const shouldMoveToTop = Boolean(
    updatedConv.last_message_at &&
    updatedConv.last_message_at !== prev[idx].last_message_at
  );
  if (shouldMoveToTop) {
    const next = prev.slice();
    next.splice(idx, 1);
    next.unshift(merged);
    return {
      conversations: profile.maxInboxLeads ? next.slice(0, profile.maxInboxLeads) : next,
      needsHydrate: false,
    };
  }
  return {
    conversations: prev.map((c) => (c.id === updatedConv.id ? merged : c)),
    needsHydrate: false,
  };
}

/**
 * Merges a freshly hydrated conversation from DB into local list:
 * - Places it at index 0.
 * - Backfills contact and updates preview.
 * - Caps at profile.maxInboxLeads on mobile (50), leaves unbounded on desktop.
 */
export function mergeHydratedConversation(
  prev: Conversation[],
  fetched: Conversation,
  profile: PlatformProfile
): Conversation[] {
  const existingIdx = prev.findIndex((c) => c.id === fetched.id);
  const next = prev.slice();
  if (existingIdx !== -1) {
    const existing = prev[existingIdx];
    const merged: Conversation = {
      ...existing,
      contact: existing.contact ?? fetched.contact,
      last_message_text: fetched.last_message_text || existing.last_message_text,
      last_message_at: fetched.last_message_at || existing.last_message_at,
    };
    next.splice(existingIdx, 1);
    next.unshift(merged);
  } else {
    next.unshift(fetched);
  }
  return profile.maxInboxLeads ? next.slice(0, profile.maxInboxLeads) : next;
}
