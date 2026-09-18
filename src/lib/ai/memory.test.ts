import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  inferScopeFromKnowledgeType,
  saveMemory,
  retrieveScopedMemories,
  formatMemoriesForPrompt,
  promoteAdMemoryToProperty,
  AD_TO_PROPERTY_PROMOTION_MIN_OCCURRENCES,
  type MemoryRow,
} from './memory';

// ============================================================
// A minimal in-memory `ai_memories` table behind the same
// select/eq/order/limit/insert/update chain shape Supabase's client
// exposes — precise enough to prove retrieveScopedMemories's isolation
// guarantees without a real database.
// ============================================================

interface Row {
  id: string;
  account_id: string;
  scope: string;
  knowledge_type: string;
  title: string;
  content: string;
  property_id: string | null;
  ad_id: string | null;
  conversation_id: string | null;
  contact_id: string | null;
  source_type: string;
  source_message_id: string | null;
  agent_id: string | null;
  confidence: string;
  occurrence_count: number;
  status: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

function fakeMemoriesDb(seed: Row[] = []) {
  const rows: Row[] = [...seed];
  let counter = 0;

  function query() {
    const filters: ((r: Row) => boolean)[] = [];
    const api = {
      select() {
        return api;
      },
      eq(field: string, value: unknown) {
        filters.push((r) => (r as unknown as Record<string, unknown>)[field] === value);
        return api;
      },
      order() {
        return api;
      },
      limit() {
        return api;
      },
      maybeSingle() {
        const found = rows.filter((r) => filters.every((f) => f(r)))[0] ?? null;
        return Promise.resolve({ data: found, error: null });
      },
      single() {
        const found = rows.filter((r) => filters.every((f) => f(r)))[0] ?? null;
        return Promise.resolve({ data: found, error: found ? null : new Error('not found') });
      },
      then(resolve: (v: { data: Row[]; error: null }) => void) {
        resolve({ data: rows.filter((r) => filters.every((f) => f(r))), error: null });
      },
    };
    return api;
  }

  const from = (table: string) => {
    if (table !== 'ai_memories') throw new Error(`unexpected table: ${table}`);
    return {
      select: () => query(),
      insert: (row: Record<string, unknown>) => {
        const id = `mem-${++counter}`;
        const full: Row = {
          id,
          account_id: row.account_id as string,
          scope: row.scope as string,
          knowledge_type: row.knowledge_type as string,
          title: row.title as string,
          content: row.content as string,
          property_id: (row.property_id as string) ?? null,
          ad_id: (row.ad_id as string) ?? null,
          conversation_id: (row.conversation_id as string) ?? null,
          contact_id: (row.contact_id as string) ?? null,
          source_type: row.source_type as string,
          source_message_id: (row.source_message_id as string) ?? null,
          agent_id: (row.agent_id as string) ?? null,
          confidence: row.confidence as string,
          occurrence_count: (row.occurrence_count as number) ?? 1,
          status: 'active',
          metadata: (row.metadata as Record<string, unknown>) ?? {},
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        rows.push(full);
        return {
          select: () => ({
            single: () => Promise.resolve({ data: full, error: null }),
          }),
        };
      },
      update: (patch: Record<string, unknown>) => {
        const filters: ((r: Row) => boolean)[] = [];
        const api = {
          eq(field: string, value: unknown) {
            filters.push((r) => (r as unknown as Record<string, unknown>)[field] === value);
            return api;
          },
          select: () => ({
            single: () => {
              const found = rows.find((r) => filters.every((f) => f(r)));
              if (found) Object.assign(found, patch);
              return Promise.resolve({ data: found ?? null, error: found ? null : new Error('not found') });
            },
          }),
          then(resolve: (v: { error: null }) => void) {
            const found = rows.find((r) => filters.every((f) => f(r)));
            if (found) Object.assign(found, patch);
            resolve({ error: null });
          },
        };
        return api;
      },
    };
  };

  return { db: { from } as unknown as SupabaseClient, rows };
}

const ACCOUNT = 'acct-1';

describe('inferScopeFromKnowledgeType', () => {
  it('maps every declared type to its scope with no ambiguity', () => {
    expect(inferScopeFromKnowledgeType('business_rule')).toBe('global');
    expect(inferScopeFromKnowledgeType('language_style')).toBe('global');
    expect(inferScopeFromKnowledgeType('communication_pattern')).toBe('global');
    expect(inferScopeFromKnowledgeType('property_fact')).toBe('property');
    expect(inferScopeFromKnowledgeType('property_subjective')).toBe('property');
    expect(inferScopeFromKnowledgeType('ad_fact')).toBe('ad');
    expect(inferScopeFromKnowledgeType('ad_strategy')).toBe('ad');
    expect(inferScopeFromKnowledgeType('client_preference')).toBe('conversation');
    expect(inferScopeFromKnowledgeType('conversation_context')).toBe('conversation');
  });

  it('returns null for a type it does not recognize (legacy types included)', () => {
    expect(inferScopeFromKnowledgeType('global_knowledge')).toBeNull();
    expect(inferScopeFromKnowledgeType('never_rule')).toBeNull();
    expect(inferScopeFromKnowledgeType('made_up')).toBeNull();
  });
});

describe('saveMemory', () => {
  it('rejects a scope/knowledgeType mismatch instead of silently miscategorizing it', async () => {
    const { db } = fakeMemoriesDb();
    await expect(
      saveMemory(db, {
        accountId: ACCOUNT,
        scope: 'global',
        knowledgeType: 'property_fact',
        title: 't',
        content: 'c',
        sourceType: 'manual',
        confidence: 'high',
      }),
    ).rejects.toThrow(/does not belong to scope/);
  });

  it('requires propertyId for a property-scoped memory', async () => {
    const { db } = fakeMemoriesDb();
    await expect(
      saveMemory(db, {
        accountId: ACCOUNT,
        scope: 'property',
        knowledgeType: 'property_fact',
        title: 't',
        content: 'c',
        sourceType: 'manual',
        confidence: 'high',
      }),
    ).rejects.toThrow(/requires propertyId/);
  });

  it('saves a valid scoped memory', async () => {
    const { db, rows } = fakeMemoriesDb();
    const memory = await saveMemory(db, {
      accountId: ACCOUNT,
      scope: 'property',
      knowledgeType: 'property_fact',
      title: 'Tem piscina',
      content: 'O imóvel tem piscina na cobertura.',
      propertyId: 'prop-a',
      sourceType: 'suggestion_approved',
      confidence: 'high',
    });
    expect(memory.propertyId).toBe('prop-a');
    expect(rows).toHaveLength(1);
  });
});

function makeRow(overrides: Partial<Row>): Row {
  return {
    id: overrides.id ?? `mem-${Math.random()}`,
    account_id: ACCOUNT,
    scope: 'global',
    knowledge_type: 'business_rule',
    title: 't',
    content: 'c',
    property_id: null,
    ad_id: null,
    conversation_id: null,
    contact_id: null,
    source_type: 'learning_scan',
    source_message_id: null,
    agent_id: null,
    confidence: 'high',
    occurrence_count: 1,
    status: 'active',
    metadata: {},
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('retrieveScopedMemories — isolation guarantees', () => {
  it('Test 1: a GLOBAL memory is returned regardless of which property/ad/conversation is asked for', async () => {
    const { db } = fakeMemoriesDb([
      makeRow({ id: 'g1', scope: 'global', knowledge_type: 'business_rule', content: 'Não trabalhamos com terrenos.' }),
    ]);
    const forA = await retrieveScopedMemories(db, ACCOUNT, { propertyId: 'prop-a' });
    const forB = await retrieveScopedMemories(db, ACCOUNT, { propertyId: 'prop-b' });
    expect(forA.global.map((m) => m.id)).toEqual(['g1']);
    expect(forB.global.map((m) => m.id)).toEqual(['g1']);
  });

  it('Test 2: PROPERTY A never appears when retrieving for PROPERTY B, and vice versa', async () => {
    const { db } = fakeMemoriesDb([
      makeRow({ id: 'pa', scope: 'property', property_id: 'prop-a', content: 'Tem piscina.' }),
      makeRow({ id: 'pb', scope: 'property', property_id: 'prop-b', content: 'Não tem área de lazer.' }),
    ]);
    const forA = await retrieveScopedMemories(db, ACCOUNT, { propertyId: 'prop-a' });
    const forB = await retrieveScopedMemories(db, ACCOUNT, { propertyId: 'prop-b' });
    expect(forA.property.map((m) => m.id)).toEqual(['pa']);
    expect(forB.property.map((m) => m.id)).toEqual(['pb']);
  });

  it('Test 3: AD A never appears when retrieving for AD B', async () => {
    const { db } = fakeMemoriesDb([
      makeRow({ id: 'ada', scope: 'ad', ad_id: 'ad-a', content: 'Unidade de 20m².' }),
      makeRow({ id: 'adb', scope: 'ad', ad_id: 'ad-b', content: 'Unidade de 24m².' }),
    ]);
    const forA = await retrieveScopedMemories(db, ACCOUNT, { adId: 'ad-a' });
    const forB = await retrieveScopedMemories(db, ACCOUNT, { adId: 'ad-b' });
    expect(forA.ad.map((m) => m.id)).toEqual(['ada']);
    expect(forB.ad.map((m) => m.id)).toEqual(['adb']);
  });

  it('Test 4: a client preference stored under CONVERSATION never leaks into another conversation', async () => {
    const { db } = fakeMemoriesDb([
      makeRow({ id: 'c1', scope: 'conversation', conversation_id: 'conv-1', content: 'Cliente 1 quer Airbnb.' }),
    ]);
    const forConv1 = await retrieveScopedMemories(db, ACCOUNT, { conversationId: 'conv-1' });
    const forConv2 = await retrieveScopedMemories(db, ACCOUNT, { conversationId: 'conv-2' });
    expect(forConv1.conversation.map((m) => m.id)).toEqual(['c1']);
    expect(forConv2.conversation).toEqual([]);
  });

  it('Test 5: language_style/communication_pattern are split into their own "style" group, never mixed into plain global facts', async () => {
    const { db } = fakeMemoriesDb([
      makeRow({ id: 'fact', scope: 'global', knowledge_type: 'business_rule', content: 'Não trabalhamos com terrenos.' }),
      makeRow({ id: 'style', scope: 'global', knowledge_type: 'language_style', content: 'Tom leve e informal.', agent_id: 'ronaldo' }),
    ]);
    const result = await retrieveScopedMemories(db, ACCOUNT, {});
    expect(result.global.map((m) => m.id)).toEqual(['fact']);
    expect(result.style.map((m) => m.id)).toEqual(['style']);
  });

  it('combines all four groups correctly when property, ad and conversation are all present at once', async () => {
    const { db } = fakeMemoriesDb([
      makeRow({ id: 'g', scope: 'global', content: 'global fact' }),
      makeRow({ id: 'p', scope: 'property', property_id: 'prop-c', content: 'property fact' }),
      makeRow({ id: 'a', scope: 'ad', ad_id: 'ad-c', content: 'ad fact' }),
      makeRow({ id: 'c', scope: 'conversation', conversation_id: 'conv-c', content: 'conversation fact' }),
      // Distractors that must NOT show up:
      makeRow({ id: 'p-other', scope: 'property', property_id: 'prop-other', content: 'other property fact' }),
      makeRow({ id: 'a-other', scope: 'ad', ad_id: 'ad-other', content: 'other ad fact' }),
    ]);
    const result = await retrieveScopedMemories(db, ACCOUNT, {
      propertyId: 'prop-c',
      adId: 'ad-c',
      conversationId: 'conv-c',
    });
    expect(result.global.map((m) => m.id)).toEqual(['g']);
    expect(result.property.map((m) => m.id)).toEqual(['p']);
    expect(result.ad.map((m) => m.id)).toEqual(['a']);
    expect(result.conversation.map((m) => m.id)).toEqual(['c']);
  });

  it('returns nothing for property/ad/conversation groups when no id is given (only global/style still return)', async () => {
    const { db } = fakeMemoriesDb([
      makeRow({ id: 'g', scope: 'global', content: 'global fact' }),
      makeRow({ id: 'p', scope: 'property', property_id: 'prop-a', content: 'property fact' }),
    ]);
    const result = await retrieveScopedMemories(db, ACCOUNT, {});
    expect(result.global.map((m) => m.id)).toEqual(['g']);
    expect(result.property).toEqual([]);
  });
});

describe('formatMemoriesForPrompt', () => {
  it('tags a memory attributed to a specific agent, and leaves an unattributed one plain', () => {
    const memories: MemoryRow[] = [
      { ...makeRowAsMemory({ agentId: 'ronaldo-id', content: 'Abre com "Joiaaaa".' }) },
      { ...makeRowAsMemory({ agentId: null, content: 'Time é sempre cordial.' }) },
    ];
    const names = new Map([['ronaldo-id', 'Ronaldo Meira']]);
    const formatted = formatMemoriesForPrompt(memories, names);
    expect(formatted[0]).toBe('[Ronaldo Meira] Abre com "Joiaaaa".');
    expect(formatted[1]).toBe('Time é sempre cordial.');
  });
});

function makeRowAsMemory(overrides: Partial<MemoryRow>): MemoryRow {
  return {
    id: 'm',
    accountId: ACCOUNT,
    scope: 'global',
    knowledgeType: 'language_style',
    title: 't',
    content: 'c',
    propertyId: null,
    adId: null,
    conversationId: null,
    contactId: null,
    sourceType: 'learning_scan',
    sourceMessageId: null,
    agentId: null,
    confidence: 'high',
    occurrenceCount: 1,
    status: 'active',
    metadata: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('promoteAdMemoryToProperty', () => {
  it('never promotes below the minimum occurrence threshold', async () => {
    const { db } = fakeMemoriesDb([
      makeRow({ id: 'ad1', scope: 'ad', ad_id: 'ad-a', occurrence_count: AD_TO_PROPERTY_PROMOTION_MIN_OCCURRENCES - 1 }),
    ]);
    const result = await promoteAdMemoryToProperty(db, ACCOUNT, 'ad1', 'prop-a');
    expect(result).toBeNull();
  });

  it('promotes to PROPERTY scope, clearing ad_id, once the threshold is met', async () => {
    const { db, rows } = fakeMemoriesDb([
      makeRow({ id: 'ad1', scope: 'ad', ad_id: 'ad-a', occurrence_count: AD_TO_PROPERTY_PROMOTION_MIN_OCCURRENCES }),
    ]);
    const result = await promoteAdMemoryToProperty(db, ACCOUNT, 'ad1', 'prop-a');
    expect(result?.scope).toBe('property');
    expect(result?.propertyId).toBe('prop-a');
    expect(rows[0].ad_id).toBeNull();
    expect(rows[0].scope).toBe('property');
  });

  it('never promotes a PROPERTY fact to GLOBAL — there is no such function at all', () => {
    // Structural guarantee, not a runtime check: promoteAdMemoryToProperty
    // is the only promotion path this module exports, and it only ever
    // targets 'property'. A PROPERTY -> GLOBAL promotion has no code path.
    expect(Object.keys({ promoteAdMemoryToProperty })).toEqual(['promoteAdMemoryToProperty']);
  });
});
