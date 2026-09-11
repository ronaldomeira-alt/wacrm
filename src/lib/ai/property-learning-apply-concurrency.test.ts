import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

// Real resolveOrCreateProperty/applyPropertySubjectiveLearning end-to-end
// against a fake `properties` table that enforces the SAME atomicity a
// real Postgres unique index gives: a duplicate (account_id,
// normalized_name) INSERT always fails with 23505, no matter how the
// preceding identity/evidence reads interleaved. This is what actually
// closes the race the security audit demonstrated — resolveOrCreateProperty
// itself still isn't one atomic transaction, but the final INSERT is
// guarded by the database, and a 23505 is recovered instead of failing.
const h = vi.hoisted(() => ({
  generateOpenAi: vi.fn(),
  generateAnthropic: vi.fn(),
  replacePropertySubjectiveKnowledge: vi.fn(),
}));
vi.mock('./providers/openai', () => ({ generateOpenAi: h.generateOpenAi }));
vi.mock('./providers/anthropic', () => ({ generateAnthropic: h.generateAnthropic }));
vi.mock('./knowledge', () => ({ replacePropertySubjectiveKnowledge: h.replacePropertySubjectiveKnowledge }));

import { resolveOrCreateProperty, applyPropertySubjectiveLearning } from './property-learning-apply';
import type { AiConfig } from './types';

function makeConfig(): AiConfig {
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
  } as AiConfig;
}

type PropertyRow = { id: string; account_id: string; name: string; normalized_name: string; [k: string]: unknown };

/** Query builder that filters an underlying array by every `.eq()`
 *  applied so far — resolves either as an array (awaited directly, like
 *  resolvePropertyIdentity's `.select().eq('account_id', x)`) or as a
 *  single row via `.maybeSingle()` (like the post-conflict recovery
 *  lookup, which adds a second `.eq('normalized_name', y)`). */
function propertiesQuery(rows: PropertyRow[]) {
  const filters: Record<string, unknown> = {};
  const builder = {
    eq(col: string, val: unknown) {
      filters[col] = val;
      return builder;
    },
    maybeSingle() {
      const match = rows.find((r) => Object.entries(filters).every(([k, v]) => r[k] === v));
      return Promise.resolve({ data: match ?? null, error: null });
    },
    then(resolve: (v: { data: PropertyRow[]; error: null }) => void) {
      resolve({ data: rows.filter((r) => Object.entries(filters).every(([k, v]) => r[k] === v)), error: null });
    },
  };
  return builder;
}

/** A `properties` table whose INSERT enforces (account_id,
 *  normalized_name) uniqueness exactly the way the real partial unique
 *  index does (migration 20260911150000): the check-and-write inside a
 *  single `insert()` call is one synchronous unit, so whichever of two
 *  concurrent callers' `.insert()` call actually runs first always wins
 *  — mirroring how a real database serializes the physical write,
 *  regardless of how the earlier (unprotected) identity/evidence reads
 *  interleaved. */
function makePropertiesTable() {
  const rows: PropertyRow[] = [];
  let nextId = 1;
  return {
    rows,
    handlers: {
      select: () => propertiesQuery(rows),
      insert: (row: Record<string, unknown>) => {
        const dupe = rows.find(
          (r) => r.account_id === row.account_id && r.normalized_name === row.normalized_name,
        );
        if (dupe) {
          return {
            select: () => ({
              single: () =>
                Promise.resolve({
                  data: null,
                  error: { code: '23505', message: 'duplicate key value violates unique constraint "idx_properties_account_normalized_name"' },
                }),
            }),
          };
        }
        const id = `prop-${nextId++}`;
        const newRow = { ...row, id } as PropertyRow;
        rows.push(newRow);
        return { select: () => ({ single: () => Promise.resolve({ data: { id }, error: null }) }) };
      },
    },
  };
}

function makeEvidenceTable(preSeeded: Record<string, { conversation_ids: string[]; context_conversation_ids: string[] }>) {
  const store = new Map(Object.entries(preSeeded));
  return {
    select: () => ({
      eq: () => ({
        eq: (_c2: string, normalizedName: string) =>
          ({ maybeSingle: () => Promise.resolve({ data: store.get(normalizedName) ?? null, error: null }) }),
      }),
    }),
    upsert: () => Promise.resolve({ data: null, error: null }),
    delete: () => ({ eq: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }) }),
  };
}

function makeDb(opts: {
  evidence?: Record<string, { conversation_ids: string[]; context_conversation_ids: string[] }>;
  contextByProperty?: Record<string, string | null>;
}) {
  const propertiesTable = makePropertiesTable();
  const evidenceTable = makeEvidenceTable(opts.evidence ?? {});
  const db = {
    from: (table: string) => {
      if (table === 'properties') return propertiesTable.handlers;
      if (table === 'property_learning_candidates') return evidenceTable;
      if (table === 'property_ai_contexts') {
        return {
          select: () => ({
            eq: (_c1: string, propId: string) => ({
              eq: () => ({
                maybeSingle: () =>
                  Promise.resolve({ data: { subjective_knowledge: opts.contextByProperty?.[propId] ?? null }, error: null }),
              }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table in test: ${table}`);
    },
  } as unknown as SupabaseClient;
  return { db, propertiesTable };
}

const SEVEN_CONVERSATIONS = { conversation_ids: Array.from({ length: 7 }, (_, i) => `c${i}`), context_conversation_ids: Array.from({ length: 7 }, (_, i) => `c${i}`) };

describe('Concurrency fix — resolveOrCreateProperty is idempotent under a race', () => {
  beforeEach(() => {
    h.generateOpenAi.mockReset().mockResolvedValue({ text: 'Texto fundido.', usage: null });
    h.replacePropertySubjectiveKnowledge.mockReset().mockResolvedValue(undefined);
  });

  it('A) two simultaneous calls for the same new empreendimento produce exactly one property', async () => {
    const { db, propertiesTable } = makeDb({ evidence: { 'solaris beach residence': SEVEN_CONVERSATIONS } });

    const [id1, id2] = await Promise.all([
      resolveOrCreateProperty(db, 'acc-1', 'user-1', 'Solaris Beach Residence'),
      resolveOrCreateProperty(db, 'acc-1', 'user-1', 'Solaris Beach Residence'),
    ]);

    expect(id1).toBe(id2);
    expect(id1).not.toBeNull();
    expect(propertiesTable.rows).toHaveLength(1);
  });

  it('B) three simultaneous calls for the same new empreendimento still produce exactly one property', async () => {
    const { db, propertiesTable } = makeDb({ evidence: { 'solaris beach residence': SEVEN_CONVERSATIONS } });

    const ids = await Promise.all([
      resolveOrCreateProperty(db, 'acc-1', 'user-1', 'Solaris Beach Residence'),
      resolveOrCreateProperty(db, 'acc-1', 'user-1', 'Solaris Beach Residence'),
      resolveOrCreateProperty(db, 'acc-1', 'user-1', 'Solaris Beach Residence'),
    ]);

    expect(new Set(ids).size).toBe(1);
    expect(ids.every((id) => id !== null)).toBe(true);
    expect(propertiesTable.rows).toHaveLength(1);
  });

  it('C) a manual approval and an auto-apply racing for the same empreendimento converge on one property', async () => {
    const { db, propertiesTable } = makeDb({ evidence: { 'solaris beach residence': SEVEN_CONVERSATIONS } });

    // "Manual approval" and "auto-apply" are, at this layer, just two
    // separate applyPropertySubjectiveLearning calls — exactly what
    // suggestions/[id]/route.ts and learning-generate.ts each do.
    const [manual, autoApply] = await Promise.all([
      applyPropertySubjectiveLearning(db, 'acc-1', makeConfig(), 'user-1', {
        propertyName: 'Solaris Beach Residence',
        info: 'Observação aprovada manualmente pelo admin.',
      }),
      applyPropertySubjectiveLearning(db, 'acc-1', makeConfig(), 'user-1', {
        propertyName: 'Solaris Beach Residence',
        info: 'Observação auto-aplicada pelo cron.',
      }),
    ]);

    expect(manual?.propertyId).toBeDefined();
    expect(manual?.propertyId).toBe(autoApply?.propertyId);
    expect(propertiesTable.rows).toHaveLength(1);
  });

  it('D) the same empreendimento in two different accounts never conflicts — one property per account', async () => {
    const { db, propertiesTable } = makeDb({
      evidence: {
        'solaris beach residence': SEVEN_CONVERSATIONS, // shared normalized name; per-account queries never cross
      },
    });

    const [idA, idB] = await Promise.all([
      resolveOrCreateProperty(db, 'acc-A', 'user-1', 'Solaris Beach Residence'),
      resolveOrCreateProperty(db, 'acc-B', 'user-1', 'Solaris Beach Residence'),
    ]);

    expect(idA).not.toBeNull();
    expect(idB).not.toBeNull();
    expect(idA).not.toBe(idB);
    expect(propertiesTable.rows).toHaveLength(2);
    expect(propertiesTable.rows.map((r) => r.account_id).sort()).toEqual(['acc-A', 'acc-B']);
  });

  it('E) a second call after the property already exists reuses it instead of creating another', async () => {
    const { db, propertiesTable } = makeDb({ evidence: { 'solaris beach residence': SEVEN_CONVERSATIONS } });

    const firstId = await resolveOrCreateProperty(db, 'acc-1', 'user-1', 'Solaris Beach Residence');
    expect(propertiesTable.rows).toHaveLength(1);

    // A later, sequential call now resolves via identity's exact-match
    // path — the same protection, no dependency on the 23505 recovery.
    const secondId = await resolveOrCreateProperty(db, 'acc-1', 'user-1', 'Solaris Beach Residence');

    expect(secondId).toBe(firstId);
    expect(propertiesTable.rows).toHaveLength(1);
  });

  it('F) a 23505 conflict on INSERT is recovered by looking up the existing row, never surfaced as a hard failure', async () => {
    const { db, propertiesTable } = makeDb({ evidence: { 'solaris beach residence': SEVEN_CONVERSATIONS } });

    // Pre-seed the row directly, simulating "another process already
    // committed it a moment ago" — resolvePropertyIdentity would
    // normally catch this via safe_match, so to specifically exercise
    // the INSERT-conflict recovery path (not the earlier identity
    // short-circuit), bypass identity by inserting with a name whose
    // fuzzy score against itself is trivially a safe_match... instead,
    // directly assert the recovery branch using two truly concurrent
    // calls (same mechanism as test A) and confirm neither call ever
    // throws/rejects.
    const results = await Promise.allSettled([
      resolveOrCreateProperty(db, 'acc-1', 'user-1', 'Solaris Beach Residence'),
      resolveOrCreateProperty(db, 'acc-1', 'user-1', 'Solaris Beach Residence'),
    ]);

    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    const ids = results.map((r) => (r as PromiseFulfilledResult<string | null>).value);
    expect(ids[0]).toBe(ids[1]);
    expect(propertiesTable.rows).toHaveLength(1);
  });
});

// ============================================================
// normalized_name = compactForMatch() — the fix for the gap the final
// audit found: the previous (spaced) normalized_name let two spacing/
// separator variants of the SAME brand-new name ("LivePark" vs "Live
// Park") race past the unique index, because they were different
// strings to Postgres even though resolvePropertyIdentity's own
// exact-match check (compactForMatch) already treats them as one
// identity. Evidence is still keyed by the (untouched) spaced form in
// property_learning_candidates, so each spelling variant needs its own
// pre-seeded evidence entry below — exactly mirroring how two
// inconsistent LLM extractions of a never-before-seen name would
// realistically accrue evidence independently before either ever
// resolves against a real `properties` row.
// ============================================================
describe('Concurrency fix — spelling-variant races (LivePark / Live Park / Live-Park / Live  Park)', () => {
  beforeEach(() => {
    h.generateOpenAi.mockReset().mockResolvedValue({ text: 'Texto fundido.', usage: null });
    h.replacePropertySubjectiveKnowledge.mockReset().mockResolvedValue(undefined);
  });

  it('A) "LivePark" and "Live Park" racing concurrently converge on ONE property with the same id', async () => {
    const { db, propertiesTable } = makeDb({
      evidence: { livepark: SEVEN_CONVERSATIONS, 'live park': SEVEN_CONVERSATIONS },
    });

    const [id1, id2] = await Promise.all([
      resolveOrCreateProperty(db, 'acc-1', 'user-1', 'LivePark'),
      resolveOrCreateProperty(db, 'acc-1', 'user-1', 'Live Park'),
    ]);

    expect(id1).toBe(id2);
    expect(id1).not.toBeNull();
    expect(propertiesTable.rows).toHaveLength(1);
    expect(propertiesTable.rows[0].normalized_name).toBe('livepark');
  });

  it('B) "Live-Park" and "Live Park" racing concurrently converge on ONE property', async () => {
    const { db, propertiesTable } = makeDb({
      evidence: { 'live park': SEVEN_CONVERSATIONS }, // "Live-Park" also normalizes (spaced) to "live park"
    });

    const [id1, id2] = await Promise.all([
      resolveOrCreateProperty(db, 'acc-1', 'user-1', 'Live-Park'),
      resolveOrCreateProperty(db, 'acc-1', 'user-1', 'Live Park'),
    ]);

    expect(id1).toBe(id2);
    expect(propertiesTable.rows).toHaveLength(1);
  });

  it('C) "Live  Park" (double space) and "Live Park" racing concurrently converge on ONE property', async () => {
    const { db, propertiesTable } = makeDb({
      evidence: { 'live park': SEVEN_CONVERSATIONS }, // double-space also normalizes (spaced) to "live park"
    });

    const [id1, id2] = await Promise.all([
      resolveOrCreateProperty(db, 'acc-1', 'user-1', 'Live  Park'),
      resolveOrCreateProperty(db, 'acc-1', 'user-1', 'Live Park'),
    ]);

    expect(id1).toBe(id2);
    expect(propertiesTable.rows).toHaveLength(1);
  });

  it('D) sequential: "LivePark" creates first, "Live Park" afterwards reuses the same property', async () => {
    const { db, propertiesTable } = makeDb({
      evidence: { livepark: SEVEN_CONVERSATIONS, 'live park': SEVEN_CONVERSATIONS },
    });

    const id1 = await resolveOrCreateProperty(db, 'acc-1', 'user-1', 'LivePark');
    expect(propertiesTable.rows).toHaveLength(1);

    // Resolved via resolvePropertyIdentity's own compact exact-match
    // against the real `properties` row — not the 23505 recovery path.
    const id2 = await resolveOrCreateProperty(db, 'acc-1', 'user-1', 'Live Park');

    expect(id2).toBe(id1);
    expect(propertiesTable.rows).toHaveLength(1);
  });

  it('E) different accounts: Account A "LivePark" + Account B "Live Park" never conflict — 2 independent properties', async () => {
    const { db, propertiesTable } = makeDb({
      evidence: { livepark: SEVEN_CONVERSATIONS, 'live park': SEVEN_CONVERSATIONS },
    });

    const [idA, idB] = await Promise.all([
      resolveOrCreateProperty(db, 'acc-A', 'user-1', 'LivePark'),
      resolveOrCreateProperty(db, 'acc-B', 'user-1', 'Live Park'),
    ]);

    expect(idA).not.toBeNull();
    expect(idB).not.toBeNull();
    expect(idA).not.toBe(idB);
    expect(propertiesTable.rows).toHaveLength(2);
    expect(propertiesTable.rows.map((r) => r.account_id).sort()).toEqual(['acc-A', 'acc-B']);
  });

  it('F) genuinely different names ("Live Park" vs "Live Home") are never merged — 2 properties', async () => {
    const { db, propertiesTable } = makeDb({
      evidence: { 'live park': SEVEN_CONVERSATIONS, 'live home': SEVEN_CONVERSATIONS },
    });

    const [idPark, idHome] = await Promise.all([
      resolveOrCreateProperty(db, 'acc-1', 'user-1', 'Live Park'),
      resolveOrCreateProperty(db, 'acc-1', 'user-1', 'Live Home'),
    ]);

    expect(idPark).not.toBeNull();
    expect(idHome).not.toBeNull();
    expect(idPark).not.toBe(idHome);
    expect(propertiesTable.rows).toHaveLength(2);
    expect(propertiesTable.rows.map((r) => r.normalized_name).sort()).toEqual(['livehome', 'livepark']);
  });

  it('G) names that normalize to an empty string never collide with each other or return the wrong property_id', async () => {
    // Two genuinely different, unrelated names that both happen to
    // normalize to nothing (no Latin letters/digits at all). Even with
    // evidence pre-seeded under the shared blank key, getPropertyLearningEvidenceCount
    // (untouched by this fix) explicitly returns 0 for an empty
    // normalized name — so neither ever reaches the INSERT at all. This
    // is a stronger, pre-existing guard than "insert with normalized_name:
    // null and let the two rows coexist": nothing gets auto-created from
    // an unnormalizable name in the first place, so there is no
    // possibility of the two being confused with each other, and no
    // 23505/recovery path is ever exercised for them.
    const { db, propertiesTable } = makeDb({
      evidence: { '': SEVEN_CONVERSATIONS },
    });

    const [id1, id2] = await Promise.all([
      resolveOrCreateProperty(db, 'acc-1', 'user-1', '北京公寓'),
      resolveOrCreateProperty(db, 'acc-1', 'user-1', '🏢🏢🏢'),
    ]);

    expect(id1).toBeNull();
    expect(id2).toBeNull();
    expect(propertiesTable.rows).toHaveLength(0);
  });

  it('H) a 23505 recovered for a compact-form conflict returns the correct winner, not an unrelated property', async () => {
    const { db, propertiesTable } = makeDb({
      evidence: { livepark: SEVEN_CONVERSATIONS, 'live park': SEVEN_CONVERSATIONS, 'live home': SEVEN_CONVERSATIONS },
    });

    // A third, unrelated property already exists — the recovery lookup
    // must not accidentally return this one.
    await resolveOrCreateProperty(db, 'acc-1', 'user-1', 'Live Home');
    expect(propertiesTable.rows).toHaveLength(1);

    const [id1, id2] = await Promise.all([
      resolveOrCreateProperty(db, 'acc-1', 'user-1', 'LivePark'),
      resolveOrCreateProperty(db, 'acc-1', 'user-1', 'Live Park'),
    ]);

    expect(id1).toBe(id2);
    expect(id1).not.toBe(propertiesTable.rows.find((r) => r.normalized_name === 'livehome')?.id);
    expect(propertiesTable.rows).toHaveLength(2); // Live Home + the one LivePark/Live Park property
  });
});
