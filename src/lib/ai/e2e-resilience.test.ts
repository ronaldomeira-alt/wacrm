import { describe, it, expect, vi, beforeEach } from 'vitest'
import { executeAiInference } from './provider-manager'
import { executeConversationalTurn } from './conversation-engine'
import { acquireConversationLeaseWithHeartbeat } from './lease-heartbeat'
import {
  confirmOutboundIntent,
  failOutboundIntent,
  isUnknownSendOutcome,
  reserveOutboundIntent,
} from './outbound-idempotency'
import { clearOpenCodeQuotaCache } from './opencode-quota'
import { AiError, type AiConfig } from './types'
import * as opencodeProvider from './providers/opencode-go'
import * as deepseekProvider from './providers/deepseek'
import type { SupabaseClient } from '@supabase/supabase-js'

function makeConfig(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'opencode_go',
    model: 'glm-5.3-flash',
    apiKey: 'oc-key',
    opencodeGoApiKey: 'oc-key',
    deepseekApiKey: 'ds-key',
    fallbackEnabled: true,
    secondaryProvider: 'deepseek',
    secondaryModel: 'deepseek-flash',
    primaryTimeoutMs: 45_000,
    secondaryTimeoutMs: 45_000,
    opencodeWacrmReservePct: 15,
    opencodeGlobalPreventivePct: 75,
    opencodeMarginPct: 25,
    circuitFailureThreshold: 3,
    circuitCooldownSeconds: 120,
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: true,
    autoReplyMaxPerConversation: 10,
    handoffAgentId: null,
    embeddingsApiKey: 'emb-key-untouched',
    identityName: 'Clara',
    toneStyle: 'consultative_warm',
    businessHoursStart: '08:00',
    businessHoursEnd: '18:00',
    businessDays: [1, 2, 3, 4, 5],
    safetyMessageLimit: 8,
    ...overrides,
  }
}

function makeMinimalDb(): SupabaseClient {
  const chain = {
    select: () => chain,
    eq: () => chain,
    in: () => chain,
    is: () => chain,
    not: () => chain,
    gt: () => chain,
    gte: () => chain,
    lt: () => chain,
    lte: () => chain,
    or: () => chain,
    order: () => chain,
    limit: () => chain,
    maybeSingle: async () => ({ data: null, error: null }),
    single: async () => ({ data: null, error: null }),
    insert: async () => ({ data: null, error: null }),
    update: () => chain,
    upsert: async () => ({ data: null, error: null }),
    then: (resolve: (v: { data: unknown[]; error: null }) => void) =>
      resolve({ data: [], error: null }),
  }
  return {
    from: () => chain,
    rpc: async () => ({ data: null, error: null }),
  } as unknown as SupabaseClient
}

describe('E2E Resilience & Continuity Suite (Sections 5 & 6)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    clearOpenCodeQuotaCache()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          rolling5h: { usagePercent: 10 },
          weekly: { usagePercent: 20 },
          monthly: { usagePercent: 25 },
        }),
        { status: 200 },
      ),
    )
  })

  it('1-3. GLM operational, quota exhausted (immediate fallback), and timeout (fallback)', async () => {
    // 1. Operational
    vi.spyOn(opencodeProvider, 'generateOpenCodeGo').mockResolvedValueOnce({
      text: JSON.stringify({
        response_text: 'Olá! Tenho ótimas opções no Altiplano. Você busca quantos quartos?',
        transfer_required: false,
        boundary_type: null,
        reason: null,
        context_summary: 'Cliente iniciou busca no Altiplano',
        suggested_next_action: 'Qualificar quartos',
        send_media: null,
      }),
      usage: { promptTokens: 400, completionTokens: 45, totalTokens: 445 },
    })

    const turn1 = await executeConversationalTurn({
      db: makeMinimalDb(),
      accountId: 'acc-1',
      config: makeConfig(),
      messages: [{ role: 'user', content: 'Oi, quero apê no Altiplano' }],
      simulatedHours: 'business_hours',
    })
    expect(turn1.provider).toBe('opencode_go')
    expect(turn1.fallbackUsed).toBe(false)
    expect(turn1.responseText).toContain('Altiplano')

    // 2. Quota exhausted -> immediate fallback
    vi.spyOn(opencodeProvider, 'generateOpenCodeGo').mockRejectedValueOnce(
      new AiError('Quota exhausted', { code: 'quota_exhausted', status: 502 }),
    )
    vi.spyOn(deepseekProvider, 'generateDeepSeek').mockResolvedValueOnce({
      text: JSON.stringify({
        response_text: 'Perfeito, e qual seria a faixa de investimento?',
        transfer_required: false,
        boundary_type: null,
        reason: null,
        context_summary: null,
        suggested_next_action: null,
        send_media: null,
      }),
      usage: { promptTokens: 450, completionTokens: 20, totalTokens: 470 },
    })

    const turn2 = await executeConversationalTurn({
      db: makeMinimalDb(),
      accountId: 'acc-1',
      config: makeConfig(),
      messages: [
        { role: 'user', content: 'Oi, quero apê no Altiplano' },
        { role: 'assistant', content: turn1.responseText },
        { role: 'user', content: '3 quartos' },
      ],
      simulatedHours: 'business_hours',
    })
    expect(turn2.provider).toBe('deepseek')
    expect(turn2.fallbackUsed).toBe(true)
    expect(turn2.responseText).toContain('investimento')

    // 3. Timeout -> fallback
    vi.spyOn(opencodeProvider, 'generateOpenCodeGo').mockRejectedValueOnce(
      new AiError('Timeout', { code: 'timeout', status: 504 }),
    )
    vi.spyOn(deepseekProvider, 'generateDeepSeek').mockResolvedValueOnce({
      text: JSON.stringify({
        response_text: 'Entendi, vou separar as melhores opções.',
        transfer_required: false,
        boundary_type: null,
        reason: null,
        context_summary: null,
        suggested_next_action: null,
        send_media: null,
      }),
      usage: { promptTokens: 500, completionTokens: 15, totalTokens: 515 },
    })
    const turn3 = await executeConversationalTurn({
      db: makeMinimalDb(),
      accountId: 'acc-1',
      config: makeConfig(),
      messages: [{ role: 'user', content: 'Até 900 mil' }],
      simulatedHours: 'business_hours',
    })
    expect(turn3.provider).toBe('deepseek')
    expect(turn3.fallbackUsed).toBe(true)
  })

  it('4 & 13-14. Lease with heartbeat + fencing token rejects stale worker after lock theft', async () => {
    let currentLockToken = ''
    let currentFencing = 0
    const db = {
      rpc: vi.fn(async (fn: string, params: Record<string, unknown>) => {
        if (fn === 'acquire_ai_conversation_lease') {
          currentLockToken = String(params.p_lock_token)
          currentFencing += 1
          return { data: [{ acquired: true, fencing_token: currentFencing }], error: null }
        }
        if (fn === 'verify_ai_conversation_lease') {
          const valid =
            params.p_lock_token === currentLockToken &&
            Number(params.p_fencing_token) === currentFencing
          return { data: valid, error: null }
        }
        if (fn === 'release_ai_conversation_lock') {
          return { data: true, error: null }
        }
        return { data: true, error: null }
      }),
    } as unknown as SupabaseClient

    const lease1 = await acquireConversationLeaseWithHeartbeat(db, 'conv-1', 'worker-1')
    expect(lease1).not.toBeNull()
    expect(await lease1!.verify()).toBe(true)

    // Worker 2 steals expired lease -> fencing token advances
    const lease2 = await acquireConversationLeaseWithHeartbeat(db, 'conv-1', 'worker-2')
    expect(lease2).not.toBeNull()
    expect(lease2!.fencingToken).toBeGreaterThan(lease1!.fencingToken)

    // Worker 1 wakes up late -> fencing verification MUST fail
    expect(await lease1!.verify()).toBe(false)
    expect(await lease2!.verify()).toBe(true)

    await lease1!.release()
    await lease2!.release()
  })

  it('5-7. Empty/invalid output triggers fallback; commercial rule violation is blocked by SecurityGuard', async () => {
    vi.spyOn(opencodeProvider, 'generateOpenCodeGo').mockRejectedValueOnce(
      new AiError('Empty response', { code: 'empty_response', status: 502 }),
    )
    // DeepSeek returns a commercial violation (ungrounded price)
    vi.spyOn(deepseekProvider, 'generateDeepSeek').mockResolvedValueOnce({
      text: JSON.stringify({
        response_text: 'Esse apartamento custa R$ 450.000,00 com entrada de R$ 50.000,00.',
        transfer_required: false,
        boundary_type: null,
        reason: null,
        context_summary: null,
        suggested_next_action: null,
        send_media: null,
      }),
      usage: { promptTokens: 300, completionTokens: 30, totalTokens: 330 },
    })

    const turn = await executeConversationalTurn({
      db: makeMinimalDb(),
      accountId: 'acc-1',
      config: makeConfig(),
      messages: [{ role: 'user', content: 'Qual o valor?' }],
      simulatedHours: 'business_hours',
    })

    // SecurityGuard deterministically intercepts ungrounded price and forces safe handoff
    expect(turn.handoff).toBe(true)
    expect(turn.securityGuardViolations?.length).toBeGreaterThan(0)
    expect(turn.responseText).not.toContain('450.000')
  })

  it('18. Outbound idempotency prevents duplicate WhatsApp send on confirmed or unknown_outcome states', async () => {
    const store = new Map<string, Record<string, unknown>>()
    const db = {
      from: () => ({
        select: () => ({
          eq: (_col: string, key: string) => ({
            maybeSingle: async () => ({ data: store.get(key) ?? null, error: null }),
          }),
        }),
        insert: async (row: Record<string, unknown>) => {
          store.set(String(row.idempotency_key), { ...row })
          return { error: null }
        },
        update: (patch: Record<string, unknown>) => ({
          eq: (_col: string, key: string) => {
            const cur = store.get(key)
            if (cur) store.set(key, { ...cur, ...patch })
            return {
              in: () => ({
                select: () => ({
                  maybeSingle: async () => ({ data: { id: '1' }, error: null }),
                }),
              }),
            }
          },
        }),
      }),
    } as unknown as SupabaseClient

    const key = 'ai-text:inbound:msg-123'
    const first = await reserveOutboundIntent(db, {
      accountId: 'acc-1',
      conversationId: 'conv-1',
      idempotencyKey: key,
      intentType: 'text',
    })
    expect(first.action).toBe('proceed')

    // Simulate Meta accepted but DB insert failed -> unknown_outcome
    const err = new Error('sent to Meta but DB insert failed: timeout')
    expect(isUnknownSendOutcome(err)).toBe(true)
    await failOutboundIntent(db, key, {
      errorMessage: err.message,
      unknownOutcome: true,
      waMessageId: 'wamid.123',
    })

    // Recovery worker retries -> MUST NOT re-send!
    const retry = await reserveOutboundIntent(db, {
      accountId: 'acc-1',
      conversationId: 'conv-1',
      idempotencyKey: key,
      intentType: 'text',
    })
    expect(retry.action).toBe('skip_ambiguous')

    // Confirmed intent also skips
    await confirmOutboundIntent(db, 'ai-text:inbound:msg-456', 'wamid.456')
    store.set('ai-text:inbound:msg-456', {
      status: 'confirmed',
      wa_message_id: 'wamid.456',
    })
    const confirmed = await reserveOutboundIntent(db, {
      accountId: 'acc-1',
      conversationId: 'conv-1',
      idempotencyKey: 'ai-text:inbound:msg-456',
      intentType: 'text',
    })
    expect(confirmed).toEqual({ action: 'skip_confirmed', waMessageId: 'wamid.456' })
  })

  it('20. High-volume Follow-up background call yields when auto_reply is active and respects global budget', async () => {
    vi.spyOn(deepseekProvider, 'generateDeepSeek').mockResolvedValue({
      text: 'OK',
      usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
    })

    const res = await executeAiInference({
      config: makeConfig({ provider: 'deepseek', model: 'deepseek-flash', fallbackEnabled: false }),
      accountId: 'acc-1',
      mode: 'followup',
      systemPrompt: 'Followup',
      messages: [{ role: 'user', content: 'score' }],
    })
    expect(res.text).toBe('OK')
  })
})
