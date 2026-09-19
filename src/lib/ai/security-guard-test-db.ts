// ============================================================
// Shared Supabase mock builder for the security-guard integration
// suite (security-guard-integration.test.ts). Not shipped code — a test
// fixture factory kept in its own file only because the adversarial
// suite and the scenario suite both need the exact same shape.
// ============================================================
import type { SupabaseClient } from '@supabase/supabase-js'

export type MemoryScope = 'global' | 'property' | 'ad' | 'conversation'

export interface FakeMemoryRow {
  id: string
  account_id?: string
  scope: MemoryScope
  knowledge_type: string
  title?: string
  content: string
  property_id?: string | null
  ad_id?: string | null
  conversation_id?: string | null
  contact_id?: string | null
  source_type?: string
  source_message_id?: string | null
  agent_id?: string | null
  confidence?: string
  occurrence_count?: number
  status?: string
  metadata?: Record<string, unknown>
  created_at?: string
  updated_at?: string
}

function withDefaults(row: FakeMemoryRow): Required<Omit<FakeMemoryRow, 'metadata'>> & { metadata: Record<string, unknown> } {
  return {
    account_id: 'acc-1',
    title: row.title ?? row.content.slice(0, 40),
    property_id: row.property_id ?? null,
    ad_id: row.ad_id ?? null,
    conversation_id: row.conversation_id ?? null,
    contact_id: row.contact_id ?? null,
    source_type: row.source_type ?? 'suggestion_approved',
    source_message_id: row.source_message_id ?? null,
    agent_id: row.agent_id ?? null,
    confidence: row.confidence ?? 'high',
    occurrence_count: row.occurrence_count ?? 1,
    status: row.status ?? 'active',
    metadata: row.metadata ?? {},
    created_at: row.created_at ?? new Date().toISOString(),
    updated_at: row.updated_at ?? new Date().toISOString(),
    ...row,
  }
}

export interface FakeKnowledgeChunk {
  id: string
  content: string
  is_global?: boolean
  property_id?: string | null
  source_type?: 'pdf_book' | 'subjective_text' | null
  title?: string | null
}

export interface TestDbOptions {
  property?: { id: string; name: string; status?: string } | null
  propertyContext?: { stage?: string; response_style_instructions?: string[] } | null
  memories?: FakeMemoryRow[]
  knowledgeChunks?: FakeKnowledgeChunk[]
}

/** Minimal shape covering every Supabase query-builder method
 *  executeConversationalTurn's dependencies chain off of. Every method
 *  returns the same node (or a promise) — good enough for read-only
 *  SELECT chains of arbitrary depth/order without pulling in the real
 *  (heavily generic) Supabase builder types. */
interface ChainNode {
  select: (...args: unknown[]) => ChainNode
  eq: (...args: unknown[]) => ChainNode
  order: (...args: unknown[]) => ChainNode
  in: (...args: unknown[]) => ChainNode
  limit: () => Promise<unknown>
  maybeSingle: () => Promise<unknown>
  single: () => Promise<unknown>
  then: (resolve: (v: unknown) => void) => Promise<unknown>
}

/** A chain node that resolves any terminal (`await`/`.maybeSingle()`/
 *  `.single()`) to the same fixed value, and returns itself for every
 *  other method call. */
function fixedChain(resolveValue: unknown): ChainNode {
  const node = {} as ChainNode
  const self = () => node
  node.select = self
  node.eq = self
  node.order = self
  node.in = self
  node.limit = () => Promise.resolve(resolveValue)
  node.maybeSingle = () => Promise.resolve(resolveValue)
  node.single = () => Promise.resolve(resolveValue)
  node.then = (resolve) => Promise.resolve(resolveValue).then(resolve)
  return node
}

/** ai_memories needs per-scope routing (4 parallel queries, one per
 *  scope, distinguished only by which `.eq('scope', X)` was called) — a
 *  fixedChain can't do that, so this tracks the scope as it's chained. */
function memoriesChain(memories: FakeMemoryRow[]): ChainNode {
  const node = {} as ChainNode
  let scope: MemoryScope | null = null
  let propertyId: string | null = null
  let adId: string | null = null
  let conversationId: string | null = null
  node.select = () => node
  node.eq = (col, val) => {
    if (col === 'scope') scope = val as MemoryScope
    if (col === 'property_id') propertyId = val as string
    if (col === 'ad_id') adId = val as string
    if (col === 'conversation_id') conversationId = val as string
    return node
  }
  node.in = () => node
  node.order = () => node
  const resolve = () => {
    const rows = memories
      .filter((m) => m.scope === scope)
      .filter((m) => (scope === 'property' ? m.property_id === propertyId : true))
      .filter((m) => (scope === 'ad' ? m.ad_id === adId : true))
      .filter((m) => (scope === 'conversation' ? m.conversation_id === conversationId : true))
      .map(withDefaults)
    return Promise.resolve({ data: rows, error: null })
  }
  node.limit = resolve
  node.then = (r) => resolve().then(r)
  return node
}

/**
 * Builds a mocked SupabaseClient covering exactly the tables/RPCs
 * executeConversationalTurn touches, so the security guard's
 * INTEGRATION suite can drive the real pipeline (not just the prompt or
 * the guard in isolation) end to end.
 */
export function makeSecurityTestDb(opts: TestDbOptions): SupabaseClient {
  const property = opts.property ?? null
  const propertyContext = opts.propertyContext ?? null
  const memories = opts.memories ?? []
  const chunks = opts.knowledgeChunks ?? []

  const chunkMetaByI = new Map(
    chunks.map((c) => [
      c.id,
      {
        id: c.id,
        property_id: c.property_id ?? (property?.id ?? null),
        ai_knowledge_documents: { source_type: c.source_type ?? 'pdf_book', title: c.title ?? null },
      },
    ]),
  )

  const from = (table: string): ChainNode => {
    switch (table) {
      case 'properties':
        return fixedChain({ data: property ? { ...property, cover_image_path: null } : null, error: null })
      case 'property_ai_contexts':
        return fixedChain({ data: propertyContext, error: null })
      case 'property_images':
        return fixedChain({ data: [], error: null })
      case 'ai_memories':
        return memoriesChain(memories)
      case 'profiles':
        return fixedChain({ data: [], error: null })
      case 'ai_knowledge_chunks':
        // Serves both the "does this account have any chunks" count
        // query (needs `count`) and the post-RPC metadata lookup (needs
        // `data`) — one object with both fields satisfies either
        // destructure since unused keys are simply ignored.
        return fixedChain({
          data: Array.from(chunkMetaByI.values()),
          count: chunks.length,
          error: null,
        })
      case 'conversations':
        return fixedChain({ data: null, error: null })
      case 'property_ad_mappings':
        return fixedChain({ data: null, error: null })
      default:
        return fixedChain({ data: null, error: null })
    }
  }

  const rpc = (fnName: string): Promise<unknown> => {
    if (fnName === 'match_property_ai_knowledge_semantic' || fnName === 'match_property_ai_knowledge_fts') {
      return Promise.resolve({
        data: chunks.map((c) => ({ id: c.id, content: c.content, is_global: c.is_global ?? !property })),
        error: null,
      })
    }
    return Promise.resolve({ data: null, error: null })
  }

  return { from, rpc } as unknown as SupabaseClient
}
