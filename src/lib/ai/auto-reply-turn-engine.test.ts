import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AiConfig } from './types'
import { buildConversationalSystemPrompt } from './prompt-builder'
import { executeConversationalTurn } from './conversation-engine'
import { resolvePropertyForConversation } from './property-resolution'
import { dispatchInboundToAiReply } from './auto-reply'

// Hoisted mocks for dispatch tests
const h = vi.hoisted(() => ({
  loadAiConfig: vi.fn(),
  buildConversationContext: vi.fn(),
  executeConversationalTurn: vi.fn(),
  engineSendText: vi.fn(),
  engineSendMedia: vi.fn(),
  sendPushToAccount: vi.fn(),
  state: {
    conv: null as Record<string, unknown> | null,
    freshConv: null as Record<string, unknown> | null,
    recentHumanMsgs: [] as { id: string }[],
    newerCustomerMsgs: [] as { id: string; created_at: string }[],
    midGenCustomerMsgs: [] as { id: string }[],
    autoResponders: [] as { id: string }[],
    flowRuns: [] as { id: string }[],
    contact: { name: 'Maria Souza' } as Record<string, unknown> | null,
    claim: true as boolean,
    lockAcquired: true as boolean,
    activeLocks: new Set<string>(),
    updatePayload: null as Record<string, unknown> | null,
    rpcCalls: [] as { name: string; args: unknown }[],
    generateOpenAi: vi.fn(),
    generateAnthropic: vi.fn(),
    retrievePropertyKnowledge: vi.fn(),
  },
}))

vi.mock('./config', () => ({ loadAiConfig: h.loadAiConfig }))
vi.mock('./context', () => ({ buildConversationContext: h.buildConversationContext }))
vi.mock('@/lib/flows/meta-send', () => ({
  engineSendText: h.engineSendText,
  engineSendMedia: h.engineSendMedia,
}))
vi.mock('@/lib/push/send', () => ({ sendPushToAccount: h.sendPushToAccount }))
vi.mock('./providers/openai', () => ({ generateOpenAi: h.state.generateOpenAi }))
vi.mock('./providers/anthropic', () => ({ generateAnthropic: h.state.generateAnthropic }))
vi.mock('./knowledge', () => ({ retrievePropertyKnowledge: h.state.retrievePropertyKnowledge }))

vi.mock('./admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (table === 'automations') {
        const chain = {
          select: () => chain,
          eq: () => chain,
          in: () => chain,
          limit: () => Promise.resolve({ data: h.state.autoResponders, error: null }),
        }
        return chain
      }
      if (table === 'flow_runs') {
        const chain = {
          select: () => chain,
          eq: () => chain,
          limit: () => Promise.resolve({ data: h.state.flowRuns, error: null }),
        }
        return chain
      }
      if (table === 'contacts') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: h.state.contact, error: null }),
            }),
          }),
        }
      }
      if (table === 'ai_usage_log') {
        return { insert: () => Promise.resolve({ error: null }) }
      }
      if (table === 'messages') {
        const msgChain = {
          select: () => msgChain,
          eq: () => msgChain,
          gt: () => ({
            order: () => ({
              limit: () => Promise.resolve({ data: h.state.newerCustomerMsgs, error: null }),
            }),
            limit: () => Promise.resolve({ data: h.state.midGenCustomerMsgs, error: null }),
          }),
          gte: () => ({
            limit: () => Promise.resolve({ data: h.state.recentHumanMsgs, error: null }),
          }),
          order: () => msgChain,
          limit: () => Promise.resolve({ data: [], error: null }),
        }
        return msgChain
      }
      if (table === 'properties') {
        return {
          select: () => ({
            eq: () =>
              Promise.resolve({
                data: [
                  { id: 'prop-livepark', name: 'Live Park' },
                  { id: 'prop-puerto', name: 'Puerto Ventura' },
                ],
                error: null,
              }),
          }),
        }
      }
      // conversations
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () => {
              const data = h.state.freshConv ?? h.state.conv
              return Promise.resolve({ data, error: null })
            },
          }),
        }),
        update: (payload: Record<string, unknown>) => {
          h.state.updatePayload = payload
          return { eq: () => Promise.resolve({ error: null }) }
        },
      }
    },
    rpc: (name: string, args: unknown) => {
      h.state.rpcCalls.push({ name, args })
      if (name === 'acquire_ai_conversation_lock') {
        const rec = args as { p_conversation_id: string; p_lock_token: string }
        if (h.state.activeLocks.has(rec.p_conversation_id)) {
          return Promise.resolve({ data: false, error: null })
        }
        h.state.activeLocks.add(rec.p_conversation_id)
        return Promise.resolve({ data: h.state.lockAcquired, error: null })
      }
      if (name === 'release_ai_conversation_lock') {
        const rec = args as { p_conversation_id: string; p_lock_token: string }
        h.state.activeLocks.delete(rec.p_conversation_id)
        return Promise.resolve({ data: true, error: null })
      }
      return Promise.resolve({ data: h.state.claim, error: null })
    },
  }),
}))

describe('WACRM — Structural Clara Conversational Behavior & Concurrency Test Suite', () => {
  const baseConfig: AiConfig = {
    provider: 'openai',
    model: 'gpt-4o',
    apiKey: 'sk-test',
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: true,
    autoReplyMaxPerConversation: 8,
    safetyMessageLimit: 8,
    handoffAgentId: null,
    embeddingsApiKey: null,
  }

  const defaultDispatchArgs = {
    accountId: 'acct-test',
    conversationId: 'conv-test-1',
    contactId: 'contact-test-1',
    configOwnerUserId: 'user-test-1',
    debounceMs: 0,
  }

  beforeEach(() => {
    vi.clearAllMocks()
    h.state.conv = {
      id: 'conv-test-1',
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_transfer_status: 'none',
      ai_reply_count: 0,
      property_id: 'prop-livepark',
    }
    h.state.freshConv = null
    h.state.recentHumanMsgs = []
    h.state.newerCustomerMsgs = []
    h.state.midGenCustomerMsgs = []
    h.state.autoResponders = []
    h.state.flowRuns = []
    h.state.contact = { name: 'Maria Souza' }
    h.state.claim = true
    h.state.lockAcquired = true
    h.state.activeLocks.clear()
    h.state.updatePayload = null
    h.state.rpcCalls = []

    h.loadAiConfig.mockResolvedValue(baseConfig)
    h.buildConversationContext.mockResolvedValue([{ role: 'user', content: 'Olá, tenho interesse.' }])
    h.state.generateOpenAi.mockResolvedValue({
      text: JSON.stringify({
        response_text: 'Olá! O Live Park é um excelente projeto no Caribessa.',
        transfer_required: false,
        boundary_type: null,
        reason: null,
        context_summary: 'Interesse inicial',
        suggested_next_action: null,
      }),
      usage: { promptTokens: 100, completionTokens: 30, totalTokens: 130 },
    })
    h.state.retrievePropertyKnowledge.mockResolvedValue({
      propertyChunks: ['Previsão de entrega do Live Park: Dezembro de 2027.'],
      globalChunks: [],
      allChunks: ['Previsão de entrega do Live Park: Dezembro de 2027.'],
      chunks: [],
    })
    h.engineSendText.mockResolvedValue({ whatsapp_message_id: 'wa-msg-1' })
  })

  // ============================================================
  // TESTE A: Cliente envia uma mensagem -> 1 execução, 1 resposta
  // ============================================================
  it('TESTE A: Single message triggers exactly 1 execution and 1 text response', async () => {
    await dispatchInboundToAiReply(defaultDispatchArgs)

    expect(h.engineSendText).toHaveBeenCalledTimes(1)
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv-test-1',
        text: expect.stringContaining('Live Park'),
      }),
    )
  })

  // ============================================================
  // TESTE B: Cliente envia duas mensagens em < 2 segundos -> Debounce consolida em 1 turno
  // ============================================================
  it('TESTE B: Two messages arriving within debounce window yields first execution and runs second', async () => {
    // Simulate first execution finding a newer customer message arrived during debounce wait
    h.state.newerCustomerMsgs = [{ id: 'msg-2', created_at: new Date().toISOString() }]

    await dispatchInboundToAiReply({
      ...defaultDispatchArgs,
      debounceMs: 50,
    })

    // First runner yielded because newer message arrived
    expect(h.engineSendText).not.toHaveBeenCalled()

    // Second runner arrives (no newer message)
    h.state.newerCustomerMsgs = []
    await dispatchInboundToAiReply({
      ...defaultDispatchArgs,
      debounceMs: 50,
    })

    // Second runner successfully generates 1 consolidated response
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
  })

  // ============================================================
  // TESTE C: 5 mensagens rápidas -> 1 turno consolidado, 1 resposta
  // ============================================================
  it('TESTE C: Rapid burst of 5 messages produces 1 consolidated turn and response', async () => {
    h.buildConversationContext.mockResolvedValueOnce([
      { role: 'user', content: 'Tenho interesse' },
      { role: 'user', content: 'Fotos' },
      { role: 'user', content: 'Preço?' },
      { role: 'user', content: 'Tem piscina?' },
      { role: 'user', content: 'Entrega quando?' },
    ])

    await dispatchInboundToAiReply(defaultDispatchArgs)

    expect(h.engineSendText).toHaveBeenCalledTimes(1)
  })

  // ============================================================
  // TESTE D: Duas mensagens simultâneas -> Lock impede respostas duplicadas
  // ============================================================
  it('TESTE D: Concurrent executions are blocked by conversation lock', async () => {
    // Lock is already active on this conversation
    h.state.activeLocks.add('conv-test-1')

    await dispatchInboundToAiReply(defaultDispatchArgs)

    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  // ============================================================
  // TESTE E: Nova mensagem chega durante processamento -> JIT detecta e reavalia
  // ============================================================
  it('TESTE E: Customer message arriving during LLM generation triggers re-evaluation before sending', async () => {
    // Simulate customer message arriving mid-generation
    h.state.midGenCustomerMsgs = [{ id: 'mid-gen-msg-1' }]

    await dispatchInboundToAiReply(defaultDispatchArgs)

    // Verify buildConversationContext was called twice (initial + mid-gen refresh)
    expect(h.buildConversationContext).toHaveBeenCalledTimes(2)
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
  })

  // ============================================================
  // TESTE F: Conversa já iniciada -> Clara NÃO repete "Boa tarde"
  // ============================================================
  it('TESTE F: Ongoing conversation strictly omits greeting and strips accidental "Boa tarde"', async () => {
    const ongoingPrompt = buildConversationalSystemPrompt({
      config: baseConfig,
      mode: 'auto_reply',
      isInitialContact: false,
      property: { id: 'p1', name: 'Live Park' },
    })

    expect(ongoingPrompt).toContain('ESTADO DA CONVERSA: CONVERSA JÁ EM ANDAMENTO')
    expect(ongoingPrompt).toContain('REGRA ABSOLUTA E INEGOCIÁVEL DE SAUDAÇÃO')

    // Model returns accidental greeting in ongoing conversation
    h.state.generateOpenAi.mockResolvedValueOnce({
      text: JSON.stringify({
        response_text: 'Boa tarde! O empreendimento possui rooftop com piscina borda infinita.',
        transfer_required: false,
        boundary_type: null,
      }),
      usage: null,
    })

    const db = {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve({ data: { id: 'p1', name: 'Live Park' }, error: null }),
          }),
        }),
      }),
    } as unknown as SupabaseClient

    const turn = await executeConversationalTurn({
      db,
      accountId: 'acct-1',
      config: baseConfig,
      propertyId: 'p1',
      messages: [
        { role: 'user', content: 'Oi' },
        { role: 'assistant', content: 'Olá! Sou a Clara.' },
        { role: 'user', content: 'Tem piscina?' },
      ],
      replyCount: 1,
    })

    // Post-processor defensively stripped "Boa tarde!"
    expect(turn.responseText).toBe('O empreendimento possui rooftop com piscina borda infinita.')
    expect(turn.responseText).not.toMatch(/^boa tarde/i)
  })

  // ============================================================
  // TESTE G: Primeiro contato -> Clara pode cumprimentar
  // ============================================================
  it('TESTE G: Initial contact allows cordial opening greeting and presentation', () => {
    const initialPrompt = buildConversationalSystemPrompt({
      config: baseConfig,
      mode: 'auto_reply',
      isInitialContact: true,
      property: { id: 'p1', name: 'Live Park' },
    })

    expect(initialPrompt).toContain('ESTADO DA CONVERSA: PRIMEIRO CONTATO DO CLIENTE')
    expect(initialPrompt).toContain('PODE abrir com uma saudação calorosa')
  })

  // ============================================================
  // TESTE H: Cliente pergunta previsão de entrega existente -> Clara responde direto
  // ============================================================
  it('TESTE H: Delivery forecast present in knowledge is answered directly without handoff', async () => {
    h.state.generateOpenAi.mockResolvedValueOnce({
      text: JSON.stringify({
        response_text: 'A previsão de entrega do Live Park é para Dezembro de 2027. Você busca o imóvel para morar ou investir?',
        transfer_required: false,
        boundary_type: null,
      }),
      usage: null,
    })

    const db = {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve({ data: { id: 'p1', name: 'Live Park' }, error: null }),
          }),
        }),
      }),
    } as unknown as SupabaseClient

    const turn = await executeConversationalTurn({
      db,
      accountId: 'acct-1',
      config: baseConfig,
      propertyId: 'p1',
      messages: [{ role: 'user', content: 'Esse está com entrega para quando?' }],
    })

    expect(turn.handoff).toBe(false)
    expect(turn.responseText).toContain('Dezembro de 2027')
  })

  // ============================================================
  // TESTE I: Cliente pergunta previsão de entrega inexistente -> Clara informa sem inventar
  // ============================================================
  it('TESTE I: Missing factual info is politely acknowledged without hallucinations or panicking', async () => {
    h.state.generateOpenAi.mockResolvedValueOnce({
      text: JSON.stringify({
        response_text: 'Não tenho a data exata de entrega cadastrada para esse item específico no momento, mas posso confirmar para você.',
        transfer_required: false,
        boundary_type: null,
      }),
      usage: null,
    })

    const db = {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve({ data: { id: 'p1', name: 'Live Park' }, error: null }),
          }),
        }),
      }),
    } as unknown as SupabaseClient

    const turn = await executeConversationalTurn({
      db,
      accountId: 'acct-1',
      config: baseConfig,
      propertyId: 'p1',
      messages: [{ role: 'user', content: 'Entrega quando?' }],
    })

    expect(turn.responseText).toContain('Não tenho a data exata')
    expect(turn.handoff).toBe(false)
  })

  // ============================================================
  // TESTE J: Conversa em Live Park pede fotos -> Fotos do Live Park
  // ============================================================
  it('TESTE J: Photos request on active Live Park context resolves Live Park media only', async () => {
    const prompt = buildConversationalSystemPrompt({
      config: baseConfig,
      mode: 'auto_reply',
      property: { id: 'prop-livepark', name: 'Live Park' },
      propertyMedia: [
        { id: 'img-1', type: 'image', description: 'Fachada Live Park', file_name: 'fachada.jpg', is_cover: true },
      ],
    })

    expect(prompt).toContain('EMPREENDIMENTO EM FOCO: Live Park')
    expect(prompt).toContain('img-1')
    expect(prompt).toContain('Fachada Live Park')
  })

  // ============================================================
  // TESTE K: Conversa em Live Park, cliente diz "E o Puerto Ventura?" -> Contexto muda para Puerto Ventura
  // ============================================================
  it('TESTE K: Explicit mention of another property triggers clean property switch', async () => {
    const db = {
      from: () => ({
        select: () => ({
          eq: () =>
            Promise.resolve({
              data: [
                { id: 'prop-livepark', name: 'Live Park' },
                { id: 'prop-puerto', name: 'Puerto Ventura' },
              ],
              error: null,
            }),
        }),
      }),
    } as unknown as SupabaseClient

    const resolution = await resolvePropertyForConversation({
      db,
      accountId: 'acct-1',
      currentPropertyId: 'prop-livepark',
      latestUserMessage: 'E o Puerto Ventura?',
    })

    expect(resolution.propertyId).toBe('prop-puerto')
    expect(resolution.propertyName).toBe('Puerto Ventura')
    expect(resolution.resolutionMethod).toBe('explicit_switch')
  })

  // ============================================================
  // TESTE L: Depois do switch, cliente diz "Fotos" -> Fotos do Puerto Ventura
  // ============================================================
  it('TESTE L: Photos request following explicit switch uses the new property context', async () => {
    const db = {
      from: () => ({
        select: () => ({
          eq: () =>
            Promise.resolve({
              data: [
                { id: 'prop-livepark', name: 'Live Park' },
                { id: 'prop-puerto', name: 'Puerto Ventura' },
              ],
              error: null,
            }),
        }),
      }),
    } as unknown as SupabaseClient

    const resolution = await resolvePropertyForConversation({
      db,
      accountId: 'acct-1',
      currentPropertyId: 'prop-puerto',
      latestUserMessage: 'Fotos',
    })

    expect(resolution.propertyId).toBe('prop-puerto')
    expect(resolution.propertyName).toBe('Puerto Ventura')
    expect(resolution.resolutionMethod).toBe('existing_conversation')
  })

  // ============================================================
  // TESTE M: Cliente manda interesse + fotos + preço + entrega em poucos segundos -> Resposta única e coerente
  // ============================================================
  it('TESTE M: Multi-intent combined message turn generates 1 coherent response respecting price rules', async () => {
    h.state.generateOpenAi.mockResolvedValueOnce({
      text: JSON.stringify({
        response_text: 'O Live Park tem previsão de entrega para Dezembro de 2027. Vou te enviar algumas fotos da fachada e da área de lazer, e direcionar para nossa equipe te passar a tabela de valores.',
        send_media: [{ property_id: 'prop-livepark', media_id: 'img-1', caption: 'Fachada' }],
        transfer_required: true,
        boundary_type: 'price',
        reason: 'Cliente perguntou valores em lançamento',
      }),
      usage: null,
    })

    const db = {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve({ data: { id: 'prop-livepark', name: 'Live Park' }, error: null }),
          }),
        }),
      }),
    } as unknown as SupabaseClient

    const turn = await executeConversationalTurn({
      db,
      accountId: 'acct-1',
      config: baseConfig,
      propertyId: 'prop-livepark',
      messages: [
        { role: 'user', content: 'Tenho interesse' },
        { role: 'user', content: 'Fotos' },
        { role: 'user', content: 'Preço?' },
        { role: 'user', content: 'Entrega?' },
      ],
    })

    expect(turn.handoff).toBe(true)
    expect(turn.decision.boundary_type).toBe('price')
    expect(turn.responseText).toContain('Dezembro de 2027')
    expect(turn.decision.send_media).toHaveLength(1)
  })
})
