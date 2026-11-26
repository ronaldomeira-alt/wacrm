import { describe, expect, it } from 'vitest';
import type { AiSuggestion } from '@/types';
import { fetchEvolutionLearnings, type FetchLike } from './evolution-fetch';

function makeLearning(
  id: string,
  status: AiSuggestion['status'],
  createdAtIso: string,
): AiSuggestion {
  return {
    id,
    account_id: 'acc-1',
    category: 'learning',
    status,
    title: `Learning ${id}`,
    description: null,
    contact_id: null,
    conversation_id: null,
    payload: { type: 'global_knowledge', info: `Info ${id}` },
    resolved_by: status === 'pending' ? null : 'user-1',
    resolved_at: status === 'pending' ? null : createdAtIso,
    snoozed_until: null,
    created_at: createdAtIso,
    updated_at: createdAtIso,
  } as unknown as AiSuggestion;
}

describe('fetchEvolutionLearnings (>200 historical rows must not hide pending learnings)', () => {
  it('retrieves all 192 older pending learnings even when 250 newer historical records exist', async () => {
    const dbRows: AiSuggestion[] = [];

    // 250 newer historical records (would completely fill an unfiltered limit=200 query)
    for (let i = 0; i < 250; i++) {
      const status = i % 3 === 0 ? 'approved' : i % 3 === 1 ? 'rejected' : 'ignored';
      dbRows.push(
        makeLearning(
          `hist-${i}`,
          status,
          new Date(Date.UTC(2026, 10, 25, 0, 0, i)).toISOString(),
        ),
      );
    }

    // 192 older pending learnings
    for (let i = 0; i < 192; i++) {
      dbRows.push(
        makeLearning(
          `pend-${i}`,
          'pending',
          new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString(),
        ),
      );
    }

    // Simulated GET /api/ai/suggestions endpoint honoring status, category and limit
    const mockFetcher: FetchLike = async (url) => {
      const parsed = new URL(url, 'http://localhost');
      const status = parsed.searchParams.get('status');
      const category = parsed.searchParams.get('category');
      const limit = Math.min(500, Math.max(1, Number(parsed.searchParams.get('limit')) || 200));

      const filtered = dbRows
        .filter((r) => (!category || r.category === category) && (!status || r.status === status))
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
        .slice(0, limit);

      return {
        ok: true,
        json: async () => ({ suggestions: filtered }),
      };
    };

    // Sanity check: the old unfiltered query (limit=200) would return 0 pending rows
    const oldRes = await mockFetcher('/api/ai/suggestions?category=learning');
    const oldData = await oldRes.json();
    expect(oldData.suggestions?.filter((s) => s.status === 'pending')).toHaveLength(0);

    // Fixed query: separates pending vs history and recovers all 192 pending + 250 history
    const { pending, history } = await fetchEvolutionLearnings(mockFetcher);
    expect(pending).toHaveLength(192);
    expect(history).toHaveLength(250);
    expect(new Set(pending.map((p) => p.id)).size).toBe(192);
    expect(new Set(history.map((h) => h.id)).size).toBe(250);
    expect(pending.every((p) => p.status === 'pending')).toBe(true);
    expect(history.every((h) => h.status !== 'pending')).toBe(true);
  });
});
