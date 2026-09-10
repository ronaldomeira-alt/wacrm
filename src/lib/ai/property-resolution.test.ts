import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  resolvePropertyForConversation,
} from './property-resolution'
import { buildConversationalSystemPrompt } from './prompt-builder'
import { executeConversationalTurn } from './conversation-engine'
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

describe('Stage 7 — CTWA, Property Resolution & Qualification Integration', () => {
  const mockConfig: AiConfig = {
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

  beforeEach(() => {
    vi.clearAllMocks()
    h.retrievePropertyKnowledge.mockResolvedValue([])
  })

  describe('5-Level Cascade Property Resolution', () => {
    it('1. Priority 1: Uses existing valid property_id on conversation directly', async () => {
      const db = {
        from: () => ({
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: () =>
                  Promise.resolve({
                    data: { id: 'prop-cabo-branco', name: 'Residencial Cabo Branco Sunset' },
                    error: null,
                  }),
              }),
            }),
          }),
        }),
      } as unknown as SupabaseClient

      const result = await resolvePropertyForConversation({
        db,
        accountId: 'acc-1',
        currentPropertyId: 'prop-cabo-branco',
        referral: { source_id: 'some-other-ad' },
      })

      expect(result.propertyId).toBe('prop-cabo-branco')
      expect(result.propertyName).toBe('Residencial Cabo Branco Sunset')
      expect(result.resolutionMethod).toBe('existing_conversation')
      expect(result.confidence).toBe(1.0)
    })

    it('2. Priority 2: Deterministic Meta CTWA Ad ID mapping (property_ad_mappings)', async () => {
      const db = {
        from: (table: string) => {
          if (table === 'property_ad_mappings') {
            return {
              select: () => ({
                eq: () => ({
                  eq: () => ({
                    maybeSingle: () =>
                      Promise.resolve({
                        data: {
                          property_id: 'prop-aurora',
                          properties: { id: 'prop-aurora', name: 'Aurora Boulevard' },
                        },
                        error: null,
                      }),
                  }),
                }),
              }),
            }
          }
          return {
            select: () => ({
              eq: () => Promise.resolve({ data: [], error: null }),
            }),
          }
        },
      } as unknown as SupabaseClient

      const result = await resolvePropertyForConversation({
        db,
        accountId: 'acc-1',
        currentPropertyId: null,
        referral: { source_id: '1202998877665544' },
      })

      expect(result.propertyId).toBe('prop-aurora')
      expect(result.propertyName).toBe('Aurora Boulevard')
      expect(result.resolutionMethod).toBe('ctwa_ad_mapping')
      expect(result.confidence).toBe(1.0)
    })

    it('3. Priority 3: Fallback match on CTWA Referral headline and body', async () => {
      const db = {
        from: (table: string) => {
          if (table === 'property_ad_mappings') {
            return {
              select: () => ({
                eq: () => ({
                  eq: () => ({
                    maybeSingle: () => Promise.resolve({ data: null, error: null }),
                  }),
                }),
              }),
            }
          }
          if (table === 'properties') {
            return {
              select: () => ({
                eq: () =>
                  Promise.resolve({
                    data: [
                      { id: 'p1', name: 'Residencial Cabo Branco Sunset' },
                      { id: 'p2', name: 'Solaris Manaíra' },
                    ],
                    error: null,
                  }),
              }),
            }
          }
          return { select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }) }
        },
      } as unknown as SupabaseClient

      const result = await resolvePropertyForConversation({
        db,
        accountId: 'acc-1',
        currentPropertyId: null,
        referral: {
          headline: 'Conheça o Solaris Manaíra - 3 Suítes com Vista Mar',
          body: 'Lançamento imperdível a 100m da praia',
        },
      })

      expect(result.propertyId).toBe('p2')
      expect(result.propertyName).toBe('Solaris Manaíra')
      expect(result.resolutionMethod).toBe('ctwa_headline_match')
    })

    it('4. Priority 4: Fallback match on First Inbound User Message', async () => {
      const db = {
        from: (table: string) => {
          if (table === 'property_ad_mappings') {
            return {
              select: () => ({
                eq: () => ({
                  eq: () => ({
                    maybeSingle: () => Promise.resolve({ data: null, error: null }),
                  }),
                }),
              }),
            }
          }
          if (table === 'properties') {
            return {
              select: () => ({
                eq: () =>
                  Promise.resolve({
                    data: [
                      { id: 'p1', name: 'Residencial Cabo Branco Sunset' },
                      { id: 'p2', name: 'Solaris Manaíra' },
                    ],
                    error: null,
                  }),
              }),
            }
          }
          return { select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }) }
        },
      } as unknown as SupabaseClient

      const result = await resolvePropertyForConversation({
        db,
        accountId: 'acc-1',
        currentPropertyId: null,
        referral: null, // No CTWA metadata
        firstUserMessage: 'Olá! Gostaria de saber mais sobre o Residencial Cabo Branco Sunset.',
      })

      expect(result.propertyId).toBe('p1')
      expect(result.propertyName).toBe('Residencial Cabo Branco Sunset')
      expect(result.resolutionMethod).toBe('first_message_match')
    })

    it('5. Priority 5: Unresolved -> UNKNOWN (null) without guessing or hallucinations', async () => {
      const db = {
        from: (table: string) => {
          if (table === 'property_ad_mappings') {
            return {
              select: () => ({
                eq: () => ({
                  eq: () => ({
                    maybeSingle: () => Promise.resolve({ data: null, error: null }),
                  }),
                }),
              }),
            }
          }
          if (table === 'properties') {
            return {
              select: () => ({
                eq: () =>
                  Promise.resolve({
                    data: [
                      { id: 'p1', name: 'Residencial Cabo Branco Sunset' },
                    ],
                    error: null,
                  }),
              }),
            }
          }
          return { select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }) }
        },
      } as unknown as SupabaseClient

      const result = await resolvePropertyForConversation({
        db,
        accountId: 'acc-1',
        currentPropertyId: null,
        referral: { headline: 'Apartamento dos seus sonhos em João Pessoa' }, // generic headline
        firstUserMessage: 'Olá, bom dia!',
      })

      expect(result.propertyId).toBeNull()
      expect(result.propertyName).toBeNull()
      expect(result.resolutionMethod).toBe('unresolved')
      expect(result.confidence).toBe(0.0)
    })
  })

  describe('Knowledge Leakage & Property Isolation Test', () => {
    it('6. Leakage Test: Property A prompt never contains Property B knowledge', () => {
      const promptA = buildConversationalSystemPrompt({
        config: mockConfig,
        mode: 'auto_reply',
        property: { id: 'prop-a', name: 'Reserva Altiplano', stage: 'Em Obras' },
        propertyKnowledge: ['Diferencial A: Piscina privativa em todas as coberturas.'],
      })

      const promptB = buildConversationalSystemPrompt({
        config: mockConfig,
        mode: 'auto_reply',
        property: { id: 'prop-b', name: 'Sunset Cabo Branco', stage: 'Lançamento' },
        propertyKnowledge: ['Diferencial B: Heliponto homologado e spa.'],
      })

      expect(promptA).toContain('Reserva Altiplano')
      expect(promptA).toContain('Piscina privativa em todas as coberturas.')
      expect(promptA).not.toContain('Sunset Cabo Branco')
      expect(promptA).not.toContain('Heliponto homologado e spa')

      expect(promptB).toContain('Sunset Cabo Branco')
      expect(promptB).toContain('Heliponto homologado e spa')
      expect(promptB).not.toContain('Reserva Altiplano')
      expect(promptB).not.toContain('Piscina privativa em todas as coberturas')
    })
  })

  describe('Qualification, Out-of-Context Demand & Knowledge Limits', () => {
    it('7. Handles out-of-context demand (rental on off-plan sale) gracefully without discarding lead', async () => {
      h.generateOpenAi.mockResolvedValueOnce({
        text: JSON.stringify({
          response_text: 'O Reserva Altiplano é um empreendimento em obras para aquisição. Mas posso verificar com nossa equipe se temos opções prontas para locação na região!',
          transfer_required: true,
          boundary_type: 'incompatible_demand',
          reason: 'Cliente busca locação enquanto o anúncio é de venda na planta',
          context_summary: 'Interesse em locação no Altiplano',
          suggested_next_action: 'Apresentar carteira de locação disponível',
        }),
        usage: { promptTokens: 200, completionTokens: 40, totalTokens: 240 },
      })

      const db = {
        from: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({
                data: { name: 'Reserva Altiplano' },
                error: null,
              }),
            }),
          }),
        }),
      } as unknown as SupabaseClient

      const result = await executeConversationalTurn({
        db,
        accountId: 'acc-1',
        config: mockConfig,
        propertyId: 'prop-a',
        messages: [{ role: 'user', content: 'Quero alugar um flat nesse prédio para o próximo mês.' }],
      })

      expect(result.handoff).toBe(true)
      expect(result.decision.boundary_type).toBe('incompatible_demand')
      expect(result.responseText).toContain('aquisição')
      expect(result.responseText).not.toContain('fora do nosso perfil')
    })

    it('8. Unknown property with specific technical query triggers knowledge_limit handoff safely', async () => {
      h.generateOpenAi.mockResolvedValueOnce({
        text: JSON.stringify({
          response_text: 'Para te fornecer as informações exatas e a documentação completa deste empreendimento, vou encaminhar nossa conversa para nossa equipe de atendimento.',
          transfer_required: true,
          boundary_type: 'knowledge_limit',
          reason: 'Empreendimento não identificado e dados específicos solicitados',
          context_summary: 'Cliente perguntou detalhes de planta sem empreendimento definido',
          suggested_next_action: 'Identificar empreendimento desejado e apresentar plantas',
        }),
        usage: { promptTokens: 180, completionTokens: 35, totalTokens: 215 },
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
        propertyId: null, // Unresolved property
        messages: [{ role: 'user', content: 'Qual a metragem da planta tipo 2?' }],
      })

      expect(result.handoff).toBe(true)
      expect(result.decision.boundary_type).toBe('knowledge_limit')
      expect(result.decision.reason).toContain('não identificado')
    })
  })
})
