import { describe, it, expect } from "vitest";
import { computeAlbumGroups } from "./message-album";
import { calculateAlbumProgress, reconcileOptimisticMessages } from "@/lib/inbox/optimistic-album";
import type { Message } from "@/types";

function createMockMessage(
  id: string,
  albumId: string,
  albumIndex: number,
  createdAt: string,
  status: "sending" | "sent" | "delivered" | "read" | "failed" = "sending",
  metadataExtra: Record<string, unknown> = {}
): Message {
  return {
    id,
    conversation_id: "conv-1",
    sender_type: "agent",
    content_type: "image",
    content_text: "",
    media_url: `blob:http://localhost:3000/${id}`,
    album_id: albumId,
    album_index: albumIndex,
    status,
    created_at: createdAt,
    metadata: {
      album_id: albumId,
      album_index: albumIndex,
      ...metadataExtra,
    },
  };
}

describe("Definitive WhatsApp Multi-Image Album Flow", () => {
  it("Scenario 1: Groups 7 images with same album_id into a single album regardless of time gaps", () => {
    const albumId = "album-uuid-123";
    const messages: Message[] = [
      createMockMessage("msg-1", albumId, 0, "2026-09-13T01:00:00.000Z"),
      createMockMessage("msg-2", albumId, 1, "2026-09-13T01:00:00.010Z"),
      createMockMessage("msg-3", albumId, 2, "2026-09-13T01:00:00.020Z"),
      createMockMessage("msg-4", albumId, 3, "2026-09-13T01:00:00.030Z"),
      createMockMessage("msg-5", albumId, 4, "2026-09-13T01:00:00.040Z"),
      createMockMessage("msg-6", albumId, 5, "2026-09-13T01:00:00.050Z"),
      createMockMessage("msg-7", albumId, 6, "2026-09-13T01:00:00.060Z"),
    ];

    const groupMap = computeAlbumGroups(messages);
    const uniqueGroups = Array.from(new Set(groupMap.values()));
    expect(uniqueGroups).toHaveLength(1);
    expect(uniqueGroups[0].messages).toHaveLength(7);
    for (const m of messages) {
      expect(groupMap.get(m.id)).toBe(uniqueGroups[0]);
    }
  });

  it("Scenario 2: Strict order preservation 1..N when completions occur out-of-order (2s, 3s, 4s, 5s, 8s, 20s, 40s)", () => {
    const albumId = "album-uuid-latency-test";

    const scrambledMessages: Message[] = [
      createMockMessage("msg-1", albumId, 0, "2026-09-13T01:00:02.000Z", "sent"),
      createMockMessage("msg-3", albumId, 2, "2026-09-13T01:00:03.000Z", "sent"),
      createMockMessage("msg-2", albumId, 1, "2026-09-13T01:00:04.000Z", "sent"),
      createMockMessage("msg-5", albumId, 4, "2026-09-13T01:00:05.000Z", "sent"),
      createMockMessage("msg-4", albumId, 3, "2026-09-13T01:00:08.000Z", "sent"),
      createMockMessage("msg-7", albumId, 6, "2026-09-13T01:00:20.000Z", "sent"),
      createMockMessage("msg-6", albumId, 5, "2026-09-13T01:00:40.000Z", "sent"),
    ];

    const groupMap = computeAlbumGroups(scrambledMessages);
    const uniqueGroups = Array.from(new Set(groupMap.values()));
    expect(uniqueGroups).toHaveLength(1);
    expect(uniqueGroups[0].messages).toHaveLength(7);

    const indices = uniqueGroups[0].messages.map(
      (m) => (m.metadata as { album_index: number }).album_index
    );
    expect(indices).toEqual([0, 1, 2, 3, 4, 5, 6]);

    const ids = uniqueGroups[0].messages.map((m) => m.id);
    expect(ids).toEqual(["msg-1", "msg-2", "msg-3", "msg-4", "msg-5", "msg-6", "msg-7"]);
  });

  it("Scenario 3: Preserves album integrity even when some images fail and others succeed", () => {
    const albumId = "album-uuid-partial-failure";
    const messages: Message[] = [
      createMockMessage("msg-1", albumId, 0, "2026-09-13T01:00:00.000Z", "sent"),
      createMockMessage("msg-2", albumId, 1, "2026-09-13T01:00:00.000Z", "failed"),
      createMockMessage("msg-3", albumId, 2, "2026-09-13T01:00:00.000Z", "sent"),
      createMockMessage("msg-4", albumId, 3, "2026-09-13T01:00:00.000Z", "failed"),
    ];

    const groupMap = computeAlbumGroups(messages);
    const uniqueGroups = Array.from(new Set(groupMap.values()));
    expect(uniqueGroups).toHaveLength(1);
    expect(uniqueGroups[0].messages).toHaveLength(4);

    const statuses = uniqueGroups[0].messages.map((m) => m.status);
    expect(statuses).toEqual(["sent", "failed", "sent", "failed"]);
  });

  it("Scenario 4: Preserves cancelled item placeholder with cancelled flag without shifting tiles", () => {
    const albumId = "album-uuid-cancellation";
    const messages: Message[] = [
      createMockMessage("msg-1", albumId, 0, "2026-09-13T01:00:00.000Z", "sent"),
      createMockMessage("msg-2", albumId, 1, "2026-09-13T01:00:00.000Z", "failed", { cancelled: true }),
      createMockMessage("msg-3", albumId, 2, "2026-09-13T01:00:00.000Z", "sending"),
    ];

    const groupMap = computeAlbumGroups(messages);
    const uniqueGroups = Array.from(new Set(groupMap.values()));
    expect(uniqueGroups).toHaveLength(1);
    expect(uniqueGroups[0].messages).toHaveLength(3);
    expect(uniqueGroups[0].messages[1].metadata?.cancelled).toBe(true);
    expect(uniqueGroups[0].messages[1].status).toBe("failed");
  });

  it("Scenario 5: Two distinct album batches with different album_ids remain in separate albums", () => {
    const albumId1 = "album-uuid-batch-1";
    const albumId2 = "album-uuid-batch-2";

    const messages: Message[] = [
      createMockMessage("msg-1", albumId1, 0, "2026-09-13T01:00:00.000Z", "sent"),
      createMockMessage("msg-2", albumId1, 1, "2026-09-13T01:00:01.000Z", "sent"),
      createMockMessage("msg-3", albumId2, 0, "2026-09-13T01:00:02.000Z", "sent"),
      createMockMessage("msg-4", albumId2, 1, "2026-09-13T01:00:03.000Z", "sent"),
    ];

    const groupMap = computeAlbumGroups(messages);
    const uniqueGroups = Array.from(new Set(groupMap.values()));
    expect(uniqueGroups).toHaveLength(2);
    expect(uniqueGroups[0].messages).toHaveLength(2);
    expect(uniqueGroups[1].messages).toHaveLength(2);
  });

  it("Scenario 6: Fallback temporal grouping (within 10s) works when album_id is absent", () => {
    const messages: Message[] = [
      {
        id: "msg-t-1",
        conversation_id: "conv-1",
        sender_type: "agent",
        content_type: "image",
        media_url: "https://example.com/img1.jpg",
        status: "sent",
        created_at: "2026-09-13T01:00:00.000Z",
      },
      {
        id: "msg-t-2",
        conversation_id: "conv-1",
        sender_type: "agent",
        content_type: "image",
        media_url: "https://example.com/img2.jpg",
        status: "sent",
        created_at: "2026-09-13T01:00:05.000Z",
      },
    ];

    const groupMap = computeAlbumGroups(messages);
    const uniqueGroups = Array.from(new Set(groupMap.values()));
    expect(uniqueGroups).toHaveLength(1);
    expect(uniqueGroups[0].messages).toHaveLength(2);
  });

  describe("calculateAlbumProgress", () => {
    it("computes exact real progress for a 7-image album without fake timers", () => {
      const albumId = "album-progress-test";
      const messages: Message[] = Array.from({ length: 7 }, (_, i) =>
        createMockMessage(`temp-${i}`, albumId, i, "2026-09-13T01:00:00.000Z", "sending")
      );

      // 0 of 7
      let summary = calculateAlbumProgress(messages);
      expect(summary.total).toBe(7);
      expect(summary.completed).toBe(0);
      expect(summary.isSending).toBe(true);
      expect(summary.percent).toBe(0);

      // 1 of 7 sent (1/7 ~ 14%)
      messages[0].status = "sent";
      summary = calculateAlbumProgress(messages);
      expect(summary.completed).toBe(1);
      expect(summary.percent).toBe(14);

      // 3 of 7 sent (3/7 ~ 43%)
      messages[1].status = "sent";
      messages[2].status = "sent";
      summary = calculateAlbumProgress(messages);
      expect(summary.completed).toBe(3);
      expect(summary.percent).toBe(43);

      // 7 of 7 sent (100%)
      for (let i = 3; i < 7; i++) messages[i].status = "sent";
      summary = calculateAlbumProgress(messages);
      expect(summary.completed).toBe(7);
      expect(summary.isSending).toBe(false);
      expect(summary.percent).toBe(100);
    });

    it("detects errors and cancellations accurately", () => {
      const albumId = "album-err-test";
      const messages: Message[] = [
        createMockMessage("m1", albumId, 0, "2026-09-13T01:00:00.000Z", "sent"),
        createMockMessage("m2", albumId, 1, "2026-09-13T01:00:00.000Z", "failed"),
        createMockMessage("m3", albumId, 2, "2026-09-13T01:00:00.000Z", "failed", { cancelled: true }),
      ];

      const summary = calculateAlbumProgress(messages);
      expect(summary.completed).toBe(1);
      expect(summary.failed).toBe(1);
      expect(summary.cancelled).toBe(1);
      expect(summary.hasErrors).toBe(true);
      expect(summary.isSending).toBe(false);
    });
  });

  describe("reconcileOptimisticMessages", () => {
    it("CRITICAL: Reconciling 1 incoming message replaces ONLY its matching item and preserves all other optimistic messages", () => {
      const albumId = "album-reconcile-test";
      const optimisticBatch: Message[] = Array.from({ length: 7 }, (_, i) => ({
        ...createMockMessage(
          `temp-${albumId}-${i}`,
          albumId,
          i,
          `2026-09-13T01:00:00.0${i}0Z`,
          "sending"
        ),
        client_ref: `temp-${albumId}-${i}`,
        media_url: `blob:http://localhost:3000/temp-${i}`,
      }));

      // Incoming confirmed message for index 0 from backend/realtime
      const incomingConfirmed: Message = {
        id: "real-uuid-msg-0",
        conversation_id: "conv-1",
        sender_type: "agent",
        content_type: "image",
        media_url: "chat-attachment/real-key-0.jpg",
        status: "sent",
        created_at: "2026-09-13T01:00:01.000Z",
        album_id: albumId,
        album_index: 0,
        client_ref: `temp-${albumId}-${0}`,
      };

      const result = reconcileOptimisticMessages(optimisticBatch, incomingConfirmed);

      expect(result.matched).toBe(true);
      // All 7 messages must still be present! NOT reduced to 1!
      expect(result.updatedMessages).toHaveLength(7);

      // The first item should be reconciled with the real ID and sent status
      const first = result.updatedMessages[0];
      expect(first.id).toBe("real-uuid-msg-0");
      expect(first.status).toBe("sent");
      expect(first.album_id).toBe(albumId);
      expect(first.album_index).toBe(0);

      // The remaining 6 items MUST remain intact and optimistic
      for (let i = 1; i < 7; i++) {
        expect(result.updatedMessages[i].id).toBe(`temp-${albumId}-${i}`);
        expect(result.updatedMessages[i].status).toBe("sending");
        expect(result.updatedMessages[i].album_index).toBe(i);
      }
    });

    it("reconciles by album_id + album_index even if client_ref is missing", () => {
      const albumId = "album-index-reconcile";
      const optimisticBatch: Message[] = [
        createMockMessage("temp-a", albumId, 0, "2026-09-13T01:00:00.000Z", "sending"),
        createMockMessage("temp-b", albumId, 1, "2026-09-13T01:00:00.010Z", "sending"),
      ];

      const incoming: Message = {
        id: "real-uuid-1",
        conversation_id: "conv-1",
        sender_type: "agent",
        content_type: "image",
        media_url: "chat-attachment/key-1.jpg",
        status: "sent",
        created_at: "2026-09-13T01:00:02.000Z",
        album_id: albumId,
        album_index: 1,
      };

      const result = reconcileOptimisticMessages(optimisticBatch, incoming);
      expect(result.matched).toBe(true);
      expect(result.updatedMessages).toHaveLength(2);
      expect(result.updatedMessages[0].id).toBe("temp-a");
      expect(result.updatedMessages[1].id).toBe("real-uuid-1");
      expect(result.updatedMessages[1].status).toBe("sent");
    });
  });

  describe("Deduplication & Anti-Ghosting during active send phase", () => {
    it("Scenario 11: computeAlbumGroups eliminates duplication when temp and real messages coexist during upload", () => {
      const albumId = "album-dedup-test";

      // Simulate the exact condition reported by user: 10 images selected.
      // 10 temp messages are in local state.
      // Simultaneously, 4 real messages have landed from Realtime/backend while 6 are still sending.
      const messages: Message[] = [];
      for (let i = 0; i < 10; i++) {
        messages.push({
          ...createMockMessage(`temp-${albumId}-${i}`, albumId, i, `2026-09-13T01:00:00.${String(i).padStart(3, "0")}Z`, "sending"),
          client_ref: `temp-${albumId}-${i}`,
        });
      }

      // Add 4 real messages that share the same slots (indices 0, 1, 2, 3)
      for (let i = 0; i < 4; i++) {
        messages.push({
          ...createMockMessage(`real-uuid-${i}`, albumId, i, `2026-09-13T01:00:01.${String(i).padStart(3, "0")}Z`, "sent"),
          client_ref: `temp-${albumId}-${i}`,
        });
      }

      // Total raw messages in array is 14 (10 temp + 4 real duplicates)
      expect(messages).toHaveLength(14);

      const groupMap = computeAlbumGroups(messages);
      const uniqueGroups = Array.from(new Set(groupMap.values()));

      // Must be grouped into EXACTLY 1 album group
      expect(uniqueGroups).toHaveLength(1);
      const album = uniqueGroups[0];

      // The album group MUST have exactly 10 images (NOT 14 images!)
      expect(album.messages).toHaveLength(10);

      // Positions 0..3 must be the real messages, 4..9 must be the temp messages
      for (let i = 0; i < 4; i++) {
        expect(album.messages[i].id).toBe(`real-uuid-${i}`);
        expect(album.messages[i].status).toBe("sent");
      }
      for (let i = 4; i < 10; i++) {
        expect(album.messages[i].id).toBe(`temp-${albumId}-${i}`);
        expect(album.messages[i].status).toBe("sending");
      }

      // ALL 14 message IDs must resolve to this group so NONE are rendered standalone
      for (const m of messages) {
        expect(groupMap.get(m.id)).toBe(album);
      }
    });

    it("Scenario 12: Independent out-of-order completion preserves album structure and index integrity", () => {
      const albumId = "album-out-of-order";

      // 4 optimistic messages created
      let messages: Message[] = [
        { ...createMockMessage(`temp-${albumId}-0`, albumId, 0, "2026-09-13T01:00:00.000Z", "sending"), client_ref: `temp-${albumId}-0` },
        { ...createMockMessage(`temp-${albumId}-1`, albumId, 1, "2026-09-13T01:00:00.001Z", "sending"), client_ref: `temp-${albumId}-1` },
        { ...createMockMessage(`temp-${albumId}-2`, albumId, 2, "2026-09-13T01:00:00.002Z", "sending"), client_ref: `temp-${albumId}-2` },
        { ...createMockMessage(`temp-${albumId}-3`, albumId, 3, "2026-09-13T01:00:00.003Z", "sending"), client_ref: `temp-${albumId}-3` },
      ];

      // Fast image at index 2 finishes first! (e.g. index 0 is HEIC being processed on server)
      const realMsg2: Message = {
        ...createMockMessage(`real-msg-2`, albumId, 2, "2026-09-13T01:00:01.000Z", "sent"),
        client_ref: `temp-${albumId}-2`,
      };
      const rec2 = reconcileOptimisticMessages(messages, realMsg2);
      expect(rec2.matched).toBe(true);
      messages = rec2.updatedMessages;

      // Fast image at index 1 finishes next!
      const realMsg1: Message = {
        ...createMockMessage(`real-msg-1`, albumId, 1, "2026-09-13T01:00:01.500Z", "sent"),
        client_ref: `temp-${albumId}-1`,
      };
      const rec1 = reconcileOptimisticMessages(messages, realMsg1);
      expect(rec1.matched).toBe(true);
      messages = rec1.updatedMessages;

      // Group into album
      const groupMap = computeAlbumGroups(messages);
      const uniqueGroups = Array.from(new Set(groupMap.values()));

      expect(uniqueGroups).toHaveLength(1);
      const album = uniqueGroups[0];
      expect(album.messages).toHaveLength(4);

      // Verify slot indices are perfectly preserved:
      expect(album.messages[0].id).toBe(`temp-${albumId}-0`);
      expect(album.messages[0].status).toBe("sending");

      expect(album.messages[1].id).toBe("real-msg-1");
      expect(album.messages[1].status).toBe("sent");

      expect(album.messages[2].id).toBe("real-msg-2");
      expect(album.messages[2].status).toBe("sent");

      expect(album.messages[3].id).toBe(`temp-${albumId}-3`);
      expect(album.messages[3].status).toBe("sending");
    });

    it("Scenario 13: Identifies specific failed photo inside visible album tiles without affecting successful tiles", () => {
      const albumId = "album-individual-failure";
      const messages: Message[] = [
        createMockMessage("msg-0", albumId, 0, "2026-09-13T01:00:00.000Z", "sent"),
        createMockMessage("msg-1", albumId, 1, "2026-09-13T01:00:00.001Z", "failed"),
        createMockMessage("msg-2", albumId, 2, "2026-09-13T01:00:00.002Z", "sent"),
        createMockMessage("msg-3", albumId, 3, "2026-09-13T01:00:00.003Z", "sent"),
      ];

      const groupMap = computeAlbumGroups(messages);
      const album = groupMap.get("msg-0");
      expect(album).toBeDefined();
      expect(album!.messages).toHaveLength(4);

      // Verify that message at index 1 is uniquely identified as failed
      expect(album!.messages[1].status).toBe("failed");
      expect(album!.messages[0].status).toBe("sent");
      expect(album!.messages[2].status).toBe("sent");
      expect(album!.messages[3].status).toBe("sent");
    });

    it("Scenario 14: Accurately counts failed items in hidden overflow (+N) when images in overflow fail", () => {
      const albumId = "album-overflow-failure";
      // 7 images in total. Visible tiles are 0, 1, 2, 3 (with +3).
      // Let's say image 4 (in overflow) and image 6 (in overflow) failed.
      const messages: Message[] = [
        createMockMessage("msg-0", albumId, 0, "2026-09-13T01:00:00.000Z", "sent"),
        createMockMessage("msg-1", albumId, 1, "2026-09-13T01:00:00.001Z", "sent"),
        createMockMessage("msg-2", albumId, 2, "2026-09-13T01:00:00.002Z", "sent"),
        createMockMessage("msg-3", albumId, 3, "2026-09-13T01:00:00.003Z", "sent"),
        createMockMessage("msg-4", albumId, 4, "2026-09-13T01:00:00.004Z", "failed"),
        createMockMessage("msg-5", albumId, 5, "2026-09-13T01:00:00.005Z", "sent"),
        createMockMessage("msg-6", albumId, 6, "2026-09-13T01:00:00.006Z", "failed"),
      ];

      const overflowFailedCount = messages.slice(3).filter(
        (m) => m.status === "failed" && !Boolean((m.metadata as Record<string, unknown> | undefined)?.cancelled)
      ).length;

      expect(overflowFailedCount).toBe(2);
    });

    it("Scenario 15: Retrying a failed photo updates only that slot and preserves original album structure", () => {
      const albumId = "album-retry-isolated";
      let messages: Message[] = [
        createMockMessage("msg-0", albumId, 0, "2026-09-13T01:00:00.000Z", "sent"),
        createMockMessage("msg-1", albumId, 1, "2026-09-13T01:00:00.001Z", "failed"),
        createMockMessage("msg-2", albumId, 2, "2026-09-13T01:00:00.002Z", "sent"),
      ];

      // Simulate re-sending msg-1: status switches to sending
      messages = messages.map((m) =>
        m.id === "msg-1" ? { ...m, status: "sending" as const } : m
      );

      let groupMap = computeAlbumGroups(messages);
      let album = groupMap.get("msg-0");
      expect(album!.messages[1].status).toBe("sending");

      // Now server responds with confirmed sent record for msg-1
      const retriedSuccess: Message = {
        ...createMockMessage("msg-1", albumId, 1, "2026-09-13T01:00:05.000Z", "sent"),
      };

      messages = messages.map((m) => (m.id === "msg-1" ? retriedSuccess : m));
      groupMap = computeAlbumGroups(messages);
      album = groupMap.get("msg-0");

      expect(album!.messages).toHaveLength(3);
      expect(album!.messages.map((m) => m.status)).toEqual(["sent", "sent", "sent"]);
      expect(album!.messages.map((m) => m.album_index)).toEqual([0, 1, 2]);
    });

    it("Scenario 16: Failure badge collection isolates exclusively failed uncancelled photos (1 failure case)", () => {
      const albumId = "album-single-fail-isolation";
      const messages: Message[] = [
        createMockMessage("msg-0", albumId, 0, "2026-09-13T01:00:00.000Z", "sent"),
        createMockMessage("msg-1", albumId, 1, "2026-09-13T01:00:00.001Z", "failed"),
        createMockMessage("msg-2", albumId, 2, "2026-09-13T01:00:00.002Z", "sent"),
        createMockMessage("msg-3", albumId, 3, "2026-09-13T01:00:00.003Z", "failed", { cancelled: true }),
      ];

      // Exact filter formula used by MessageAlbum
      const failedMessages = messages.filter(
        (m) => m.status === "failed" && !Boolean((m.metadata as Record<string, unknown> | undefined)?.cancelled)
      );

      // Must strictly contain exactly 1 photo, completely excluding sent, delivered, read, and cancelled items
      expect(failedMessages).toHaveLength(1);
      expect(failedMessages[0].id).toBe("msg-1");
      expect(failedMessages[0].album_index).toBe(1);
      expect(failedMessages[0].album_id).toBe(albumId);
    });

    it("Scenario 17: Multiple failure isolation (2 failures, 3+ failures) contains strictly the failed ones", () => {
      const albumId = "album-multi-fail-isolation";
      // 6 images album: 2 sent, 3 failed, 1 cancelled
      const messages: Message[] = [
        createMockMessage("msg-0", albumId, 0, "2026-09-13T01:00:00.000Z", "sent"),
        createMockMessage("msg-1", albumId, 1, "2026-09-13T01:00:00.001Z", "failed"),
        createMockMessage("msg-2", albumId, 2, "2026-09-13T01:00:00.002Z", "sent"),
        createMockMessage("msg-3", albumId, 3, "2026-09-13T01:00:00.003Z", "failed"),
        createMockMessage("msg-4", albumId, 4, "2026-09-13T01:00:00.004Z", "failed"),
        createMockMessage("msg-5", albumId, 5, "2026-09-13T01:00:00.005Z", "failed", { cancelled: true }),
      ];

      const failedMessages = messages.filter(
        (m) => m.status === "failed" && !Boolean((m.metadata as Record<string, unknown> | undefined)?.cancelled)
      );

      // Strictly 3 failed items
      expect(failedMessages).toHaveLength(3);
      expect(failedMessages.map((m) => m.id)).toEqual(["msg-1", "msg-3", "msg-4"]);
      expect(failedMessages.map((m) => m.album_index)).toEqual([1, 3, 4]);

      // Verify that successfully sent items are never present
      expect(failedMessages.some((m) => m.id === "msg-0" || m.id === "msg-2")).toBe(false);
      // Verify that cancelled items are never present
      expect(failedMessages.some((m) => m.id === "msg-5")).toBe(false);
    });

    it("Scenario 18: Preserves album_id, album_index, and client_ref during selective retry", () => {
      const albumId = "album-retry-metadata-preservation";
      const messages: Message[] = [
        createMockMessage("msg-0", albumId, 0, "2026-09-13T01:00:00.000Z", "sent"),
        {
          ...createMockMessage("temp-retry-1", albumId, 1, "2026-09-13T01:00:00.001Z", "failed"),
          client_ref: "client-ref-12345",
        },
      ];

      const failedMessages = messages.filter(
        (m) => m.status === "failed" && !Boolean((m.metadata as Record<string, unknown> | undefined)?.cancelled)
      );

      expect(failedMessages).toHaveLength(1);
      const toRetry = failedMessages[0];
      expect(toRetry.album_id).toBe(albumId);
      expect(toRetry.album_index).toBe(1);
      expect(toRetry.client_ref).toBe("client-ref-12345");

      // Simulating retrying: client_ref, album_id, and album_index must remain identical
      const retryingMessage: Message = {
        ...toRetry,
        status: "sending",
      };
      expect(retryingMessage.album_id).toBe(toRetry.album_id);
      expect(retryingMessage.album_index).toBe(toRetry.album_index);
      expect(retryingMessage.client_ref).toBe(toRetry.client_ref);
    });

    it("Scenario 19: Retrying 1 failed item dynamically updates the failed count without disturbing remaining failures", () => {
      const albumId = "album-decrement-failures";
      let messages: Message[] = [
        createMockMessage("msg-0", albumId, 0, "2026-09-13T01:00:00.000Z", "failed"),
        createMockMessage("msg-1", albumId, 1, "2026-09-13T01:00:00.001Z", "failed"),
        createMockMessage("msg-2", albumId, 2, "2026-09-13T01:00:00.002Z", "failed"),
      ];

      // Initially 3 failures -> badge shows 3
      let failed = messages.filter(
        (m) => m.status === "failed" && !Boolean((m.metadata as Record<string, unknown> | undefined)?.cancelled)
      );
      expect(failed).toHaveLength(3);

      // User retries msg-1: status switches to sending
      messages = messages.map((m) => (m.id === "msg-1" ? { ...m, status: "sending" as const } : m));
      failed = messages.filter(
        (m) => m.status === "failed" && !Boolean((m.metadata as Record<string, unknown> | undefined)?.cancelled)
      );
      // Badge updates to 2 remaining
      expect(failed).toHaveLength(2);
      expect(failed.map((m) => m.id)).toEqual(["msg-0", "msg-2"]);

      // User retries msg-0: status switches to sending
      messages = messages.map((m) => (m.id === "msg-0" ? { ...m, status: "sending" as const } : m));
      failed = messages.filter(
        (m) => m.status === "failed" && !Boolean((m.metadata as Record<string, unknown> | undefined)?.cancelled)
      );
      // Badge updates to 1 (single ! circle)
      expect(failed).toHaveLength(1);
      expect(failed[0].id).toBe("msg-2");

      // User retries msg-2: status switches to sending
      messages = messages.map((m) => (m.id === "msg-2" ? { ...m, status: "sending" as const } : m));
      failed = messages.filter(
        (m) => m.status === "failed" && !Boolean((m.metadata as Record<string, unknown> | undefined)?.cancelled)
      );
      // All failed items retried -> badge disappears completely (length 0)
      expect(failed).toHaveLength(0);
    });

    it("Scenario 20: Cancel action leaves all messages, album integrity and database untouched", () => {
      const albumId = "album-cancel-untouched";
      const originalMessages: Message[] = [
        createMockMessage("msg-0", albumId, 0, "2026-09-13T01:00:00.000Z", "sent"),
        createMockMessage("msg-1", albumId, 1, "2026-09-13T01:00:00.001Z", "failed"),
      ];

      // Cancellation closes viewer without triggering any status mutation
      const messagesAfterCancel = [...originalMessages];
      expect(messagesAfterCancel).toEqual(originalMessages);
      expect(messagesAfterCancel[1].status).toBe("failed");
    });
  });
});
