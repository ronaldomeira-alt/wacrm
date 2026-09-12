import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  isExplicitMediaRequest,
  didAssistantOfferMedia,
  isAffirmativeConfirmation,
  isMediaSendAuthorized,
  executeConversationalTurn,
  type ConversationalTurnArgs,
} from './conversation-engine';
import { dispatchInboundToAiReply } from './auto-reply';
import * as configMod from './config';
import * as contextMod from './context';
import * as engineMod from './conversation-engine';
import * as metaSendMod from '@/lib/flows/meta-send';
import type { AiConfig, PropertyMediaSummary } from './types';

describe('Media Authorization Guard - Scenarios 1 to 12', () => {
  const baseConfig: AiConfig = {
    provider: 'openai',
    model: 'gpt-4o-mini',
    apiKey: 'sk-test',
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: true,
    autoReplyMaxPerConversation: 8,
    handoffAgentId: null,
    embeddingsApiKey: null,
  };

  const sampleMediaPool: PropertyMediaSummary[] = [
    {
      id: 'media-fachada-1',
      type: 'image',
      description: 'Fachada frontal imponente com pele de vidro e paisagismo',
      file_name: 'fachada.jpg',
      is_cover: false,
    },
    {
      id: 'media-lazer-piscina',
      type: 'image',
      description: 'Área de lazer com piscina de borda infinita e deck molhado',
      file_name: 'piscina.jpg',
      is_cover: false,
    },
    {
      id: 'media-lazer-gourmet',
      type: 'image',
      description: 'Espaço gourmet integrado e área de churrasqueira',
      file_name: 'gourmet.jpg',
      is_cover: false,
    },
    {
      id: 'media-planta-tipo',
      type: 'image',
      description: 'Planta baixa tipo com 3 suítes e varanda gourmet',
      file_name: 'planta_3suites.jpg',
      is_cover: false,
    },
    {
      id: 'media-academia',
      type: 'image',
      description: 'Academia completa e climatizada',
      file_name: 'academia.jpg',
      is_cover: false,
    },
  ];

  function createMockDb(mediaItems: PropertyMediaSummary[]) {
    return {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'properties') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: { id: 'prop-1', name: 'Puerto Ventura', status: 'ativo', cover_image_path: null },
              error: null,
            }),
          };
        }
        if (table === 'property_ai_contexts') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: { stage: 'lancamento', response_style_instructions: [] },
              error: null,
            }),
          };
        }
        if (table === 'property_images') {
          const makeBuilder = () => {
            const builder: any = {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
              in: vi.fn().mockImplementation((_col: string, ids: string[]) => {
                const filtered = mediaItems.filter((m) => ids.includes(m.id));
                return Promise.resolve({
                  data: filtered.map((m, idx) => ({
                    id: m.id,
                    property_id: 'prop-1',
                    storage_path: `account-1/${m.file_name}`,
                    file_name: m.file_name,
                    content_type: 'image/jpeg',
                    description: m.description,
                    is_cover: m.is_cover,
                    position: idx,
                  })),
                  error: null,
                });
              }),
              order: vi.fn().mockImplementation(() => builder),
              then: (resolve: (val: any) => void) => {
                resolve({
                  data: mediaItems.map((m, idx) => ({
                    id: m.id,
                    property_id: 'prop-1',
                    storage_path: `account-1/${m.file_name}`,
                    file_name: m.file_name,
                    content_type: 'image/jpeg',
                    description: m.description,
                    is_cover: m.is_cover,
                    position: idx,
                  })),
                  error: null,
                });
              },
            };
            return builder;
          };
          return makeBuilder();
        }
        if (table === 'property_knowledge') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            order: vi.fn().mockResolvedValue({ data: [], error: null }),
          };
        }
        if (table === 'ai_global_knowledge') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            order: vi.fn().mockResolvedValue({ data: [], error: null }),
          };
        }
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        };
      }),
      storage: {
        from: vi.fn().mockReturnValue({
          getPublicUrl: vi.fn().mockImplementation((path: string) => ({
            data: { publicUrl: `https://storage.supabase.co/property-media/${path}` },
          })),
        }),
      },
    } as never;
  }

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // TEST 1: Primeiro turno: "Olá, gostaria de mais informações"
  it('CENÁRIO 1: Primeiro turno com "Olá, gostaria de mais informações" não autoriza envio de mídia', () => {
    const messages = [{ role: 'user' as const, content: 'Olá, gostaria de mais informações' }];
    const auth = isMediaSendAuthorized({
      messages,
      isInitialContact: true,
      userMessageCount: 1,
    });

    expect(auth.authorized).toBe(false);
    expect(auth.reason).toContain('Primeiro contato sem solicitação explícita de mídia');
  });

  // TEST 2: Primeiro turno: "Quero investir no Bessa"
  it('CENÁRIO 2: Primeiro turno com "Quero investir no Bessa" não autoriza envio de mídia', () => {
    const messages = [{ role: 'user' as const, content: 'Quero investir no Bessa' }];
    const auth = isMediaSendAuthorized({
      messages,
      isInitialContact: true,
      userMessageCount: 1,
    });

    expect(auth.authorized).toBe(false);
    expect(auth.reason).toContain('Primeiro contato sem solicitação explícita de mídia');
  });

  // TEST 3: Primeiro turno: "Quero investir em João Pessoa, manda mais informações!"
  it('CENÁRIO 3: Primeiro turno com "Quero investir em João Pessoa, manda mais informações!" não autoriza mídia ("manda" isolado não dispara fotos)', () => {
    const messages = [
      { role: 'user' as const, content: 'Quero investir em João Pessoa, manda mais informações!' },
    ];
    const auth = isMediaSendAuthorized({
      messages,
      isInitialContact: true,
      userMessageCount: 1,
    });

    expect(auth.authorized).toBe(false);
  });

  // TEST 4: Pedido explícito de fotos: "Pode me mandar fotos?"
  it('CENÁRIO 4: Pedido explícito "Pode me mandar fotos?" autoriza envio de mídias', () => {
    const messages = [{ role: 'user' as const, content: 'Pode me mandar fotos?' }];
    const auth = isMediaSendAuthorized({
      messages,
      isInitialContact: true,
      userMessageCount: 1,
    });

    expect(auth.authorized).toBe(true);
    expect(auth.filterTopic).toBe('geral');
  });

  // TEST 5: Pedido específico de área de lazer: "Quero ver a área de lazer"
  it('CENÁRIO 5: Pedido visual de lazer "Quero ver a área de lazer" autoriza e filtra para tópico lazer', () => {
    const messages = [{ role: 'user' as const, content: 'Quero ver a área de lazer' }];
    const auth = isMediaSendAuthorized({
      messages,
      isInitialContact: true,
      userMessageCount: 1,
    });

    expect(auth.authorized).toBe(true);
    expect(auth.filterTopic).toBe('lazer');
  });

  // TEST 6: Clara ofereceu fotos no turno anterior e o lead confirmou com "Sim"
  it('CENÁRIO 6: Turno 2 com Clara oferecendo fotos e lead respondendo "Sim" autoriza envio', () => {
    const messages = [
      { role: 'user' as const, content: 'Olá, gostaria de saber mais sobre o Puerto Ventura' },
      {
        role: 'assistant' as const,
        content: 'O Puerto Ventura fica no Bessa e possui 3 suítes. Quer que eu te envie algumas fotos do empreendimento?',
      },
      { role: 'user' as const, content: 'Sim' },
    ];

    const auth = isMediaSendAuthorized({
      messages,
      isInitialContact: false,
      userMessageCount: 2,
    });

    expect(auth.authorized).toBe(true);
    expect(auth.reason).toContain('confirmou afirmativamente oferta de fotos');
  });

  // TEST 7: Pedido amplo em turno subsequente: "Quero conhecer melhor o empreendimento"
  it('CENÁRIO 7: Pedido amplo no turno 2 sem menção a fotos não autoriza mídia', () => {
    const messages = [
      { role: 'user' as const, content: 'Olá!' },
      { role: 'assistant' as const, content: 'Olá! Como posso ajudar você hoje?' },
      { role: 'user' as const, content: 'Quero conhecer melhor o empreendimento' },
    ];

    const auth = isMediaSendAuthorized({
      messages,
      isInitialContact: false,
      userMessageCount: 2,
    });

    expect(auth.authorized).toBe(false);
  });

  // TEST 8: Contexto com 20 mídias cadastradas, mas lead não pediu fotos -> executeConversationalTurn não envia mídias
  it('CENÁRIO 8: Com 20 mídias no banco, se o lead não pedir fotos, validatedMediaToSend é vazio', async () => {
    const twentyMediaItems: PropertyMediaSummary[] = Array.from({ length: 20 }, (_, i) => ({
      id: `media-${i + 1}`,
      type: 'image',
      description: `Foto do empreendimento número ${i + 1}`,
      file_name: `foto_${i + 1}.jpg`,
      is_cover: false,
    }));

    const mockDb = createMockDb(twentyMediaItems);

    // Mock AI completion returning response without photo request
    const openAiMod = await import('./providers/openai');
    vi.spyOn(openAiMod, 'generateOpenAi').mockResolvedValue({
      text: JSON.stringify({
        response_text: 'O Puerto Ventura é um excelente investimento no Bessa.',
        transfer_required: false,
      }),
      usage: null,
    });

    const result = await executeConversationalTurn({
      db: mockDb,
      accountId: 'acc-1',
      config: baseConfig,
      propertyId: 'prop-1',
      messages: [{ role: 'user', content: 'Olá, gostaria de saber mais sobre as opções de investimento' }],
      replyCount: 0,
    });

    expect(result.mediaSendAllowed).toBe(false);
    expect(result.decision.send_media).toBeNull();
    expect(result.validatedMediaToSend).toEqual([]);
  });

  // TEST 9: Pedido de mídia específica (fachada): "Tem foto da fachada?"
  it('CENÁRIO 9: Pedido específico de fachada envia apenas fotos da fachada no auto-resolve', async () => {
    const mockDb = createMockDb(sampleMediaPool);

    const openAiMod = await import('./providers/openai');
    // Model returns text without send_media field, triggering topic-filtered auto-resolution
    vi.spyOn(openAiMod, 'generateOpenAi').mockResolvedValue({
      text: JSON.stringify({
        response_text: 'Aqui está a foto da fachada do Puerto Ventura!',
        transfer_required: false,
      }),
      usage: null,
    });

    const result = await executeConversationalTurn({
      db: mockDb,
      accountId: 'acc-1',
      config: baseConfig,
      propertyId: 'prop-1',
      messages: [{ role: 'user', content: 'Tem foto da fachada?' }],
      replyCount: 0,
    });

    expect(result.mediaSendAllowed).toBe(true);
    expect(result.validatedMediaToSend.length).toBeGreaterThan(0);
    // All returned items must match fachada
    for (const item of result.validatedMediaToSend) {
      expect(item.fileName.toLowerCase()).toContain('fachada');
    }
  });

  // TEST 10: Ordem de envio no WhatsApp: Texto primeiro, mídias autorizadas depois
  it('CENÁRIO 10: No dispatch de auto-reply, o texto da Clara é enviado PRIMEIRO e as mídias DEPOIS', async () => {
    vi.spyOn(configMod, 'loadAiConfig').mockResolvedValue(baseConfig);
    vi.spyOn(contextMod, 'buildConversationContext').mockResolvedValue([
      { role: 'user', content: 'Pode me mandar fotos do Puerto Ventura?' },
    ]);

    const mockTurnResult: engineMod.ConversationalTurnResult = {
      responseText: 'Aqui estão algumas fotos do Puerto Ventura para você conhecer!',
      handoff: false,
      decision: {
        response_text: 'Aqui estão algumas fotos do Puerto Ventura para você conhecer!',
        transfer_required: false,
        boundary_type: null,
        reason: null,
        context_summary: null,
        suggested_next_action: null,
        send_media: [
          {
            property_id: 'prop-1',
            media_id: 'media-fachada-1',
            caption: null,
          },
        ],
      },
      usage: null,
      retrievedKnowledgeCount: 1,
      retrievedKnowledge: [],
      systemPrompt: 'prompt',
      propertyInfo: { id: 'prop-1', name: 'Puerto Ventura' },
      availableMedia: sampleMediaPool,
      validatedMediaToSend: [
        {
          mediaId: 'media-fachada-1',
          propertyId: 'prop-1',
          storagePath: 'account-1/fachada.jpg',
          publicUrl: 'https://storage.supabase.co/property-media/account-1/fachada.jpg',
          caption: null,
          fileName: 'fachada.jpg',
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
      mediaSendAllowed: true,
    };

    vi.spyOn(engineMod, 'executeConversationalTurn').mockResolvedValue(mockTurnResult);

    const sendMediaSpy = vi
      .spyOn(metaSendMod, 'engineSendMedia')
      .mockResolvedValue({ whatsapp_message_id: 'wamid-media-10' });
    const sendTextSpy = vi
      .spyOn(metaSendMod, 'engineSendText')
      .mockResolvedValue({ whatsapp_message_id: 'wamid-text-10' });

    const mockAdminDb = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'automations' || table === 'flow_runs') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            in: vi.fn().mockReturnThis(),
            limit: vi.fn().mockResolvedValue({ data: [] }),
          };
        }
        if (table === 'conversations') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                id: 'conv-10',
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
          };
        }
        if (table === 'messages') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            gte: vi.fn().mockReturnThis(),
            gt: vi.fn().mockReturnThis(),
            order: vi.fn().mockReturnThis(),
            limit: vi.fn().mockResolvedValue({ data: [] }),
          };
        }
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        };
      }),
      rpc: vi.fn().mockResolvedValue({ data: true, error: null }),
    };

    const adminClientMod = await import('./admin-client');
    vi.spyOn(adminClientMod, 'supabaseAdmin').mockReturnValue(mockAdminDb as never);

    await dispatchInboundToAiReply({
      accountId: 'account-1',
      conversationId: 'conv-10',
      contactId: 'contact-10',
      configOwnerUserId: 'user-1',
    });

    expect(sendTextSpy).toHaveBeenCalledTimes(1);
    expect(sendMediaSpy).toHaveBeenCalledTimes(1);

    const textCallOrder = sendTextSpy.mock.invocationCallOrder[0];
    const mediaCallOrder = sendMediaSpy.mock.invocationCallOrder[0];
    expect(textCallOrder).toBeLessThan(mediaCallOrder);
  });

  // TEST 11: Turno 1 com conhecimento do empreendimento carregado -> Resposta conceitual, zero fotos sem solicitação
  it('CENÁRIO 11: Primeiro turno mesmo com dados de empreendimento carregados gera zero mídias se não houver pedido', async () => {
    const mockDb = createMockDb(sampleMediaPool);

    const openAiMod = await import('./providers/openai');
    // Model erroneously hallucinates send_media on first contact
    vi.spyOn(openAiMod, 'generateOpenAi').mockResolvedValue({
      text: JSON.stringify({
        response_text: 'O Puerto Ventura conta com excelente localização no Bessa.',
        send_media: [
          { property_id: 'prop-1', media_id: 'media-fachada-1' },
          { property_id: 'prop-1', media_id: 'media-lazer-piscina' },
        ],
        transfer_required: false,
      }),
      usage: null,
    });

    const result = await executeConversationalTurn({
      db: mockDb,
      accountId: 'acc-1',
      config: baseConfig,
      propertyId: 'prop-1',
      messages: [{ role: 'user', content: 'Gostaria de conhecer o Puerto Ventura' }],
      replyCount: 0,
    });

    // Guard MUST intercept the LLM hallucination and strip send_media
    expect(result.mediaSendAllowed).toBe(false);
    expect(result.decision.send_media).toBeNull();
    expect(result.validatedMediaToSend).toEqual([]);
  });

  // TEST 12: Turno 2 ou 3 em que lead pede imagens: mídias são autorizadas e enviadas normalmente
  it('CENÁRIO 12: Turno subsequente onde o lead solicita imagens autoriza e envia as mídias normalmente', async () => {
    const mockDb = createMockDb(sampleMediaPool);

    const openAiMod = await import('./providers/openai');
    vi.spyOn(openAiMod, 'generateOpenAi').mockResolvedValue({
      text: JSON.stringify({
        response_text: 'Com certeza! Aqui estão as imagens do Puerto Ventura.',
        send_media: [{ property_id: 'prop-1', media_id: 'media-fachada-1' }],
        transfer_required: false,
      }),
      usage: null,
    });

    const messages = [
      { role: 'user' as const, content: 'Olá, gostaria de saber mais sobre o empreendimento' },
      {
        role: 'assistant' as const,
        content: 'Olá! O Puerto Ventura é um empreendimento de alto padrão no Bessa.',
      },
      { role: 'user' as const, content: 'Você tem imagens do projeto para me mostrar?' },
    ];

    const result = await executeConversationalTurn({
      db: mockDb,
      accountId: 'acc-1',
      config: baseConfig,
      propertyId: 'prop-1',
      messages,
      replyCount: 1,
    });

    expect(result.mediaSendAllowed).toBe(true);
    expect(result.validatedMediaToSend.length).toBeGreaterThan(0);
    expect(result.validatedMediaToSend[0].mediaId).toBe('media-fachada-1');
  });
});
