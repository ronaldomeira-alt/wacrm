import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { consumeFollowupDraft, writeFollowupDraft } from './followup-draft';

describe('followup-draft handoff (Match & Follow-up)', () => {
  const store = new Map<string, string>();

  beforeEach(() => {
    store.clear();
    vi.stubGlobal('sessionStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('grava e consome rascunho de Match em operação one-shot por conversa', () => {
    writeFollowupDraft('conv-99', {
      mode: 'free',
      text: 'Oi Maria! Confira https://ronaldomeira.com.br/imovel/bessa-1',
      matchShare: {
        matchId: 'match-1',
        leadId: 'lead-1',
        propertyId: 'prop-1',
        propertyTitle: 'Live Park Bessa',
        publicUrl: 'https://ronaldomeira.com.br/imovel/bessa-1',
        alreadySentBefore: true,
        templateAngle: 'nova_opcao_comparativa',
      },
    });

    const firstRead = consumeFollowupDraft('conv-99');
    expect(firstRead?.mode).toBe('free');
    expect(firstRead?.matchShare?.propertyTitle).toBe('Live Park Bessa');
    expect(firstRead?.matchShare?.alreadySentBefore).toBe(true);

    // Uma recarga ou segundo acesso não pode reexibir o mesmo rascunho nem vazar para outra conversa
    expect(consumeFollowupDraft('conv-99')).toBeNull();
    expect(consumeFollowupDraft('conv-other')).toBeNull();
  });
});
