import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  resolvePropertyIdentity,
  findConversationEvidence,
  recordPropertyLearningEvidence,
  getPropertyLearningEvidenceCount,
  meetsPropertyCreationEvidence,
  clearPropertyLearningEvidence,
  MIN_PROPERTY_LEARNING_CONVERSATIONS,
} from './property-identity';

// ============================================================
// Fake `properties` table, scoped by account — resolvePropertyIdentity
// only ever does `.select('id, name').eq('account_id', accountId)`.
// ============================================================
function makePropertiesDb(byAccount: Record<string, { id: string; name: string }[]>): SupabaseClient {
  return {
    from: (table: string) => {
      if (table !== 'properties') throw new Error(`unexpected table in test: ${table}`);
      return {
        select: () => ({
          eq: (_col: string, accountId: string) =>
            Promise.resolve({ data: byAccount[accountId] ?? [], error: null }),
        }),
      };
    },
  } as unknown as SupabaseClient;
}

// ============================================================
// Fake `property_learning_candidates` table — an in-memory map keyed by
// (account_id, normalized_name), enough to exercise the real
// record/get/clear functions under test without a real database.
// ============================================================
function makeCandidatesDb() {
  const store = new Map<string, { conversation_ids: string[]; context_conversation_ids: string[] }>();
  const key = (accountId: string, normalizedName: string) => `${accountId}::${normalizedName}`;

  const db = {
    from: (table: string) => {
      if (table !== 'property_learning_candidates') throw new Error(`unexpected table in test: ${table}`);
      return {
        select: () => ({
          eq: (_c1: string, accountId: string) => ({
            eq: (_c2: string, normalizedName: string) => ({
              maybeSingle: () =>
                Promise.resolve({ data: store.get(key(accountId, normalizedName)) ?? null, error: null }),
            }),
          }),
        }),
        upsert: (row: Record<string, unknown>) => {
          store.set(key(row.account_id as string, row.normalized_name as string), {
            conversation_ids: row.conversation_ids as string[],
            context_conversation_ids: row.context_conversation_ids as string[],
          });
          return Promise.resolve({ data: null, error: null });
        },
        delete: () => ({
          eq: (_c1: string, accountId: string) => ({
            eq: (_c2: string, normalizedName: string) => {
              store.delete(key(accountId, normalizedName));
              return Promise.resolve({ data: null, error: null });
            },
          }),
        }),
      };
    },
  } as unknown as SupabaseClient;

  return { db, store };
}

describe('resolvePropertyIdentity — Parte 1: resolução semântica de identidade', () => {
  it('Test 1: Live Park → Liv Park resolves as a safe match — no duplicate created', async () => {
    const db = makePropertiesDb({ 'acc-1': [{ id: 'p-livepark', name: 'Live Park' }] });
    const result = await resolvePropertyIdentity(db, 'acc-1', 'Liv Park');
    expect(result).toEqual({ kind: 'safe_match', propertyId: 'p-livepark', score: expect.any(Number) });
  });

  it('Test 2: Live Park → LivePark resolves as a safe match', async () => {
    const db = makePropertiesDb({ 'acc-1': [{ id: 'p-livepark', name: 'Live Park' }] });
    const result = await resolvePropertyIdentity(db, 'acc-1', 'LivePark');
    expect(result.kind).toBe('safe_match');
    if (result.kind === 'safe_match') expect(result.propertyId).toBe('p-livepark');
  });

  it('Test 3: Puerto Ventura → Porto Ventura is evaluated as the same likely entity, never no_match', async () => {
    const db = makePropertiesDb({ 'acc-1': [{ id: 'p-ventura', name: 'Puerto Ventura' }] });
    const result = await resolvePropertyIdentity(db, 'acc-1', 'Porto Ventura');
    expect(result.kind).not.toBe('no_match');
    if (result.kind === 'safe_match') expect(result.propertyId).toBe('p-ventura');
    if (result.kind === 'ambiguous') expect(result.candidates.map((c) => c.propertyId)).toContain('p-ventura');
  });

  it('Avant Home → AvantHome resolves as a safe match', async () => {
    const db = makePropertiesDb({ 'acc-1': [{ id: 'p-avant', name: 'Avant Home' }] });
    const result = await resolvePropertyIdentity(db, 'acc-1', 'AvantHome');
    expect(result).toEqual({ kind: 'safe_match', propertyId: 'p-avant', score: expect.any(Number) });
  });

  it('Fix Problema 1a: "Live" vs Live Park / Live Home / Live Residence resolves AMBIGUOUS, never no_match', async () => {
    const db = makePropertiesDb({
      'acc-1': [
        { id: 'prop-park', name: 'Live Park' },
        { id: 'prop-home', name: 'Live Home' },
        { id: 'prop-residence', name: 'Live Residence' },
      ],
    });
    const result = await resolvePropertyIdentity(db, 'acc-1', 'Live');
    expect(result.kind).toBe('ambiguous');
    if (result.kind === 'ambiguous') {
      expect(result.candidates.map((c) => c.propertyId).sort()).toEqual(
        ['prop-home', 'prop-park', 'prop-residence'].sort(),
      );
    }
  });

  it('Fix Problema 1b: "Live" vs Live Park / Live Home resolves AMBIGUOUS, never no_match', async () => {
    const db = makePropertiesDb({
      'acc-1': [
        { id: 'prop-park', name: 'Live Park' },
        { id: 'prop-home', name: 'Live Home' },
      ],
    });
    const result = await resolvePropertyIdentity(db, 'acc-1', 'Live');
    expect(result.kind).toBe('ambiguous');
  });

  it('a bare generic single word ("Park") still never confidently binds, even after the Problema 1 fix', async () => {
    // "Park" is a SUFFIX of "Live Park", not a prefix — the structural
    // plausibility fix must not reopen this exact protection.
    const db = makePropertiesDb({ 'acc-1': [{ id: 'prop-livepark', name: 'Live Park' }] });
    const result = await resolvePropertyIdentity(db, 'acc-1', 'Park');
    expect(result.kind).toBe('no_match');
  });

  it('Fix Problema 2: an exact match wins outright even with a very close sibling ("Prime Tower A" vs "Prime Tower B")', async () => {
    const db = makePropertiesDb({
      'acc-1': [
        { id: 'prop-a', name: 'Prime Tower A' },
        { id: 'prop-b', name: 'Prime Tower B' },
      ],
    });
    const result = await resolvePropertyIdentity(db, 'acc-1', 'Prime Tower A');
    expect(result).toEqual({ kind: 'safe_match', propertyId: 'prop-a', score: 1 });
  });

  it('Test 9: two semantically similar existing properties are AMBIGUOUS — never guessed', async () => {
    const db = makePropertiesDb({
      'acc-1': [
        { id: 'p-bosques', name: 'Residencial Bosques' },
        { id: 'p-basque', name: 'Residencial Basque' },
      ],
    });
    const result = await resolvePropertyIdentity(db, 'acc-1', 'Residencial Bosque');
    expect(result.kind).toBe('ambiguous');
  });

  it('a bare generic single word ("Park") never confidently binds to a specific property', async () => {
    const db = makePropertiesDb({ 'acc-1': [{ id: 'p-livepark', name: 'Live Park' }] });
    const result = await resolvePropertyIdentity(db, 'acc-1', 'Park');
    expect(result.kind).toBe('no_match');
  });

  it('Test 11: never mixes properties across accounts', async () => {
    const db = makePropertiesDb({
      'acc-1': [{ id: 'p-a', name: 'Live Park' }],
      'acc-2': [{ id: 'p-b', name: 'Liv Park' }],
    });
    const result = await resolvePropertyIdentity(db, 'acc-1', 'Liv Park');
    // Only sees acc-1's "Live Park" — resolves fuzzily to it, never to acc-2's row.
    expect(result).toEqual({ kind: 'safe_match', propertyId: 'p-a', score: expect.any(Number) });
  });

  it('a genuinely new name with no plausible existing property resolves as no_match', async () => {
    const db = makePropertiesDb({ 'acc-1': [{ id: 'p-livepark', name: 'Live Park' }] });
    const result = await resolvePropertyIdentity(db, 'acc-1', 'Residencial Horizonte Completamente Novo');
    expect(result).toEqual({ kind: 'no_match' });
  });
});

describe('findConversationEvidence — mecânica vs. contexto real', () => {
  it('Test 7: 20 mentions inside a single conversation still count as exactly 1 distinct conversation', () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({
      conversationId: 'conv-1',
      text: `Cliente perguntou de novo sobre o Residencial Reserva (mensagem ${i}), com metragem e localização.`,
    }));
    const { mentioned, withContext } = findConversationEvidence(rows, 'Residencial Reserva');
    expect(mentioned.size).toBe(1);
    expect(withContext.size).toBe(1);
  });

  it('a bare mention with no real-estate context does not count toward context evidence', () => {
    const rows = [{ conversationId: 'conv-1', text: 'Residencial Reserva' }];
    const { mentioned, withContext } = findConversationEvidence(rows, 'Residencial Reserva');
    expect(mentioned.size).toBe(1);
    expect(withContext.size).toBe(0);
  });

  it('counts distinct conversations correctly when the name appears in several different ones', () => {
    const rows = [
      { conversationId: 'conv-1', text: 'Interessado no Residencial Reserva, quer saber a metragem.' },
      { conversationId: 'conv-2', text: 'Perguntou do Residencial Reserva e da localização.' },
      { conversationId: 'conv-2', text: 'Segue perguntando sobre lazer do Residencial Reserva.' },
      { conversationId: 'conv-3', text: 'Nada a ver com o assunto.' },
    ];
    const { mentioned, withContext } = findConversationEvidence(rows, 'Residencial Reserva');
    expect(mentioned).toEqual(new Set(['conv-1', 'conv-2']));
    expect(withContext).toEqual(new Set(['conv-1', 'conv-2']));
  });
});

describe('conversation-evidence ledger — Parte 4/5: 7 conversas distintas + contexto', () => {
  it('Test 4: a single conversation is nowhere near enough to create', async () => {
    const { db } = makeCandidatesDb();
    await recordPropertyLearningEvidence(db, 'acc-1', 'Residencial Reserva', ['conv-1'], ['conv-1']);
    const count = await getPropertyLearningEvidenceCount(db, 'acc-1', 'Residencial Reserva');
    expect(count).toBe(1);
    expect(meetsPropertyCreationEvidence(count)).toBe(false);
  });

  it('Test 5: 6 distinct conversations still fall short of the bar', async () => {
    const { db } = makeCandidatesDb();
    const convIds = Array.from({ length: 6 }, (_, i) => `conv-${i + 1}`);
    await recordPropertyLearningEvidence(db, 'acc-1', 'Residencial Reserva', convIds, convIds);
    const count = await getPropertyLearningEvidenceCount(db, 'acc-1', 'Residencial Reserva');
    expect(count).toBe(6);
    expect(meetsPropertyCreationEvidence(count)).toBe(false);
  });

  it('Test 6: 7 distinct, context-bearing conversations accumulated across scans clears the bar', async () => {
    const { db } = makeCandidatesDb();
    // Simulates two separate cron runs, evidence accumulating between them.
    await recordPropertyLearningEvidence(
      db,
      'acc-1',
      'Residencial Reserva',
      ['conv-1', 'conv-2', 'conv-3', 'conv-4', 'conv-5', 'conv-6'],
      ['conv-1', 'conv-2', 'conv-3', 'conv-4', 'conv-5', 'conv-6'],
    );
    await recordPropertyLearningEvidence(db, 'acc-1', 'Residencial Reserva', ['conv-7'], ['conv-7']);

    const count = await getPropertyLearningEvidenceCount(db, 'acc-1', 'Residencial Reserva');
    expect(count).toBe(MIN_PROPERTY_LEARNING_CONVERSATIONS);
    expect(meetsPropertyCreationEvidence(count)).toBe(true);
  });

  it('Test 10: a genuinely new empreendimento with 7 context-bearing conversations is eligible', async () => {
    const { db } = makeCandidatesDb();
    const convIds = Array.from({ length: 7 }, (_, i) => `conv-${i + 1}`);
    await recordPropertyLearningEvidence(db, 'acc-1', 'Costa Serena Residence', convIds, convIds);
    const count = await getPropertyLearningEvidenceCount(db, 'acc-1', 'Costa Serena Residence');
    expect(meetsPropertyCreationEvidence(count)).toBe(true);
  });

  it('mentions without context signal never count toward the creation bar, however numerous', async () => {
    const { db } = makeCandidatesDb();
    const convIds = Array.from({ length: 10 }, (_, i) => `conv-${i + 1}`);
    // All 10 conversations merely mention the name — none carry real context.
    await recordPropertyLearningEvidence(db, 'acc-1', 'Residencial Reserva', convIds, []);
    const count = await getPropertyLearningEvidenceCount(db, 'acc-1', 'Residencial Reserva');
    expect(count).toBe(0);
    expect(meetsPropertyCreationEvidence(count)).toBe(false);
  });

  it('Test 11: evidence never leaks across accounts', async () => {
    const { db } = makeCandidatesDb();
    const convIds = Array.from({ length: 7 }, (_, i) => `conv-${i + 1}`);
    await recordPropertyLearningEvidence(db, 'acc-1', 'Residencial Reserva', convIds, convIds);

    const countOtherAccount = await getPropertyLearningEvidenceCount(db, 'acc-2', 'Residencial Reserva');
    expect(countOtherAccount).toBe(0);
    expect(meetsPropertyCreationEvidence(countOtherAccount)).toBe(false);
  });

  it('clears the ledger once the property is created — nothing left to accumulate toward', async () => {
    const { db, store } = makeCandidatesDb();
    const convIds = Array.from({ length: 7 }, (_, i) => `conv-${i + 1}`);
    await recordPropertyLearningEvidence(db, 'acc-1', 'Residencial Reserva', convIds, convIds);
    expect(store.size).toBe(1);
    await clearPropertyLearningEvidence(db, 'acc-1', 'Residencial Reserva');
    expect(store.size).toBe(0);
    expect(await getPropertyLearningEvidenceCount(db, 'acc-1', 'Residencial Reserva')).toBe(0);
  });
});
