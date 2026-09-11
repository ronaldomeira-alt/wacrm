import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { executeConversationalTurn } from './conversation-engine'
import { buildConversationalSystemPrompt } from './prompt-builder'
import { retrievePropertyKnowledge } from './knowledge'
import type { AiConfig } from './types'

const BASE_CONFIG: AiConfig = {
  provider: 'openai',
  model: 'gpt-4o-mini',
  apiKey: 'sk-test-key',
  systemPrompt: null,
  isActive: true,
  autoReplyEnabled: true,
  autoReplyMaxPerConversation: 8,
  handoffAgentId: null,
  embeddingsApiKey: null,
  businessHoursStart: '08:00',
  businessHoursEnd: '20:00',
  businessDays: [1, 2, 3, 4, 5, 6],
  offHoursInstructions: null,
  safetyMessageLimit: 10,
  responseStyleInstructions: [
    'Responda de forma concisa e natural.',
    'Seja cordial e direta.',
  ],
}

const PUERTO_PROPERTY = {
  id: '4f27cb41-ecbb-4175-bc19-005245a5494c',
  name: 'Puerto Ventura - Locação',
  stage: 'Pronto',
  status: 'ativo',
}

const CLEAN_PUERTO_KNOWLEDGE = [
  `[Ficha Técnica]
1. DADOS GERAIS: Puerto Ventura na Avenida Cabo Branco, João Pessoa/PB. Locação mensal de R$ 3.500/mês com condomínio incluso. Não opera por temporada.
2. CARACTERÍSTICAS DA UNIDADE:
- Metragem: Aproximadamente 45 m², mobiliado e decorado.
- Posição e Vista: Posição sul e vista lateral. NÃO possui vista frontal para o mar.
- Abertura da Sala: A unidade NÃO POSSUI VARANDA, sacada ou terraço. Na sala de estar existe uma abertura/esquadria envidraçada de grandes dimensões que traz ampla iluminação e ventilação. NUNCA descrever como varanda.
- Conectividade: As unidades NÃO POSSUEM tomadas ou entradas de carregamento USB.
3. ÁREAS COMUNS: Rooftop com piscina e vista panorâmica para o mar, restaurante, academia, lavanderia, portaria 24h.`,
  `[Visão do Corretor]
Apartamento de 45 m² à beira-mar de Cabo Branco, totalmente mobiliado, em posição sul com vista lateral e excelente ventilação.
Não possui varanda; a sala de estar conta com uma esquadria envidraçada de grandes dimensões. Não possui USB nas unidades.`,
]

describe('WACRM — Puerto Ventura Knowledge Source & Behavioral Guarantees', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ============================================================
  // TESTE 1: Pergunta "O Puerto Ventura tem varanda?"
  // ============================================================
  it('TESTE 1: Question about balcony informs no balcony and explains the glazed opening in the living room', async () => {
    const originalFetch = global.fetch
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                response_text:
                  'O apartamento não possui varanda, mas conta com uma esquadria envidraçada de grandes dimensões na sala de estar, que proporciona excelente iluminação e ventilação natural.',
                transfer_required: false,
                boundary_type: null,
                reason: 'Esclarecida a ausência de varanda e descrita a esquadria da sala',
                context_summary: 'Informada ausência de varanda no Puerto Ventura',
                suggested_next_action: null,
              }),
            },
          },
        ],
      }),
    })

    const db = {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve({ data: null, error: null }),
            in: () => Promise.resolve({ data: [], error: null }),
          }),
        }),
      }),
    } as unknown as SupabaseClient

    const result = await executeConversationalTurn({
      db,
      accountId: 'acc-1',
      config: BASE_CONFIG,
      propertyId: PUERTO_PROPERTY.id,
      messages: [{ role: 'user', content: 'O Puerto Ventura tem varanda?' }],
    })

    global.fetch = originalFetch

    expect(result.decision.response_text.toLowerCase()).toContain('não possui varanda')
    expect(result.decision.response_text.toLowerCase()).toContain('esquadria envidraçada')
    expect(result.decision.transfer_required).toBe(false)
  })

  // ============================================================
  // TESTE 2: Pergunta "Tem USB no apartamento?"
  // ============================================================
  it('TESTE 2: Question about USB informs unit does not have USB charging', async () => {
    const originalFetch = global.fetch
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                response_text:
                  'As unidades do Puerto Ventura não possuem tomadas ou entradas de carregamento USB.',
                transfer_required: false,
                boundary_type: null,
                reason: 'Esclarecido que o imóvel não possui USB',
                context_summary: 'Informada ausência de USB',
                suggested_next_action: null,
              }),
            },
          },
        ],
      }),
    })

    const db = {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve({ data: null, error: null }),
            in: () => Promise.resolve({ data: [], error: null }),
          }),
        }),
      }),
    } as unknown as SupabaseClient

    const result = await executeConversationalTurn({
      db,
      accountId: 'acc-1',
      config: BASE_CONFIG,
      propertyId: PUERTO_PROPERTY.id,
      messages: [{ role: 'user', content: 'Tem USB no apartamento?' }],
    })

    global.fetch = originalFetch

    expect(result.decision.response_text.toLowerCase()).toContain('não possuem')
    expect(result.decision.response_text.toLowerCase()).toContain('usb')
    expect(result.decision.transfer_required).toBe(false)
  })

  // ============================================================
  // TESTE 3: Pergunta "Tem vista para o mar?"
  // ============================================================
  it('TESTE 3: Question about ocean view respects south position and lateral view without asserting frontal sea view', async () => {
    const originalFetch = global.fetch
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                response_text:
                  'O apartamento possui posição sul, com vista lateral e excelente ventilação.',
                transfer_required: false,
                boundary_type: null,
                reason: 'Informada posição sul e vista lateral',
                context_summary: 'Posição sul e vista lateral informadas',
                suggested_next_action: null,
              }),
            },
          },
        ],
      }),
    })

    const db = {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve({ data: null, error: null }),
            in: () => Promise.resolve({ data: [], error: null }),
          }),
        }),
      }),
    } as unknown as SupabaseClient

    const result = await executeConversationalTurn({
      db,
      accountId: 'acc-1',
      config: BASE_CONFIG,
      propertyId: PUERTO_PROPERTY.id,
      messages: [{ role: 'user', content: 'Tem vista para o mar?' }],
    })

    global.fetch = originalFetch

    expect(result.decision.response_text.toLowerCase()).toContain('posição sul')
    expect(result.decision.response_text.toLowerCase()).toContain('vista lateral')
    expect(result.decision.response_text.toLowerCase()).not.toContain('vista frontal para o mar')
    expect(result.decision.response_text.toLowerCase()).not.toContain('frente mar')
  })

  // ============================================================
  // TESTE 4: Pergunta "Tem varanda com vista?" (Premissa Falsa)
  // ============================================================
  it('TESTE 4: False premise "Tem varanda com vista?" is politely corrected', async () => {
    const originalFetch = global.fetch
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                response_text:
                  'O apartamento não possui varanda, mas conta com uma esquadria envidraçada de grandes dimensões na sala com vista lateral e posição sul.',
                transfer_required: false,
                boundary_type: null,
                reason: 'Premissa de varanda corrigida',
                context_summary: 'Esclarecido que a unidade tem esquadria na sala e vista lateral',
                suggested_next_action: null,
              }),
            },
          },
        ],
      }),
    })

    const db = {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve({ data: null, error: null }),
            in: () => Promise.resolve({ data: [], error: null }),
          }),
        }),
      }),
    } as unknown as SupabaseClient

    const result = await executeConversationalTurn({
      db,
      accountId: 'acc-1',
      config: BASE_CONFIG,
      propertyId: PUERTO_PROPERTY.id,
      messages: [{ role: 'user', content: 'Tem varanda com vista?' }],
    })

    global.fetch = originalFetch

    expect(result.decision.response_text.toLowerCase()).toContain('não possui varanda')
    expect(result.decision.response_text.toLowerCase()).toContain('esquadria envidraçada')
    expect(result.decision.response_text.toLowerCase()).toContain('vista lateral')
  })

  // ============================================================
  // TESTE 5: Pergunta "Como é a abertura da sala?"
  // ============================================================
  it('TESTE 5: Question "Como é a abertura da sala?" describes the glazed opening without calling it balcony', async () => {
    const originalFetch = global.fetch
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                response_text:
                  'A sala de estar possui uma abertura com esquadria envidraçada de grandes dimensões, garantindo muita luz natural e ótima ventilação.',
                transfer_required: false,
                boundary_type: null,
                reason: 'Descrita a abertura envidraçada da sala',
                context_summary: 'Abertura envidraçada da sala descrita',
                suggested_next_action: null,
              }),
            },
          },
        ],
      }),
    })

    const db = {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve({ data: null, error: null }),
            in: () => Promise.resolve({ data: [], error: null }),
          }),
        }),
      }),
    } as unknown as SupabaseClient

    const result = await executeConversationalTurn({
      db,
      accountId: 'acc-1',
      config: BASE_CONFIG,
      propertyId: PUERTO_PROPERTY.id,
      messages: [{ role: 'user', content: 'Como é a abertura da sala?' }],
    })

    global.fetch = originalFetch

    expect(result.decision.response_text.toLowerCase()).toContain('esquadria envidraçada de grandes dimensões')
    expect(result.decision.response_text.toLowerCase()).not.toContain('varanda')
    expect(result.decision.response_text.toLowerCase()).not.toContain('sacada')
  })

  // ============================================================
  // TESTE 6: Diálogo Contínuo (Varanda -> Vista)
  // ============================================================
  it('TESTE 6: Follow-up turn maintains Puerto Ventura context and explains south position / lateral view', async () => {
    const originalFetch = global.fetch
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                response_text:
                  'A unidade possui posição sul, com vista lateral e ventilação muito agradável.',
                transfer_required: false,
                boundary_type: null,
                reason: 'Vista lateral e posição sul informadas no follow-up',
                context_summary: 'Vista lateral do Puerto Ventura explicada',
                suggested_next_action: null,
              }),
            },
          },
        ],
      }),
    })

    const db = {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve({ data: null, error: null }),
            in: () => Promise.resolve({ data: [], error: null }),
          }),
        }),
      }),
    } as unknown as SupabaseClient

    const result = await executeConversationalTurn({
      db,
      accountId: 'acc-1',
      config: BASE_CONFIG,
      propertyId: PUERTO_PROPERTY.id,
      messages: [
        { role: 'user', content: 'Esse apartamento tem varanda?' },
        { role: 'assistant', content: 'Não possui varanda, mas sim uma esquadria envidraçada de grandes dimensões na sala.' },
        { role: 'user', content: 'Ah, e a vista?' },
      ],
    })

    global.fetch = originalFetch

    expect(result.decision.response_text.toLowerCase()).toContain('posição sul')
    expect(result.decision.response_text.toLowerCase()).toContain('vista lateral')
    expect(result.decision.response_text.toLowerCase()).not.toContain('vista frontal')
  })

  // ============================================================
  // TESTE 7: Retrieval não retorna chunks desatualizados
  // ============================================================
  it('TESTE 7: Retrieval strictly returns updated chunks without old "Varanda com vista" or "Tomadas USB"', async () => {
    const mockDb = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'ai_knowledge_chunks') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockResolvedValue({ count: 1, error: null }),
              in: vi.fn().mockResolvedValue({
                data: [
                  {
                    id: 'chunk-clean-1',
                    property_id: PUERTO_PROPERTY.id,
                    ai_knowledge_documents: { source_type: 'pdf_book', title: 'Ficha Técnica' },
                  },
                ],
                error: null,
              }),
            }),
            eq: vi.fn().mockReturnThis(),
          }
        }
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
        }
      }),
      rpc: vi.fn().mockResolvedValue({
        data: [
          {
            id: 'chunk-clean-1',
            content: CLEAN_PUERTO_KNOWLEDGE[0],
            is_global: false,
          },
        ],
        error: null,
      }),
    } as unknown as SupabaseClient

    const res = await retrievePropertyKnowledge(
      mockDb,
      'acc-1',
      BASE_CONFIG,
      PUERTO_PROPERTY.id,
      'varanda usb vista',
      5,
    )

    const allContent = res.propertyChunks.join('\n')
    expect(allContent).toContain('NÃO POSSUI VARANDA')
    expect(allContent).toContain('NÃO POSSUEM tomadas ou entradas de carregamento USB')
    expect(allContent).toContain('Posição sul e vista lateral')
    expect(allContent).not.toContain('Varanda com vista')
    expect(allContent).not.toContain('Tomadas USB nos apartamentos')
  })

  // ============================================================
  // TESTE 8: Prompt final enviado à Clara não contém conflitos
  // ============================================================
  it('TESTE 8: Final system prompt is free of conflicting affirmations', () => {
    const prompt = buildConversationalSystemPrompt({
      config: BASE_CONFIG,
      mode: 'auto_reply',
      property: PUERTO_PROPERTY,
      propertyKnowledge: CLEAN_PUERTO_KNOWLEDGE,
    })

    expect(prompt).toContain('EMPREENDIMENTO EM FOCO: Puerto Ventura - Locação')
    expect(prompt).toContain('ISOLAMENTO E ANCORAGEM')
    expect(prompt).toContain('Fatos específicos e restrições negativas autorizadas deste empreendimento prevalecem')
    expect(prompt).toContain('A unidade NÃO POSSUI VARANDA')
    expect(prompt).toContain('NÃO POSSUEM tomadas ou entradas de carregamento USB')
    expect(prompt).toContain('Posição sul e vista lateral')
    // Ensure no positive balcony or positive USB statements exist for Puerto Ventura
    expect(prompt).not.toContain('Tomadas USB nos apartamentos')
    expect(prompt).not.toContain('Varanda com vista')
  })
})
