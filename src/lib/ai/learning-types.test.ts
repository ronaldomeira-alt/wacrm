import { describe, expect, it } from 'vitest';
import { parseLearningScanResult } from './learning-types';

describe('parseLearningScanResult', () => {
  it('parses a well-formed learnings array', () => {
    const raw = JSON.stringify({
      learnings: [
        {
          type: 'commercial_rule',
          info: 'Entrada de 20% é aceita para lançamentos.',
          context_summary: 'Mencionado em várias negociações.',
          application: 'Usar como referência ao negociar entrada.',
          occurrence_count: 3,
          confidence: 'high',
          is_isolated: false,
        },
      ],
    });
    const result = parseLearningScanResult(raw);
    expect(result).toHaveLength(1);
    expect(result?.[0]).toMatchObject({
      type: 'commercial_rule',
      info: 'Entrada de 20% é aceita para lançamentos.',
      occurrence_count: 3,
      confidence: 'high',
      is_isolated: false,
    });
  });

  it('also accepts a bare array (no wrapping object)', () => {
    const raw = JSON.stringify([{ info: 'x', is_isolated: false, confidence: 'high' }]);
    expect(parseLearningScanResult(raw)).toHaveLength(1);
  });

  it('drops an entry with no info', () => {
    const raw = JSON.stringify({ learnings: [{ is_isolated: false }] });
    expect(parseLearningScanResult(raw)).toEqual([]);
  });

  it('defaults an unknown type to "other" and unknown confidence to "low"', () => {
    const raw = JSON.stringify({
      learnings: [{ info: 'x', type: 'made_up', confidence: 'sure', is_isolated: false }],
    });
    const result = parseLearningScanResult(raw);
    expect(result?.[0].type).toBe('other');
    expect(result?.[0].confidence).toBe('low');
  });

  it('fails safe: an unclear is_isolated defaults to true (isolated)', () => {
    const raw = JSON.stringify({ learnings: [{ info: 'x', confidence: 'high' }] });
    expect(parseLearningScanResult(raw)?.[0].is_isolated).toBe(true);
  });

  it('returns an empty array (not null) when the model found nothing', () => {
    const raw = JSON.stringify({ learnings: [] });
    expect(parseLearningScanResult(raw)).toEqual([]);
  });

  it('returns null for unparseable output', () => {
    expect(parseLearningScanResult('not json')).toBeNull();
  });

  it('strips a markdown code fence', () => {
    const raw = '```json\n{"learnings":[]}\n```';
    expect(parseLearningScanResult(raw)).toEqual([]);
  });

  it('recovers JSON wrapped in prose commentary', () => {
    const raw = `Aqui está minha análise:\n${JSON.stringify({ learnings: [{ info: 'x', confidence: 'high', is_isolated: false }] })}\nEspero que ajude!`;
    const result = parseLearningScanResult(raw);
    expect(result).toHaveLength(1);
    expect(result?.[0].info).toBe('x');
  });

  it('salvages complete candidates from a response truncated mid-array by an output token limit', () => {
    // Simulates exactly the production failure (2026-09-18): the model
    // produced several complete objects, then got cut off mid-object.
    const raw =
      '{"learnings": [' +
      '{"type": "business_rule", "info": "Primeiro fato completo.", "confidence": "high", "is_isolated": false, "occurrence_count": 3},' +
      '{"type": "property_fact", "info": "Segundo fato completo.", "confidence": "high", "is_isolated": false, "occurrence_count": 2},' +
      '{"type": "property_fact", "info": "Terceiro fato truncado no me';
    const result = parseLearningScanResult(raw);
    expect(result).toHaveLength(2);
    expect(result?.[0].info).toBe('Primeiro fato completo.');
    expect(result?.[1].info).toBe('Segundo fato completo.');
  });

  it('returns null when even the first candidate is truncated (nothing to salvage)', () => {
    const raw = '{"learnings": [{"type": "business_rule", "info": "cortado no meio';
    expect(parseLearningScanResult(raw)).toBeNull();
  });

  it('carries through the new scoped-memory fields (ad_id, conversation_id, agent_name)', () => {
    const raw = JSON.stringify({
      learnings: [
        {
          type: 'ad_fact',
          info: 'Este anúncio divulga unidade de 21 m².',
          confidence: 'high',
          is_isolated: false,
          ad_id: '120250622441180493',
        },
        {
          type: 'client_preference',
          info: 'Cliente quer para Airbnb.',
          confidence: 'high',
          is_isolated: false,
          conversation_id: 'conv-123',
        },
        {
          type: 'language_style',
          info: 'Abre a conversa com "Joiaaaa".',
          confidence: 'high',
          is_isolated: false,
          agent_name: 'Ronaldo',
        },
      ],
    });
    const result = parseLearningScanResult(raw);
    expect(result?.[0].ad_id).toBe('120250622441180493');
    expect(result?.[1].conversation_id).toBe('conv-123');
    expect(result?.[2].agent_name).toBe('Ronaldo');
  });
});
