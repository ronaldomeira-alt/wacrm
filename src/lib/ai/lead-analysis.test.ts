import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findOrCreateTag: vi.fn(),
  findTag: vi.fn(),
  addContactTagAndDispatch: vi.fn(),
  removeContactTag: vi.fn(),
  sendQualifiedLeadEvent: vi.fn(),
}));

vi.mock('@/lib/contacts/tag-find-or-create', () => ({
  findOrCreateTag: mocks.findOrCreateTag,
  findTag: mocks.findTag,
}));
vi.mock('@/lib/contacts/tag-events', () => ({
  addContactTagAndDispatch: mocks.addContactTagAndDispatch,
}));
vi.mock('@/lib/contacts/tag-write', () => ({
  removeContactTag: mocks.removeContactTag,
}));
vi.mock('@/lib/whatsapp/meta-capi', () => ({
  sendQualifiedLeadEvent: mocks.sendQualifiedLeadEvent,
}));

import { applyLeadAnalysisResult } from './lead-analysis';
import { emptyLeadSummary, parseLeadAnalysisResult, type LeadAnalysisResult } from './lead-analysis-types';

// ------------------------------------------------------------
// Fake `ai_suggestions` table. Only the calls applyStageSuggestion
// actually makes: a select (dedupe/already-applied check), an update,
// or an insert.
// ------------------------------------------------------------
interface FakeSuggestionsDb {
  db: { from: (table: string) => unknown };
  calls: {
    insert: unknown[];
    update: { id: string; patch: unknown }[];
    contactUpdate: unknown[];
    dealUpdate: unknown[];
  };
}

function fakeDb(existingPending: { id: string; payload: unknown } | null = null): FakeSuggestionsDb {
  const calls: FakeSuggestionsDb['calls'] = { insert: [], update: [], contactUpdate: [], dealUpdate: [] };

  const db = {
    from(table: string) {
      if (table === 'contacts') {
        return {
          update(patch: unknown) {
            calls.contactUpdate.push(patch);
            return {
              eq() {
                return Promise.resolve({ data: null, error: null });
              },
            };
          },
        };
      }
      if (table === 'deals') {
        return {
          update(patch: unknown) {
            calls.dealUpdate.push(patch);
            return {
              eq() {
                return Promise.resolve({ data: { id: 'deal-1' }, error: null });
              },
            };
          },
        };
      }
      if (table !== 'ai_suggestions') {
        throw new Error(`unexpected table in test: ${table}`);
      }
      const builder = {
        select() {
          return builder;
        },
        eq() {
          return builder;
        },
        maybeSingle() {
          return Promise.resolve({ data: existingPending, error: null });
        },
        update(patch: unknown) {
          return {
            eq(_col: string, id: string) {
              calls.update.push({ id, patch });
              return Promise.resolve({ data: null, error: null });
            },
          };
        },
        insert(row: unknown) {
          calls.insert.push(row);
          return Promise.resolve({ data: null, error: null });
        },
      };
      return builder;
    },
  };

  return { db, calls };
}

const STAGES = [
  { id: 'stage-novo', name: 'Novo Lead' },
  { id: 'stage-qualificacao', name: 'Qualificação' },
  { id: 'stage-interesse', name: 'Interesse' },
  { id: 'stage-followup', name: 'Follow-up' },
];

function result(overrides: Partial<LeadAnalysisResult> = {}): LeadAnalysisResult {
  return {
    summary: emptyLeadSummary(),
    tag_changes: [],
    stage_suggestion: null,
    lead_score: null,
    ...overrides,
  };
}

const BASE_ARGS = {
  accountId: 'account-1',
  contactId: 'contact-1',
  conversationId: 'conversation-1',
};

beforeEach(() => {
  mocks.findOrCreateTag.mockReset().mockResolvedValue('tag-x');
  mocks.findTag.mockReset().mockResolvedValue('tag-x');
  mocks.addContactTagAndDispatch.mockReset().mockResolvedValue({ added: true, dispatched: true });
  mocks.removeContactTag.mockReset().mockResolvedValue(undefined);
  mocks.sendQualifiedLeadEvent.mockReset().mockResolvedValue({ sent: true });
});

describe('applyLeadAnalysisResult — tags (section 19.1/19.2/19.3)', () => {
  it('scenario 1: adds purpose + property type + location tags from a clear statement', async () => {
    const { db } = fakeDb();
    await applyLeadAnalysisResult({
      db: db as never,
      ...BASE_ARGS,
      deal: null,
      stages: [],
      result: result({
        tag_changes: [
          { category: 'Finalidade', name: 'Investimento', action: 'add', confidence: 'high' },
          { category: 'Tipo de imóvel', name: 'Flat', action: 'add', confidence: 'high' },
          { category: 'Bairro', name: 'Bessa', action: 'add', confidence: 'high' },
          { category: 'Faixa de valor', name: 'R$300–400 mil', action: 'add', confidence: 'high' },
        ],
      }),
    });

    expect(mocks.findOrCreateTag).toHaveBeenCalledTimes(4);
    expect(mocks.addContactTagAndDispatch).toHaveBeenCalledTimes(4);
    expect(mocks.findOrCreateTag).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ category: 'Bairro', name: 'Bessa' }),
    );
  });

  it('scenario 2: removes a retracted preference and adds the new one', async () => {
    const { db } = fakeDb();
    await applyLeadAnalysisResult({
      db: db as never,
      ...BASE_ARGS,
      deal: null,
      stages: [],
      result: result({
        tag_changes: [
          { category: 'Bairro', name: 'Bessa', action: 'remove', confidence: 'high' },
          { category: 'Bairro', name: 'Cabo Branco', action: 'add', confidence: 'high' },
        ],
      }),
    });

    expect(mocks.findTag).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ name: 'Bessa' }),
    );
    expect(mocks.removeContactTag).toHaveBeenCalledTimes(1);
    expect(mocks.findOrCreateTag).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ name: 'Cabo Branco' }),
    );
    expect(mocks.addContactTagAndDispatch).toHaveBeenCalledTimes(1);
  });

  it('scenario 3: keeps both purposes when the lead wants both', async () => {
    const { db } = fakeDb();
    await applyLeadAnalysisResult({
      db: db as never,
      ...BASE_ARGS,
      deal: null,
      stages: [],
      result: result({
        tag_changes: [
          { category: 'Finalidade', name: 'Moradia', action: 'add', confidence: 'high' },
          { category: 'Finalidade', name: 'Investimento', action: 'add', confidence: 'high' },
        ],
      }),
    });

    expect(mocks.addContactTagAndDispatch).toHaveBeenCalledTimes(2);
  });

  it('scenario 6: does nothing when there is no evidence', async () => {
    const { db, calls } = fakeDb();
    await applyLeadAnalysisResult({
      db: db as never,
      ...BASE_ARGS,
      deal: null,
      stages: [],
      result: result(),
    });

    expect(mocks.findOrCreateTag).not.toHaveBeenCalled();
    expect(mocks.addContactTagAndDispatch).not.toHaveBeenCalled();
    expect(mocks.removeContactTag).not.toHaveBeenCalled();
    expect(calls.insert).toHaveLength(0);
    expect(calls.update).toHaveLength(0);
    expect(calls.contactUpdate).toHaveLength(0);
  });

  it('section 3: skips a low-confidence tag change', async () => {
    const { db } = fakeDb();
    await applyLeadAnalysisResult({
      db: db as never,
      ...BASE_ARGS,
      deal: null,
      stages: [],
      result: result({
        tag_changes: [
          { category: 'Bairro', name: 'Talvez Bessa', action: 'add', confidence: 'low' },
        ],
      }),
    });

    expect(mocks.findOrCreateTag).not.toHaveBeenCalled();
    expect(mocks.addContactTagAndDispatch).not.toHaveBeenCalled();
  });

  it('ignores a tag change in a category the model invented', async () => {
    const { db } = fakeDb();
    await applyLeadAnalysisResult({
      db: db as never,
      ...BASE_ARGS,
      deal: null,
      stages: [],
      result: result({
        tag_changes: [
          { category: 'Não Existe', name: 'Qualquer coisa', action: 'add', confidence: 'high' },
        ],
      }),
    });

    expect(mocks.findOrCreateTag).not.toHaveBeenCalled();
  });
});

describe('applyLeadAnalysisResult — pipeline_move suggestions (section 19.4-19.7)', () => {
  // ── Scenario 4 (updated): auto-move transitions no longer produce suggestions ──
  // Qualificação → Interesse is now handled by auto-progression; a pending
  // suggestion must NOT be created regardless of score, because these moves
  // now appear in Central de IA only as auto-executed history (status: done),
  // never as pending cards awaiting human action.
  it('scenario 4a: does NOT create a suggestion for Qualificação → Interesse (insufficient ai_score)', async () => {
    const { db, calls } = fakeDb();
    await applyLeadAnalysisResult({
      db: db as never,
      ...BASE_ARGS,
      deal: { id: 'deal-1', stage_id: 'stage-qualificacao' },
      stages: STAGES,
      currentAiScore: 5, // below minAiScore 7 for this transition
      result: result({
        stage_suggestion: {
          should_suggest: true,
          target_stage_name: 'Interesse',
          justification: 'Perguntou o preço e disse que gostou do imóvel.',
          score: 87,
        },
      }),
    });

    // Score insufficient → silent skip; no pending suggestion, no auto-move
    expect(calls.insert).toHaveLength(0);
    expect(calls.dealUpdate).toHaveLength(0);
    expect(mocks.sendQualifiedLeadEvent).not.toHaveBeenCalled();
  });

  it('scenario 4b: auto-moves Qualificação → Interesse when ai_score qualifies', async () => {
    const { db, calls } = fakeDb();
    await applyLeadAnalysisResult({
      db: db as never,
      ...BASE_ARGS,
      deal: { id: 'deal-1', stage_id: 'stage-qualificacao' },
      stages: STAGES,
      currentAiScore: 8, // ≥ minAiScore 7 → auto-move
      result: result({
        stage_suggestion: {
          should_suggest: true,
          target_stage_name: 'Interesse',
          justification: 'Solicitou simulação de financiamento.',
          score: 87,
        },
      }),
    });

    // Auto-move executed; no pending suggestion in Central de IA. The
    // Meta QualifiedLead signal is a separate concern now (see the
    // dedicated describe block below) — currentAiScore: 8 here means the
    // lead was already qualified before this batch, so no fresh
    // crossing, so no CAPI assertion belongs in this pipeline-focused test.
    expect(calls.dealUpdate).toHaveLength(1);
    expect(calls.dealUpdate[0]).toMatchObject({ stage_id: 'stage-interesse' });
    expect(calls.insert).toHaveLength(0);
  });

  it('scenario 4c: auto-moves Qualificação → Interesse using freshly-computed lead_score over currentAiScore', async () => {
    const { db, calls } = fakeDb();
    await applyLeadAnalysisResult({
      db: db as never,
      ...BASE_ARGS,
      deal: { id: 'deal-1', stage_id: 'stage-qualificacao' },
      stages: STAGES,
      currentAiScore: 5, // would be insufficient on its own
      result: result({
        lead_score: { value: 9, reason: 'Agendou visita.' }, // freshly-computed wins
        stage_suggestion: {
          should_suggest: true,
          target_stage_name: 'Interesse',
          justification: 'Agendou visita ao imóvel.',
          score: 92,
        },
      }),
    });

    expect(calls.dealUpdate).toHaveLength(1);
    expect(calls.insert).toHaveLength(0);
  });

  it('auto-moves Novo Lead → Qualificação when ai_score ≥ 3 and AI has evidence', async () => {
    const { db, calls } = fakeDb();
    await applyLeadAnalysisResult({
      db: db as never,
      ...BASE_ARGS,
      deal: { id: 'deal-1', stage_id: 'stage-novo' },
      stages: STAGES,
      currentAiScore: 4, // ≥ minAiScore 3
      result: result({
        stage_suggestion: {
          should_suggest: true,
          target_stage_name: 'Qualificação',
          justification: 'Informou bairro e número de quartos desejados.',
          score: 75,
        },
      }),
    });

    expect(calls.dealUpdate).toHaveLength(1);
    expect(calls.dealUpdate[0]).toMatchObject({ stage_id: 'stage-qualificacao' });
    expect(calls.insert).toHaveLength(0);
    // Qualificação isn't this account's "lead qualificado" definition — only
    // landing in Interesse is. No CAPI event for this transition.
    expect(mocks.sendQualifiedLeadEvent).not.toHaveBeenCalled();
  });

  it('does NOT auto-move Novo Lead → Qualificação when ai_score is too low', async () => {
    const { db, calls } = fakeDb();
    await applyLeadAnalysisResult({
      db: db as never,
      ...BASE_ARGS,
      deal: { id: 'deal-1', stage_id: 'stage-novo' },
      stages: STAGES,
      currentAiScore: 2, // < minAiScore 3
      result: result({
        stage_suggestion: {
          should_suggest: true,
          target_stage_name: 'Qualificação',
          justification: 'Sinal fraco.',
          score: 65,
        },
      }),
    });

    expect(calls.dealUpdate).toHaveLength(0);
    expect(calls.insert).toHaveLength(0);
  });

  it('auto-moves Novo Lead → Interesse directly when ai_score ≥ 7', async () => {
    const { db, calls } = fakeDb();
    await applyLeadAnalysisResult({
      db: db as never,
      ...BASE_ARGS,
      deal: { id: 'deal-1', stage_id: 'stage-novo' },
      stages: STAGES,
      currentAiScore: 8,
      result: result({
        stage_suggestion: {
          should_suggest: true,
          target_stage_name: 'Interesse',
          justification: 'Pediu simulação de financiamento na primeira mensagem.',
          score: 88,
        },
      }),
    });

    expect(calls.dealUpdate).toHaveLength(1);
    expect(calls.dealUpdate[0]).toMatchObject({ stage_id: 'stage-interesse' });
    expect(calls.insert).toHaveLength(0);
  });

  it('resolves a stale pending suggestion when auto-moving', async () => {
    const { db, calls } = fakeDb({ id: 'stale-sugg', payload: { to_stage_id: 'stage-interesse' } });
    await applyLeadAnalysisResult({
      db: db as never,
      ...BASE_ARGS,
      deal: { id: 'deal-1', stage_id: 'stage-qualificacao' },
      stages: STAGES,
      currentAiScore: 8,
      result: result({
        stage_suggestion: {
          should_suggest: true,
          target_stage_name: 'Interesse',
          justification: 'Solicitou proposta formal.',
          score: 90,
        },
      }),
    });

    expect(calls.dealUpdate).toHaveLength(1);
    // Stale pending suggestion must be resolved as done
    expect(calls.update).toHaveLength(1);
    expect(calls.update[0]).toMatchObject({ id: 'stale-sugg', patch: { status: 'done' } });
    expect(calls.insert).toHaveLength(0);
  });

  it('scenario 5: keeps suggestion flow for Follow-up (not automated)', async () => {
    const { db, calls } = fakeDb();
    await applyLeadAnalysisResult({
      db: db as never,
      ...BASE_ARGS,
      deal: { id: 'deal-1', stage_id: 'stage-qualificacao' },
      stages: STAGES,
      result: result({
        stage_suggestion: {
          should_suggest: true,
          target_stage_name: 'Follow-up',
          justification: 'Vai vender o imóvel atual antes de decidir.',
          score: 70,
        },
      }),
    });

    // Follow-up is NOT an auto-move transition → creates pending suggestion for human review
    expect(calls.insert).toHaveLength(1);
    const inserted = calls.insert[0] as Record<string, unknown>;
    expect((inserted.payload as Record<string, unknown>).to_stage_name).toBe('Follow-up');
    expect(calls.dealUpdate).toHaveLength(0);
  });

  it('scenario 7: does not duplicate a suggestion for a lead already correctly staged', async () => {
    const { db, calls } = fakeDb();
    await applyLeadAnalysisResult({
      db: db as never,
      ...BASE_ARGS,
      deal: { id: 'deal-1', stage_id: 'stage-interesse' },
      stages: STAGES,
      result: result({
        stage_suggestion: {
          should_suggest: true,
          target_stage_name: 'Interesse',
          justification: 'Continua demonstrando interesse.',
          score: 92,
        },
      }),
    });

    expect(calls.insert).toHaveLength(0);
    expect(calls.update).toHaveLength(0);
  });

  it('section 7: auto-resolves a stale pending suggestion once the lead is already at the suggested stage', async () => {
    const { db, calls } = fakeDb({
      id: 'sugg-1',
      payload: { to_stage_id: 'stage-interesse' },
    });
    await applyLeadAnalysisResult({
      db: db as never,
      ...BASE_ARGS,
      deal: { id: 'deal-1', stage_id: 'stage-interesse' },
      stages: STAGES,
      result: result({
        stage_suggestion: {
          should_suggest: true,
          target_stage_name: 'Interesse',
          justification: null,
          score: 90,
        },
      }),
    });

    expect(calls.update).toHaveLength(1);
    expect(calls.update[0]).toMatchObject({ id: 'sugg-1', patch: { status: 'done' } });
  });

  it('section 7: updates an existing pending Follow-up suggestion instead of creating a second one', async () => {
    // For non-auto-move transitions (Follow-up), the existing dedup logic must
    // still update the existing pending suggestion rather than inserting a new one.
    const { db, calls } = fakeDb({ id: 'sugg-1', payload: { to_stage_id: 'stage-followup' } });
    await applyLeadAnalysisResult({
      db: db as never,
      ...BASE_ARGS,
      deal: { id: 'deal-1', stage_id: 'stage-qualificacao' },
      stages: STAGES,
      result: result({
        stage_suggestion: {
          should_suggest: true,
          target_stage_name: 'Follow-up',
          justification: 'Continua aguardando venda do imóvel atual.',
          score: 72,
        },
      }),
    });

    expect(calls.insert).toHaveLength(0);
    expect(calls.update).toHaveLength(1);
    expect(calls.update[0].id).toBe('sugg-1');
  });

  it('section 8: does not create a suggestion below the minimum score', async () => {
    const { db, calls } = fakeDb();
    await applyLeadAnalysisResult({
      db: db as never,
      ...BASE_ARGS,
      deal: { id: 'deal-1', stage_id: 'stage-qualificacao' },
      stages: STAGES,
      result: result({
        stage_suggestion: {
          should_suggest: true,
          target_stage_name: 'Interesse',
          justification: 'Sinal fraco.',
          score: 55,
        },
      }),
    });

    expect(calls.insert).toHaveLength(0);
  });

  it('never suggests a stage the pipeline does not actually have', async () => {
    const { db, calls } = fakeDb();
    await applyLeadAnalysisResult({
      db: db as never,
      ...BASE_ARGS,
      deal: { id: 'deal-1', stage_id: 'stage-qualificacao' },
      stages: STAGES,
      result: result({
        stage_suggestion: {
          should_suggest: true,
          target_stage_name: 'Etapa Inventada',
          justification: null,
          score: 95,
        },
      }),
    });

    expect(calls.insert).toHaveLength(0);
  });

  it('Interesse stage is never auto-moved backward — suggestion created for human review', async () => {
    // Backward moves are not in PIPELINE_AUTO_MOVE_RULES, so they fall through
    // to the existing human-approval suggestion flow (the AI rarely suggests
    // backward, but when it does we surface it as a normal suggestion, not a
    // silent skip, so agents can review).
    const { db, calls } = fakeDb();
    await applyLeadAnalysisResult({
      db: db as never,
      ...BASE_ARGS,
      deal: { id: 'deal-1', stage_id: 'stage-interesse' },
      stages: STAGES,
      currentAiScore: 9,
      result: result({
        stage_suggestion: {
          should_suggest: true,
          target_stage_name: 'Qualificação',
          justification: 'Lead disse que precisa repensar.',
          score: 65,
        },
      }),
    });

    // Not an auto-move transition → no auto-move; creates a pending suggestion
    expect(calls.dealUpdate).toHaveLength(0);
    expect(calls.insert).toHaveLength(1);
    const inserted = calls.insert[0] as Record<string, unknown>;
    expect((inserted.payload as Record<string, unknown>).to_stage_name).toBe('Qualificação');
  });

  it('does nothing when the lead has no deal, even with a strong signal', async () => {
    const { calls, db } = fakeDb();
    await applyLeadAnalysisResult({
      db: db as never,
      ...BASE_ARGS,
      deal: null,
      stages: [],
      result: result({
        stage_suggestion: {
          should_suggest: true,
          target_stage_name: 'Interesse',
          justification: null,
          score: 95,
        },
      }),
    });

    expect(calls.insert).toHaveLength(0);
  });
});

// ============================================================
// QualifiedLead → Meta Conversions API signal — independent of pipeline
// stage (business rule change: ai_score crossing 7 is the whole trigger,
// no auto-move / no stage_suggestion confidence required). See
// applyQualifiedLeadSignal in lead-analysis.ts.
// ============================================================
describe('applyLeadAnalysisResult — QualifiedLead Meta signal (independent of pipeline)', () => {
  it('1. score 6 → não envia', async () => {
    const { db } = fakeDb();
    await applyLeadAnalysisResult({
      db: db as never,
      ...BASE_ARGS,
      deal: { id: 'deal-1', stage_id: 'stage-novo' },
      stages: STAGES,
      currentAiScore: 0,
      result: result({ lead_score: { value: 6, reason: 'Ainda em pesquisa.' } }),
    });

    expect(mocks.sendQualifiedLeadEvent).not.toHaveBeenCalled();
  });

  it('2. score 7 → envia', async () => {
    const { db } = fakeDb();
    await applyLeadAnalysisResult({
      db: db as never,
      ...BASE_ARGS,
      deal: { id: 'deal-1', stage_id: 'stage-novo' },
      stages: STAGES,
      currentAiScore: 5,
      result: result({ lead_score: { value: 7, reason: 'Pediu simulação de financiamento.' } }),
    });

    expect(mocks.sendQualifiedLeadEvent).toHaveBeenCalledTimes(1);
    expect(mocks.sendQualifiedLeadEvent).toHaveBeenCalledWith(db, BASE_ARGS.accountId, BASE_ARGS.conversationId);
  });

  it('3. score 8 após já estar em 7 → não duplica', async () => {
    const { db } = fakeDb();
    await applyLeadAnalysisResult({
      db: db as never,
      ...BASE_ARGS,
      deal: { id: 'deal-1', stage_id: 'stage-novo' },
      stages: STAGES,
      currentAiScore: 7, // already qualified as of the prior batch
      result: result({ lead_score: { value: 8, reason: 'Continua engajado.' } }),
    });

    expect(mocks.sendQualifiedLeadEvent).not.toHaveBeenCalled();
  });

  it('4. score 9 após já estar em 8 → não duplica', async () => {
    const { db } = fakeDb();
    await applyLeadAnalysisResult({
      db: db as never,
      ...BASE_ARGS,
      deal: { id: 'deal-1', stage_id: 'stage-novo' },
      stages: STAGES,
      currentAiScore: 8, // already qualified as of the prior batch
      result: result({ lead_score: { value: 9, reason: 'Pediu proposta formal.' } }),
    });

    expect(mocks.sendQualifiedLeadEvent).not.toHaveBeenCalled();
  });

  it('5. lead em Novo Lead + score 7 → envia', async () => {
    const { db } = fakeDb();
    await applyLeadAnalysisResult({
      db: db as never,
      ...BASE_ARGS,
      deal: { id: 'deal-1', stage_id: 'stage-novo' },
      stages: STAGES,
      currentAiScore: 2,
      result: result({ lead_score: { value: 7, reason: 'Intenção forte logo na primeira mensagem.' } }),
    });

    expect(mocks.sendQualifiedLeadEvent).toHaveBeenCalledTimes(1);
  });

  it('6. lead em Qualificação + score 7 → envia', async () => {
    const { db } = fakeDb();
    await applyLeadAnalysisResult({
      db: db as never,
      ...BASE_ARGS,
      deal: { id: 'deal-1', stage_id: 'stage-qualificacao' },
      stages: STAGES,
      currentAiScore: 5,
      result: result({ lead_score: { value: 7, reason: 'Perguntou sobre financiamento.' } }),
    });

    expect(mocks.sendQualifiedLeadEvent).toHaveBeenCalledTimes(1);
  });

  it('7. lead em Interesse + score 7 → envia', async () => {
    const { db } = fakeDb();
    await applyLeadAnalysisResult({
      db: db as never,
      ...BASE_ARGS,
      deal: { id: 'deal-1', stage_id: 'stage-interesse' },
      stages: STAGES,
      currentAiScore: 6,
      result: result({ lead_score: { value: 7, reason: 'Pediu para agendar visita.' } }),
    });

    expect(mocks.sendQualifiedLeadEvent).toHaveBeenCalledTimes(1);
  });

  it('8. score 7 sem stage_suggestion / sem mudança de estágio → envia', async () => {
    const { db, calls } = fakeDb();
    await applyLeadAnalysisResult({
      db: db as never,
      ...BASE_ARGS,
      deal: { id: 'deal-1', stage_id: 'stage-novo' },
      stages: STAGES,
      currentAiScore: 3,
      // stage_suggestion is null (default) — no pipeline move happens at all.
      result: result({ lead_score: { value: 7, reason: 'Perguntou condições de pagamento.' } }),
    });

    expect(calls.dealUpdate).toHaveLength(0);
    expect(mocks.sendQualifiedLeadEvent).toHaveBeenCalledTimes(1);
  });

  it('9. confiança do stage_suggestion abaixo de 60 + score 7 → envia mesmo assim', async () => {
    const { db, calls } = fakeDb();
    await applyLeadAnalysisResult({
      db: db as never,
      ...BASE_ARGS,
      deal: { id: 'deal-1', stage_id: 'stage-novo' },
      stages: STAGES,
      currentAiScore: 4,
      result: result({
        lead_score: { value: 7, reason: 'Perguntou disponibilidade e preço.' },
        stage_suggestion: {
          should_suggest: true,
          target_stage_name: 'Interesse',
          justification: 'Sinal moderado, não decisivo pro pipeline.',
          score: 40, // below STAGE_SUGGESTION_MIN_SCORE (60) — pipeline move must NOT happen
        },
      }),
    });

    // The Meta signal fires regardless of the pipeline's own confidence gate.
    expect(calls.dealUpdate).toHaveLength(0);
    expect(mocks.sendQualifiedLeadEvent).toHaveBeenCalledTimes(1);
  });

  it('10. falha da Meta não quebra o restante do pipeline', async () => {
    mocks.sendQualifiedLeadEvent.mockRejectedValueOnce(new Error('Graph API down'));
    const { db, calls } = fakeDb();

    await expect(
      applyLeadAnalysisResult({
        db: db as never,
        ...BASE_ARGS,
        deal: { id: 'deal-1', stage_id: 'stage-qualificacao' },
        stages: STAGES,
        currentAiScore: 5,
        result: result({
          lead_score: { value: 7, reason: 'Pediu proposta.' },
          stage_suggestion: {
            should_suggest: true,
            target_stage_name: 'Interesse',
            justification: 'Solicitou proposta formal.',
            score: 90,
          },
        }),
      }),
    ).resolves.toBeUndefined();

    // The pipeline auto-move is a separate concern and must complete
    // regardless of the Meta call's outcome.
    expect(calls.dealUpdate).toHaveLength(1);
    expect(calls.dealUpdate[0]).toMatchObject({ stage_id: 'stage-interesse' });
    expect(mocks.sendQualifiedLeadEvent).toHaveBeenCalledTimes(1);
  });

  it('11. retry (mesmo score ainda não persistido) → mesma identidade de evento, não uma nova qualificação', async () => {
    const { db } = fakeDb();
    const args = {
      db: db as never,
      ...BASE_ARGS,
      deal: { id: 'deal-1', stage_id: 'stage-novo' },
      stages: STAGES,
      currentAiScore: 5, // simulates the score never having been persisted between attempts
      result: result({ lead_score: { value: 7, reason: 'Pediu simulação.' } }),
    };

    await applyLeadAnalysisResult(args);
    await applyLeadAnalysisResult(args); // same batch reprocessed (webhook redelivery, crash-retry, etc.)

    // lead-analysis.ts does not itself block the second attempt — that's
    // deliberate (see the file-level comment on applyQualifiedLeadSignal).
    // What guarantees Meta only ever counts ONE QualifiedLead is that both
    // calls target the exact same (db, accountId, conversationId), which
    // meta-capi.ts turns into the same deterministic event_id
    // (`qualified-lead:<conversationId>`) every time — proven separately
    // in meta-capi.test.ts's "deterministic event_id ... stable across
    // calls" test.
    expect(mocks.sendQualifiedLeadEvent).toHaveBeenCalledTimes(2);
    expect(mocks.sendQualifiedLeadEvent).toHaveBeenNthCalledWith(1, db, BASE_ARGS.accountId, BASE_ARGS.conversationId);
    expect(mocks.sendQualifiedLeadEvent).toHaveBeenNthCalledWith(2, db, BASE_ARGS.accountId, BASE_ARGS.conversationId);
  });

  it('primeira análise já com score >= 7 (sem observação anterior) → envia', async () => {
    const { db } = fakeDb();
    await applyLeadAnalysisResult({
      db: db as never,
      ...BASE_ARGS,
      deal: { id: 'deal-1', stage_id: 'stage-novo' },
      stages: STAGES,
      // currentAiScore omitted entirely — mirrors a brand-new contact
      // (dispatchInboundToLeadAnalysis defaults contacts.ai_score ?? 0).
      result: result({ lead_score: { value: 8, reason: 'Já chegou pedindo proposta e visita.' } }),
    });

    expect(mocks.sendQualifiedLeadEvent).toHaveBeenCalledTimes(1);
  });
});

describe('applyLeadAnalysisResult — lead_score (Score IA, migration 082)', () => {
  it('writes ai_score/ai_score_reason/ai_score_updated_at when the model returns a lead_score', async () => {
    const { db, calls } = fakeDb();
    await applyLeadAnalysisResult({
      db: db as never,
      ...BASE_ARGS,
      deal: null,
      stages: [],
      result: result({
        lead_score: { value: 7, reason: 'Pediu simulação e confirmou orçamento de R$500 mil.' },
      }),
    });

    expect(calls.contactUpdate).toHaveLength(1);
    expect(calls.contactUpdate[0]).toMatchObject({
      ai_score: 7,
      ai_score_reason: 'Pediu simulação e confirmou orçamento de R$500 mil.',
    });
  });

  it('does not touch contacts when the model returns no lead_score', async () => {
    const { db, calls } = fakeDb();
    await applyLeadAnalysisResult({
      db: db as never,
      ...BASE_ARGS,
      deal: null,
      stages: [],
      result: result(),
    });

    expect(calls.contactUpdate).toHaveLength(0);
  });
});

describe('parseLeadAnalysisResult', () => {
  it('parses a well-formed JSON response', () => {
    const raw = JSON.stringify({
      summary: { purpose: ['investimento'] },
      tag_changes: [{ category: 'Finalidade', name: 'Investimento', action: 'add', confidence: 'high' }],
      stage_suggestion: { should_suggest: false },
    });
    const parsed = parseLeadAnalysisResult(raw);
    expect(parsed?.summary.purpose).toEqual(['investimento']);
    expect(parsed?.tag_changes).toHaveLength(1);
    expect(parsed?.stage_suggestion).toEqual({
      should_suggest: false,
      target_stage_name: null,
      justification: null,
      score: null,
    });
  });

  it('strips a markdown code fence around the JSON', () => {
    const raw = '```json\n{"summary":{},"tag_changes":[],"stage_suggestion":null}\n```';
    expect(parseLeadAnalysisResult(raw)).not.toBeNull();
  });

  it('returns null for unparseable output instead of throwing', () => {
    expect(parseLeadAnalysisResult('the model said something weird')).toBeNull();
  });

  it('defaults an invalid confidence to low', () => {
    const raw = JSON.stringify({
      tag_changes: [{ category: 'Bairro', name: 'X', action: 'add', confidence: 'super-sure' }],
    });
    expect(parseLeadAnalysisResult(raw)?.tag_changes[0].confidence).toBe('low');
  });

  it('drops a stage_suggestion missing a target or score even if should_suggest is true', () => {
    const raw = JSON.stringify({ stage_suggestion: { should_suggest: true } });
    expect(parseLeadAnalysisResult(raw)?.stage_suggestion?.should_suggest).toBe(false);
  });

  it('parses and clamps lead_score to an integer 0-10', () => {
    const raw = JSON.stringify({ lead_score: { value: 12.6, reason: 'Pediu visita.' } });
    expect(parseLeadAnalysisResult(raw)?.lead_score).toEqual({ value: 10, reason: 'Pediu visita.' });
  });

  it('returns lead_score null when absent', () => {
    expect(parseLeadAnalysisResult('{}')?.lead_score).toBeNull();
  });
});
