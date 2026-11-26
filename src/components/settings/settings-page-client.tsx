'use client';

import { Suspense, useEffect, useMemo, type ReactNode } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { useAuth } from '@/hooks/use-auth';
import { useTheme } from '@/hooks/use-theme';
import { SettingsRail } from '@/components/settings/settings-rail';
import { SettingsOverview } from '@/components/settings/settings-overview';
import { ProfileForm } from '@/components/settings/profile-form';
import { SecurityPanel } from '@/components/settings/security-panel';
import { AppearancePanel } from '@/components/settings/appearance-panel';
import { NotificationsPanel } from '@/components/settings/notifications-panel';
import { WhatsAppConfig } from '@/components/settings/whatsapp-config';
import { TemplateManager } from '@/components/settings/template-manager';
import { QuickRepliesManager } from '@/components/settings/quick-replies-manager';
import { FieldsAndTagsPanel } from '@/components/settings/fields-and-tags-panel';
import { DealsSettings } from '@/components/settings/deals-settings';
import { MembersTab } from '@/components/settings/members-tab';
import { ApiKeysSettings } from '@/components/settings/api-keys-settings';
import { AiAgentsPanel } from '@/components/settings/ai-agents-panel';
import { BaileysConfig } from '@/components/settings/baileys-config';
import {
  resolveSection,
  type SettingsSection,
} from '@/components/settings/settings-sections';

export function SettingsPageClient({
  unifiedAiHubActive,
}: {
  unifiedAiHubActive: boolean;
}) {
  return (
    <Suspense fallback={null}>
      <SettingsPageInner unifiedAiHubActive={unifiedAiHubActive} />
    </Suspense>
  );
}

function SettingsPageInner({
  unifiedAiHubActive,
}: {
  unifiedAiHubActive: boolean;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { defaultCurrency } = useAuth();
  const { mode } = useTheme();
  const t = useTranslations('Settings');

  const section = resolveSection(searchParams.get('tab'));

  // Client-side guard: if the user navigates to `?tab=ai-agents` while the
  // unified AI Central is active, forward them directly to `/agents`.
  useEffect(() => {
    if (unifiedAiHubActive && section === 'ai-agents') {
      router.replace('/agents');
    }
  }, [unifiedAiHubActive, section, router]);

  const go = (next: SettingsSection) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('tab', next);
    router.replace(`/settings?${params.toString()}`, { scroll: false });
  };

  const hints: Partial<Record<SettingsSection, ReactNode>> = useMemo(
    () => ({
      appearance: mode.charAt(0).toUpperCase() + mode.slice(1),
      deals: defaultCurrency,
    }),
    [mode, defaultCurrency],
  );

  const panel: Record<SettingsSection, ReactNode> = {
    overview: <SettingsOverview onSelect={go} hideAiAgents={unifiedAiHubActive} />,
    profile: <ProfileForm />,
    security: <SecurityPanel />,
    appearance: <AppearancePanel />,
    notifications: <NotificationsPanel />,
    whatsapp: <WhatsAppConfig />,
    templates: <TemplateManager />,
    'quick-replies': <QuickRepliesManager />,
    fields: <FieldsAndTagsPanel />,
    deals: <DealsSettings />,
    members: <MembersTab />,
    api: <ApiKeysSettings />,
    'ai-agents': unifiedAiHubActive ? null : <AiAgentsPanel />,
    envios: <BaileysConfig />,
  };

  return (
    <div>
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">
          {t('pageTitle')}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('pageDesc')}
        </p>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[236px_minmax(0,1fr)] lg:items-start">
        <SettingsRail
          active={section}
          onSelect={go}
          hints={hints}
          hideAiAgents={unifiedAiHubActive}
        />
        <div className="min-w-0">{panel[section]}</div>
      </div>
    </div>
  );
}
