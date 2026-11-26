import { UnifiedAiHub } from '@/components/agents/unified-ai-hub';
import { LegacyAiHub } from '@/components/agents/legacy-ai-hub';
import { resolveAiHubUiMode } from '@/lib/ai/hub-mode';

// Dynamic rendering evaluates `UNIFIED_AI_HUB_ENABLED` and `?ui=` at request
// runtime so rollback to the legacy interface requires no database change.
export const dynamic = 'force-dynamic';

export default async function AgentsPage({
  searchParams,
}: {
  searchParams: Promise<{ ui?: string }>;
}) {
  const params = await searchParams;
  const mode = resolveAiHubUiMode({
    envValue: process.env.UNIFIED_AI_HUB_ENABLED,
    queryOverride: params?.ui,
    defaultMode: 'unified',
  });

  if (mode === 'legacy') {
    return <LegacyAiHub />;
  }

  return <UnifiedAiHub basePath="/agents" />;
}
