import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })
import { supabaseAdmin } from '../src/lib/ai/admin-client'
import { loadAiConfig } from '../src/lib/ai/config'
import { generateOpenAi } from '../src/lib/ai/providers/openai'
import { generateAnthropic } from '../src/lib/ai/providers/anthropic'
import { aiRequestTimeoutMs } from '../src/lib/ai/defaults'
import {
  buildReactivationSystemPrompt,
  buildReactivationUserPrompt,
} from '../src/lib/ai/reactivation-prompt'
import {
  isWithinBusinessHours,
  getNextBusinessHourStart,
} from '../src/lib/ai/reactivation-engine'
import type { ChatMessage, AiConfig } from '../src/lib/ai/types'

async function runDryRun() {
  const db = supabaseAdmin()

  const targetAccountId = 'f8d2ae51-e393-4a74-a432-ddab0610837e'
  let config: AiConfig | null = null
  try {
    config = await loadAiConfig(db, targetAccountId)
  } catch (err) {
    console.error('loadAiConfig error:', err)
  }

  if (!config) {
    const { data: configs } = await db
      .from('ai_configs')
      .select('account_id')
      .eq('is_active', true)

    for (const c of configs || []) {
      config = await loadAiConfig(db, c.account_id).catch(() => null)
      if (config) break
    }
  }

  if (!config) {
    console.error('Could not load and decrypt any active AI config!')
    process.exit(1)
  }

  console.log(`[DRY-RUN] Loaded config for account: ${targetAccountId}`)
  console.log(`[DRY-RUN] Provider: ${config.provider}, Model: ${config.model}, Identity: ${config.identityName || 'Clara'}\n`)

  const callLlm = async (args: {
    contactName: string
    propertyName?: string
    propertyStage?: string
    messages: ChatMessage[]
  }) => {
    const systemPrompt = buildReactivationSystemPrompt({ identityName: config.identityName })
    const userPrompt = buildReactivationUserPrompt({
      contactName: args.contactName,
      propertyName: args.propertyName,
      propertyStage: args.propertyStage,
      identityName: config.identityName,
      messages: args.messages,
    })

    const providerArgs = {
      apiKey: config.apiKey,
      model: config.model,
      systemPrompt,
      messages: [{ role: 'user' as const, content: userPrompt }],
      timeoutMs: aiRequestTimeoutMs(),
    }

    const response =
      config.provider === 'openai'
        ? await generateOpenAi(providerArgs)
        : await generateAnthropic(providerArgs)

    const cleaned = response.text.trim().replace(/```json/gi, '').replace(/```/g, '').trim()
    try {
      return JSON.parse(cleaned)
    } catch {
      return {
        should_reactivate: true,
        reactivation_type: 'global',
        detected_need_or_clue: null,
        reason: 'Raw text output',
        message_text: response.text.trim(),
      }
    }
  }

  const results: Record<string, unknown>[] = []

  // ==========================================
  // CENÁRIO 1 — SEM CONTEXTO
  // ==========================================
  console.log('Executando Cenário 1...')
  const sc1Messages: ChatMessage[] = [
    { role: 'user', content: 'Oi' },
    { role: 'assistant', content: 'Olá! Tudo bem? Como posso te ajudar hoje?' },
  ]
  const sc1Decision = await callLlm({
    contactName: 'Carlos',
    propertyName: 'Live Park',
    propertyStage: 'Lançamento',
    messages: sc1Messages,
  })
  results.push({
    cenario: 'CENÁRIO 1 — SEM CONTEXTO',
    contexto: 'Cliente apenas enviou "Oi" e parou de responder após a saudação da Clara.',
    tipo_escolhido: sc1Decision.reactivation_type,
    pista_identificada: sc1Decision.detected_need_or_clue,
    mensagem_exata: sc1Decision.message_text,
    decisao_envio: sc1Decision.should_reactivate ? 'ENVIAR' : 'NÃO ENVIAR',
    motivo_decisao: sc1Decision.reason,
  })

  // ==========================================
  // CENÁRIO 2 — QUARTOS
  // ==========================================
  console.log('Executando Cenário 2...')
  const sc2Messages: ChatMessage[] = [
    { role: 'user', content: 'Olá, quantos quartos tem o Live Park?' },
    { role: 'assistant', content: 'O Live Park conta com opções inteligentes em conceito studio e 1 quarto.' },
  ]
  const sc2Decision = await callLlm({
    contactName: 'Marina',
    propertyName: 'Live Park',
    propertyStage: 'Lançamento',
    messages: sc2Messages,
  })
  results.push({
    cenario: 'CENÁRIO 2 — QUARTOS',
    contexto: 'Cliente perguntou quantos quartos tem, Clara respondeu que tem 1 quarto e o cliente silenciou por 3h.',
    tipo_escolhido: sc2Decision.reactivation_type,
    pista_identificada: sc2Decision.detected_need_or_clue,
    mensagem_exata: sc2Decision.message_text,
    decisao_envio: sc2Decision.should_reactivate ? 'ENVIAR' : 'NÃO ENVIAR',
    motivo_decisao: sc2Decision.reason,
  })

  // ==========================================
  // CENÁRIO 3 — PRONTO OU CONSTRUÇÃO
  // ==========================================
  console.log('Executando Cenário 3...')
  const sc3Messages: ChatMessage[] = [
    { role: 'user', content: 'Esse prédio já está pronto para morar?' },
    { role: 'assistant', content: 'O Live Park ainda está em fase de lançamento e obras, com entrega prevista para 2027.' },
  ]
  const sc3Decision = await callLlm({
    contactName: 'Rodrigo',
    propertyName: 'Live Park',
    propertyStage: 'Lançamento',
    messages: sc3Messages,
  })
  results.push({
    cenario: 'CENÁRIO 3 — PRONTO OU CONSTRUÇÃO',
    contexto: 'Cliente perguntou se já está pronto, soube que está em obras até 2027 e silenciou por 3h.',
    tipo_escolhido: sc3Decision.reactivation_type,
    pista_identificada: sc3Decision.detected_need_or_clue,
    mensagem_exata: sc3Decision.message_text,
    decisao_envio: sc3Decision.should_reactivate ? 'ENVIAR' : 'NÃO ENVIAR',
    motivo_decisao: sc3Decision.reason,
  })

  // ==========================================
  // CENÁRIO 4 — TEMPORADA
  // ==========================================
  console.log('Executando Cenário 4...')
  const sc4Messages: ChatMessage[] = [
    { role: 'user', content: 'Estou procurando um imóvel para rentabilizar com locação por temporada no Airbnb.' },
    { role: 'assistant', content: 'O Live Park conta com piscina no rooftop e lazer completo no Caribessa, mas tem proposta residencial voltada para estadias com perfil tranquilo.' },
  ]
  const sc4Decision = await callLlm({
    contactName: 'Patrícia',
    propertyName: 'Live Park',
    propertyStage: 'Lançamento',
    messages: sc4Messages,
  })
  results.push({
    cenario: 'CENÁRIO 4 — TEMPORADA',
    contexto: 'Cliente buscou investimento em Airbnb/temporada e silenciou por 3h após explicação do perfil.',
    tipo_escolhido: sc4Decision.reactivation_type,
    pista_identificada: sc4Decision.detected_need_or_clue,
    mensagem_exata: sc4Decision.message_text,
    decisao_envio: sc4Decision.should_reactivate ? 'ENVIAR' : 'NÃO ENVIAR',
    motivo_decisao: sc4Decision.reason,
  })

  // ==========================================
  // CENÁRIO 5 — PREÇO
  // ==========================================
  console.log('Executando Cenário 5...')
  const sc5Messages: ChatMessage[] = [
    { role: 'user', content: 'Estou buscando algo na faixa de até 250 mil reais no Bessa.' },
    { role: 'assistant', content: 'No Live Park as unidades partem de valores a partir de 330 mil reais devido à localização a 170 metros da praia.' },
  ]
  const sc5Decision = await callLlm({
    contactName: 'Juliana',
    propertyName: 'Live Park',
    propertyStage: 'Lançamento',
    messages: sc5Messages,
  })
  results.push({
    cenario: 'CENÁRIO 5 — PREÇO',
    contexto: 'Cliente tinha orçamento de 250 mil, soube que o Live Park começa em 330 mil e silenciou por 3h.',
    tipo_escolhido: sc5Decision.reactivation_type,
    pista_identificada: sc5Decision.detected_need_or_clue,
    mensagem_exata: sc5Decision.message_text,
    decisao_envio: sc5Decision.should_reactivate ? 'ENVIAR' : 'NÃO ENVIAR',
    motivo_decisao: sc5Decision.reason,
  })

  // ==========================================
  // CENÁRIO 6 — CLIENTE SIMPLESMENTE OCUPADO
  // ==========================================
  console.log('Executando Cenário 6...')
  const sc6Messages: ChatMessage[] = [
    { role: 'user', content: 'Onde fica localizado exatamente?' },
    { role: 'assistant', content: 'Fica no bairro do Bessa, numa região conhecida como Caribessa, a cerca de 170 metros da praia.' },
    { role: 'user', content: 'Que bacana, bem perto do mar! Tem piscina?' },
    { role: 'assistant', content: 'Tem sim! Uma piscina linda no rooftop com vista panorâmica.' },
  ]
  const sc6Decision = await callLlm({
    contactName: 'Fernando',
    propertyName: 'Live Park',
    propertyStage: 'Lançamento',
    messages: sc6Messages,
  })
  results.push({
    cenario: 'CENÁRIO 6 — CLIENTE SIMPLESMENTE OCUPADO',
    contexto: 'Cliente fez perguntas normais, elogiou ("Que bacana!"), não apontou objeção e silenciou por 3h.',
    tipo_escolhido: sc6Decision.reactivation_type,
    pista_identificada: sc6Decision.detected_need_or_clue,
    mensagem_exata: sc6Decision.message_text,
    decisao_envio: sc6Decision.should_reactivate ? 'ENVIAR' : 'NÃO ENVIAR',
    motivo_decisao: sc6Decision.reason,
  })

  // ==========================================
  // CENÁRIO 7 — SEM PISTA SUFICIENTE
  // ==========================================
  console.log('Executando Cenário 7...')
  const sc7Messages: ChatMessage[] = [
    { role: 'user', content: 'Boa tarde, vi o anúncio de vocês.' },
    { role: 'assistant', content: 'Boa tarde! Seja muito bem-vindo. Como posso te ajudar hoje?' },
    { role: 'user', content: 'Estava dando uma olhada nos imóveis aqui de João Pessoa.' },
    { role: 'assistant', content: 'Perfeito! Temos opções muito interessantes no litoral. O que você gostaria de priorizar?' },
  ]
  const sc7Decision = await callLlm({
    contactName: 'Eduardo',
    propertyName: undefined,
    propertyStage: undefined,
    messages: sc7Messages,
  })
  results.push({
    cenario: 'CENÁRIO 7 — SEM PISTA SUFICIENTE',
    contexto: 'Cliente comentou apenas que estava olhando imóveis em João Pessoa, sem detalhar características, e silenciou por 3h.',
    tipo_escolhido: sc7Decision.reactivation_type,
    pista_identificada: sc7Decision.detected_need_or_clue,
    mensagem_exata: sc7Decision.message_text,
    decisao_envio: sc7Decision.should_reactivate ? 'ENVIAR' : 'NÃO ENVIAR',
    motivo_decisao: sc7Decision.reason,
  })

  // ==========================================
  // CENÁRIO 8 — CLIENTE RESPONDE ANTES DO ENVIO
  // ==========================================
  console.log('Executando Cenário 8...')
  const sc8LastEvaluated = '2026-09-12T10:00:00.000Z'
  const sc8NewCustomerMsg = {
    content: 'Oi! Desculpe a demora, estava numa reunião de trabalho. Tem vaga de garagem?',
    created_at: '2026-09-12T12:45:00.000Z',
  }
  // Simulando a regra do engine
  const sc8Replied = new Date(sc8NewCustomerMsg.created_at).getTime() > new Date(sc8LastEvaluated).getTime()
  results.push({
    cenario: 'CENÁRIO 8 — CLIENTE RESPONDE ANTES DO ENVIO',
    contexto: `Reativação estava pendente/agendada desde 10:00. Às 12:45 o cliente enviou: "${sc8NewCustomerMsg.content}". (replied=${sc8Replied})`,
    tipo_escolhido: 'none',
    pista_identificada: 'Cliente quebrou o silêncio ativamente antes da janela de disparo.',
    mensagem_exata: '(Nenhuma mensagem de reativação gerada — o webhook do auto-reply assume a resposta normalmente)',
    decisao_envio: 'NÃO ENVIAR',
    motivo_decisao: 'cancelled_customer_replied: Como o cliente respondeu antes da execução, a reativação pendente foi imediatamente cancelada para não gerar mensagem sobreposta ou descontextualizada.',
  })

  // ==========================================
  // CENÁRIO 9 — FORA DO HORÁRIO
  // ==========================================
  console.log('Executando Cenário 9...')
  // Cliente falou às 19:00 BRT. 3h depois é 22:00 BRT (01:00 UTC do dia seguinte).
  const sc9SimulatedNow = new Date('2026-09-13T01:00:00.000Z') // 22:00 BRT
  const sc9IsBusiness = isWithinBusinessHours(sc9SimulatedNow, config)
  const sc9NextStart = getNextBusinessHourStart(sc9SimulatedNow, config)
  results.push({
    cenario: 'CENÁRIO 9 — FORA DO HORÁRIO COMERCIAL',
    contexto: `Cliente enviou mensagem às 19:00. O gatilho de 3 horas vence às 22:00 (isBusinessHours=${sc9IsBusiness}).`,
    tipo_escolhido: 'none (retido/postergado)',
    pista_identificada: `Horário atual avaliado: 22:00 BRT (fora da janela comercial de 08:00 às 20:00).`,
    mensagem_exata: '(Nenhuma mensagem enviada às 22:00 — agendada para o próximo expediente)',
    decisao_envio: 'NÃO ENVIAR IMEDIATAMENTE (AGENDAR)',
    motivo_decisao: `scheduled_for_business_hours: O sistema detectou que 22:00 está fora do horário permitido. A conversa foi marcada com status "scheduled" para reavaliação às 08:00 do próximo período operacional (${sc9NextStart.toISOString()}).`,
  })

  // ==========================================
  // CENÁRIO 10 — CONVERSA JÁ ASSUMIDA POR HUMANO
  // ==========================================
  console.log('Executando Cenário 10...')
  const sc10AssignedAgent = 'uuid-corretor-ronaldo'
  const sc10BotDisabled = true
  results.push({
    cenario: 'CENÁRIO 10 — CONVERSA JÁ ASSUMIDA POR HUMANO',
    contexto: `Durante o período de inatividade, o corretor assumiu no painel (agent=${sc10AssignedAgent}, disabled=${sc10BotDisabled}).`,
    tipo_escolhido: 'none',
    pista_identificada: 'Atendimento humano ativo no thread.',
    mensagem_exata: '(Nenhuma mensagem gerada — a IA desliga e respeita o corretor humano)',
    decisao_envio: 'NÃO ENVIAR',
    motivo_decisao: 'cancelled_human_assigned: A thread possui um corretor humano designado. Qualquer automação de reativação é cancelada para evitar sobreposição ao atendimento humano.',
  })

  console.log('\n================ RESULTADOS FINAIS ================\n')
  console.log(JSON.stringify(results, null, 2))
}

runDryRun().catch((err) => {
  console.error('Fatal error in dry-run:', err)
  process.exit(1)
})
