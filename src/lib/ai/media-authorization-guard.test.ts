import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  isMediaSendAuthorized,
  executeConversationalTurn,
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
            const builder: Record<string, unknown> = {
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
                    content_type: m.type === 'video' ? 'video/mp4' : 'image/jpeg',
                    description: m.description,
                    is_cover: m.is_cover,
                    position: idx,
                  })),
                  error: null,
                });
              }),
              order: vi.fn().mockImplementation(() => builder),
              then: (resolve: (val: unknown) => void) => {
                resolve({
                  data: mediaItems.map((m, idx) => ({
                    id: m.id,
                    property_id: 'prop-1',
                    storage_path: `account-1/${m.file_name}`,
                    file_name: m.file_name,
                    content_type: m.type === 'video' ? 'video/mp4' : 'image/jpeg',
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
          type: 'image',
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

  // TEST 13: Regression for the reported bug — Clara offers photos, lead
  // replies with a natural (non-imperative) confirmation, and the guard
  // must recognize it instead of forcing another round of text.
  it('CENÁRIO 13: Confirmação contextual "OK, pode mostrar" após oferta de fotos autoriza envio', () => {
    const messages = [
      { role: 'user' as const, content: 'Oi, queria saber mais sobre o apartamento' },
      {
        role: 'assistant' as const,
        content: 'Se quiser, posso te mostrar algumas fotos da sala, cozinha e área de lazer.',
      },
      { role: 'user' as const, content: 'OK, pode mostrar.' },
    ];

    const auth = isMediaSendAuthorized({
      messages,
      isInitialContact: false,
      userMessageCount: 2,
    });

    expect(auth.authorized).toBe(true);
    expect(auth.reason).toContain('confirmou afirmativamente oferta de fotos');
  });

  // TEST 14: A broader set of natural confirmations must all be recognized
  // as valid, as long as they answer a photo offer Clara just made.
  it.each([
    'Pode mandar',
    'Pode enviar',
    'Manda',
    'Pode mandar as fotos',
    'Quero ver',
    'Gostaria',
    'Sim',
    'Sim, pode',
    'Pode mostrar',
    'Pode enviar as fotos',
    'Aguardo',
    'Fico no aguardo',
    'Tá bom, pode mandar',
    'Perfeito, pode mostrar',
    'Ok',
    'Tudo bem',
  ])('CENÁRIO 14: Confirmação "%s" após oferta de fotos autoriza envio', (confirmation) => {
    const messages = [
      { role: 'user' as const, content: 'Oi, queria saber mais sobre o apartamento' },
      {
        role: 'assistant' as const,
        content: 'Se quiser, posso te enviar algumas fotos do apartamento.',
      },
      { role: 'user' as const, content: confirmation },
    ];

    const auth = isMediaSendAuthorized({
      messages,
      isInitialContact: false,
      userMessageCount: 2,
    });

    expect(auth.authorized).toBe(true);
  });

  // TEST 15: A vague signal of interest with NO prior photo offer must still
  // NOT authorize a send — the offer is what establishes the context.
  it('CENÁRIO 15: "Gostei" sem oferta prévia de fotos NÃO autoriza envio', () => {
    const messages = [
      { role: 'user' as const, content: 'Oi, queria saber mais sobre o apartamento' },
      {
        role: 'assistant' as const,
        content: 'O apartamento tem 2 quartos, 1 suíte e fica a 100m da praia.',
      },
      { role: 'user' as const, content: 'Gostei' },
    ];

    const auth = isMediaSendAuthorized({
      messages,
      isInitialContact: false,
      userMessageCount: 2,
    });

    expect(auth.authorized).toBe(false);
  });

  // TEST 16: FULL END-TO-END — from the LLM's raw decision all the way to
  // the real dispatch call that would hit WhatsApp. Nothing about
  // executeConversationalTurn is mocked here (only the LLM provider call
  // and the outbound Meta calls are stubbed), so this exercises the exact
  // production path: guard → auto-resolve → validateAndResolveMediaToSend
  // → dispatchInboundToAiReply → engineSendMedia. Deliberately reproduces
  // the reported failure mode: the model's JSON leaves send_media empty
  // (as if it only "promised" the photos in text) — proving the photos
  // still go out because authorization + auto-resolution do the work
  // independent of the model remembering to fill send_media itself.
  it('CENÁRIO 16: E2E — "OK, pode mostrar." após oferta de fotos resulta em envio real de mídia via dispatch', async () => {
    const mockDb = {
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
          const builder: Record<string, unknown> = {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            in: vi.fn().mockImplementation((_col: string, ids: string[]) => {
              const filtered = sampleMediaPool.filter((m) => ids.includes(m.id));
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
            then: (resolve: (val: unknown) => void) => {
              resolve({
                data: sampleMediaPool.map((m, idx) => ({
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
        }
        if (table === 'conversations') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                id: 'conv-16',
                assigned_agent_id: null,
                ai_autoreply_disabled: false,
                ai_reply_count: 1,
                property_id: 'prop-1',
                ai_transfer_status: null,
                ctwa_referral: null,
                ai_reactivation_status: null,
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
        if (table === 'automations' || table === 'flow_runs') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            in: vi.fn().mockReturnThis(),
            limit: vi.fn().mockResolvedValue({ data: [] }),
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
      rpc: vi.fn().mockResolvedValue({ data: true, error: null }),
    };

    vi.spyOn(configMod, 'loadAiConfig').mockResolvedValue(baseConfig);
    vi.spyOn(contextMod, 'buildConversationContext').mockResolvedValue([
      { role: 'user', content: 'Oi, queria saber mais sobre o apartamento' },
      {
        role: 'assistant',
        content: 'Se quiser, posso te mostrar algumas fotos da sala, cozinha e área de lazer.',
      },
      { role: 'user', content: 'OK, pode mostrar.' },
    ]);

    // Deliberately reproduces the bug's exact failure ingredient: the
    // model's JSON says it will show photos in text but leaves send_media
    // empty — the pre-fix code had nothing to fall back on once the
    // (broken) confirmation regex also failed; the auto-resolve step
    // (8c in conversation-engine.ts) is what must compensate now.
    const openAiMod = await import('./providers/openai');
    vi.spyOn(openAiMod, 'generateOpenAi').mockResolvedValue({
      text: JSON.stringify({
        response_text: 'Perfeito! Vou te mostrar agora.',
        transfer_required: false,
      }),
      usage: null,
    });

    const adminClientMod = await import('./admin-client');
    vi.spyOn(adminClientMod, 'supabaseAdmin').mockReturnValue(mockDb as never);

    const sendMediaSpy = vi
      .spyOn(metaSendMod, 'engineSendMedia')
      .mockResolvedValue({ whatsapp_message_id: 'wamid-media-16' });
    const sendTextSpy = vi
      .spyOn(metaSendMod, 'engineSendText')
      .mockResolvedValue({ whatsapp_message_id: 'wamid-text-16' });

    // Step 1 — run the real engine in isolation to inspect every stage of
    // the pipeline (not just the final authorized boolean).
    const turnResult = await executeConversationalTurn({
      db: mockDb as never,
      accountId: 'acc-1',
      config: baseConfig,
      conversationId: 'conv-16',
      contactId: 'contact-16',
      propertyId: 'prop-1',
      messages: [
        { role: 'user', content: 'Oi, queria saber mais sobre o apartamento' },
        {
          role: 'assistant',
          content: 'Se quiser, posso te mostrar algumas fotos da sala, cozinha e área de lazer.',
        },
        { role: 'user', content: 'OK, pode mostrar.' },
      ],
      replyCount: 1,
    });

    // Guard authorized the send from the contextual confirmation alone.
    expect(turnResult.mediaSendAllowed).toBe(true);
    // Auto-resolution filled send_media even though the model's JSON didn't.
    expect(turnResult.decision.send_media).not.toBeNull();
    expect(turnResult.decision.send_media!.length).toBeGreaterThan(0);
    // Media was validated against the DB and resolved to real public URLs.
    expect(turnResult.validatedMediaToSend.length).toBeGreaterThan(0);
    for (const item of turnResult.validatedMediaToSend) {
      expect(item.publicUrl).toContain('https://storage.supabase.co/property-media/');
    }

    // Step 2 — run the actual dispatch path (auto-reply.ts) end-to-end and
    // prove it reaches the real send call, not just a text promise.
    await dispatchInboundToAiReply({
      accountId: 'account-1',
      conversationId: 'conv-16',
      contactId: 'contact-16',
      configOwnerUserId: 'user-1',
      debounceMs: 0,
    });

    expect(sendTextSpy).toHaveBeenCalledTimes(1);
    expect(sendMediaSpy).toHaveBeenCalled();
    for (const call of sendMediaSpy.mock.calls) {
      expect(call[0].link).toContain('https://storage.supabase.co/property-media/');
      expect(call[0].kind).toBe('image');
    }

    // Text still goes out before media (ordering contract from CENÁRIO 10).
    const textCallOrder = sendTextSpy.mock.invocationCallOrder[0];
    const firstMediaCallOrder = sendMediaSpy.mock.invocationCallOrder[0];
    expect(textCallOrder).toBeLessThan(firstMediaCallOrder);
  });

  // ============================================================
  // Video support — reuses the exact same guard (isMediaSendAuthorized,
  // didAssistantOfferMedia, isAffirmativeConfirmation) with no new
  // authorization logic. These scenarios only add kind-awareness on top:
  // an offer/request that names a kind should not leak the other kind
  // into the send.
  // ============================================================
  const sampleMediaPoolWithVideo: PropertyMediaSummary[] = [
    ...sampleMediaPool,
    {
      id: 'media-video-lazer',
      type: 'video',
      description: 'Vídeo da área de lazer com piscina e deck',
      file_name: 'lazer.mp4',
      is_cover: false,
    },
  ];

  // TEST 17: Same offer+confirmation logic as photos, now for a video offer.
  it('CENÁRIO 17: Oferta explícita de vídeo + confirmação "Pode mandar." autoriza e identifica filterKind "video"', () => {
    const messages = [
      { role: 'user' as const, content: 'Oi, queria saber mais sobre o apartamento' },
      { role: 'assistant' as const, content: 'Posso te mostrar um vídeo da área de lazer.' },
      { role: 'user' as const, content: 'Pode mandar.' },
    ];

    const auth = isMediaSendAuthorized({
      messages,
      isInitialContact: false,
      userMessageCount: 2,
    });

    expect(auth.authorized).toBe(true);
    expect(auth.reason).toContain('confirmou afirmativamente');
    expect(auth.filterKind).toBe('video');
  });

  // TEST 18: Same "no offer, vague interest" guard as CENÁRIO 15 — the
  // rule is not video-specific, but the checklist calls it out explicitly.
  it('CENÁRIO 18: "Gostei" sem nenhuma oferta prévia NÃO autoriza envio (nem foto, nem vídeo)', () => {
    const messages = [
      { role: 'user' as const, content: 'Oi, queria saber mais sobre o apartamento' },
      {
        role: 'assistant' as const,
        content: 'O apartamento tem 2 quartos, 1 suíte e fica a 100m da praia.',
      },
      { role: 'user' as const, content: 'Gostei' },
    ];

    const auth = isMediaSendAuthorized({
      messages,
      isInitialContact: false,
      userMessageCount: 2,
    });

    expect(auth.authorized).toBe(false);
  });

  // TEST 19: Auto-resolve must be kind-aware — an explicit "vídeo" request
  // against a mixed gallery (5 photos + 1 video) must select ONLY the
  // video, never mix in photos.
  it('CENÁRIO 19: Pedido explícito "Manda o vídeo da área de lazer" com galeria mista seleciona somente o vídeo', async () => {
    const mockDb = createMockDb(sampleMediaPoolWithVideo);

    const openAiMod = await import('./providers/openai');
    vi.spyOn(openAiMod, 'generateOpenAi').mockResolvedValue({
      text: JSON.stringify({
        response_text: 'Claro! Aqui está o vídeo da área de lazer.',
        transfer_required: false,
      }),
      usage: null,
    });

    const result = await executeConversationalTurn({
      db: mockDb,
      accountId: 'acc-1',
      config: baseConfig,
      propertyId: 'prop-1',
      messages: [{ role: 'user', content: 'Manda o vídeo da área de lazer' }],
      replyCount: 0,
    });

    expect(result.mediaSendAllowed).toBe(true);
    expect(result.validatedMediaToSend.length).toBeGreaterThan(0);
    for (const item of result.validatedMediaToSend) {
      expect(item.type).toBe('video');
    }
  });

  // TEST 16 (inverse direction): the same kind-awareness must not let a
  // photo request pull in the video either.
  it('CENÁRIO 20: Pedido explícito "Manda as fotos" com galeria mista seleciona somente fotos, nunca o vídeo', async () => {
    const mockDb = createMockDb(sampleMediaPoolWithVideo);

    const openAiMod = await import('./providers/openai');
    vi.spyOn(openAiMod, 'generateOpenAi').mockResolvedValue({
      text: JSON.stringify({
        response_text: 'Claro! Aqui estão as fotos.',
        transfer_required: false,
      }),
      usage: null,
    });

    const result = await executeConversationalTurn({
      db: mockDb,
      accountId: 'acc-1',
      config: baseConfig,
      propertyId: 'prop-1',
      messages: [{ role: 'user', content: 'Manda as fotos' }],
      replyCount: 0,
    });

    expect(result.mediaSendAllowed).toBe(true);
    expect(result.validatedMediaToSend.length).toBeGreaterThan(0);
    for (const item of result.validatedMediaToSend) {
      expect(item.type).toBe('image');
    }
  });

  // TEST 12/13/18 (video E2E): full pipeline — offer → confirmation →
  // authorization → auto-resolved selection → DB validation → dispatch
  // — proving the send actually happens with kind: 'video', not just
  // that authorization returns true. Mirrors CENÁRIO 16 exactly, swapping
  // the photo offer/gallery for a video one.
  it('CENÁRIO 21: E2E vídeo — oferta + "Pode mandar." resulta em envio real com kind "video"', async () => {
    const mockDb = {
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
          const builder: Record<string, unknown> = {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            in: vi.fn().mockImplementation((_col: string, ids: string[]) => {
              const filtered = sampleMediaPoolWithVideo.filter((m) => ids.includes(m.id));
              return Promise.resolve({
                data: filtered.map((m, idx) => ({
                  id: m.id,
                  property_id: 'prop-1',
                  storage_path: `account-1/${m.file_name}`,
                  file_name: m.file_name,
                  content_type: m.type === 'video' ? 'video/mp4' : 'image/jpeg',
                  description: m.description,
                  is_cover: m.is_cover,
                  position: idx,
                })),
                error: null,
              });
            }),
            order: vi.fn().mockImplementation(() => builder),
            then: (resolve: (val: unknown) => void) => {
              resolve({
                data: sampleMediaPoolWithVideo.map((m, idx) => ({
                  id: m.id,
                  property_id: 'prop-1',
                  storage_path: `account-1/${m.file_name}`,
                  file_name: m.file_name,
                  content_type: m.type === 'video' ? 'video/mp4' : 'image/jpeg',
                  description: m.description,
                  is_cover: m.is_cover,
                  position: idx,
                })),
                error: null,
              });
            },
          };
          return builder;
        }
        if (table === 'conversations') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                id: 'conv-21',
                assigned_agent_id: null,
                ai_autoreply_disabled: false,
                ai_reply_count: 1,
                property_id: 'prop-1',
                ai_transfer_status: null,
                ctwa_referral: null,
                ai_reactivation_status: null,
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
        if (table === 'automations' || table === 'flow_runs') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            in: vi.fn().mockReturnThis(),
            limit: vi.fn().mockResolvedValue({ data: [] }),
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
      rpc: vi.fn().mockResolvedValue({ data: true, error: null }),
    };

    vi.spyOn(configMod, 'loadAiConfig').mockResolvedValue(baseConfig);
    vi.spyOn(contextMod, 'buildConversationContext').mockResolvedValue([
      { role: 'user', content: 'Oi, queria saber mais sobre o apartamento' },
      { role: 'assistant', content: 'Posso te mostrar um vídeo da área de lazer.' },
      { role: 'user', content: 'Pode mandar.' },
    ]);

    // Same failure ingredient as CENÁRIO 16: the model's JSON only
    // promises in text and leaves send_media empty — auto-resolve (now
    // kind-aware) must be what actually attaches the video.
    const openAiMod = await import('./providers/openai');
    vi.spyOn(openAiMod, 'generateOpenAi').mockResolvedValue({
      text: JSON.stringify({
        response_text: 'Perfeito! Vou te mandar agora.',
        transfer_required: false,
      }),
      usage: null,
    });

    const adminClientMod = await import('./admin-client');
    vi.spyOn(adminClientMod, 'supabaseAdmin').mockReturnValue(mockDb as never);

    const sendMediaSpy = vi
      .spyOn(metaSendMod, 'engineSendMedia')
      .mockResolvedValue({ whatsapp_message_id: 'wamid-media-21' });
    const sendTextSpy = vi
      .spyOn(metaSendMod, 'engineSendText')
      .mockResolvedValue({ whatsapp_message_id: 'wamid-text-21' });

    const turnResult = await executeConversationalTurn({
      db: mockDb as never,
      accountId: 'acc-1',
      config: baseConfig,
      conversationId: 'conv-21',
      contactId: 'contact-21',
      propertyId: 'prop-1',
      messages: [
        { role: 'user', content: 'Oi, queria saber mais sobre o apartamento' },
        { role: 'assistant', content: 'Posso te mostrar um vídeo da área de lazer.' },
        { role: 'user', content: 'Pode mandar.' },
      ],
      replyCount: 1,
    });

    expect(turnResult.mediaSendAllowed).toBe(true);
    expect(turnResult.validatedMediaToSend.length).toBeGreaterThan(0);
    // Only the video was selected — the offer named "vídeo", so the
    // kind-aware auto-resolve must not have pulled in any photo too.
    for (const item of turnResult.validatedMediaToSend) {
      expect(item.type).toBe('video');
      expect(item.mediaId).toBe('media-video-lazer');
    }

    await dispatchInboundToAiReply({
      accountId: 'account-1',
      conversationId: 'conv-21',
      contactId: 'contact-21',
      configOwnerUserId: 'user-1',
      debounceMs: 0,
    });

    expect(sendTextSpy).toHaveBeenCalledTimes(1);
    expect(sendMediaSpy).toHaveBeenCalled();
    for (const call of sendMediaSpy.mock.calls) {
      expect(call[0].kind).toBe('video');
      expect(call[0].link).toContain('lazer.mp4');
    }

    const textCallOrder = sendTextSpy.mock.invocationCallOrder[0];
    const firstMediaCallOrder = sendMediaSpy.mock.invocationCallOrder[0];
    expect(textCallOrder).toBeLessThan(firstMediaCallOrder);
  });

  // ============================================================
  // Progressive disclosure — confirming media authorizes the OFFERED
  // media, not a dump of the whole gallery. No new authorization logic:
  // same isMediaSendAuthorized guard, just a smaller auto-resolve batch.
  // ============================================================

  // TEST 22: with 5 photos available and a generic explicit photo
  // request, auto-resolve must send a small first batch (3), never all 5
  // just because they exist — "quantidade gradual, não mecânica".
  it('CENÁRIO 22: Pedido genérico de fotos com 5 disponíveis envia uma leva pequena (não as 5 de uma vez)', async () => {
    const mockDb = createMockDb(sampleMediaPool); // 5 image items

    const openAiMod = await import('./providers/openai');
    vi.spyOn(openAiMod, 'generateOpenAi').mockResolvedValue({
      text: JSON.stringify({
        response_text: 'Claro! Aqui estão algumas fotos.',
        transfer_required: false,
      }),
      usage: null,
    });

    const result = await executeConversationalTurn({
      db: mockDb,
      accountId: 'acc-1',
      config: baseConfig,
      propertyId: 'prop-1',
      messages: [{ role: 'user', content: 'Pode me mandar fotos?' }],
      replyCount: 0,
    });

    expect(result.mediaSendAllowed).toBe(true);
    expect(result.validatedMediaToSend.length).toBeGreaterThan(0);
    expect(result.validatedMediaToSend.length).toBeLessThan(5);
  });

  // TEST 18 (E2E, exact wording from spec): Clara already showed photos,
  // then offers a video too — the offer clause mentions "vídeo" while an
  // earlier clause in the SAME message mentions "fotos" (past tense).
  // Confirming must select the video ONLY, proving kind detection reads
  // the offer clause, not the whole message.
  it('CENÁRIO 23: "Já te mostrei fotos... vídeo também?" + "Quero." seleciona somente o vídeo', () => {
    const messages = [
      { role: 'user' as const, content: 'Oi, queria saber mais' },
      {
        role: 'assistant' as const,
        content: 'Já te mostrei algumas fotos. Quer que eu te envie também um vídeo?',
      },
      { role: 'user' as const, content: 'Quero.' },
    ];

    const auth = isMediaSendAuthorized({
      messages,
      isInitialContact: false,
      userMessageCount: 2,
    });

    expect(auth.authorized).toBe(true);
    expect(auth.filterKind).toBe('video');
  });

  // TEST (E2E, exact wording from spec): "Quero ver as fotos" after Clara
  // mentioned both kinds must resolve to photos, never videos.
  it('CENÁRIO 24: "Tenho fotos e vídeos" + "Quero ver as fotos" seleciona fotos, não vídeos', async () => {
    const sampleMediaPoolWithVideo: PropertyMediaSummary[] = [
      ...sampleMediaPool,
      {
        id: 'media-video-lazer',
        type: 'video',
        description: 'Vídeo da área de lazer',
        file_name: 'lazer.mp4',
        is_cover: false,
      },
    ];
    const mockDb = createMockDb(sampleMediaPoolWithVideo);

    const openAiMod = await import('./providers/openai');
    vi.spyOn(openAiMod, 'generateOpenAi').mockResolvedValue({
      text: JSON.stringify({
        response_text: 'Claro! Aqui estão as fotos.',
        transfer_required: false,
      }),
      usage: null,
    });

    const result = await executeConversationalTurn({
      db: mockDb,
      accountId: 'acc-1',
      config: baseConfig,
      propertyId: 'prop-1',
      messages: [
        { role: 'user', content: 'Oi' },
        { role: 'assistant', content: 'Tenho algumas fotos e também tenho vídeos. Prefere ver primeiro qual?' },
        { role: 'user', content: 'Quero ver as fotos' },
      ],
      replyCount: 1,
    });

    expect(result.mediaSendAllowed).toBe(true);
    expect(result.validatedMediaToSend.length).toBeGreaterThan(0);
    for (const item of result.validatedMediaToSend) {
      expect(item.type).toBe('image');
    }
  });

  // ============================================================
  // REGRESSÃO CIRÚRGICA: OFERTA ATENDIDA VS PENDENTE VS REENVIO
  // ============================================================

  // CENÁRIO A — oferta + envio no mesmo turno
  // Clara oferece fotos e já envia as fotos.
  // Cliente: "sim, quero ver".
  // Resultado: NÃO reenviar.
  it('CENÁRIO A: Oferta + envio no mesmo turno seguido de "sim, quero ver" NÃO reenvia as fotos', async () => {
    const mockDb = createMockDb(sampleMediaPool);

    const messages = [
      { role: 'user' as const, content: 'Tem fotos do apartamento?' },
      {
        role: 'assistant' as const,
        content: 'Tenho sim — posso te mostrar algumas fotos para você conhecer melhor a cozinha, a sala e um dos quartos.',
      },
      { role: 'assistant' as const, content: '[Assistente enviou uma imagem]' },
      { role: 'assistant' as const, content: '[Assistente enviou uma imagem]' },
      { role: 'assistant' as const, content: '[Assistente enviou uma imagem]' },
      { role: 'user' as const, content: 'sim, quero ver' },
    ];

    // Checagem direta do guardião
    const auth = isMediaSendAuthorized({
      messages,
      isInitialContact: false,
      userMessageCount: 2,
    });
    expect(auth.authorized).toBe(false);
    expect(auth.reason).toContain('já foi efetivamente enviada no turno anterior');

    // Checagem E2E via executeConversationalTurn
    const openAiMod = await import('./providers/openai');
    vi.spyOn(openAiMod, 'generateOpenAi').mockResolvedValue({
      text: JSON.stringify({
        response_text: 'Essas foram as fotos dos ambientes principais! O que achou do espaço?',
        transfer_required: false,
        send_media: null,
      }),
      usage: null,
    });

    const turnResult = await executeConversationalTurn({
      db: mockDb,
      accountId: 'acc-1',
      config: baseConfig,
      propertyId: 'prop-1',
      messages,
      replyCount: 2,
    });

    expect(turnResult.mediaSendAllowed).toBe(false);
    expect(turnResult.validatedMediaToSend).toEqual([]);
    expect(turnResult.decision?.send_media).toBeNull();
  });

  // CENÁRIO B — oferta pendente
  // Clara oferece fotos, mas NÃO envia nenhuma.
  // Cliente: "sim, quero ver".
  // Resultado: enviar as fotos.
  it('CENÁRIO B: Oferta pendente sem envio prévio seguida de "sim, quero ver" autoriza e envia as fotos', async () => {
    const mockDb = createMockDb(sampleMediaPool);

    const messages = [
      { role: 'user' as const, content: 'Oi, queria mais informações' },
      {
        role: 'assistant' as const,
        content: 'Posso te mostrar algumas fotos da sala, cozinha e quarto.',
      },
      { role: 'user' as const, content: 'sim, quero ver' },
    ];

    const auth = isMediaSendAuthorized({
      messages,
      isInitialContact: false,
      userMessageCount: 2,
    });
    expect(auth.authorized).toBe(true);
    expect(auth.filterKind).toBe('image');

    const openAiMod = await import('./providers/openai');
    vi.spyOn(openAiMod, 'generateOpenAi').mockResolvedValue({
      text: JSON.stringify({
        response_text: 'Perfeito! Aqui estão as fotos.',
        transfer_required: false,
      }),
      usage: null,
    });

    const turnResult = await executeConversationalTurn({
      db: mockDb,
      accountId: 'acc-1',
      config: baseConfig,
      propertyId: 'prop-1',
      messages,
      replyCount: 2,
    });

    expect(turnResult.mediaSendAllowed).toBe(true);
    expect(turnResult.validatedMediaToSend.length).toBeGreaterThan(0);
  });

  // CENÁRIO C — reenvio explícito
  // Fotos já foram enviadas.
  // Cliente: "pode mandar essas fotos novamente?"
  // Resultado: permitir reenvio.
  it('CENÁRIO C: Fotos já enviadas + pedido explícito "pode mandar essas fotos novamente?" autoriza o reenvio', async () => {
    const mockDb = createMockDb(sampleMediaPool);

    const messages = [
      { role: 'user' as const, content: 'Tem fotos?' },
      {
        role: 'assistant' as const,
        content: 'Aqui estão as fotos do apartamento.',
      },
      { role: 'assistant' as const, content: '[Assistente enviou uma imagem]' },
      { role: 'assistant' as const, content: '[Assistente enviou uma imagem]' },
      { role: 'user' as const, content: 'pode mandar essas fotos novamente?' },
    ];

    const auth = isMediaSendAuthorized({
      messages,
      isInitialContact: false,
      userMessageCount: 2,
    });
    expect(auth.authorized).toBe(true);
    expect(auth.reason).toContain('Lead solicitou reenvio explícito de mídia');

    const openAiMod = await import('./providers/openai');
    vi.spyOn(openAiMod, 'generateOpenAi').mockResolvedValue({
      text: JSON.stringify({
        response_text: 'Claro! Reenviando as fotos para você.',
        transfer_required: false,
      }),
      usage: null,
    });

    const turnResult = await executeConversationalTurn({
      db: mockDb,
      accountId: 'acc-1',
      config: baseConfig,
      propertyId: 'prop-1',
      messages,
      replyCount: 2,
    });

    expect(turnResult.mediaSendAllowed).toBe(true);
    expect(turnResult.validatedMediaToSend.length).toBeGreaterThan(0);
  });

  // CENÁRIO D — nova oferta posterior
  // Uma mídia foi enviada anteriormente, mas Clara faz uma nova oferta contextual posteriormente.
  // Cliente confirma a nova oferta.
  // Resultado: não bloquear apenas porque a mídia apareceu anteriormente no histórico.
  it('CENÁRIO D: Mídia enviada anteriormente não bloqueia nova oferta posterior de outra mídia', async () => {
    const sampleMediaPoolWithVideo: PropertyMediaSummary[] = [
      ...sampleMediaPool,
      {
        id: 'media-video-lazer',
        type: 'video',
        description: 'Vídeo da área de lazer',
        file_name: 'lazer.mp4',
        is_cover: false,
      },
    ];
    const mockDb = createMockDb(sampleMediaPoolWithVideo);

    const messages = [
      { role: 'user' as const, content: 'Tem fotos?' },
      { role: 'assistant' as const, content: 'Tenho sim, veja as fotos.' },
      { role: 'assistant' as const, content: '[Assistente enviou uma imagem]' },
      { role: 'user' as const, content: 'Gostei dos quartos' },
      {
        role: 'assistant' as const,
        content: 'São bem espaçosos! Se quiser, posso te mostrar um vídeo da área de lazer.',
      },
      { role: 'user' as const, content: 'pode mandar' },
    ];

    const auth = isMediaSendAuthorized({
      messages,
      isInitialContact: false,
      userMessageCount: 3,
    });
    expect(auth.authorized).toBe(true);
    expect(auth.filterKind).toBe('video');

    const openAiMod = await import('./providers/openai');
    vi.spyOn(openAiMod, 'generateOpenAi').mockResolvedValue({
      text: JSON.stringify({
        response_text: 'Aqui está o vídeo da área de lazer!',
        transfer_required: false,
      }),
      usage: null,
    });

    const turnResult = await executeConversationalTurn({
      db: mockDb,
      accountId: 'acc-1',
      config: baseConfig,
      propertyId: 'prop-1',
      messages,
      replyCount: 3,
    });

    expect(turnResult.mediaSendAllowed).toBe(true);
    expect(turnResult.validatedMediaToSend.length).toBe(1);
    expect(turnResult.validatedMediaToSend[0].type).toBe('video');
  });

  // CENÁRIO E — auto-resolve
  // Quando mediaAuth.authorized === false porque a oferta já foi atendida,
  // confirmar que o passo de auto-resolve da engine também NÃO consegue injetar novamente as mídias.
  it('CENÁRIO E: Quando oferta já foi atendida, auto-resolve é impedido e validatedMediaToSend permanece vazio', async () => {
    const mockDb = createMockDb(sampleMediaPool);

    const messages = [
      { role: 'user' as const, content: 'Tem fotos?' },
      {
        role: 'assistant' as const,
        content: 'Tenho sim, posso te mostrar algumas fotos da sala e cozinha.',
      },
      { role: 'assistant' as const, content: '[Assistente enviou uma imagem]' },
      { role: 'user' as const, content: 'sim, quero ver' },
    ];

    // O LLM tenta erradamente enviar mídias ou omite send_media
    const openAiMod = await import('./providers/openai');
    vi.spyOn(openAiMod, 'generateOpenAi').mockResolvedValue({
      text: JSON.stringify({
        response_text: 'Vou te mostrar as fotos.',
        transfer_required: false,
        send_media: [
          { property_id: 'prop-1', media_id: 'media-foto-1', caption: null },
        ],
      }),
      usage: null,
    });

    const turnResult = await executeConversationalTurn({
      db: mockDb,
      accountId: 'acc-1',
      config: baseConfig,
      propertyId: 'prop-1',
      messages,
      replyCount: 2,
    });

    // Como mediaAuth.authorized é false:
    // 1. send_media gerado pelo modelo é limpo (stripped para null)
    // 2. auto-resolve não é acionado
    // 3. validatedMediaToSend permanece rigorosamente vazio
    expect(turnResult.mediaSendAllowed).toBe(false);
    expect(turnResult.decision?.send_media).toBeNull();
    expect(turnResult.validatedMediaToSend).toEqual([]);
  });

  // =========================================================================
  // PROBLEMAS 1 E 2 — BINDING DE OFERTA DE VÍDEO E DEDUPLICAÇÃO DE FOTOS
  // =========================================================================
  describe('Problemas 1 e 2 — Offer Binding (Vídeo) e Desduplicação Contextual ("Mais Fotos")', () => {
    const testMediaPool: PropertyMediaSummary[] = [
      {
        id: 'media-foto-A',
        type: 'image',
        description: 'Fachada frontal imponente',
        file_name: 'fachada.jpg',
        is_cover: false,
      },
      {
        id: 'media-foto-B',
        type: 'image',
        description: 'Piscina com borda infinita',
        file_name: 'piscina.jpg',
        is_cover: false,
      },
      {
        id: 'media-foto-C',
        type: 'image',
        description: 'Espaço gourmet integrado',
        file_name: 'gourmet.jpg',
        is_cover: false,
      },
      {
        id: 'media-foto-D',
        type: 'image',
        description: 'Academia completa',
        file_name: 'academia.jpg',
        is_cover: false,
      },
      {
        id: 'media-foto-E',
        type: 'image',
        description: 'Planta baixa 3 suítes',
        file_name: 'planta.jpg',
        is_cover: false,
      },
      {
        id: 'media-video-1',
        type: 'video',
        description: 'Vídeo tour completo do empreendimento',
        file_name: 'tour.mp4',
        is_cover: false,
      },
    ];

    // TESTE 1: Clara oferece vídeo ("Se quiser, posso te mostrar um vídeo.") + cliente diz "manda" -> envia APENAS vídeo, 0 fotos
    it('TESTE 1: Clara oferece vídeo + cliente diz "manda" -> envia APENAS vídeo, 0 fotos', async () => {
      const mockDb = createMockDb(testMediaPool);

      const messages = [
        { role: 'user' as const, content: 'Oi, queria conhecer o Live Park' },
        {
          role: 'assistant' as const,
          content: 'Claro! 😊 Tenho sim algumas fotos do Live Park para você conhecer melhor o visual do projeto. Se quiser, também posso te mostrar um vídeo.',
        },
        { role: 'assistant' as const, content: '[Assistente enviou uma imagem: "fachada.jpg" (id: media-foto-A)]' },
        { role: 'assistant' as const, content: '[Assistente enviou uma imagem: "piscina.jpg" (id: media-foto-B)]' },
        { role: 'user' as const, content: 'manda' },
      ];

      const openAiMod = await import('./providers/openai');
      // Mesmo se o modelo retornar fotos ou vazio, a engine ancora no VÍDEO
      vi.spyOn(openAiMod, 'generateOpenAi').mockResolvedValue({
        text: JSON.stringify({
          response_text: 'Aqui está o vídeo do Live Park!',
          transfer_required: false,
          send_media: [
            { property_id: 'prop-1', media_id: 'media-foto-C', caption: null },
          ],
        }),
        usage: null,
      });

      const turnResult = await executeConversationalTurn({
        db: mockDb,
        accountId: 'acc-1',
        config: baseConfig,
        propertyId: 'prop-1',
        messages,
        replyCount: 2,
      });

      expect(turnResult.mediaSendAllowed).toBe(true);
      expect(turnResult.validatedMediaToSend.length).toBe(1);
      expect(turnResult.validatedMediaToSend[0].type).toBe('video');
      expect(turnResult.validatedMediaToSend[0].mediaId).toBe('media-video-1');
      expect(turnResult.validatedMediaToSend.filter((m) => m.type === 'image')).toHaveLength(0);
    });

    // TESTE 2: Clara oferece fotos ("Se quiser, posso te mostrar mais algumas fotos.") + cliente diz "manda" -> envia fotos
    it('TESTE 2: Clara oferece fotos + cliente diz "manda" -> envia fotos', async () => {
      const mockDb = createMockDb(testMediaPool);

      const messages = [
        { role: 'user' as const, content: 'Gostei da localização' },
        {
          role: 'assistant' as const,
          content: 'Que ótimo! Se quiser, posso te mostrar mais algumas fotos do empreendimento.',
        },
        { role: 'user' as const, content: 'manda' },
      ];

      const openAiMod = await import('./providers/openai');
      vi.spyOn(openAiMod, 'generateOpenAi').mockResolvedValue({
        text: JSON.stringify({
          response_text: 'Vou te mostrar as fotos!',
          transfer_required: false,
        }),
        usage: null,
      });

      const turnResult = await executeConversationalTurn({
        db: mockDb,
        accountId: 'acc-1',
        config: baseConfig,
        propertyId: 'prop-1',
        messages,
        replyCount: 1,
      });

      expect(turnResult.mediaSendAllowed).toBe(true);
      expect(turnResult.validatedMediaToSend.length).toBeGreaterThan(0);
      expect(turnResult.validatedMediaToSend.every((m) => m.type === 'image')).toBe(true);
    });

    // TESTE 3: 5 fotos cadastradas (A, B, C, D, E), A e B já enviadas, cliente diz "manda mais fotos" -> envia C, D, E (A e B NUNCA aparecem)
    it('TESTE 3: 5 fotos cadastradas, A e B já enviadas, cliente diz "manda mais fotos" -> envia C, D, E (A e B NUNCA aparecem)', async () => {
      const fivePhotosPool = testMediaPool.filter((m) => m.type === 'image'); // A, B, C, D, E
      const mockDb = createMockDb(fivePhotosPool);

      const messages = [
        { role: 'user' as const, content: 'Quero ver fotos' },
        { role: 'assistant' as const, content: 'Aqui estão algumas fotos.' },
        { role: 'assistant' as const, content: '[Assistente enviou uma imagem: "fachada.jpg" (id: media-foto-A)]' },
        { role: 'assistant' as const, content: '[Assistente enviou uma imagem: "piscina.jpg" (id: media-foto-B)]' },
        { role: 'user' as const, content: 'manda mais fotos' },
      ];

      const openAiMod = await import('./providers/openai');
      // Simulando que o modelo tenta erroneamente mandar fotos A e C
      vi.spyOn(openAiMod, 'generateOpenAi').mockResolvedValue({
        text: JSON.stringify({
          response_text: 'Aqui estão mais fotos!',
          transfer_required: false,
          send_media: [
            { property_id: 'prop-1', media_id: 'media-foto-A', caption: null },
            { property_id: 'prop-1', media_id: 'media-foto-C', caption: null },
          ],
        }),
        usage: null,
      });

      const turnResult = await executeConversationalTurn({
        db: mockDb,
        accountId: 'acc-1',
        config: baseConfig,
        propertyId: 'prop-1',
        messages,
        replyCount: 2,
      });

      expect(turnResult.mediaSendAllowed).toBe(true);
      const sentIds = turnResult.validatedMediaToSend.map((m) => m.mediaId);
      expect(sentIds).not.toContain('media-foto-A');
      expect(sentIds).not.toContain('media-foto-B');
      expect(sentIds).toContain('media-foto-C');
    });

    // TESTE 4: 3 fotos cadastradas (A, B, C), A e B já enviadas, cliente diz "manda mais fotos" -> envia APENAS C (não repete A ou B para "completar lote")
    it('TESTE 4: 3 fotos cadastradas, A e B já enviadas, cliente diz "manda mais fotos" -> envia APENAS C (não repete A ou B para "completar lote")', async () => {
      const threePhotosPool = testMediaPool.filter((m) => ['media-foto-A', 'media-foto-B', 'media-foto-C'].includes(m.id));
      const mockDb = createMockDb(threePhotosPool);

      const messages = [
        { role: 'user' as const, content: 'Tem fotos?' },
        { role: 'assistant' as const, content: 'Tenho sim, veja.' },
        { role: 'assistant' as const, content: '[Assistente enviou uma imagem: "fachada.jpg" (id: media-foto-A)]' },
        { role: 'assistant' as const, content: '[Assistente enviou uma imagem: "piscina.jpg" (id: media-foto-B)]' },
        { role: 'user' as const, content: 'manda mais fotos' },
      ];

      const openAiMod = await import('./providers/openai');
      // Auto-resolve deve agir porque send_media vem nulo
      vi.spyOn(openAiMod, 'generateOpenAi').mockResolvedValue({
        text: JSON.stringify({
          response_text: 'Aqui está mais uma foto!',
          transfer_required: false,
        }),
        usage: null,
      });

      const turnResult = await executeConversationalTurn({
        db: mockDb,
        accountId: 'acc-1',
        config: baseConfig,
        propertyId: 'prop-1',
        messages,
        replyCount: 2,
      });

      expect(turnResult.mediaSendAllowed).toBe(true);
      expect(turnResult.validatedMediaToSend.length).toBe(1);
      expect(turnResult.validatedMediaToSend[0].mediaId).toBe('media-foto-C');
      const sentIds = turnResult.validatedMediaToSend.map((m) => m.mediaId);
      expect(sentIds).not.toContain('media-foto-A');
      expect(sentIds).not.toContain('media-foto-B');
    });

    // TESTE 5: Fotos A, B enviadas, cliente diz "manda essas fotos novamente" -> reenvio permitido
    it('TESTE 5: Fotos A, B enviadas, cliente diz "manda essas fotos novamente" -> reenvio permitido', async () => {
      const twoPhotosPool = testMediaPool.filter((m) => ['media-foto-A', 'media-foto-B'].includes(m.id));
      const mockDb = createMockDb(twoPhotosPool);

      const messages = [
        { role: 'user' as const, content: 'Tem fotos?' },
        { role: 'assistant' as const, content: 'Aqui estão.' },
        { role: 'assistant' as const, content: '[Assistente enviou uma imagem: "fachada.jpg" (id: media-foto-A)]' },
        { role: 'assistant' as const, content: '[Assistente enviou uma imagem: "piscina.jpg" (id: media-foto-B)]' },
        { role: 'user' as const, content: 'manda essas fotos novamente' },
      ];

      const openAiMod = await import('./providers/openai');
      vi.spyOn(openAiMod, 'generateOpenAi').mockResolvedValue({
        text: JSON.stringify({
          response_text: 'Reenviando as fotos para você!',
          transfer_required: false,
        }),
        usage: null,
      });

      const turnResult = await executeConversationalTurn({
        db: mockDb,
        accountId: 'acc-1',
        config: baseConfig,
        propertyId: 'prop-1',
        messages,
        replyCount: 2,
      });

      expect(turnResult.mediaSendAllowed).toBe(true);
      expect(turnResult.validatedMediaToSend.length).toBeGreaterThan(0);
      const sentIds = turnResult.validatedMediaToSend.map((m) => m.mediaId);
      expect(sentIds).toContain('media-foto-A');
    });

    // TESTE 6: Vídeo já enviado no mesmo turno, cliente diz "sim" -> NÃO reenvia (oferta já atendida)
    it('TESTE 6: Vídeo já enviado no mesmo turno, cliente diz "sim" -> NÃO reenvia (oferta já atendida)', async () => {
      const mockDb = createMockDb(testMediaPool);

      const messages = [
        { role: 'user' as const, content: 'Quero ver o vídeo' },
        { role: 'assistant' as const, content: 'Aqui está o vídeo de apresentação do condomínio.' },
        { role: 'assistant' as const, content: '[Assistente enviou um vídeo: "tour.mp4" (id: media-video-1)]' },
        { role: 'user' as const, content: 'sim' },
      ];

      const openAiMod = await import('./providers/openai');
      vi.spyOn(openAiMod, 'generateOpenAi').mockResolvedValue({
        text: JSON.stringify({
          response_text: 'O que achou do vídeo?',
          transfer_required: false,
          send_media: [
            { property_id: 'prop-1', media_id: 'media-video-1', caption: null },
          ],
        }),
        usage: null,
      });

      const turnResult = await executeConversationalTurn({
        db: mockDb,
        accountId: 'acc-1',
        config: baseConfig,
        propertyId: 'prop-1',
        messages,
        replyCount: 2,
      });

      expect(turnResult.mediaSendAllowed).toBe(false);
      expect(turnResult.validatedMediaToSend).toEqual([]);
      expect(turnResult.decision?.send_media).toBeNull();
    });

    // TESTE 7: Vídeo antigo já enviado; depois Clara oferece fotos novas; cliente diz "manda" -> envia fotos (não é bloqueado por vídeo antigo)
    it('TESTE 7: Vídeo antigo já enviado; depois Clara oferece fotos novas; cliente diz "manda" -> envia fotos', async () => {
      const mockDb = createMockDb(testMediaPool);

      const messages = [
        { role: 'user' as const, content: 'Quero ver o vídeo' },
        { role: 'assistant' as const, content: 'Aqui está o vídeo.' },
        { role: 'assistant' as const, content: '[Assistente enviou um vídeo: "tour.mp4" (id: media-video-1)]' },
        { role: 'user' as const, content: 'Muito bom! Gostei' },
        { role: 'assistant' as const, content: 'Que ótimo! Se quiser, posso te mostrar fotos do apartamento decorado.' },
        { role: 'user' as const, content: 'manda' },
      ];

      const openAiMod = await import('./providers/openai');
      vi.spyOn(openAiMod, 'generateOpenAi').mockResolvedValue({
        text: JSON.stringify({
          response_text: 'Aqui estão as fotos do decorado!',
          transfer_required: false,
        }),
        usage: null,
      });

      const turnResult = await executeConversationalTurn({
        db: mockDb,
        accountId: 'acc-1',
        config: baseConfig,
        propertyId: 'prop-1',
        messages,
        replyCount: 3,
      });

      expect(turnResult.mediaSendAllowed).toBe(true);
      expect(turnResult.validatedMediaToSend.length).toBeGreaterThan(0);
      expect(turnResult.validatedMediaToSend.every((m) => m.type === 'image')).toBe(true);
    });

    // TESTE 8: Todas as fotos já enviadas, cliente diz "manda mais fotos" -> validatedMediaToSend vazio, nenhuma repetição
    it('TESTE 8: Todas as fotos já enviadas, cliente diz "manda mais fotos" -> validatedMediaToSend vazio, nenhuma repetição', async () => {
      const twoPhotosPool = testMediaPool.filter((m) => ['media-foto-A', 'media-foto-B'].includes(m.id));
      const mockDb = createMockDb(twoPhotosPool);

      const messages = [
        { role: 'user' as const, content: 'Tem fotos?' },
        { role: 'assistant' as const, content: 'Aqui estão as fotos.' },
        { role: 'assistant' as const, content: '[Assistente enviou uma imagem: "fachada.jpg" (id: media-foto-A)]' },
        { role: 'assistant' as const, content: '[Assistente enviou uma imagem: "piscina.jpg" (id: media-foto-B)]' },
        { role: 'user' as const, content: 'manda mais fotos' },
      ];

      const openAiMod = await import('./providers/openai');
      vi.spyOn(openAiMod, 'generateOpenAi').mockResolvedValue({
        text: JSON.stringify({
          response_text: 'Já te mostrei todas as fotos disponíveis desse imóvel!',
          transfer_required: false,
        }),
        usage: null,
      });

      const turnResult = await executeConversationalTurn({
        db: mockDb,
        accountId: 'acc-1',
        config: baseConfig,
        propertyId: 'prop-1',
        messages,
        replyCount: 2,
      });

      expect(turnResult.validatedMediaToSend).toEqual([]);
      expect(turnResult.decision?.send_media).toBeNull();
    });
  });
});

