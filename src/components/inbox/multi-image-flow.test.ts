import { describe, it, expect } from "vitest";
import { computeAlbumGroups } from "./message-album";
import type { Message } from "@/types";

describe("Multi-Image Album Flow & Optimistic Grouping", () => {
  function makeOptimisticBatch(count: number, baseTime = 1700000000000, caption?: string): Message[] {
    return Array.from({ length: count }, (_, i) => ({
      id: `temp-${baseTime}-${i}`,
      conversation_id: "conv-1",
      sender_type: "agent" as const,
      sender_id: "user-1",
      content_type: "image" as const,
      content_text: i === 0 ? caption : undefined,
      media_url: `blob:http://localhost:3000/mock-uuid-${i}`,
      status: "sending" as const,
      created_at: new Date(baseTime + i * 10).toISOString(),
    }));
  }

  it("1. Single image: does NOT form an album (preserves single bubble flow)", () => {
    const singleMessage = makeOptimisticBatch(1);
    const groups = computeAlbumGroups(singleMessage);

    expect(groups.size).toBe(0);
    expect(groups.get(singleMessage[0].id)).toBeUndefined();
  });

  it("2. 2 images: forms an album with exactly 2 images immediately", () => {
    const messages = makeOptimisticBatch(2);
    const groups = computeAlbumGroups(messages);

    expect(groups.size).toBe(2);
    const group = groups.get(messages[0].id);
    expect(group).toBeDefined();
    expect(group!.messages).toHaveLength(2);
    expect(group!.id).toBe(messages[0].id);
  });

  it("3. 3 images: forms an album with exactly 3 images immediately", () => {
    const messages = makeOptimisticBatch(3);
    const groups = computeAlbumGroups(messages);

    expect(groups.size).toBe(3);
    const group = groups.get(messages[0].id);
    expect(group!.messages).toHaveLength(3);
  });

  it("4. 4 images: forms an album with exactly 4 images immediately", () => {
    const messages = makeOptimisticBatch(4);
    const groups = computeAlbumGroups(messages);

    expect(groups.size).toBe(4);
    const group = groups.get(messages[0].id);
    expect(group!.messages).toHaveLength(4);
  });

  it("5. 7 images: forms a stable album born with 7 images at once", () => {
    const messages = makeOptimisticBatch(7, 1700000000000, "Fotos do empreendimento");
    const groups = computeAlbumGroups(messages);

    expect(groups.size).toBe(7);
    const group = groups.get(messages[0].id);
    expect(group).toBeDefined();
    expect(group!.messages).toHaveLength(7);
    expect(group!.messages[0].content_text).toBe("Fotos do empreendimento");

    // All 7 messages point to the same group reference
    for (const msg of messages) {
      expect(groups.get(msg.id)).toBe(group);
    }
  });

  it("6. 10 images: forms a stable album born with 10 images at once", () => {
    const messages = makeOptimisticBatch(10);
    const groups = computeAlbumGroups(messages);

    expect(groups.size).toBe(10);
    const group = groups.get(messages[0].id);
    expect(group!.messages).toHaveLength(10);
  });

  it("7. Stable structure: album structure does not change when messages resolve from 'sending' to 'sent'", () => {
    const baseTime = 1700000000000;
    const initialBatch = makeOptimisticBatch(7, baseTime);

    const initialGroups = computeAlbumGroups(initialBatch);
    expect(initialGroups.get(initialBatch[0].id)!.messages).toHaveLength(7);

    // Now simulate messages settling from 'sending' to 'sent' with remote R2 key
    const resolvedBatch: Message[] = initialBatch.map((m, i) => ({
      ...m,
      status: (i === 3 ? "failed" : "sent") as Message["status"], // 1 image failed, 6 sent
      media_url: i === 3 ? m.media_url : `chat-attachments/account/prop-${i}.jpg`,
    }));

    const resolvedGroups = computeAlbumGroups(resolvedBatch);
    const resolvedGroup = resolvedGroups.get(resolvedBatch[0].id);

    expect(resolvedGroup).toBeDefined();
    // Album STILL contains all 7 images!
    expect(resolvedGroup!.messages).toHaveLength(7);
    expect(resolvedGroup!.messages[3].status).toBe("failed");
    expect(resolvedGroup!.messages[0].status).toBe("sent");
  });

  it("8. Respects ALBUM_MAX_GAP_MS (8,000ms): 10ms spaced timestamps are grouped", () => {
    const baseTime = 1700000000000;
    const messages = makeOptimisticBatch(5, baseTime);

    // Gaps: 10ms each
    for (let i = 1; i < messages.length; i++) {
      const gap = new Date(messages[i].created_at).getTime() - new Date(messages[i - 1].created_at).getTime();
      expect(gap).toBe(10);
      expect(gap).toBeLessThanOrEqual(8000);
    }

    const groups = computeAlbumGroups(messages);
    expect(groups.size).toBe(5);
  });

  it("9. Splitting behavior: images with gap > 8,000ms are correctly separated", () => {
    const baseTime = 1700000000000;
    const batch1 = makeOptimisticBatch(2, baseTime);
    // 2nd batch 10 seconds later
    const batch2 = makeOptimisticBatch(2, baseTime + 10_000);

    const allMessages = [...batch1, ...batch2];
    const groups = computeAlbumGroups(allMessages);

    const group1 = groups.get(batch1[0].id);
    const group2 = groups.get(batch2[0].id);

    expect(group1).toBeDefined();
    expect(group2).toBeDefined();
    expect(group1!.id).not.toBe(group2!.id);
    expect(group1!.messages).toHaveLength(2);
    expect(group2!.messages).toHaveLength(2);
  });

  it("10. Preserves original order: message sequence matches selection order", () => {
    const messages = makeOptimisticBatch(7);
    const groups = computeAlbumGroups(messages);
    const album = groups.get(messages[0].id)!;

    const idsInAlbum = album.messages.map((m) => m.id);
    const expectedIds = messages.map((m) => m.id);

    expect(idsInAlbum).toEqual(expectedIds);
  });

  it("11. album_id priority: 6 images with extreme delays (up to 40s) remain a single unified album", () => {
    const baseTime = 1700000000000;
    const albumId = "album-batch-uuid-1234";

    // User scenario:
    // Foto 1 -> 2s
    // Foto 2 -> 3s
    // Foto 3 -> 4s
    // Foto 4 -> 5s
    // Foto 5 -> 25s (gap of 20s from Foto 4!)
    // Foto 6 -> 40s (gap of 15s from Foto 5!)
    const delays = [2_000, 3_000, 4_000, 5_000, 25_000, 40_000];

    const messages: Message[] = delays.map((delay, idx) => ({
      id: `msg-${idx + 1}`,
      conversation_id: "conv-1",
      sender_type: "agent",
      sender_id: "user-1",
      content_type: "image",
      content_text: idx === 0 ? "Empreendimento Completo" : undefined,
      media_url: `chat-attachments/account/img-${idx + 1}.jpg`,
      status: "sent",
      created_at: new Date(baseTime + delay).toISOString(),
      album_id: albumId,
    }));

    const groups = computeAlbumGroups(messages);

    // All 6 messages must be present in the grouping
    expect(groups.size).toBe(6);

    // The album must contain all 6 messages as one single unified group
    const album = groups.get(messages[0].id);
    expect(album).toBeDefined();
    expect(album!.messages).toHaveLength(6);
    expect(album!.id).toBe("album-batch-uuid-1234");

    // Every message references the exact same album group
    for (const msg of messages) {
      expect(groups.get(msg.id)).toBe(album);
    }
  });

  it("12. album_id distinction: two separate batches sent shortly apart do NOT merge", () => {
    const baseTime = 1700000000000;
    const albumA = "album-batch-A";
    const albumB = "album-batch-B";

    const batchA: Message[] = [
      {
        id: "msg-a1",
        conversation_id: "conv-1",
        sender_type: "agent",
        sender_id: "user-1",
        content_type: "image",
        media_url: "r2/a1.jpg",
        status: "sent",
        created_at: new Date(baseTime).toISOString(),
        album_id: albumA,
      },
      {
        id: "msg-a2",
        conversation_id: "conv-1",
        sender_type: "agent",
        sender_id: "user-1",
        content_type: "image",
        media_url: "r2/a2.jpg",
        status: "sent",
        created_at: new Date(baseTime + 1000).toISOString(),
        album_id: albumA,
      },
    ];

    const batchB: Message[] = [
      {
        id: "msg-b1",
        conversation_id: "conv-1",
        sender_type: "agent",
        sender_id: "user-1",
        content_type: "image",
        media_url: "r2/b1.jpg",
        status: "sent",
        created_at: new Date(baseTime + 2000).toISOString(), // within 1s of batchA
        album_id: albumB,
      },
      {
        id: "msg-b2",
        conversation_id: "conv-1",
        sender_type: "agent",
        sender_id: "user-1",
        content_type: "image",
        media_url: "r2/b2.jpg",
        status: "sent",
        created_at: new Date(baseTime + 3000).toISOString(),
        album_id: albumB,
      },
    ];

    const groups = computeAlbumGroups([...batchA, ...batchB]);

    expect(groups.size).toBe(4);
    const groupA = groups.get("msg-a1");
    const groupB = groups.get("msg-b1");

    expect(groupA).toBeDefined();
    expect(groupB).toBeDefined();
    expect(groupA!.id).toBe("album-batch-A");
    expect(groupB!.id).toBe("album-batch-B");
    expect(groupA!.messages).toHaveLength(2);
    expect(groupB!.messages).toHaveLength(2);
  });
});
