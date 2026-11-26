'use client';

import { Suspense, useCallback } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { BrainCircuit, Building2, FlaskConical } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { canEditSettings } from '@/lib/auth/roles';
import { Badge } from '@/components/ui/badge';
import { SettingsPanelHead } from '@/components/settings/settings-panel-head';
import { PropertyKnowledgeList } from './property-knowledge-list';
import { GlobalKnowledgeSection } from './global-knowledge-section';
import { AiBehaviorSettings } from './ai-behavior-settings';
import { AiPlayground } from './ai-playground';
import { AiEvolutionDashboard } from './ai-evolution-dashboard';
import { AiSuggestionsPanel } from './ai-suggestions-panel';
import { AiProvidersPanel } from './ai-providers';
import { AiCredentialsPanel } from './ai-credentials-panel';
import { AiUsageCard } from './ai-usage';
import { AiOverviewPanel } from './ai-overview-panel';
import { AiHubRail } from './ai-hub-rail';
import {
  AI_HUB_SECTION_META,
  resolveAiHubSection,
  type AiHubSection,
} from './ai-hub-sections';

export interface UnifiedAiHubProps {
  /** Base route used when updating `?tab=` / `?contact=` query parameters. */
  basePath?: string;
  /** Shows a non-intrusive experimental preview banner (Stage 2 only). */
  isPreview?: boolean;
}

export function UnifiedAiHub(props: UnifiedAiHubProps = {}) {
  return (
    <Suspense fallback={null}>
      <UnifiedAiHubInner {...props} />
    </Suspense>
  );
}

function UnifiedAiHubInner({
  basePath = '/agents/preview',
  isPreview = false,
}: UnifiedAiHubProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { accountRole } = useAuth();
  const canAccessInfrastructure = accountRole ? canEditSettings(accountRole) : false;

  const contactFilter = searchParams.get('contact');
  const activeSection = resolveAiHubSection(searchParams.get('tab'), {
    hasContactFilter: Boolean(contactFilter),
    canAccessInfrastructure,
  });

  const go = useCallback(
    (next: AiHubSection) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set('tab', next);
      router.replace(`${basePath}?${params.toString()}`, { scroll: false });
    },
    [basePath, router, searchParams],
  );

  const clearContactFilter = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete('contact');
    const qs = params.toString();
    router.replace(`${basePath}${qs ? `?${qs}` : ''}`, { scroll: false });
  }, [basePath, router, searchParams]);

  const meta = AI_HUB_SECTION_META[activeSection];

  // Conditional mounting: ONLY the active section is instantiated and mounted,
  // preventing simultaneous fetches, subscriptions, or side effects from
  // inactive tabs.
  const renderActiveSection = () => {
    switch (activeSection) {
      case 'overview':
        return (
          <AiOverviewPanel
            canAccessInfrastructure={canAccessInfrastructure}
            onSelect={go}
          />
        );
      case 'knowledge':
        return (
          <div className="space-y-8">
            <div className="space-y-3">
              <div>
                <h3 className="text-base font-semibold text-foreground flex items-center gap-2">
                  <Building2 className="h-4 w-4 text-primary" />
                  Empreendimentos &amp; Books Técnicos
                </h3>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Cadastre seus empreendimentos, faça upload dos Books em PDF e adicione anotações práticas do corretor. O conhecimento é 100% isolado por imóvel no RAG.
                </p>
              </div>
              <PropertyKnowledgeList />
            </div>

            <div className="space-y-3 pt-6 border-t border-border">
              <GlobalKnowledgeSection />
            </div>
          </div>
        );
      case 'behavior':
        return <AiBehaviorSettings />;
      case 'playground':
        return (
          <AiPlayground
            onGoToSetup={() =>
              go(canAccessInfrastructure ? 'credentials' : 'behavior')
            }
          />
        );
      case 'evolution':
        return <AiEvolutionDashboard />;
      case 'suggestions':
        return (
          <AiSuggestionsPanel
            contactFilter={contactFilter}
            onClearContactFilter={clearContactFilter}
          />
        );
      case 'providers':
        return canAccessInfrastructure ? (
          <AiProvidersPanel
            hideCredentialInputs
            onGoToCredentials={() => go('credentials')}
          />
        ) : null;
      case 'credentials':
        return canAccessInfrastructure ? (
          <AiCredentialsPanel onGoToProviders={() => go('providers')} />
        ) : null;
      case 'usage':
        return canAccessInfrastructure ? <AiUsageCard /> : null;
    }
  };

  return (
    <div>
      {isPreview && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-primary/25 bg-primary/5 px-4 py-2.5 text-xs">
          <div className="flex items-center gap-2 text-foreground">
            <FlaskConical className="h-4 w-4 shrink-0 text-primary" />
            <span>
              <strong>Prévia da Central de IA Unificada (Etapa 2)</strong> — As interfaces atuais permanecem ativas em paralelo.
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href="/agents"
              className="font-medium text-primary hover:underline"
            >
              Abrir Central atual
            </Link>
            <span className="text-muted-foreground">·</span>
            <Link
              href="/settings?tab=ai-agents"
              className="font-medium text-primary hover:underline"
            >
              Abrir Configurações → Agentes de IA
            </Link>
            <span className="text-muted-foreground">·</span>
            <Link
              href="/agents/preview?ui=legacy"
              className="font-medium text-muted-foreground hover:text-foreground hover:underline"
            >
              Testar rollback (legacy)
            </Link>
          </div>
        </div>
      )}

      <div>
        <div className="flex items-center gap-2">
          <BrainCircuit className="h-6 w-6 text-primary" />
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            Central de IA
          </h1>
          {isPreview && (
            <Badge variant="outline" className="text-[11px] font-medium">
              Preview
            </Badge>
          )}
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Gestão unificada da Clara, base de conhecimento, comportamento, simulações e infraestrutura de IA.
        </p>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[236px_minmax(0,1fr)] lg:items-start">
        <AiHubRail
          active={activeSection}
          onSelect={go}
          canAccessInfrastructure={canAccessInfrastructure}
        />
        <div className="min-w-0">
          {activeSection !== 'overview' && (
            <SettingsPanelHead title={meta.label} description={meta.description} />
          )}
          {renderActiveSection()}
        </div>
      </div>
    </div>
  );
}
