import AgentsPage from '../page';
import { UnifiedAiHub } from '@/components/agents/unified-ai-hub';
import { resolveAiHubUiMode } from '@/lib/ai/hub-mode';

// Dynamic rendering ensures `process.env.UNIFIED_AI_HUB_ENABLED` and `?ui=`
// are evaluated at request runtime — enabling instant rollback without rebuild
// or database changes.
export const dynamic = 'force-dynamic';

export default async function AgentsPreviewPage({
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
    return <AgentsPage />;
  }

  return <UnifiedAiHub basePath="/agents/preview" isPreview />;
}
