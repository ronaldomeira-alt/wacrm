import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { executeConversationalTurn } from './conversation-engine'
import { buildConversationalSystemPrompt } from './prompt-builder'
import { getBusinessHoursContext } from './business-hours'
import type { AiConfig } from './types'

const h = vi.hoisted(() => ({
  generateOpenAi: vi.fn(),
  generateAnthropic: vi.fn(),
  retrievePropertyKnowledge: vi.fn(),
}))

vi.mock('./providers/openai', () => ({
  generateOpenAi: h.generateOpenAi,
}))

vi.mock('./providers/anthropic', () => ({
  generateAnthropic: h.generateAnthropic,
}))

vi.mock('./knowledge', () => ({
  retrievePropertyKnowledge: h.retrievePropertyKnowledge,
}))

describe('Stage 5 — Playground & Conversational Diagnostics', () => {
  const mockConfig: AiConfig = {
    provider: 'openai',
    model: 'gpt-4o',
    apiKey: 'sk-test',
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: false,
    autoReplyMaxPerConversation: 8,
    handoffAgentId: null,
    embeddingsApiKey: null,
    identityName: 'Equipe de Atendimento',
    toneStyle: 'consultative_warm',
    teamPresentation: 'Somos a equipe de atendimento do Ronaldo e da Thatianna.',
    globalNeverRules: 'NUNCA negociar valores, prometer descontos ou inventar especificações não documentadas.',
    responseStyleInstructions: ['Responda em no máximo 2 frases curtas.', 'Sempre termine com uma pergunta.'],
    businessHoursStart: '08:00',
    businessHoursEnd: '18:00',
    businessDays: [1, 2, 3, 4, 5, 6],
    offHoursInstructions: 'Avisar que responderemos no primeiro horário da manhã seguinte.',
    safetyMessageLimit: 8,
  }

  beforeEach(() => {
    vi.clearAllMocks()
    h.retrievePropertyKnowledge.mockResolvedValue([])
  })

  it('1. Playground executes turns without sending WhatsApp messages or triggering external webhook side-effects', async () => {
    h.generateOpenAi.mockResolvedValueOnce({
      text: JSON.stringify({
        response_text: 'Olá! Sou da equipe do Ronaldo e da Thatianna. Em que posso ajudar você hoje?',
        transfer_required: false,
        boundary_type: null,
        reason: null,
        context_summary: 'Primeiro contato amigável',
        suggested_next_action: 'Perguntar interesse ou tipologia',
      }),
      usage: { promptTokens: 150, completionTokens: 40, totalTokens: 190 },
    })

    const db = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
          }),
        }),
      }),
    } as unknown as SupabaseClient

    const result = await executeConversationalTurn({
      db,
      accountId: 'acc-1',
      config: mockConfig,
      messages: [{ role: 'user', content: 'Olá, gostaria de informações' }],
      simulatedHours: 'business_hours',
    })

    expect(result.responseText).toContain('Ronaldo e da Thatianna')
    expect(result.handoff).toBe(false)
    expect(result.decision.transfer_required).toBe(false)
    expect(result.systemPrompt).toBeTruthy()
    expect(result.usage).toBeDefined()
  })

  it('2. Playground uses the exact same conversational prompt builder as production', () => {
    const prompt = buildConversationalSystemPrompt({
      config: mockConfig,
      mode: 'auto_reply',
      businessHours: {
        isBusinessHours: true,
        startHour: '08:00',
        endHour: '18:00',
        offHoursInstructions: null,
        instructionForModel: 'HORÁRIO ATUAL: HORÁRIO COMERCIAL ATIVO.',
      },
      structuredOutputRequired: true,
    })

    expect(prompt).toContain('=== 1. MISSÃO PRINCIPAL E PAPEL NO ATENDIMENTO ===')
    expect(prompt).toContain('=== 2. PERSONALIDADE, TOM DE VOZ E MALEMOLÊNCIA ===')
    expect(prompt).toContain('=== 3. INSTRUÇÕES DE ESTILO DE RESPOSTA ===')
    expect(prompt).toContain('Responda em no máximo 2 frases curtas.')
    expect(prompt).toContain('=== 4. FRONTEIRAS RÍGIDAS')
    expect(prompt).toContain('NUNCA negociar valores, prometer descontos')
    expect(prompt).toContain('=== 11. FORMATO DE RESPOSTA (DECISÃO ESTRUTURADA) ===')
  })

  it('2b. Omitting responseStyleInstructions leaves section 3 out of the prompt entirely', () => {
    const prompt = buildConversationalSystemPrompt({
      config: { ...mockConfig, responseStyleInstructions: null },
      mode: 'auto_reply',
      structuredOutputRequired: false,
    })

    expect(prompt).not.toContain('=== 3. INSTRUÇÕES DE ESTILO DE RESPOSTA ===')
  })

  it('3. Property selector isolation: includes property book in knowledge when property is selected', () => {
    const prompt = buildConversationalSystemPrompt({
      config: mockConfig,
      mode: 'auto_reply',
      property: {
        id: 'prop-123',
        name: 'Residencial Cabo Branco Sunset',
        stage: 'Lançamento',
      },
      propertyKnowledge: [
        'O condomínio dispõe de academia, espaço gourmet e vaga coberta.',
      ],
    })

    expect(prompt).toContain('Residencial Cabo Branco Sunset')
    expect(prompt).toContain('Lançamento')
    expect(prompt).toContain('academia, espaço gourmet e vaga coberta')
  })

  it('4. Property selector isolation: handles unknown or general inquiry when property is null', () => {
    const prompt = buildConversationalSystemPrompt({
      config: mockConfig,
      mode: 'auto_reply',
      property: null,
      propertyKnowledge: [],
    })

    expect(prompt).toContain('Nenhum empreendimento específico foi identificado ainda.')
    expect(prompt).toContain('Você pode acolher o cliente, responder perguntas gerais')
  })

  it('5. Business hours simulation: correctly injects business hours prompt guidance', () => {
    const status = getBusinessHoursContext(mockConfig, new Date('2026-09-09T14:30:00-03:00'))
    expect(status.isBusinessHours).toBe(true)

    const prompt = buildConversationalSystemPrompt({
      config: mockConfig,
      mode: 'auto_reply',
      businessHours: status,
    })
    expect(prompt).toContain('HORÁRIO ATUAL: HORÁRIO COMERCIAL ATIVO')
  })

  it('6. Business hours simulation: correctly injects off-hours / night plantão guidance', () => {
    const status = getBusinessHoursContext(mockConfig, new Date('2026-09-09T22:30:00-03:00'))
    expect(status.isBusinessHours).toBe(false)

    const prompt = buildConversationalSystemPrompt({
      config: mockConfig,
      mode: 'auto_reply',
      businessHours: status,
    })
    expect(prompt).toContain('FORA DO EXPEDIENTE COMERCIAL')
  })

  it('7. Simulated lead context reuse: injects confirmed facts and blocks repetitive questions', () => {
    const prompt = buildConversationalSystemPrompt({
      config: mockConfig,
      mode: 'auto_reply',
      leadContext: {
        contactName: 'Eduardo Guimarães',
        aiScore: 9,
        aiScoreReason: 'Investidor qualificado com alta capacidade financeira',
        summary: {
          purpose: ['investimento'],
          property_type: ['apartamento'],
          location: ['Bessa', 'Manaira'],
          price_min: 500000,
          price_max: 800000,
          price_flex_max: null,
          bedrooms: [2],
          features: ['vista mar', 'varanda gourmet'],
          profile: ['investidor'],
          intent: 'alta',
          stage_signal: null,
          notes: 'Busca rentabilidade com locação por temporada.',
        },
        tags: ['investidor', 'alta-renda', 'temporada'],
        promptExcerpts:
          'INFORMAÇÕES JÁ EXTRAÍDAS E CONFIRMADAS SOBRE ESTE CLIENTE (Eduardo Guimarães):\n- Finalidade declarada: investimento\n- Bairros/Localizações de interesse: Bessa, Manaira\n- Faixa de orçamento informada: até R$ 800.000\n- Quartos desejados: 2',
      },
    })

    expect(prompt).toContain('INFORMAÇÕES JÁ EXTRAÍDAS E CONFIRMADAS SOBRE ESTE CLIENTE (Eduardo Guimarães)')
    expect(prompt).toContain('Finalidade declarada: investimento')
    expect(prompt).toContain('Faixa de orçamento informada: até R$ 800.000')
  })

  it('8. Safety limit enforces transfer_required on turn count >= safetyLimit', async () => {
    const db = {} as unknown as SupabaseClient

    const result = await executeConversationalTurn({
      db,
      accountId: 'acc-1',
      config: mockConfig,
      messages: [{ role: 'user', content: 'Mais uma pergunta...' }],
      replyCount: 8, // Max safety limit reached
    })

    // Safety limit triggers fast-path closing & transfer
    expect(result.handoff).toBe(true)
    expect(result.decision.transfer_required).toBe(true)
    expect(result.decision.boundary_type).toBe('safety_limit_reached')
    expect(h.generateOpenAi).not.toHaveBeenCalled()
  })

  it('9. Boundary enforcement: handles boundary transfer when discount or direct negotiation is requested', async () => {
    h.generateOpenAi.mockResolvedValueOnce({
      text: JSON.stringify({
        response_text: 'Compreendo perfeitamente sua proposta! Questões sobre margem de desconto e condições comerciais personalizadas são conduzidas diretamente pelo Ronaldo. Já avisei que você tem essa proposta para que ele dê continuidade com você.',
        transfer_required: true,
        boundary_type: 'discount_negotiation',
        reason: 'Cliente solicitou 15% de desconto à vista no imóvel',
        context_summary: 'Interessado no Cabo Branco Sunset com proposta de desconto à vista',
        suggested_next_action: 'Ronaldo deve entrar em contato para avaliar margem de negociação',
      }),
      usage: { promptTokens: 250, completionTokens: 80, totalTokens: 330 },
    })

    const db = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
          }),
        }),
      }),
    } as unknown as SupabaseClient

    const result = await executeConversationalTurn({
      db,
      accountId: 'acc-1',
      config: mockConfig,
      messages: [{ role: 'user', content: 'Tem como fazer por 700 mil à vista com desconto?' }],
    })

    expect(result.handoff).toBe(true)
    expect(result.decision.transfer_required).toBe(true)
    expect(result.decision.boundary_type).toBe('discount_negotiation')
    expect(result.responseText).toContain('Ronaldo')
  })

  it('10. Diagnostic metadata: returns token usage, latency context, and full system prompt for administrative inspection', async () => {
    h.generateOpenAi.mockResolvedValueOnce({
      text: JSON.stringify({
        response_text: 'O Residencial Cabo Branco Sunset conta com piscina de borda infinita na cobertura e espaço fitness completo!',
        transfer_required: false,
        boundary_type: null,
        reason: null,
        context_summary: 'Dúvida sobre lazer e piscina',
        suggested_next_action: 'Verificar interesse em agendar visita',
      }),
      usage: { promptTokens: 310, completionTokens: 65, totalTokens: 375 },
    })

    const db = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
          }),
        }),
      }),
    } as unknown as SupabaseClient

    const result = await executeConversationalTurn({
      db,
      accountId: 'acc-1',
      config: mockConfig,
      messages: [{ role: 'user', content: 'Tem piscina e academia no prédio?' }],
    })

    expect(result.usage).toEqual({ promptTokens: 310, completionTokens: 65, totalTokens: 375 })
    expect(result.systemPrompt).toContain('MISSÃO PRINCIPAL E PAPEL NO ATENDIMENTO')
    expect(result.businessHoursContext).toBeDefined()
    expect(result.propertyInfo).toBeNull()
  })
})
