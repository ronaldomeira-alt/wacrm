import type { Conversation } from "@/types";

export interface ResolveDeepLinkParams {
  conversationId: string | null;
  loadedConversations: Conversation[];
  activeConversationId: string | null;
  alreadyResolvedId: string | null;
  fetchById: (id: string) => Promise<Conversation | null>;
  isStillCurrent: () => boolean;
}

export type DeepLinkResolution =
  | { status: "noop"; conversation: null }
  | { status: "resolved_from_list"; conversation: Conversation }
  | { status: "resolved_from_fetch"; conversation: Conversation }
  | { status: "not_found"; conversation: null }
  | { status: "stale"; conversation: null };

/**
 * Resolves a `/inbox?c=<conversationId>` deep-link target across both desktop
 * (full conversation list) and mobile/iPhone PWA (top-50 capped list or initial
 * cold mount before the list has loaded).
 */
export async function resolveDeepLinkConversation({
  conversationId,
  loadedConversations,
  activeConversationId,
  alreadyResolvedId,
  fetchById,
  isStillCurrent,
}: ResolveDeepLinkParams): Promise<DeepLinkResolution> {
  if (!conversationId) {
    return { status: "noop", conversation: null };
  }

  if (
    activeConversationId === conversationId ||
    alreadyResolvedId === conversationId
  ) {
    return { status: "noop", conversation: null };
  }

  const fromList = loadedConversations.find((c) => c.id === conversationId);
  if (fromList) {
    return { status: "resolved_from_list", conversation: fromList };
  }

  const fetched = await fetchById(conversationId);
  if (!isStillCurrent()) {
    return { status: "stale", conversation: null };
  }

  if (!fetched) {
    return { status: "not_found", conversation: null };
  }

  return { status: "resolved_from_fetch", conversation: fetched };
}
