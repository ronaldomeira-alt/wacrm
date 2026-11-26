import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const metaMocks = vi.hoisted(() => ({
  sendMediaMessage: vi.fn(),
  sendTextMessage: vi.fn(),
  sendTemplateMessage: vi.fn(),
  sendInteractiveButtons: vi.fn(),
  sendInteractiveList: vi.fn(),
}));

vi.mock('@/lib/whatsapp/meta-api', () => ({
  sendMediaMessage: metaMocks.sendMediaMessage,
  sendTextMessage: metaMocks.sendTextMessage,
  sendTemplateMessage: metaMocks.sendTemplateMessage,
  sendInteractiveButtons: metaMocks.sendInteractiveButtons,
  sendInteractiveList: metaMocks.sendInteractiveList,
  MetaApiError: class extends Error {
    httpStatus = 500;
    code = 0;
  },
}));

vi.mock('@/lib/automations/engine', () => ({ runAutomationsForTrigger: vi.fn(async () => {}) }));
vi.mock('@/lib/whatsapp/ctwa-fep', () => ({ maybeActivateCtwaFep: vi.fn(async () => {}) }));
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: vi.fn() }));
vi.mock('@/lib/documents/generate-document-preview', () => ({
  generateDocumentPreviewFromUrl: vi.fn(async () => {}),
  looksLikePdf: () => false,
}));
vi.mock('@/lib/storage/resolve-media-for-send', () => ({
  resolveMediaUrlForSend: vi.fn(async (u: string) => u),
}));
vi.mock('@/lib/ai/transcribe-audio', () => ({
  transcribeAgentAudioMessage: vi.fn(async () => {}),
}));
vi.mock('@/lib/whatsapp/session-window', () => ({
  getConversationSessionStatus: vi.fn(async () => ({ windowOpen: true })),
  validateApprovedTemplateSubmission: vi.fn(() => ({ valid: true })),
}));

import { sendMessageToConversation } from './send-message';

function makeIdempotencyDb(existingRow: { id: string; message_id: string | null; status: string }): SupabaseClient {
  const conversationData = {
    id: 'conv-1',
    account_id: 'acct-1',
    assigned_agent_id: null,
    ai_transfer_status: null,
    last_customer_message_at: new Date().toISOString(),
    contact: { id: 'c-1', phone: '5511999999999' },
  };

  return {
    from(table: string) {
      if (table === 'conversations') {
        const chain: Record<string, unknown> = {
          select: () => chain,
          eq: () => chain,
          single: async () => ({ data: conversationData, error: null }),
        };
        return chain;
      }
      if (table === 'messages') {
        const chain: Record<string, unknown> = {
          upsert: () => ({
            select: () => ({
              // Lost the claim race -> returns null so we check existing row
              maybeSingle: async () => ({ data: null, error: null }),
            }),
          }),
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: existingRow, error: null }),
            }),
          }),
        };
        return chain;
      }
      throw new Error(`Unexpected table ${table}`);
    },
  } as unknown as SupabaseClient;
}

describe('sendMessageToConversation — idempotency on delivered/read statuses', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  for (const status of ['sent', 'delivered', 'read'] as const) {
    it(`returns idempotent deduplicated success when existing row status is "${status}"`, async () => {
      const db = makeIdempotencyDb({
        id: 'db-msg-1',
        message_id: 'wamid.existing.123',
        status,
      });

      const res = await sendMessageToConversation(db, 'acct-1', {
        conversationId: 'conv-1',
        messageType: 'audio',
        mediaUrl: 'acct-1/audio/voice.ogg',
        clientRef: 'rec-idemp-1',
      });

      expect(res).toEqual({
        messageId: 'db-msg-1',
        whatsappMessageId: 'wamid.existing.123',
        deduplicated: true,
      });
      expect(metaMocks.sendMediaMessage).not.toHaveBeenCalled();
    });
  }
});
