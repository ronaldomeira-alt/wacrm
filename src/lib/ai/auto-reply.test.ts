import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AiConfig } from './types'

// Shared hoisted mock state
const h = vi.hoisted(() => ({
  loadAiConfig: vi.fn(),
  buildConversationContext: vi.fn(),
  executeConversationalTurn: vi.fn(),
  engineSendText: vi.fn(),
  sendPushToAccount: vi.fn(),
  state: {
    conv: null as Record<string, unknown> | null,
    freshConv: null as Record<string, unknown> | null,
    recentHumanMsgs: [] as { id: string }[],
    autoResponders: [] as { id: string }[],
    flowRuns: [] as { id: string }[],
    contact: { name: 'João Silva' } as Record<string, unknown> | null,
    claim: true as boolean,
    updatePayload: null as Record<string, unknown> | null,
    rpcCalls: [] as { name: string; args: unknown }[],
  },
}))

vi.mock('./config', () => ({ loadAiConfig: h.loadAiConfig }))
vi.mock('./context', () => ({ buildConversationContext: h.buildConversationContext }))
vi.mock('./conversation-engine', () => ({ executeConversationalTurn: h.executeConversationalTurn }))
vi.mock('@/lib/flows/meta-send', () => ({ engineSendText: h.engineSendText }))
vi.mock('@/lib/push/send', () => ({ sendPushToAccount: h.sendPushToAccount }))

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
        return {
          insert: () => Promise.resolve({ error: null }),
        }
      }
      if (table === 'messages') {
        const msgChain = {
          select: () => msgChain,
          eq: () => msgChain,
          gt: () => msgChain,
          gte: () => msgChain,
          order: () => msgChain,
          limit: () => Promise.resolve({ data: h.state.recentHumanMsgs, error: null }),
        }
        return msgChain
      }
      // conversations table
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () => {
              // First query returns initial conv, second query (JIT) returns freshConv
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
      if (name === 'acquire_ai_conversation_lock' || name === 'release_ai_conversation_lock') {
        return Promise.resolve({ data: true, error: null })
      }
      return Promise.resolve({ data: h.state.claim, error: null })
    },
  }),
}))

import { dispatchInboundToAiReply } from './auto-reply'

const ARGS = {
  accountId: 'acct-1',
  conversationId: 'conv-1',
  contactId: 'contact-1',
  configOwnerUserId: 'user-1',
  debounceMs: 0,
}

function aiConfig(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
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
    ...overrides,
  }
}

beforeEach(() => {
  h.state.conv = {
    id: 'conv-1',
    assigned_agent_id: null,
    ai_autoreply_disabled: false,
    ai_transfer_status: 'none',
    ai_reply_count: 0,
    property_id: null,
  }
  h.state.freshConv = null
  h.state.recentHumanMsgs = []
  h.state.autoResponders = []
  h.state.flowRuns = []
  h.state.contact = { name: 'João Silva' }
  h.state.claim = true
  h.state.updatePayload = null
  h.state.rpcCalls = []

  h.loadAiConfig.mockResolvedValue(aiConfig())
  h.buildConversationContext.mockResolvedValue([{ role: 'user', content: 'Olá!' }])
  h.executeConversationalTurn.mockResolvedValue({
    responseText: 'Olá! Sou a assistente da equipe do Ronaldo e da Thatianna. Como posso te ajudar?',
    handoff: false,
    decision: {
      transfer_required: false,
      boundary_type: null,
      reason: null,
      context_summary: 'Primeiro contato',
      suggested_next_action: null,
    },
    usage: { promptTokens: 100, completionTokens: 30, totalTokens: 130 },
  })
  h.engineSendText.mockResolvedValue({ whatsapp_message_id: 'wa-1' })
  h.sendPushToAccount.mockResolvedValue({ sent: 1, pruned: 0 })
})

describe('Stage 6 — Integration with Real Flow, Handoff & Concurrency Safety', () => {
  it('1. Happy Path: Executes conversational turn, claims slot, and sends via Meta Cloud API', async () => {
    await dispatchInboundToAiReply(ARGS)

    expect(h.executeConversationalTurn).toHaveBeenCalled()
    expect(h.state.rpcCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'acquire_ai_conversation_lock',
        }),
        expect.objectContaining({
          name: 'claim_ai_reply_slot',
          args: { conversation_id: 'conv-1', max_replies: 8 },
        }),
        expect.objectContaining({
          name: 'release_ai_conversation_lock',
        }),
      ]),
    )
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'acct-1',
        conversationId: 'conv-1',
        text: 'Olá! Sou a assistente da equipe do Ronaldo e da Thatianna. Como posso te ajudar?',
        aiGenerated: true,
      }),
    )
  })

  it('2. Kill-Switch: Strictly aborts with 0 sends when auto_reply_enabled is false', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ autoReplyEnabled: false }))

    await dispatchInboundToAiReply(ARGS)

    expect(h.executeConversationalTurn).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('3. Active Flows & Automations: Yields to deterministic flows without sending AI message', async () => {
    h.state.flowRuns = [{ id: 'flow-active-1' }]

    await dispatchInboundToAiReply(ARGS)

    expect(h.executeConversationalTurn).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('4. Persistent Human Takeover: AI stands down if conversation is already disabled or assigned', async () => {
    h.state.conv = {
      id: 'conv-1',
      assigned_agent_id: 'ronaldo-user-id',
      ai_autoreply_disabled: true,
      ai_transfer_status: 'transferred',
      ai_reply_count: 1,
    }

    await dispatchInboundToAiReply(ARGS)

    expect(h.executeConversationalTurn).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('5. CRITICAL CONCURRENCY RACE CONDITION: Human answers while AI is generating -> JIT aborts send', async () => {
    // Initial check passes, but during LLM generation, a human sent a message or took over
    h.state.freshConv = {
      id: 'conv-1',
      assigned_agent_id: 'thatianna-user-id', // Human assigned during processing
      ai_autoreply_disabled: true, // Human took over
      ai_transfer_status: 'transferred',
      ai_reply_count: 0,
    }

    await dispatchInboundToAiReply(ARGS)

    // LLM might have run, but JIT gate caught the race condition and ABORTED sending
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('6. CRITICAL CONCURRENCY RACE CONDITION: Human message inserted in DB during LLM generation -> aborts send', async () => {
    // A new message from agent arrived in messages table during generation
    h.state.recentHumanMsgs = [{ id: 'msg-human-agent-1' }]

    await dispatchInboundToAiReply(ARGS)

    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('7. Handoff Flow: When price or boundary is touched, sends transition, sets pending_human and pushes alert', async () => {
    h.executeConversationalTurn.mockResolvedValueOnce({
      responseText: 'Excelente! Para te passar a tabela de preços atualizada, vou direcionar para nossa equipe.',
      handoff: true,
      decision: {
        transfer_required: true,
        boundary_type: 'price',
        reason: 'Cliente solicitou valores e tabela',
        context_summary: 'Interesse no Cabo Branco Sunset',
        suggested_next_action: 'Enviar tabela em PDF',
      },
      usage: { promptTokens: 200, completionTokens: 40, totalTokens: 240 },
    })

    await dispatchInboundToAiReply(ARGS)

    // 1. Sends natural transition message to client
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Excelente! Para te passar a tabela de preços atualizada, vou direcionar para nossa equipe.',
      }),
    )

    // 2. Updates conversation to pending_human and disables auto_reply
    expect(h.state.updatePayload).toMatchObject({
      ai_autoreply_disabled: true,
      ai_transfer_status: 'pending_human',
      ai_transfer_reason: 'Cliente solicitou valores e tabela',
      ai_transfer_boundary_type: 'price',
    })
    expect(h.state.updatePayload?.ai_handoff_summary).toContain('[TRANSFERÊNCIA PELA IA]')

    // 3. Triggers Web Push attention notification for the team
    expect(h.sendPushToAccount).toHaveBeenCalledWith(
      'acct-1',
      expect.objectContaining({
        title: expect.stringContaining('João Silva'),
        body: expect.stringContaining('Cliente solicitou valores e tabela'),
      }),
    )
  })

  it('8. Safety Message Limit: When reply count reaches safety limit (8), enforces handoff', async () => {
    h.state.conv = {
      id: 'conv-1',
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_transfer_status: 'none',
      ai_reply_count: 8, // Safety limit reached
    }

    await dispatchInboundToAiReply(ARGS)

    expect(h.executeConversationalTurn).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })
})
