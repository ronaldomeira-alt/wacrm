import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const h = vi.hoisted(() => ({ embedTexts: vi.fn() }));
vi.mock('./embeddings', () => ({
  embedTexts: h.embedTexts,
  toVectorLiteral: (v: number[]) => `[${v.join(',')}]`,
}));

import {
  retrievePropertyKnowledge,
  replacePropertySubjectiveKnowledge,
} from './knowledge';

describe('Property Knowledge Isolation and Management', () => {
  beforeEach(() => {
    h.embedTexts.mockReset();
    h.embedTexts.mockImplementation(async (_key: string, inputs: string[]) =>
      inputs.map((_, i) => [i, i]),
    );
  });

  describe('retrievePropertyKnowledge', () => {
    it('returns empty list for empty query without calling RPC', async () => {
      const db = {
        rpc: vi.fn(),
        from: vi.fn(),
      } as unknown as SupabaseClient;

      const result = await retrievePropertyKnowledge(
        db,
        'acc-1',
        { embeddingsApiKey: null },
        'prop-1',
        '   ',
      );
      expect(result).toEqual({
        propertyChunks: [],
        globalChunks: [],
        allChunks: [],
        chunks: [],
      });
      expect(db.rpc).not.toHaveBeenCalled();
    });

    it('invokes match_property_ai_knowledge_semantic with target property_id when embeddings key is provided', async () => {
      const rpcMock = vi.fn().mockImplementation((name, args) => {
        if (name === 'match_property_ai_knowledge_semantic') {
          expect(args.p_property_id).toBe('prop-123');
          expect(args.p_account_id).toBe('acc-1');
          return Promise.resolve({
            data: [{ id: 'c1', content: 'Apartamento com vista para o mar' }],
            error: null,
          });
        }
        return Promise.resolve({ data: null, error: null });
      });

      const db = {
        rpc: rpcMock,
        from: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({ count: 10, error: null }),
            in: vi.fn().mockResolvedValue({ data: [], error: null }),
          }),
        }),
      } as unknown as SupabaseClient;

      const results = await retrievePropertyKnowledge(
        db,
        'acc-1',
        { embeddingsApiKey: 'sk-test' },
        'prop-123',
        'qual a vista?',
      );

      expect(results.propertyChunks).toEqual([
        '[Origem: Ficha Técnica]\nApartamento com vista para o mar',
      ]);
      expect(rpcMock).toHaveBeenCalledWith(
        'match_property_ai_knowledge_semantic',
        expect.objectContaining({
          p_property_id: 'prop-123',
          p_account_id: 'acc-1',
        }),
      );
    });

    it('falls back to match_property_ai_knowledge_fts when no embeddings key is present', async () => {
      const rpcMock = vi.fn().mockImplementation((name, args) => {
        if (name === 'match_property_ai_knowledge_fts') {
          expect(args.p_property_id).toBe('prop-456');
          return Promise.resolve({
            data: [{ id: 'f1', content: 'Sol da manhã na torre B' }],
            error: null,
          });
        }
        return Promise.resolve({ data: null, error: null });
      });

      const db = {
        rpc: rpcMock,
        from: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({ count: 5, error: null }),
            in: vi.fn().mockResolvedValue({ data: [], error: null }),
          }),
        }),
      } as unknown as SupabaseClient;

      const results = await retrievePropertyKnowledge(
        db,
        'acc-1',
        { embeddingsApiKey: null },
        'prop-456',
        'torre',
      );

      expect(results.propertyChunks).toEqual([
        '[Origem: Ficha Técnica]\nSol da manhã na torre B',
      ]);
      expect(rpcMock).toHaveBeenCalledWith(
        'match_property_ai_knowledge_fts',
        expect.objectContaining({
          p_property_id: 'prop-456',
        }),
      );
    });
  });

  describe('replacePropertySubjectiveKnowledge', () => {
    it('upserts property context and creates an isolated subjective document', async () => {
      const insertedDocs: Record<string, unknown>[] = [];
      const upsertedContexts: Record<string, unknown>[] = [];
      const deletedFilters: Record<string, unknown>[] = [];

      const db = {
        from: (table: string) => {
          if (table === 'property_ai_contexts') {
            return {
              upsert: (payload: Record<string, unknown>) => {
                upsertedContexts.push(payload);
                return Promise.resolve({ error: null });
              },
            };
          }
          if (table === 'ai_knowledge_documents') {
            return {
              delete: () => ({
                eq: (col1: string, val1: string) => ({
                  eq: (col2: string, val2: string) => ({
                    eq: (col3: string, val3: string) => {
                      deletedFilters.push({ [col1]: val1, [col2]: val2, [col3]: val3 });
                      return Promise.resolve({ error: null });
                    },
                  }),
                }),
              }),
              insert: (payload: Record<string, unknown>) => {
                insertedDocs.push(payload);
                return {
                  select: () => ({
                    single: () => Promise.resolve({ data: { id: 'doc-subj-1' }, error: null }),
                  }),
                };
              },
            };
          }
          if (table === 'ai_knowledge_chunks') {
            return {
              delete: () => ({
                eq: () => Promise.resolve({ error: null }),
              }),
              insert: () => Promise.resolve({ error: null }),
            };
          }
          return {};
        },
      } as unknown as SupabaseClient;

      await replacePropertySubjectiveKnowledge(
        db,
        'acc-1',
        { embeddingsApiKey: null },
        'prop-10',
        {
          subjectiveKnowledge: 'Vista excelente e ventilação cruzada',
          stage: 'pronto',
        },
      );

      expect(upsertedContexts.length).toBe(1);
      expect(upsertedContexts[0]).toMatchObject({
        property_id: 'prop-10',
        subjective_knowledge: 'Vista excelente e ventilação cruzada',
        stage: 'pronto',
      });

      expect(insertedDocs.length).toBe(1);
      expect(insertedDocs[0]).toMatchObject({
        property_id: 'prop-10',
        source_type: 'subjective_text',
        content: 'Vista excelente e ventilação cruzada',
      });
    });
  });
});
