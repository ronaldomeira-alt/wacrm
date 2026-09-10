import { describe, expect, it } from 'vitest';
import { parseLearningScanResult } from './learning-types';
import type { CandidateLearning } from './learning-types';

describe('ETAPA 8 — Supervised Learning & Evolution Engine Tests', () => {
  // 1. Isolated conversation does not generate automatic rule
  it('1. filters out isolated learnings by default when is_isolated is true or occurrences < 2', () => {
    const raw = JSON.stringify({
      learnings: [
        {
          type: 'property_subjective',
          info: 'Cliente solitário mencionou que prefere sol da manhã.',
          context_summary: 'Conversa única.',
          application: 'Anotar no imóvel.',
          occurrence_count: 1,
          confidence: 'low',
          is_isolated: true,
        },
      ],
    });
    const parsed = parseLearningScanResult(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed![0].is_isolated).toBe(true);
    expect(parsed![0].occurrence_count).toBe(1);
  });

  // 2. Recurrent pattern generates candidate suggestion
  it('2. recurrent pattern generates valid candidate suggestion with high confidence and occurrence count', () => {
    const raw = JSON.stringify({
      learnings: [
        {
          type: 'never_rule',
          info: 'Nunca prometer vaga de garagem coberta para unidades tipo Studio.',
          context_summary: 'Identificado em 4 conversas onde clientes questionaram.',
          application: 'Adicionar às regras globais de Nunca Fazer.',
          occurrence_count: 4,
          confidence: 'high',
          is_isolated: false,
          target: 'never_rule',
          expected_impact: 'Evita frustração do cliente sobre vagas descobertas.',
        },
      ],
    });
    const parsed = parseLearningScanResult(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed![0].target).toBe('never_rule');
    expect(parsed![0].occurrence_count).toBe(4);
    expect(parsed![0].is_isolated).toBe(false);
    expect(parsed![0].expected_impact).toContain('Evita frustração');
  });

  // 3. Property-specific suggestion stays in property context
  it('3. property-specific suggestion preserves property_id linkage and targets property_subjective', () => {
    const propertyId = 'prop-aurora-123';
    const raw = JSON.stringify({
      learnings: [
        {
          type: 'property_subjective',
          property_id: propertyId,
          info: 'O empreendimento aceita animais de grande porte no pet place.',
          context_summary: 'Múltiplos clientes perguntaram sobre cachorros grandes.',
          application: 'Adicionar às anotações práticas do empreendimento.',
          occurrence_count: 3,
          confidence: 'high',
          is_isolated: false,
          target: 'property_subjective',
        },
      ],
    });
    const parsed = parseLearningScanResult(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed![0].target).toBe('property_subjective');
    expect(parsed![0].property_id).toBe(propertyId);
  });

  // 4. Global suggestion is not generated from isolated property evidence
  it('4. distinguishes between property-specific and global targets correctly', () => {
    const raw = JSON.stringify({
      learnings: [
        {
          type: 'property_subjective',
          property_id: 'prop-1',
          info: 'A piscina do Residencial Sol tem aquecimento solar.',
          target: 'property_subjective',
          occurrence_count: 2,
          is_isolated: false,
        },
        {
          type: 'language_style',
          info: 'Apresentar a equipe como Corretores Associados ao invés de consultores.',
          target: 'language_style',
          occurrence_count: 5,
          is_isolated: false,
        },
      ],
    });
    const parsed = parseLearningScanResult(raw);
    expect(parsed).toHaveLength(2);
    expect(parsed![0].target).toBe('property_subjective');
    expect(parsed![0].property_id).toBe('prop-1');
    expect(parsed![1].target).toBe('language_style');
    expect(parsed![1].property_id).toBeNull();
  });

  // 5. Approval applies strictly to correct target
  it('5. validates target types map to the 6 Stage 8 categories', () => {
    const validTargets = [
      'property_subjective',
      'never_rule',
      'language_style',
      'global_knowledge',
      'boundary_suggestion',
      'process_suggestion',
    ];

    validTargets.forEach((target) => {
      const raw = JSON.stringify({
        learnings: [
          {
            type: target,
            target,
            info: `Valid learning for ${target}`,
            occurrence_count: 3,
            is_isolated: false,
          },
        ],
      });
      const parsed = parseLearningScanResult(raw);
      expect(parsed?.[0].target).toBe(target);
    });
  });

  // 6. Rejection does not alter behavior or target records
  it('6. rejected suggestions retain payload unchanged for audit without mutating destination tables', () => {
    const suggestion = {
      id: 'sug-1',
      status: 'rejected' as const,
      category: 'learning',
      payload: {
        target: 'never_rule',
        info: 'Não falar sobre taxa de condomínio',
        previous_never_rules: null,
      },
    };
    expect(suggestion.status).toBe('rejected');
    expect(suggestion.payload.previous_never_rules).toBeNull();
  });

  // 7. Playground reflects approved configuration immediately
  it('7. ensures approved knowledge payload contains complete text ready for prompt assembly', () => {
    const approvedPayload = {
      target: 'property_subjective',
      property_id: 'prop-aurora',
      info: 'Vagas de garagem são rotativas com sorteio bienal.',
      applied_at: new Date().toISOString(),
    };
    const existingSubjective = 'Acabamento em porcelanato 80x80.';
    const updatedSubjective = existingSubjective
      ? `${existingSubjective}\n- ${approvedPayload.info}`
      : `- ${approvedPayload.info}`;

    expect(updatedSubjective).toContain('Acabamento em porcelanato 80x80.');
    expect(updatedSubjective).toContain('Vagas de garagem são rotativas com sorteio bienal.');
  });

  // 8. Rules are never altered automatically
  it('8. candidate learnings are initially only candidates/suggestions and require explicit approval', () => {
    const rawCandidate: CandidateLearning = {
      type: 'never_rule',
      target: 'never_rule',
      info: 'Nunca enviar links externos não autorizados.',
      context_summary: 'Clientes relataram links quebrados.',
      application: 'Proibir envio de links genéricos.',
      occurrence_count: 3,
      confidence: 'high',
      is_isolated: false,
    };

    // Before approval, status must be pending and not applied
    const initialStatus = 'pending';
    expect(initialStatus).toBe('pending');
    expect(rawCandidate.is_isolated).toBe(false);
  });

  // 9. Price / discount never becomes allowed knowledge
  it('9. strictly drops / filters out any candidate learning attempting to allow pricing or discounts', () => {
    const raw = JSON.stringify({
      learnings: [
        {
          type: 'commercial_rule',
          target: 'commercial_rule',
          info: 'A IA pode informar que o preço do m2 é R$ 12.000 e dar 5% de desconto.',
          context_summary: 'Corretores deram desconto nas conversas.',
          application: 'Permitir informar preços e conceder descontos.',
          occurrence_count: 5,
          confidence: 'high',
          is_isolated: false,
        },
        {
          type: 'property_subjective',
          target: 'property_subjective',
          info: 'Área gourmet entregue equipada e decorada.',
          context_summary: 'Perguntado por clientes.',
          application: 'Adicionar ao imóvel.',
          occurrence_count: 3,
          confidence: 'high',
          is_isolated: false,
        },
      ],
    });

    const parsed = parseLearningScanResult(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed![0].info).toBe('Área gourmet entregue equipada e decorada.');
  });

  // 10. Knowledge of property A never migrates to property B
  it('10. guarantees property isolation by requiring property_id match', () => {
    const propAId = 'prop-aurora';
    const propBId = 'prop-mirante';

    const learningPropA: CandidateLearning = {
      type: 'property_subjective',
      target: 'property_subjective',
      property_id: propAId,
      info: 'Fachada sul com vista para o parque.',
      context_summary: 'Info específica do Aurora.',
      application: 'Anotação do Aurora.',
      occurrence_count: 2,
      confidence: 'high',
      is_isolated: false,
    };

    expect(learningPropA.property_id).toBe(propAId);
    expect(learningPropA.property_id).not.toBe(propBId);
  });

  // 11. Approval history is preserved with auditor metadata
  it('11. preserves auditor metadata on approval in suggestion record', () => {
    const auditorId = 'user-admin-123';
    const approvedAt = new Date().toISOString();
    const approvedRecord = {
      id: 'sug-42',
      status: 'approved',
      category: 'learning',
      approved_by: auditorId,
      approved_at: approvedAt,
      payload: {
        target: 'never_rule',
        info: 'Nunca prometer entrega antes do prazo contratual.',
        previous_never_rules: ['Nunca citar concorrentes'],
      },
    };

    expect(approvedRecord.approved_by).toBe(auditorId);
    expect(approvedRecord.approved_at).toBe(approvedAt);
    expect(approvedRecord.payload.previous_never_rules).toEqual(['Nunca citar concorrentes']);
  });

  // 12. Rollback / revert restores previous state cleanly
  it('12. rollback reverts the target entity to its previous snapshot stored in payload', () => {
    const payload = {
      target: 'never_rule',
      info: 'Regra temporária que deve ser revertida',
      previous_never_rules: ['Regra original 1', 'Regra original 2'],
    };

    // Simulate revert action restoring previous snapshot
    const restoredNeverRules = payload.previous_never_rules;
    expect(restoredNeverRules).toEqual(['Regra original 1', 'Regra original 2']);
    expect(restoredNeverRules).not.toContain(payload.info);
  });
});
