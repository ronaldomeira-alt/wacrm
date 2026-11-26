import {
  BarChart3,
  BookOpen,
  GraduationCap,
  KeyRound,
  LayoutGrid,
  ListTodo,
  ShieldCheck,
  Sliders,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';
import type { AiSuggestionCategory } from '@/types';

/**
 * Definitive 9-section information architecture for the unified AI Central.
 *
 * Mirrors `src/components/settings/settings-sections.ts` so the secondary
 * vertical rail shares the exact same visual language and URL contract (`?tab=`).
 */
export const AI_HUB_SECTIONS = [
  'overview',
  'knowledge',
  'behavior',
  'playground',
  'evolution',
  'suggestions',
  'providers',
  'credentials',
  'usage',
] as const;

export type AiHubSection = (typeof AI_HUB_SECTIONS)[number];

export type AiHubGroup = 'management' | 'infrastructure';

export const DEFAULT_AI_HUB_SECTION: AiHubSection = 'overview';

export interface AiHubSectionMeta {
  id: AiHubSection;
  label: string;
  description: string;
  icon: LucideIcon;
  group: AiHubGroup;
  adminOnly?: boolean;
}

export const AI_HUB_SECTION_META: Record<AiHubSection, AiHubSectionMeta> = {
  overview: {
    id: 'overview',
    label: 'Visão geral',
    description: 'Estado operacional da Clara, modelo ativo, indicadores e acessos rápidos.',
    icon: LayoutGrid,
    group: 'management',
  },
  knowledge: {
    id: 'knowledge',
    label: 'Conhecimento',
    description: 'Empreendimentos, books técnicos, visão do corretor e conhecimento global.',
    icon: BookOpen,
    group: 'management',
  },
  behavior: {
    id: 'behavior',
    label: 'Comportamento',
    description: 'Identidade, tom de voz, condução, fronteiras, horários, limites e ativação.',
    icon: Sliders,
    group: 'management',
  },
  playground: {
    id: 'playground',
    label: 'Playground',
    description: 'Simulações de atendimento da Clara e testes isolados de modelos.',
    icon: Sparkles,
    group: 'management',
  },
  evolution: {
    id: 'evolution',
    label: 'Evolução',
    description: 'Aprendizados pendentes, edição, aprovação, histórico e rollback.',
    icon: GraduationCap,
    group: 'management',
  },
  suggestions: {
    id: 'suggestions',
    label: 'Sugestões',
    description: 'Recomendações de movimentação de pipeline, ações e inconsistências.',
    icon: ListTodo,
    group: 'management',
  },
  providers: {
    id: 'providers',
    label: 'Provedores',
    description: 'Modelos, prioridades, timeouts, circuit breaker, cotas e fallback.',
    icon: ShieldCheck,
    group: 'infrastructure',
    adminOnly: true,
  },
  credentials: {
    id: 'credentials',
    label: 'Credenciais',
    description: 'Chaves de API de IA, embeddings, testes de conexão e manutenção.',
    icon: KeyRound,
    group: 'infrastructure',
    adminOnly: true,
  },
  usage: {
    id: 'usage',
    label: 'Consumo',
    description: 'Gráficos, tokens, requisições, valores em USD, filtros e histórico.',
    icon: BarChart3,
    group: 'infrastructure',
    adminOnly: true,
  },
};

export const AI_HUB_RAIL_GROUPS: {
  group: AiHubGroup;
  label: string;
  adminOnly?: boolean;
}[] = [
  { group: 'management', label: 'GESTÃO DA IA' },
  { group: 'infrastructure', label: 'INFRAESTRUTURA', adminOnly: true },
];

/**
 * Operational suggestion categories for the unified Suggestions section (Decision 3).
 * Excludes `learning` (centralized in Evolution) and `followup` (own `/followup` module).
 */
export const UNIFIED_SUGGESTION_CATEGORIES: readonly AiSuggestionCategory[] = [
  'pipeline_move',
  'action',
  'inconsistency',
  'other',
];

const LEGACY_SECTION_ALIASES: Record<string, AiHubSection> = {
  setup: 'credentials',
  'ai-agents': 'overview',
  config: 'behavior',
};

function isAiHubSection(value: string | null): value is AiHubSection {
  return !!value && (AI_HUB_SECTIONS as readonly string[]).includes(value);
}

/**
 * Resolve the active section from `?tab=` and `?contact=`, enforcing
 * `adminOnly` access gates for the Infrastructure group.
 */
export function resolveAiHubSection(
  rawTab: string | null,
  options: {
    hasContactFilter?: boolean;
    canAccessInfrastructure?: boolean;
  } = {},
): AiHubSection {
  const { hasContactFilter = false, canAccessInfrastructure = false } = options;

  let resolved: AiHubSection | null = null;
  if (rawTab) {
    const normalized = rawTab.trim().toLowerCase();
    if (isAiHubSection(normalized)) {
      resolved = normalized;
    } else if (normalized in LEGACY_SECTION_ALIASES) {
      resolved = LEGACY_SECTION_ALIASES[normalized];
    }
  }

  if (!resolved) {
    return hasContactFilter ? 'suggestions' : DEFAULT_AI_HUB_SECTION;
  }

  if (AI_HUB_SECTION_META[resolved].adminOnly && !canAccessInfrastructure) {
    return DEFAULT_AI_HUB_SECTION;
  }

  return resolved;
}

export function getVisibleAiHubSections(canAccessInfrastructure: boolean): AiHubSection[] {
  return AI_HUB_SECTIONS.filter(
    (id) => !AI_HUB_SECTION_META[id].adminOnly || canAccessInfrastructure,
  );
}
