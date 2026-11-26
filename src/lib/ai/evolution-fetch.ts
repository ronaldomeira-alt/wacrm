import type { AiSuggestion } from '@/types';

export interface EvolutionLearningsResult {
  pending: AiSuggestion[];
  history: AiSuggestion[];
}

export type FetchLike = (input: string) => Promise<{
  ok: boolean;
  json: () => Promise<{ suggestions?: AiSuggestion[] }>;
}>;

const EVOLUTION_QUERY_LIMIT = 500;
const HISTORY_STATUSES = ['approved', 'rejected', 'ignored'] as const;

function dedupeById(items: AiSuggestion[]): AiSuggestion[] {
  const seen = new Set<string>();
  const result: AiSuggestion[] = [];
  for (const item of items) {
    if (!item?.id || seen.has(item.id)) continue;
    seen.add(item.id);
    result.push(item);
  }
  return result;
}

function sortTimestampDesc(a: AiSuggestion, b: AiSuggestion, preferResolved: boolean): number {
  const tsA = new Date(
    (preferResolved ? a.resolved_at : null) ?? a.created_at ?? 0,
  ).getTime();
  const tsB = new Date(
    (preferResolved ? b.resolved_at : null) ?? b.created_at ?? 0,
  ).getTime();
  return tsB - tsA;
}

/**
 * Fetches pending and historical `learning` suggestions in separate filtered
 * requests against `GET /api/ai/suggestions` so that >200 historical rows can
 * never crowd out older `pending` learnings from the Evolution dashboard.
 */
export async function fetchEvolutionLearnings(
  fetcher: FetchLike = (url) => fetch(url, { cache: 'no-store' }),
): Promise<EvolutionLearningsResult> {
  const pendingUrl = `/api/ai/suggestions?category=learning&status=pending&limit=${EVOLUTION_QUERY_LIMIT}`;
  const historyUrls = HISTORY_STATUSES.map(
    (status) =>
      `/api/ai/suggestions?category=learning&status=${status}&limit=${EVOLUTION_QUERY_LIMIT}`,
  );

  const [pendingRes, ...historyResList] = await Promise.all([
    fetcher(pendingUrl),
    ...historyUrls.map((url) => fetcher(url)),
  ]);

  const pendingJson: { suggestions?: AiSuggestion[] } = pendingRes.ok
    ? await pendingRes.json().catch(() => ({}))
    : {};
  const pendingRaw = Array.isArray(pendingJson.suggestions) ? pendingJson.suggestions : [];
  const pending = dedupeById(pendingRaw.filter((s) => s.status === 'pending')).sort((a, b) =>
    sortTimestampDesc(a, b, false),
  );

  const historyRaw: AiSuggestion[] = [];
  for (const res of historyResList) {
    if (!res.ok) continue;
    const json: { suggestions?: AiSuggestion[] } = await res.json().catch(() => ({}));
    if (Array.isArray(json.suggestions)) {
      historyRaw.push(...json.suggestions);
    }
  }
  const history = dedupeById(historyRaw.filter((s) => s.status !== 'pending')).sort((a, b) =>
    sortTimestampDesc(a, b, true),
  );

  return { pending, history };
}
