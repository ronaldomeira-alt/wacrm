'use client';

import { Suspense, useCallback, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  BrainCircuit,
  BookOpen,
  Sparkles,
  ListTodo,
  Sliders,
  Building2,
  GraduationCap,
} from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { PropertyKnowledgeList } from '@/components/agents/property-knowledge-list';
import { GlobalKnowledgeSection } from '@/components/agents/global-knowledge-section';
import { AiPlayground } from '@/components/agents/ai-playground';
import { AiBehaviorSettings } from '@/components/agents/ai-behavior-settings';
import { AiEvolutionDashboard } from '@/components/agents/ai-evolution-dashboard';
import { AiSuggestionsPanel } from '@/components/agents/ai-suggestions-panel';
import { CENTRAL_IA_SUGGESTION_CATEGORIES } from '@/lib/ai-suggestion-status';

type MainTab = 'knowledge' | 'playground' | 'evolution' | 'suggestions' | 'behavior';

/**
 * Legacy 5-tab Central de IA interface preserved intact during the
 * stabilization window so rollback (`UNIFIED_AI_HUB_ENABLED=false` or
 * `?ui=legacy`) restores the previous UX immediately without rebuild
 * or database changes.
 */
export function LegacyAiHub() {
  return (
    <Suspense fallback={null}>
      <LegacyAiHubInner />
    </Suspense>
  );
}

function LegacyAiHubInner() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const contactFilter = searchParams.get('contact');
  const tabParam = searchParams.get('tab') as MainTab | null;

  const [activeTab, setActiveTab] = useState<MainTab>(
    tabParam || (contactFilter ? 'suggestions' : 'knowledge'),
  );

  const handleTabChange = (val: string) => {
    const nextTab = val as MainTab;
    setActiveTab(nextTab);
    const params = new URLSearchParams(searchParams.toString());
    params.set('tab', nextTab);
    router.replace(`/agents?${params.toString()}`, { scroll: false });
  };

  const clearContactFilter = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete('contact');
    router.replace(`/agents${params.toString() ? `?${params.toString()}` : ''}`, {
      scroll: false,
    });
  }, [router, searchParams]);

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-2">
          <BrainCircuit className="h-6 w-6 text-primary" />
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            Central de IA
          </h1>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Gestão de conhecimento dos empreendimentos, testes de conversação, atividades e comportamento da IA.
        </p>
      </div>

      <Tabs value={activeTab} onValueChange={handleTabChange} className="space-y-6">
        <TabsList className="flex w-full overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:grid sm:grid-cols-5 max-w-3xl justify-start sm:justify-center">
          <TabsTrigger value="knowledge" className="flex items-center gap-1.5 shrink-0 px-3 sm:px-1.5">
            <BookOpen className="h-4 w-4" />
            <span>Conhecimento</span>
          </TabsTrigger>
          <TabsTrigger value="playground" className="flex items-center gap-1.5 shrink-0 px-3 sm:px-1.5">
            <Sparkles className="h-4 w-4" />
            <span>Playground</span>
          </TabsTrigger>
          <TabsTrigger value="evolution" className="flex items-center gap-1.5 shrink-0 px-3 sm:px-1.5">
            <GraduationCap className="h-4 w-4" />
            <span>Evolução</span>
          </TabsTrigger>
          <TabsTrigger value="suggestions" className="flex items-center gap-1.5 shrink-0 px-3 sm:px-1.5">
            <ListTodo className="h-4 w-4" />
            <span>Sugestões</span>
          </TabsTrigger>
          <TabsTrigger value="behavior" className="flex items-center gap-1.5 shrink-0 px-3 sm:px-1.5">
            <Sliders className="h-4 w-4" />
            <span>Comportamento</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="knowledge" className="space-y-8">
          <div className="space-y-3">
            <div>
              <h2 className="text-base font-semibold text-foreground flex items-center gap-2">
                <Building2 className="h-4 w-4 text-primary" />
                Empreendimentos &amp; Books Técnicos
              </h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                Cadastre seus empreendimentos, faça upload dos Books em PDF e adicione anotações práticas do corretor. O conhecimento é 100% isolado por imóvel no RAG.
              </p>
            </div>
            <PropertyKnowledgeList />
          </div>

          <div className="space-y-3 pt-6 border-t border-border">
            <GlobalKnowledgeSection />
          </div>
        </TabsContent>

        <TabsContent value="playground">
          <AiPlayground />
        </TabsContent>

        <TabsContent value="evolution">
          <AiEvolutionDashboard />
        </TabsContent>

        <TabsContent value="suggestions" className="space-y-4">
          <AiSuggestionsPanel
            contactFilter={contactFilter}
            onClearContactFilter={clearContactFilter}
            categories={CENTRAL_IA_SUGGESTION_CATEGORIES}
          />
        </TabsContent>

        <TabsContent value="behavior">
          <AiBehaviorSettings />
        </TabsContent>
      </Tabs>
    </div>
  );
}
