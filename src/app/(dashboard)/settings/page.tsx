import { redirect } from 'next/navigation';
import { SettingsPageClient } from '@/components/settings/settings-page-client';
import { resolveAiHubUiMode } from '@/lib/ai/hub-mode';

export const dynamic = 'force-dynamic';

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; ui?: string }>;
}) {
  const params = await searchParams;
  const mode = resolveAiHubUiMode({
    envValue: process.env.UNIFIED_AI_HUB_ENABLED,
    queryOverride: params?.ui,
    defaultMode: 'unified',
  });
  const unifiedAiHubActive = mode === 'unified';

  // Server-side redirect for bookmarks/deep-links to `/settings?tab=ai-agents`
  // while the unified Central de IA is active. When rollback (`mode === 'legacy'`)
  // is triggered, `/settings?tab=ai-agents` seamlessly restores AiAgentsPanel.
  if (unifiedAiHubActive && params?.tab === 'ai-agents') {
    redirect('/agents');
  }

  return <SettingsPageClient unifiedAiHubActive={unifiedAiHubActive} />;
}
