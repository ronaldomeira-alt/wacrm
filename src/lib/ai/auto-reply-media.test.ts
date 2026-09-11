import { describe, it, expect, vi, beforeEach } from 'vitest'
import { dispatchInboundToAiReply } from './auto-reply'
import * as configMod from './config'
import * as contextMod from './context'
import * as engineMod from './conversation-engine'
import * as metaSendMod from '@/lib/flows/meta-send'

describe('AI Auto-Reply with Property Media Sending', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('sends decided property media before text message', async () => {
    const mockAiConfig = {
      provider: 'openai' as const,
      model: 'gpt-4o-mini',
      apiKey: 'sk-test',
      systemPrompt: null,
      isActive: true,
      autoReplyEnabled: true,
      autoReplyMaxPerConversation: 8,
      handoffAgentId: null,
      embeddingsApiKey: null,
    }

    vi.spyOn(configMod, 'loadAiConfig').mockResolvedValue(mockAiConfig)
    vi.spyOn(contextMod, 'buildConversationContext').mockResolvedValue([
      { role: 'user', content: 'Tem fotos da piscina do empreendimento?' },
    ])

    const mockTurnResult: engineMod.ConversationalTurnResult = {
      responseText: 'Aqui está a foto da nossa área de lazer e piscina!',
      handoff: false,
      decision: {
        response_text: 'Aqui está a foto da nossa área de lazer e piscina!',
        transfer_required: false,
        boundary_type: null,
        reason: 'Fotos da piscina solicitadas',
        context_summary: 'Enviada foto da piscina',
        suggested_next_action: null,
        send_media: [
          {
            property_id: 'prop-1',
            media_id: 'img-piscina-1',
            caption: 'Piscina com borda infinita',
          },
        ],
      },
      usage: null,
      retrievedKnowledgeCount: 1,
      retrievedKnowledge: ['Piscina aquecida'],
      systemPrompt: 'prompt',
      propertyInfo: { id: 'prop-1', name: 'Puerto Ventura' },
      availableMedia: [
        {
          id: 'img-piscina-1',
          type: 'image',
          description: 'Piscina com borda infinita',
          file_name: 'piscina.jpg',
          is_cover: false,
        },
      ],
      validatedMediaToSend: [
        {
          mediaId: 'img-piscina-1',
          propertyId: 'prop-1',
          storagePath: 'account-1/piscina.jpg',
          publicUrl: 'https://storage.supabase.co/property-media/account-1/piscina.jpg',
          caption: 'Piscina com borda infinita',
          fileName: 'piscina.jpg',
          contentType: 'image/jpeg',
        },
      ],
      businessHoursContext: {
        isBusinessHours: true,
        startHour: '08:00',
        endHour: '18:00',
        instructionForModel: '',
        offHoursInstructions: null,
      },
      leadContext: null,
    }

    vi.spyOn(engineMod, 'executeConversationalTurn').mockResolvedValue(mockTurnResult)

    const sendMediaSpy = vi
      .spyOn(metaSendMod, 'engineSendMedia')
      .mockResolvedValue({ whatsapp_message_id: 'wamid-media-1' })
    const sendTextSpy = vi
      .spyOn(metaSendMod, 'engineSendText')
      .mockResolvedValue({ whatsapp_message_id: 'wamid-text-1' })

    const mockAdminDb = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'automations' || table === 'flow_runs') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            in: vi.fn().mockReturnThis(),
            limit: vi.fn().mockResolvedValue({ data: [] }),
          }
        }
        if (table === 'conversations') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                id: 'conv-1',
                assigned_agent_id: null,
                ai_autoreply_disabled: false,
                ai_reply_count: 1,
                property_id: 'prop-1',
                ai_transfer_status: null,
                ctwa_referral: null,
              },
              error: null,
            }),
            update: vi.fn().mockReturnThis(),
          }
        }
        if (table === 'messages') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            gte: vi.fn().mockReturnThis(),
            gt: vi.fn().mockReturnThis(),
            order: vi.fn().mockReturnThis(),
            limit: vi.fn().mockResolvedValue({ data: [] }),
          }
        }
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        }
      }),
      rpc: vi.fn().mockResolvedValue({ data: true, error: null }),
    }

    const adminClientMod = await import('./admin-client')
    vi.spyOn(adminClientMod, 'supabaseAdmin').mockReturnValue(mockAdminDb as never)

    await dispatchInboundToAiReply({
      accountId: 'account-1',
      conversationId: 'conv-1',
      contactId: 'contact-1',
      configOwnerUserId: 'user-1',
    })

    expect(sendMediaSpy).toHaveBeenCalledTimes(1)
    expect(sendMediaSpy).toHaveBeenCalledWith({
      accountId: 'account-1',
      userId: 'user-1',
      conversationId: 'conv-1',
      contactId: 'contact-1',
      kind: 'image',
      link: 'https://storage.supabase.co/property-media/account-1/piscina.jpg',
      caption: 'Piscina com borda infinita',
      aiGenerated: true,
    })

    expect(sendTextSpy).toHaveBeenCalledTimes(1)
    expect(sendTextSpy).toHaveBeenCalledWith({
      accountId: 'account-1',
      userId: 'user-1',
      conversationId: 'conv-1',
      contactId: 'contact-1',
      text: 'Aqui está a foto da nossa área de lazer e piscina!',
      aiGenerated: true,
    })
  })
})
