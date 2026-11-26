import { describe, it, expect, vi } from 'vitest'
import { logAiUsage } from './usage'
import type { SupabaseClient } from '@supabase/supabase-js'

function fakeDb() {
  const insert = vi.fn().mockResolvedValue({ error: null })
  const db = { from: vi.fn(() => ({ insert })) }
  return { db: db as unknown as SupabaseClient, insert, from: db.from }
}

describe('logAiUsage', () => {
  it('inserts a row mapping normalized usage to the log columns', async () => {
    const { db, insert, from } = fakeDb()
    await logAiUsage(db, {
      accountId: 'acct-1',
      conversationId: 'conv-1',
      mode: 'auto_reply',
      provider: 'anthropic',
      model: 'claude-x',
      usage: { promptTokens: 30, completionTokens: 6, totalTokens: 36 },
    })
    expect(from).toHaveBeenCalledWith('ai_usage_log')
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        account_id: 'acct-1',
        conversation_id: 'conv-1',
        mode: 'auto_reply',
        provider: 'anthropic',
        model: 'claude-x',
        prompt_tokens: 30,
        completion_tokens: 6,
        total_tokens: 36,
        status: 'completed',
        consumption_type: 'confirmed',
        cost_source: 'estimated',
        input_cost_usd: expect.any(Number),
        cache_cost_usd: 0,
        output_cost_usd: expect.any(Number),
        cost_usd: expect.any(Number),
      }),
    )
  })

  it('persists OpenCode Go provider-confirmed cost breakdown without overwriting null for unknown usage', async () => {
    const { db, insert } = fakeDb()
    await logAiUsage(db, {
      accountId: 'acct-1',
      conversationId: 'conv-1',
      mode: 'auto_reply',
      provider: 'opencode_go',
      model: 'deepseek-v4.1-flash',
      usage: {
        promptTokens: 134,
        completionTokens: 12,
        totalTokens: 146,
        cachedTokens: 100,
        providerCost: {
          listCostUsd: 0.0000126,
          billedCostUsd: 0,
          allowanceUsd: 0.00000756,
          billingSource: 'go',
          uncachedInputTokens: 34,
          cacheReadTokens: 100,
          outputTokens: 12,
        },
      },
    })
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'opencode_go',
        model: 'deepseek-v4.1-flash',
        cost_usd: 0.0000126,
        billed_cost_usd: 0,
        opencode_allowance_usd: 0.00000756,
        billing_source: 'go',
        consumption_type: 'estimated',
        cost_source: 'provider_confirmed',
      }),
    )
  })

  it('is a no-op when the provider reported no usage', async () => {
    const { db, from } = fakeDb()
    await logAiUsage(db, {
      accountId: 'acct-1',
      conversationId: null,
      mode: 'draft',
      provider: 'openai',
      model: 'gpt-x',
      usage: null,
    })
    expect(from).not.toHaveBeenCalled()
  })

  it('never throws when the insert errors', async () => {
    const insert = vi.fn().mockResolvedValue({ error: { message: 'boom' } })
    const db = { from: vi.fn(() => ({ insert })) } as unknown as SupabaseClient
    await expect(
      logAiUsage(db, {
        accountId: 'acct-1',
        conversationId: 'conv-1',
        mode: 'draft',
        provider: 'openai',
        model: 'gpt-x',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      }),
    ).resolves.toBeUndefined()
  })
})
