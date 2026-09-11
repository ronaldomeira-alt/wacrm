import { describe, it, expect } from 'vitest'
import { buildConversationalSystemPrompt } from './prompt-builder'
import { parseStructuredDecision } from './conversation-engine'
import type { AiConfig, PropertyMediaSummary } from './types'

describe('Property Media Prompt Building & Engine Decision Parsing', () => {
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
  }

  const sampleMedia: PropertyMediaSummary[] = [
    {
      id: 'media-fachada-123',
      type: 'image',
      description: 'Fachada principal com vista frontal e paisagismo',
      file_name: 'fachada.jpg',
      is_cover: true,
    },
    {
      id: 'media-lazer-456',
      type: 'image',
      description: 'Piscina aquecida com borda infinita e deck molhado',
      file_name: 'piscina.webp',
      is_cover: false,
    },
    {
      id: 'media-gym-789',
      type: 'image',
      description: 'Academia equipada com esteiras e pesos livres',
      file_name: 'academia.jpg',
      is_cover: false,
    },
  ]

  it('buildConversationalSystemPrompt includes formatted media metadata in Section 8 when media is present', () => {
    const prompt = buildConversationalSystemPrompt({
      config: baseConfig,
      mode: 'auto_reply',
      property: {
        id: 'prop-1',
        name: 'Puerto Ventura',
        stage: 'Lançamento',
      },
      propertyMedia: sampleMedia,
      structuredOutputRequired: true,
    })

    expect(prompt).toContain('MÍDIAS DISPONÍVEIS DESTE EMPREENDIMENTO (FOTOS CADASTRADAS):')
    expect(prompt).toContain('media-fachada-123')
    expect(prompt).toContain('Fachada principal com vista frontal e paisagismo')
    expect(prompt).toContain('media-lazer-456')
    expect(prompt).toContain('DIRETRIZES PARA ENVIO DE FOTOS (send_media)')
    expect(prompt).toContain('NUNCA invente media_id')
    expect(prompt).toContain('"send_media"')
  })

  it('buildConversationalSystemPrompt omits media section when propertyMedia is empty', () => {
    const prompt = buildConversationalSystemPrompt({
      config: baseConfig,
      mode: 'auto_reply',
      property: {
        id: 'prop-1',
        name: 'Puerto Ventura',
      },
      propertyMedia: [],
      structuredOutputRequired: true,
    })

    expect(prompt).not.toContain('MÍDIAS DISPONÍVEIS DESTE EMPREENDIMENTO (FOTOS CADASTRADAS):')
  })

  it('parseStructuredDecision extracts send_media array correctly', () => {
    const modelOutput = JSON.stringify({
      response_text: 'Aqui está a foto da fachada e da piscina do Puerto Ventura!',
      send_media: [
        {
          property_id: 'prop-1',
          media_id: 'media-fachada-123',
          caption: 'Fachada principal',
        },
        {
          media_id: 'media-lazer-456',
          caption: 'Piscina com borda infinita',
        },
      ],
      transfer_required: false,
      boundary_type: null,
      reason: 'Cliente solicitou fotos das áreas comuns',
      context_summary: 'Enviadas fotos da fachada e piscina',
      suggested_next_action: null,
    })

    const decision = parseStructuredDecision(modelOutput)

    expect(decision.response_text).toBe('Aqui está a foto da fachada e da piscina do Puerto Ventura!')
    expect(decision.transfer_required).toBe(false)
    expect(decision.send_media).toBeDefined()
    expect(decision.send_media).toHaveLength(2)
    expect(decision.send_media![0]).toEqual({
      property_id: 'prop-1',
      media_id: 'media-fachada-123',
      caption: 'Fachada principal',
    })
    expect(decision.send_media![1]).toEqual({
      property_id: undefined,
      media_id: 'media-lazer-456',
      caption: 'Piscina com borda infinita',
    })
  })

  it('parseStructuredDecision extracts single object send_media correctly', () => {
    const modelOutput = JSON.stringify({
      response_text: 'Veja a fachada do empreendimento:',
      send_media: {
        media_id: 'media-fachada-123',
        caption: 'Fachada',
      },
      transfer_required: false,
    })

    const decision = parseStructuredDecision(modelOutput)

    expect(decision.send_media).toHaveLength(1)
    expect(decision.send_media![0].media_id).toBe('media-fachada-123')
    expect(decision.send_media![0].caption).toBe('Fachada')
  })

  it('parseStructuredDecision handles null or absent send_media gracefully', () => {
    const modelOutput = JSON.stringify({
      response_text: 'O empreendimento conta com 3 suítes e 2 vagas de garagem.',
      transfer_required: false,
      boundary_type: null,
    })

    const decision = parseStructuredDecision(modelOutput)
    expect(decision.send_media).toBeNull()
  })
})
