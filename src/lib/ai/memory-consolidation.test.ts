import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  consolidateMemory,
  classifyRelation,
  evaluateConsolidation,
  isLowSignalContent,
  type ConsolidateMemoryArgs,
} from './memory-consolidation';

// ============================================================
// Same minimal in-memory `ai_memories` fake as memory.test.ts, extended
// with `.in()`/`.is()` support (memory-consolidation.ts's group lookup
// uses both) — precise enough to prove the consolidation policy without a
// real database.
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
  evidence: unknown[];
  value_history: unknown[];
  created_at: string;
  updated_at: string;
}

function fakeMemoriesDb(seed: Row[] = []) {
  const rows: Row[] = [...seed];
  let counter = 0;

  function selectQuery() {
    const filters: ((r: Row) => boolean)[] = [];
    const api = {
      select() {
        return api;
      },
      eq(field: string, value: unknown) {
        filters.push((r) => (r as unknown as Record<string, unknown>)[field] === value);
        return api;
      },
      is(field: string, value: unknown) {
        filters.push((r) => (r as unknown as Record<string, unknown>)[field] === value);
        return api;
      },
      in(field: string, values: unknown[]) {
        filters.push((r) => values.includes((r as unknown as Record<string, unknown>)[field]));
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
      select: () => selectQuery(),
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
          status: (row.status as string) ?? 'active',
          metadata: (row.metadata as Record<string, unknown>) ?? {},
          evidence: (row.evidence as unknown[]) ?? [],
          value_history: (row.value_history as unknown[]) ?? [],
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

function areaArgs(overrides: Partial<ConsolidateMemoryArgs> = {}): ConsolidateMemoryArgs {
  return {
    accountId: ACCOUNT,
    scope: 'property',
    knowledgeType: 'property_fact',
    title: 'Área mínima',
    content: 'Tem unidades a partir de 18,94 m².',
    propertyId: 'prop-a',
    sourceType: 'learning_scan',
    evidence: { kind: 'conversation', conversationId: 'conv-1' },
    ...overrides,
  };
}

describe('classifyRelation', () => {
  it('treats "18,94 m²" and "19 m²" as equivalent', () => {
    expect(classifyRelation('Tem unidades a partir de 18,94 m².', 'Tem unidades a partir de 19 m².')).toBe(
      'equivalent',
    );
  });

  it('treats "18,94 m²" and "22 m²" as a conflict, not equivalence', () => {
    expect(classifyRelation('Tem unidades a partir de 18,94 m².', 'Tem unidades a partir de 22 m².')).toBe(
      'conflict',
    );
  });

  it('treats unrelated claims as unrelated', () => {
    expect(classifyRelation('Tem piscina na cobertura.', 'Aceita financiamento pela Caixa.')).toBe('unrelated');
  });

  it('parses Brazilian-formatted currency correctly (thousands "." + decimal ",")', () => {
    // Regression: a naive comma->dot replacement turned "270.000,00" into
    // "270.000.00" and only read the first "270.000" group back out as the
    // number 270 — silently dropping three orders of magnitude. A real
    // price bump (270k -> 274k) must still be classified as a conflict.
    expect(classifyRelation('Valor a partir de R$ 270.000,00.', 'Valor a partir de R$ 270.000,00.')).toBe(
      'equivalent',
    );
    expect(classifyRelation('Valor a partir de R$ 270.000,00.', 'Valor a partir de R$ 274.000,00.')).toBe(
      'conflict',
    );
    // Without the fix these were both misread as ~270 and ~274 (a 4-unit
    // gap within tolerance) instead of 270000 vs 284000 (a real conflict).
    expect(classifyRelation('Valor a partir de R$ 270.000,00.', 'Valor a partir de R$ 284.000,00.')).toBe(
      'conflict',
    );
  });

  it('does not silently equate a claim that states a number with one that omits it', () => {
    // Regression: "unidades a partir de 18,94 m²" and bare "unidades" share
    // enough tokens to clear the jaccard threshold; when only one side
    // states a number this must NOT merge into one memory (spec: uma
    // informação nova cria nova memória, nunca perde o valor específico).
    expect(classifyRelation('Tem unidades a partir de 18,94 m².', 'Tem unidades.')).toBe('unrelated');
  });
});

describe('isLowSignalContent', () => {
  it('flags bare interjections', () => {
    expect(isLowSignalContent('Joiaaaa')).toBe(true);
    expect(isLowSignalContent('show de bola')).toBe(true);
  });

  it('does not flag a real fact that happens to contain a short word', () => {
    expect(isLowSignalContent('O empreendimento tem piscina na cobertura e vista para o mar.')).toBe(false);
  });
});

describe('consolidateMemory', () => {
  it('Test 1: "18,94 m²" and "19 m²" fold into a single memory', async () => {
    const { db, rows } = fakeMemoriesDb();
    const first = await consolidateMemory(db, areaArgs({ evidence: { kind: 'conversation', conversationId: 'conv-1' } }));
    expect(first.action).toBe('created_candidate');

    const second = await consolidateMemory(
      db,
      areaArgs({ content: 'Tem unidades a partir de 19 m².', evidence: { kind: 'conversation', conversationId: 'conv-2' } }),
    );
    expect(second.action).toBe('reinforced');
    expect(rows).toHaveLength(1);
  });

  it('Test 2: the exact same info repeated increases occurrence_count, never a new row', async () => {
    const { db, rows } = fakeMemoriesDb();
    await consolidateMemory(db, areaArgs());
    await consolidateMemory(db, areaArgs());
    expect(rows).toHaveLength(1);
    expect(rows[0].occurrence_count).toBe(2);
  });

  it('Test 3: ten repetitions in the same conversation count as ONE independent confirmation, not ten', async () => {
    const { db, rows } = fakeMemoriesDb();
    for (let i = 0; i < 10; i++) {
      await consolidateMemory(db, areaArgs({ evidence: { kind: 'conversation', conversationId: 'conv-1' } }));
    }
    expect(rows).toHaveLength(1);
    expect(rows[0].occurrence_count).toBe(10);
    expect(rows[0].status).toBe('candidate');
    expect(rows[0].confidence).toBe('low');
  });

  it('Test 4: the first occurrence of new knowledge is stored as a low-confidence candidate', async () => {
    const { db } = fakeMemoriesDb();
    const result = await consolidateMemory(db, areaArgs());
    expect(result.action).toBe('created_candidate');
    expect(result.memory?.status).toBe('candidate');
    expect(result.memory?.confidence).toBe('low');
  });

  it('Test 5: a second independent confirmation raises confidence without fully consolidating', async () => {
    const { db } = fakeMemoriesDb();
    await consolidateMemory(db, areaArgs({ evidence: { kind: 'conversation', conversationId: 'conv-1' } }));
    const second = await consolidateMemory(
      db,
      areaArgs({ evidence: { kind: 'conversation', conversationId: 'conv-2' } }),
    );
    expect(second.memory?.status).toBe('candidate');
    expect(second.memory?.confidence).toBe('medium');
  });

  it('Test 6: a third independent confirmation consolidates the memory to active/high', async () => {
    const { db } = fakeMemoriesDb();
    await consolidateMemory(db, areaArgs({ evidence: { kind: 'conversation', conversationId: 'conv-1' } }));
    await consolidateMemory(db, areaArgs({ evidence: { kind: 'conversation', conversationId: 'conv-2' } }));
    const third = await consolidateMemory(
      db,
      areaArgs({ evidence: { kind: 'conversation', conversationId: 'conv-3' } }),
    );
    expect(third.action).toBe('consolidated');
    expect(third.memory?.status).toBe('active');
    expect(third.memory?.confidence).toBe('high');
  });

  it('Test 7: a contradicting observation does not overwrite the active memory', async () => {
    const { db, rows } = fakeMemoriesDb();
    await consolidateMemory(db, areaArgs({ evidence: { kind: 'conversation', conversationId: 'conv-1' } }));
    await consolidateMemory(db, areaArgs({ evidence: { kind: 'conversation', conversationId: 'conv-2' } }));
    await consolidateMemory(db, areaArgs({ evidence: { kind: 'conversation', conversationId: 'conv-3' } }));

    const conflict = await consolidateMemory(
      db,
      areaArgs({
        content: 'Tem unidades a partir de 22 m².',
        evidence: { kind: 'conversation', conversationId: 'conv-4' },
      }),
    );
    expect(conflict.action).toBe('conflict_recorded');
    const activeRow = rows.find((r) => r.status === 'active');
    expect(activeRow?.content).toContain('18,94');
    expect(rows.some((r) => r.status === 'conflict')).toBe(true);
  });

  it('Test 8: three independent confirmations of the new value are enough to replace the active memory', async () => {
    const { db, rows } = fakeMemoriesDb();
    await consolidateMemory(db, areaArgs({ evidence: { kind: 'conversation', conversationId: 'conv-1' } }));
    await consolidateMemory(db, areaArgs({ evidence: { kind: 'conversation', conversationId: 'conv-2' } }));
    await consolidateMemory(db, areaArgs({ evidence: { kind: 'conversation', conversationId: 'conv-3' } }));

    const newContent = 'Tem unidades a partir de 22 m².';
    await consolidateMemory(db, areaArgs({ content: newContent, evidence: { kind: 'conversation', conversationId: 'conv-4' } }));
    await consolidateMemory(db, areaArgs({ content: newContent, evidence: { kind: 'conversation', conversationId: 'conv-5' } }));
    const third = await consolidateMemory(
      db,
      areaArgs({ content: newContent, evidence: { kind: 'conversation', conversationId: 'conv-6' } }),
    );

    expect(third.action).toBe('contradiction_resolved');
    const activeRows = rows.filter((r) => r.status === 'active');
    expect(activeRows).toHaveLength(1);
    expect(activeRows[0].content).toBe(newContent);
    expect(activeRows[0].value_history).toHaveLength(1);
    expect((activeRows[0].value_history[0] as { value: string }).value).toContain('18,94');
  });

  it('Test 9: an official source contradicting the active memory replaces it immediately', async () => {
    const { db, rows } = fakeMemoriesDb();
    await consolidateMemory(db, areaArgs({ evidence: { kind: 'conversation', conversationId: 'conv-1' } }));
    await consolidateMemory(db, areaArgs({ evidence: { kind: 'conversation', conversationId: 'conv-2' } }));
    await consolidateMemory(db, areaArgs({ evidence: { kind: 'conversation', conversationId: 'conv-3' } }));

    const result = await consolidateMemory(
      db,
      areaArgs({
        content: 'Tem unidades a partir de 22 m².',
        evidence: { kind: 'official', ref: 'tabela-oficial' },
      }),
    );
    expect(result.action).toBe('replaced_by_official');
    expect(result.memory?.content).toContain('22');
    expect(result.memory?.valueHistory[0]?.value).toContain('18,94');
    expect(rows.filter((r) => r.status === 'active')).toHaveLength(1);
  });

  it('Test 10: dynamic value updates accumulate history without ever creating concurrent rows', async () => {
    const { db, rows } = fakeMemoriesDb();
    const price = (content: string, evidence: ConsolidateMemoryArgs['evidence']) =>
      areaArgs({ knowledgeType: 'property_fact', content, evidence });

    await consolidateMemory(db, price('Menor valor disponível: R$ 270 mil.', { kind: 'conversation', conversationId: 'conv-1' }));
    await consolidateMemory(db, price('Menor valor disponível: R$ 270 mil.', { kind: 'conversation', conversationId: 'conv-2' }));
    await consolidateMemory(db, price('Menor valor disponível: R$ 270 mil.', { kind: 'conversation', conversationId: 'conv-3' }));

    await consolidateMemory(db, price('Menor valor disponível: R$ 274 mil.', { kind: 'official', ref: 'tabela' }));
    const final = await consolidateMemory(
      db,
      price('Menor valor disponível: R$ 284 mil.', { kind: 'official', ref: 'tabela' }),
    );

    expect(final.memory?.content).toContain('284');
    expect(final.memory?.valueHistory.map((h) => h.value)).toEqual([
      expect.stringContaining('270'),
      expect.stringContaining('274'),
    ]);
    expect(rows.filter((r) => r.knowledge_type === 'property_fact' && r.status === 'active')).toHaveLength(1);
  });

  it('Test 11: PROPERTY A memories never merge with PROPERTY B', async () => {
    const { db, rows } = fakeMemoriesDb();
    await consolidateMemory(db, areaArgs({ propertyId: 'prop-a', evidence: { kind: 'conversation', conversationId: 'conv-1' } }));
    await consolidateMemory(db, areaArgs({ propertyId: 'prop-b', evidence: { kind: 'conversation', conversationId: 'conv-2' } }));
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.property_id))).toEqual(new Set(['prop-a', 'prop-b']));
  });

  it('Test 12: AD A memories never merge with AD B', async () => {
    const { db, rows } = fakeMemoriesDb();
    const adArgs = (adId: string, conversationId: string): ConsolidateMemoryArgs => ({
      accountId: ACCOUNT,
      scope: 'ad',
      knowledgeType: 'ad_fact',
      title: 'Área mínima do anúncio',
      content: 'Tem unidades a partir de 18,94 m².',
      adId,
      sourceType: 'learning_scan',
      evidence: { kind: 'conversation', conversationId },
    });
    await consolidateMemory(db, adArgs('ad-a', 'conv-1'));
    await consolidateMemory(db, adArgs('ad-b', 'conv-2'));
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.ad_id))).toEqual(new Set(['ad-a', 'ad-b']));
  });

  it('Test 13: CONVERSATION-scoped facts stay isolated and are usable immediately', async () => {
    const { db, rows } = fakeMemoriesDb();
    const convArgs = (conversationId: string): ConsolidateMemoryArgs => ({
      accountId: ACCOUNT,
      scope: 'conversation',
      knowledgeType: 'client_preference',
      title: 'Preferência do cliente',
      content: 'Cliente prefere andar alto.',
      conversationId,
      sourceType: 'learning_scan',
      evidence: { kind: 'conversation', conversationId },
    });
    const r1 = await consolidateMemory(db, convArgs('conv-1'));
    const r2 = await consolidateMemory(db, convArgs('conv-2'));
    expect(r1.action).toBe('created_active');
    expect(r2.action).toBe('created_active');
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.conversation_id === 'conv-1')?.status).toBe('active');
    expect(rows.find((r) => r.conversation_id === 'conv-2')?.status).toBe('active');
  });

  it('Test 14: a PROPERTY-typed fact cannot be stored as GLOBAL — rejected before it reaches consolidation', async () => {
    const { db } = fakeMemoriesDb();
    await expect(
      consolidateMemory(db, {
        accountId: ACCOUNT,
        scope: 'global',
        knowledgeType: 'property_fact',
        title: 'Piscina',
        content: 'Este empreendimento possui piscina.',
        sourceType: 'learning_scan',
        evidence: { kind: 'human', agentId: 'admin-1' },
      }),
    ).rejects.toThrow(/does not belong to scope/);
  });

  it('Test 15: corretor interjections never become a memory', async () => {
    const { db, rows } = fakeMemoriesDb();
    const result = await consolidateMemory(db, {
      accountId: ACCOUNT,
      scope: 'global',
      knowledgeType: 'communication_pattern',
      title: 'Abertura',
      content: 'Joiaaaa',
      sourceType: 'learning_scan',
      evidence: { kind: 'conversation', conversationId: 'conv-1' },
    });
    expect(result.action).toBe('skipped_low_signal');
    expect(result.memory).toBeNull();
    expect(rows).toHaveLength(0);
  });

  it('Test 16: consolidation only ever touches ai_memories — never global_never_rules/ai_configs', async () => {
    const { db } = fakeMemoriesDb();
    const calls: string[] = [];
    const wrapped = {
      from: (table: string) => {
        calls.push(table);
        return (db as unknown as { from: (t: string) => unknown }).from(table);
      },
    } as unknown as SupabaseClient;
    await consolidateMemory(wrapped, areaArgs());
    expect(calls.every((t) => t === 'ai_memories')).toBe(true);
  });

  it('Test 17: audio-transcribed observations go through the same consolidation pipeline', async () => {
    const { db, rows } = fakeMemoriesDb();
    await consolidateMemory(db, areaArgs({ sourceType: 'audio_transcript', evidence: { kind: 'conversation', conversationId: 'conv-1' } }));
    const second = await consolidateMemory(
      db,
      areaArgs({ sourceType: 'audio_transcript', evidence: { kind: 'conversation', conversationId: 'conv-2' } }),
    );
    expect(second.action).toBe('reinforced');
    expect(rows).toHaveLength(1);
  });
});

describe('evaluateConsolidation — GLOBAL rigor', () => {
  it('requires evidence across >= 2 distinct conversations for GLOBAL, not just 3 same-conversation mentions', () => {
    const now = new Date().toISOString();
    const sameConvo = [
      { kind: 'conversation' as const, conversationId: 'c1', recordedAt: now },
    ];
    expect(evaluateConsolidation('global', sameConvo).status).toBe('candidate');

    const twoConvos = [
      { kind: 'conversation' as const, conversationId: 'c1', recordedAt: now },
      { kind: 'conversation' as const, conversationId: 'c2', recordedAt: now },
      { kind: 'human' as const, agentId: 'a1', recordedAt: now },
    ];
    expect(evaluateConsolidation('global', twoConvos)).toEqual({ status: 'active', confidence: 'high' });
  });
});
