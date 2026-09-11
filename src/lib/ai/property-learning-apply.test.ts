import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const h = vi.hoisted(() => ({
  generateOpenAi: vi.fn(),
  generateAnthropic: vi.fn(),
  replacePropertySubjectiveKnowledge: vi.fn(),
  resolvePropertyIdentity: vi.fn(),
  getPropertyLearningEvidenceCount: vi.fn(),
  clearPropertyLearningEvidence: vi.fn(),
}));

vi.mock('./providers/openai', () => ({ generateOpenAi: h.generateOpenAi }));
vi.mock('./providers/anthropic', () => ({ generateAnthropic: h.generateAnthropic }));
vi.mock('./knowledge', () => ({ replacePropertySubjectiveKnowledge: h.replacePropertySubjectiveKnowledge }));
// Identity resolution and the evidence ledger are unit-tested on their own
// in property-identity.test.ts — here we only need to drive the three
// outcomes (safe_match / ambiguous / no_match) to verify resolveOrCreateProperty's
// decision tree, without simulating fuzzy matching or extra DB tables.
vi.mock('./property-identity', async () => {
  const actual = await vi.importActual<typeof import('./property-identity')>('./property-identity');
  return {
    ...actual,
    resolvePropertyIdentity: h.resolvePropertyIdentity,
    getPropertyLearningEvidenceCount: h.getPropertyLearningEvidenceCount,
    clearPropertyLearningEvidence: h.clearPropertyLearningEvidence,
  };
});

import {
  AUTO_APPLY_MIN_OCCURRENCES,
  meetsAutoApplyThreshold,
  resolveOrCreateProperty,
  applyPropertySubjectiveLearning,
} from './property-learning-apply';
import { MIN_PROPERTY_LEARNING_CONVERSATIONS } from './property-identity';
import type { AiConfig } from './types';

function makeConfig(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'openai',
    model: 'gpt-test',
    apiKey: 'sk-test',
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: false,
    autoReplyMaxPerConversation: 3,
    handoffAgentId: null,
    embeddingsApiKey: 'sk-embed',
    ...overrides,
  } as AiConfig;
}

describe('meetsAutoApplyThreshold (Parte 4 gate)', () => {
  it('accepts high confidence + non-isolated + occurrence_count at the minimum', () => {
    expect(
      meetsAutoApplyThreshold({
        confidence: 'high',
        is_isolated: false,
        occurrence_count: AUTO_APPLY_MIN_OCCURRENCES,
      }),
    ).toBe(true);
  });

  it('rejects occurrence_count below the minimum', () => {
    expect(
      meetsAutoApplyThreshold({
        confidence: 'high',
        is_isolated: false,
        occurrence_count: AUTO_APPLY_MIN_OCCURRENCES - 1,
      }),
    ).toBe(false);
  });

  it('rejects medium confidence even with plenty of occurrences', () => {
    expect(meetsAutoApplyThreshold({ confidence: 'medium', is_isolated: false, occurrence_count: 10 })).toBe(false);
  });

  it('rejects an isolated observation regardless of confidence/count', () => {
    expect(meetsAutoApplyThreshold({ confidence: 'high', is_isolated: true, occurrence_count: 10 })).toBe(false);
  });
});

describe('resolveOrCreateProperty (Parte 2 + trava de identidade/evidência)', () => {
  beforeEach(() => {
    h.resolvePropertyIdentity.mockReset();
    h.getPropertyLearningEvidenceCount.mockReset();
    h.clearPropertyLearningEvidence.mockReset().mockResolvedValue(undefined);
  });

  it('uses the existing property id on a safe semantic match instead of creating a duplicate', async () => {
    h.resolvePropertyIdentity.mockResolvedValue({ kind: 'safe_match', propertyId: 'prop-existing', score: 0.9 });
    const db = { from: vi.fn() } as unknown as SupabaseClient;

    const id = await resolveOrCreateProperty(db, 'acc-1', 'user-1', 'Liv Park');
    expect(id).toBe('prop-existing');
    expect(db.from).not.toHaveBeenCalled(); // never touches `properties` directly — resolution owns that lookup
    expect(h.getPropertyLearningEvidenceCount).not.toHaveBeenCalled();
  });

  it('Test 8: a huge recurrence count never overrides a safe match — "Liv Park" keeps binding to Live Park, never spawns its own property', async () => {
    h.resolvePropertyIdentity.mockResolvedValue({ kind: 'safe_match', propertyId: 'prop-live-park', score: 0.9 });
    // Even if "Liv Park" had accrued evidence from 20 conversations, it must
    // never be consulted once identity already resolved safely — occurrence
    // count/evidence can never override or substitute for identity resolution.
    h.getPropertyLearningEvidenceCount.mockResolvedValue(20);
    const insertCalled = vi.fn();
    const db = { from: insertCalled } as unknown as SupabaseClient;

    const id = await resolveOrCreateProperty(db, 'acc-1', 'user-1', 'Liv Park');
    expect(id).toBe('prop-live-park');
    expect(h.getPropertyLearningEvidenceCount).not.toHaveBeenCalled();
    expect(insertCalled).not.toHaveBeenCalled();
  });

  it('Required test 9: 7+ conversations of evidence never overrides an AMBIGUOUS resolution — still no creation', async () => {
    h.resolvePropertyIdentity.mockResolvedValue({
      kind: 'ambiguous',
      candidates: [
        { propertyId: 'prop-park', score: 0.7 },
        { propertyId: 'prop-home', score: 0.68 },
      ],
    });
    h.getPropertyLearningEvidenceCount.mockResolvedValue(20); // way past the 7-conversation bar
    const insertCalled = vi.fn();
    const db = { from: insertCalled } as unknown as SupabaseClient;

    const id = await resolveOrCreateProperty(db, 'acc-1', 'user-1', 'Live');
    expect(id).toBeNull();
    expect(h.getPropertyLearningEvidenceCount).not.toHaveBeenCalled();
    expect(insertCalled).not.toHaveBeenCalled();
  });

  it('never creates on an ambiguous resolution — no guessing between plausible candidates', async () => {
    h.resolvePropertyIdentity.mockResolvedValue({
      kind: 'ambiguous',
      candidates: [
        { propertyId: 'prop-a', score: 0.7 },
        { propertyId: 'prop-b', score: 0.68 },
      ],
    });
    const db = { from: vi.fn() } as unknown as SupabaseClient;

    const id = await resolveOrCreateProperty(db, 'acc-1', 'user-1', 'Reserva Bosque');
    expect(id).toBeNull();
    expect(db.from).not.toHaveBeenCalled();
  });

  it('does NOT create a new property on no_match when evidence is below the 7-conversation bar', async () => {
    h.resolvePropertyIdentity.mockResolvedValue({ kind: 'no_match' });
    h.getPropertyLearningEvidenceCount.mockResolvedValue(MIN_PROPERTY_LEARNING_CONVERSATIONS - 1);
    const insertCalled = vi.fn();
    const db = { from: insertCalled } as unknown as SupabaseClient;

    const id = await resolveOrCreateProperty(db, 'acc-1', 'user-1', 'Residencial Horizonte');
    expect(id).toBeNull();
    expect(insertCalled).not.toHaveBeenCalled();
  });

  it('auto-creates a provisional property on no_match once evidence reaches the 7-conversation bar', async () => {
    h.resolvePropertyIdentity.mockResolvedValue({ kind: 'no_match' });
    h.getPropertyLearningEvidenceCount.mockResolvedValue(MIN_PROPERTY_LEARNING_CONVERSATIONS);
    const insertedRows: Record<string, unknown>[] = [];
    const db = {
      from: vi.fn().mockReturnValue({
        insert: (row: Record<string, unknown>) => {
          insertedRows.push(row);
          return { select: () => ({ single: () => Promise.resolve({ data: { id: 'prop-new' }, error: null }) }) };
        },
      }),
    } as unknown as SupabaseClient;

    const id = await resolveOrCreateProperty(db, 'acc-1', 'user-1', 'Residencial Horizonte');
    expect(id).toBe('prop-new');
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0]).toMatchObject({
      account_id: 'acc-1',
      user_id: 'user-1',
      name: 'Residencial Horizonte',
      status: 'provisorio',
      created_from_learning: true,
    });
    expect(h.clearPropertyLearningEvidence).toHaveBeenCalledWith(db, 'acc-1', 'Residencial Horizonte');
  });
});

describe('applyPropertySubjectiveLearning (Partes 2 & 3)', () => {
  beforeEach(() => {
    h.generateOpenAi.mockReset();
    h.generateAnthropic.mockReset();
    h.replacePropertySubjectiveKnowledge.mockReset().mockResolvedValue(undefined);
    h.resolvePropertyIdentity.mockReset();
    h.getPropertyLearningEvidenceCount.mockReset();
    h.clearPropertyLearningEvidence.mockReset().mockResolvedValue(undefined);
  });

  it('fuses the new observation with the existing text via the model and persists only through replacePropertySubjectiveKnowledge', async () => {
    h.generateOpenAi.mockResolvedValue({ text: 'Texto fundido único e coeso.', usage: null });

    const db = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'properties') {
          // Problem 3 fix: an id-only call now must confirm the id
          // actually belongs to this account before trusting it.
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({ maybeSingle: () => Promise.resolve({ data: { id: 'prop-1' }, error: null }) }),
              }),
            }),
          };
        }
        if (table === 'property_ai_contexts') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: () => Promise.resolve({ data: { subjective_knowledge: 'Texto antigo.' }, error: null }),
                }),
              }),
            }),
          };
        }
        throw new Error(`unexpected table in test: ${table}`);
      }),
    } as unknown as SupabaseClient;

    const result = await applyPropertySubjectiveLearning(db, 'acc-1', makeConfig(), 'user-1', {
      propertyId: 'prop-1',
      info: 'Aceita entrada de 20% em lançamentos.',
    });

    expect(result).toEqual({ propertyId: 'prop-1', previousKnowledge: 'Texto antigo.' });
    expect(h.generateOpenAi).toHaveBeenCalledTimes(1);
    const userPrompt = h.generateOpenAi.mock.calls[0][0].messages[0].content as string;
    expect(userPrompt).toContain('Texto antigo.');
    expect(userPrompt).toContain('Aceita entrada de 20% em lançamentos.');

    expect(h.replacePropertySubjectiveKnowledge).toHaveBeenCalledTimes(1);
    expect(h.replacePropertySubjectiveKnowledge).toHaveBeenCalledWith(
      db,
      'acc-1',
      { embeddingsApiKey: 'sk-embed' },
      'prop-1',
      { subjectiveKnowledge: 'Texto fundido único e coeso.' },
    );
  });

  it('auto-creates the provisional property by name when no property_id is given and evidence is sufficient', async () => {
    h.generateOpenAi.mockResolvedValue({ text: 'Primeira observação registrada.', usage: null });
    h.resolvePropertyIdentity.mockResolvedValue({ kind: 'no_match' });
    h.getPropertyLearningEvidenceCount.mockResolvedValue(MIN_PROPERTY_LEARNING_CONVERSATIONS);

    const insertedRows: Record<string, unknown>[] = [];
    const db = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'properties') {
          return {
            insert: (row: Record<string, unknown>) => {
              insertedRows.push(row);
              return { select: () => ({ single: () => Promise.resolve({ data: { id: 'prop-auto' }, error: null }) }) };
            },
          };
        }
        if (table === 'property_ai_contexts') {
          return {
            select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) }),
          };
        }
        throw new Error(`unexpected table in test: ${table}`);
      }),
    } as unknown as SupabaseClient;

    const result = await applyPropertySubjectiveLearning(db, 'acc-1', makeConfig(), 'user-1', {
      propertyName: 'Residencial Nova Vista',
      info: 'Cliente sempre pergunta sobre vaga de garagem dupla.',
    });

    expect(result?.propertyId).toBe('prop-auto');
    expect(result?.previousKnowledge).toBeNull();
    expect(insertedRows[0]).toMatchObject({ name: 'Residencial Nova Vista', status: 'provisorio', created_from_learning: true });
    expect(h.replacePropertySubjectiveKnowledge).toHaveBeenCalledWith(
      db,
      'acc-1',
      { embeddingsApiKey: 'sk-embed' },
      'prop-auto',
      { subjectiveKnowledge: 'Primeira observação registrada.' },
    );
  });

  it('Required test 12: an externally supplied property_id belonging to another account is rejected, not trusted', async () => {
    const db = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'properties') {
          // Scoped by account_id in the query — a foreign-account id
          // never matches, so this always resolves to "not found".
          return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) }) };
        }
        throw new Error(`unexpected table in test: ${table}`);
      }),
    } as unknown as SupabaseClient;

    const result = await applyPropertySubjectiveLearning(db, 'acc-1', makeConfig(), 'user-1', {
      propertyId: 'prop-from-other-account',
      info: 'Informação sem nome de imóvel associado.',
    });

    expect(result).toBeNull();
    expect(h.generateOpenAi).not.toHaveBeenCalled();
    expect(h.replacePropertySubjectiveKnowledge).not.toHaveBeenCalled();
  });

  it('Required test 13: a property_id that contradicts the resolved identity never bypasses the resolver', async () => {
    h.generateOpenAi.mockResolvedValue({ text: 'Texto fundido.', usage: null });
    // The name genuinely resolves (safely) to a DIFFERENT property than
    // the one smuggled in as propertyId.
    h.resolvePropertyIdentity.mockResolvedValue({ kind: 'safe_match', propertyId: 'prop-correct', score: 0.95 });

    const db = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'property_ai_contexts') {
          return {
            select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) }),
          };
        }
        throw new Error(`unexpected table in test: ${table}`);
      }),
    } as unknown as SupabaseClient;

    const result = await applyPropertySubjectiveLearning(db, 'acc-1', makeConfig(), 'user-1', {
      propertyId: 'prop-wrong-injected', // disagrees with the resolver
      propertyName: 'Live Park',
      info: 'Observação sobre o Live Park.',
    });

    // The resolver's finding wins — never the raw supplied id.
    expect(result?.propertyId).toBe('prop-correct');
    expect(h.replacePropertySubjectiveKnowledge).toHaveBeenCalledWith(
      db,
      'acc-1',
      { embeddingsApiKey: 'sk-embed' },
      'prop-correct',
      expect.any(Object),
    );
  });

  it('returns null and never calls the model when the name has no match and insufficient conversation evidence', async () => {
    h.resolvePropertyIdentity.mockResolvedValue({ kind: 'no_match' });
    h.getPropertyLearningEvidenceCount.mockResolvedValue(2);
    const db = { from: vi.fn() } as unknown as SupabaseClient;

    const result = await applyPropertySubjectiveLearning(db, 'acc-1', makeConfig(), 'user-1', {
      propertyName: 'Residencial Recém Falado',
      info: 'Mencionado uma vez.',
    });

    expect(result).toBeNull();
    expect(h.generateOpenAi).not.toHaveBeenCalled();
    expect(h.replacePropertySubjectiveKnowledge).not.toHaveBeenCalled();
  });

  it('returns null and never calls the model when there is no property id/name to resolve', async () => {
    const db = { from: vi.fn() } as unknown as SupabaseClient;
    const result = await applyPropertySubjectiveLearning(db, 'acc-1', makeConfig(), 'user-1', {
      info: 'Observação sem imóvel associado.',
    });
    expect(result).toBeNull();
    expect(h.generateOpenAi).not.toHaveBeenCalled();
    expect(h.replacePropertySubjectiveKnowledge).not.toHaveBeenCalled();
  });
});
