import { describe, expect, it, vi } from "vitest";
import type { Conversation } from "@/types";
import { resolveDeepLinkConversation } from "./deep-link";

function makeConv(id: string): Conversation {
  return {
    id,
    user_id: "user-1",
    contact_id: `contact-${id}`,
    status: "open",
    unread_count: 0,
    pinned: false,
    last_message_at: "2026-11-10T12:00:00.000Z",
    last_message_text: "Olá",
    created_at: "2026-11-01T12:00:00.000Z",
    updated_at: "2026-11-10T12:00:00.000Z",
  };
}

describe("resolveDeepLinkConversation", () => {
  it("returns noop when conversationId is absent or already active/resolved", async () => {
    const fetchById = vi.fn();

    await expect(
      resolveDeepLinkConversation({
        conversationId: null,
        loadedConversations: [],
        activeConversationId: null,
        alreadyResolvedId: null,
        fetchById,
        isStillCurrent: () => true,
      }),
    ).resolves.toEqual({ status: "noop", conversation: null });

    await expect(
      resolveDeepLinkConversation({
        conversationId: "c1",
        loadedConversations: [],
        activeConversationId: "c1",
        alreadyResolvedId: null,
        fetchById,
        isStillCurrent: () => true,
      }),
    ).resolves.toEqual({ status: "noop", conversation: null });

    await expect(
      resolveDeepLinkConversation({
        conversationId: "c1",
        loadedConversations: [],
        activeConversationId: null,
        alreadyResolvedId: "c1",
        fetchById,
        isStillCurrent: () => true,
      }),
    ).resolves.toEqual({ status: "noop", conversation: null });

    expect(fetchById).not.toHaveBeenCalled();
  });

  it("resolves directly from loadedConversations without fetching when present", async () => {
    const target = makeConv("c-in-list");
    const fetchById = vi.fn();

    const result = await resolveDeepLinkConversation({
      conversationId: "c-in-list",
      loadedConversations: [makeConv("c-other"), target],
      activeConversationId: null,
      alreadyResolvedId: null,
      fetchById,
      isStillCurrent: () => true,
    });

    expect(result).toEqual({
      status: "resolved_from_list",
      conversation: target,
    });
    expect(fetchById).not.toHaveBeenCalled();
  });

  it("falls back to fetchById when conversation is outside the iPhone top-50 list", async () => {
    const olderFollowup = makeConv("c-stale-followup");
    const fetchById = vi.fn().mockResolvedValue(olderFollowup);

    const result = await resolveDeepLinkConversation({
      conversationId: "c-stale-followup",
      loadedConversations: [makeConv("c-recent-1"), makeConv("c-recent-2")],
      activeConversationId: null,
      alreadyResolvedId: null,
      fetchById,
      isStillCurrent: () => true,
    });

    expect(fetchById).toHaveBeenCalledWith("c-stale-followup");
    expect(result).toEqual({
      status: "resolved_from_fetch",
      conversation: olderFollowup,
    });
  });

  it("resolves via fetchById even on cold mount before conversations finish loading", async () => {
    const coldConv = makeConv("c-cold");
    const fetchById = vi.fn().mockResolvedValue(coldConv);

    const result = await resolveDeepLinkConversation({
      conversationId: "c-cold",
      loadedConversations: [],
      activeConversationId: null,
      alreadyResolvedId: null,
      fetchById,
      isStillCurrent: () => true,
    });

    expect(fetchById).toHaveBeenCalledWith("c-cold");
    expect(result).toEqual({
      status: "resolved_from_fetch",
      conversation: coldConv,
    });
  });

  it("returns not_found safely when conversation does not exist or RLS hides it", async () => {
    const fetchById = vi.fn().mockResolvedValue(null);

    const result = await resolveDeepLinkConversation({
      conversationId: "c-missing",
      loadedConversations: [makeConv("c-1")],
      activeConversationId: null,
      alreadyResolvedId: null,
      fetchById,
      isStillCurrent: () => true,
    });

    expect(fetchById).toHaveBeenCalledWith("c-missing");
    expect(result).toEqual({ status: "not_found", conversation: null });
  });

  it("returns stale and discards fetched conversation when user navigated away mid-flight", async () => {
    let current = true;
    const fetchById = vi.fn(async () => {
      current = false;
      return makeConv("c-slow");
    });

    const result = await resolveDeepLinkConversation({
      conversationId: "c-slow",
      loadedConversations: [],
      activeConversationId: null,
      alreadyResolvedId: null,
      fetchById,
      isStillCurrent: () => current,
    });

    expect(result).toEqual({ status: "stale", conversation: null });
  });
});
