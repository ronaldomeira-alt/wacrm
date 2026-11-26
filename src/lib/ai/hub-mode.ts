/**
 * Runtime UI mode resolver for the AI Central unification rollback mechanism.
 *
 * Unlike `NEXT_PUBLIC_*` variables (which are inlined at build time and
 * require a rebuild to flip), reading a server-side env var (`UNIFIED_AI_HUB_ENABLED`)
 * inside a `force-dynamic` Server Component allows instant runtime rollback
 * without rebuilding or touching the database.
 */
export type AiHubUiMode = 'unified' | 'legacy';

export interface ResolveAiHubUiModeInput {
  /** Server runtime env var (`process.env.UNIFIED_AI_HUB_ENABLED`). */
  envValue?: string | null;
  /** Optional explicit query param (`?ui=legacy` or `?ui=unified`) for preview/verification. */
  queryOverride?: string | null;
  /** Default mode when env var is unset ('legacy' in Stage 2, 'unified' in Stage 3). */
  defaultMode?: AiHubUiMode;
}

export function resolveAiHubUiMode({
  envValue,
  queryOverride,
  defaultMode = 'legacy',
}: ResolveAiHubUiModeInput = {}): AiHubUiMode {
  const normalizedQuery = queryOverride?.trim().toLowerCase();
  if (normalizedQuery === 'legacy') return 'legacy';
  if (normalizedQuery === 'unified') return 'unified';

  const normalizedEnv = envValue?.trim().toLowerCase();
  if (normalizedEnv === 'false' || normalizedEnv === '0' || normalizedEnv === 'legacy') {
    return 'legacy';
  }
  if (normalizedEnv === 'true' || normalizedEnv === '1' || normalizedEnv === 'unified') {
    return 'unified';
  }

  return defaultMode;
}
