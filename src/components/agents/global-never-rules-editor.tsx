'use client';

import { useMemo, useState } from 'react';
import {
  Loader2,
  Plus,
  X,
  Pencil,
  Check,
  ChevronDown,
  ChevronUp,
  Search,
  Shield,
  Briefcase,
  Scale,
  Handshake,
  Sparkles,
  Layers,
  ShieldAlert,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

export interface NeverRuleCategory {
  id: string;
  name: string;
  shortName: string;
  icon: typeof Shield;
  prefix: string;
  keywords: string[];
}

export const NEVER_RULE_CATEGORIES: NeverRuleCategory[] = [
  {
    id: 'seguranca',
    name: 'Segurança & Confiabilidade',
    shortName: 'Segurança',
    icon: Shield,
    prefix: '[Segurança]',
    keywords: [
      'invent', 'inventar', 'invente', 'suposiç', 'suposição', 'supor', 'suposições',
      'afirmar sem', 'sem confirmação', 'sem certeza', 'dado falso', 'expor', 'vazar',
      'confidencial', 'segurança', 'confiabilidade', 'alucina', 'alucinação', 'certeza absoluta',
      'não garanta', 'sem ter certeza', 'sem validação técnica', 'especular'
    ],
  },
  {
    id: 'comercial',
    name: 'Comercial & Valores',
    shortName: 'Comercial',
    icon: Briefcase,
    prefix: '[Comercial]',
    keywords: [
      'preço', 'precos', 'preços', 'valor', 'valores', 'desconto', 'descontos',
      'tabela', 'tabela de preço', 'condição', 'condições', 'condição comercial', 'condições comerciais',
      'parcela', 'parcelas', 'entrada', 'financiamento', 'disponibilidade', 'unidade livre',
      'reserva', 'reservar', 'promessa', 'prometer', 'prometer valorização', 'custo por m²',
      'm²', 'metro quadrado', 'proposta', 'contraproposta', 'negociação'
    ],
  },
  {
    id: 'limites',
    name: 'Limites de Atuação & Responsabilidade',
    shortName: 'Limites',
    icon: Scale,
    prefix: '[Limites]',
    keywords: [
      'jurídic', 'jurídica', 'jurídico', 'juridico', 'advocacia', 'lei', 'contrato definitivo',
      'financeir', 'financeira', 'financeiro', 'assessoria financeira', 'técnic', 'técnica', 'técnico definitiva',
      'autoridade', 'profissional', 'responsabilidade', 'competência', 'limite', 'limites',
      'garantir rentabilidade', 'promessa de lucro', 'laudo', 'parecer', 'garantia legal'
    ],
  },
  {
    id: 'escopo',
    name: 'Escopo Operacional & Handoff',
    shortName: 'Escopo',
    icon: Handshake,
    prefix: '[Escopo]',
    keywords: [
      'visita', 'visitas', 'agendar', 'agendamento', 'marcar visita', 'confirmar visita',
      'horário', 'confirmar horário', 'compromisso', 'equipe', 'humano', 'corretor', 'corretores',
      'transfer', 'transferir', 'encaminhar', 'direcionar', 'especialista', 'intervenção',
      'passar contato', 'ligar', 'telefonar', 'assumir compromisso'
    ],
  },
];

/**
 * Converte um texto de regras legadas em um array limpo de regras.
 */
export function parseLegacyRulesToLines(rawText: string | null | undefined): string[] {
  if (!rawText || !rawText.trim()) return [];
  return rawText
    .split('\n')
    .map((line) => line.trim().replace(/^[-•*]\s*/, '').trim())
    .filter((line) => line.length > 0);
}

/**
 * Converte um array de regras de volta para string consolidada.
 */
export function formatLinesToLegacyRules(rules: string[]): string {
  return rules.filter((r) => r.trim().length > 0).join('\n');
}

/**
 * Análise semântica em tempo real para as regras proibitivas.
 */
export function inferNeverRuleCategoryFromText(text: string): NeverRuleCategory {
  const lower = text.toLowerCase().trim();
  if (!lower) return NEVER_RULE_CATEGORIES[0];

  const byPrefix = NEVER_RULE_CATEGORIES.find((c) => text.startsWith(c.prefix));
  if (byPrefix) return byPrefix;

  let bestCategory = NEVER_RULE_CATEGORIES[0];
  let maxScore = 0;

  for (const cat of NEVER_RULE_CATEGORIES) {
    let score = 0;
    for (const kw of cat.keywords) {
      if (lower.includes(kw)) {
        score += kw.includes(' ') ? 3 : 1;
      }
    }
    if (score > maxScore) {
      maxScore = score;
      bestCategory = cat;
    }
  }

  return bestCategory;
}

interface GlobalNeverRulesEditorProps {
  value: string[] | string;
  loading?: boolean;
  onChange: (rules: string[]) => void;
  placeholder?: string;
  emptyLabel?: string;
  className?: string;
  searchThreshold?: number;
}

export function GlobalNeverRulesEditor({
  value,
  loading = false,
  onChange,
  placeholder = 'Ex: Nunca invente informações ou responda com suposições.',
  emptyLabel = 'Nenhuma regra proibitiva cadastrada ainda.',
  className,
  searchThreshold = 6,
}: GlobalNeverRulesEditorProps) {
  const rulesList = useMemo(() => {
    if (Array.isArray(value)) return value;
    return parseLegacyRulesToLines(value);
  }, [value]);

  const [draft, setDraft] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('auto');
  const [adding, setAdding] = useState(false);
  const [removingIndex, setRemovingIndex] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);
  const [search, setSearch] = useState('');
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());

  const detectedCategory = useMemo(() => {
    if (selectedCategory !== 'auto') {
      return (
        NEVER_RULE_CATEGORIES.find((c) => c.id === selectedCategory) ||
        NEVER_RULE_CATEGORIES[0]
      );
    }
    return inferNeverRuleCategoryFromText(draft);
  }, [selectedCategory, draft]);

  const handleAdd = () => {
    const trimmed = draft.trim();
    if (!trimmed || adding) return;
    setAdding(true);
    try {
      const cat = detectedCategory;
      const hasPrefix = NEVER_RULE_CATEGORIES.some((c) => trimmed.startsWith(c.prefix));
      const formatted = hasPrefix || !cat ? trimmed : `${cat.prefix} ${trimmed}`;

      const updated = [...rulesList, formatted];
      onChange(updated);
      setDraft('');
      if (cat) {
        setOpenGroups((prev) => new Set(prev).add(cat.id));
      }
    } finally {
      setAdding(false);
    }
  };

  const handleRemove = (index: number) => {
    if (removingIndex !== null) return;
    setRemovingIndex(index);
    try {
      const updated = rulesList.filter((_, i) => i !== index);
      onChange(updated);
    } finally {
      setRemovingIndex(null);
    }
  };

  const startEdit = (index: number) => {
    if (editingIndex !== null) return;
    setEditingIndex(index);
    setEditDraft(rulesList[index]);
  };

  const cancelEdit = () => {
    setEditingIndex(null);
    setEditDraft('');
  };

  const saveEdit = (index: number) => {
    const trimmed = editDraft.trim();
    if (!trimmed || savingEdit) return;
    setSavingEdit(true);
    try {
      const updated = rulesList.map((v, i) => (i === index ? trimmed : v));
      onChange(updated);
      setEditingIndex(null);
      setEditDraft('');
    } finally {
      setSavingEdit(false);
    }
  };

  const toggleExpanded = (index: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const toggleGroup = (groupId: string) => {
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  };

  const categorizedRules = useMemo(() => {
    const q = search.trim().toLowerCase();

    const categorized = rulesList.map((rawText, originalIndex) => {
      let matchedCategory = NEVER_RULE_CATEGORIES.find((c) => rawText.startsWith(c.prefix));
      let cleanText = rawText;

      if (matchedCategory) {
        cleanText = rawText.slice(matchedCategory.prefix.length).trim();
      } else {
        const lower = rawText.toLowerCase();
        matchedCategory =
          NEVER_RULE_CATEGORIES.find((c) => c.keywords.some((k) => lower.includes(k))) || undefined;
      }

      return {
        originalIndex,
        rawText,
        cleanText,
        categoryId: matchedCategory ? matchedCategory.id : 'outras',
        matchesSearch: !q || rawText.toLowerCase().includes(q),
      };
    });

    const groups: {
      category: NeverRuleCategory | { id: string; name: string; shortName: string; icon: typeof Layers; prefix: string };
      items: typeof categorized;
    }[] = NEVER_RULE_CATEGORIES.map((cat) => ({
      category: cat,
      items: categorized.filter((item) => item.categoryId === cat.id && item.matchesSearch),
    }));

    const uncategorizedItems = categorized.filter(
      (item) => item.categoryId === 'outras' && item.matchesSearch,
    );
    if (uncategorizedItems.length > 0) {
      groups.push({
        category: {
          id: 'outras',
          name: 'Outras Proibições & Restrições',
          shortName: 'Outras',
          icon: Layers,
          prefix: '',
        },
        items: uncategorizedItems,
      });
    }

    return groups;
  }, [rulesList, search]);

  const totalVisibleItems = useMemo(
    () => categorizedRules.reduce((sum, g) => sum + g.items.length, 0),
    [categorizedRules],
  );

  return (
    <div className={cn('space-y-3.5', className)}>
      {/* 1. Header Alert / Principle — Tons refinados em Rose suave e Amber */}
      <div className="rounded-xl border border-rose-500/20 bg-gradient-to-r from-rose-500/10 via-rose-500/5 to-transparent dark:border-rose-500/20 dark:from-rose-950/40 dark:via-rose-950/20 p-3.5 shadow-xs">
        <div className="flex items-center gap-2">
          <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-rose-500/15 text-rose-600 dark:text-rose-400">
            <ShieldAlert className="h-3.5 w-3.5" />
          </div>
          <p className="text-xs font-semibold text-rose-600 dark:text-rose-400 uppercase tracking-wide">
            Diretrizes Inegociáveis & Fronteiras Rígidas
          </p>
        </div>
        <p className="mt-1.5 text-xs font-medium text-foreground leading-relaxed pl-8">
          &ldquo;A IA nunca assume compromissos comerciais, nunca inventa dados e sempre transfere para a equipe humana quando atinge uma fronteira.&rdquo;
        </p>
      </div>

      {/* 2. Add New Never Rule Form */}
      <div className="rounded-xl border border-border/70 bg-card p-3 shadow-xs space-y-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-medium text-foreground">Nova Regra Proibitiva</span>
            {draft.trim().length > 0 && selectedCategory === 'auto' && (
              <span className="inline-flex items-center gap-1 text-[11px] font-medium text-rose-700 dark:text-rose-300 bg-rose-500/15 px-2 py-0.5 rounded-full animate-in fade-in-0 duration-200 border border-rose-500/20">
                <Sparkles className="h-3 w-3 text-rose-600 dark:text-rose-400" />
                Enquadramento: <strong className="text-foreground">{detectedCategory.shortName}</strong>
              </span>
            )}
          </div>
          <div className="flex items-center gap-1 overflow-x-auto pb-0.5">
            <button
              type="button"
              onClick={() => setSelectedCategory('auto')}
              className={cn(
                'inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors cursor-pointer',
                selectedCategory === 'auto'
                  ? 'bg-rose-600 text-white dark:bg-rose-700/80 dark:text-rose-100 shadow-xs font-semibold'
                  : 'bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
              title="Detecta o grupo automaticamente pelo significado da proibição digitada"
            >
              <Sparkles className="h-3 w-3" />
              <span>Auto</span>
            </button>
            {NEVER_RULE_CATEGORIES.map((cat) => {
              const Icon = cat.icon;
              const isSelected = selectedCategory === cat.id;
              return (
                <button
                  key={cat.id}
                  type="button"
                  onClick={() => setSelectedCategory(cat.id)}
                  className={cn(
                    'inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors cursor-pointer',
                    isSelected
                      ? 'bg-rose-600 text-white dark:bg-rose-700/80 dark:text-rose-100 shadow-xs'
                      : 'bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}
                >
                  <Icon className="h-3 w-3" />
                  <span>{cat.shortName}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleAdd();
              }
            }}
            disabled={loading}
            placeholder={placeholder}
            rows={2}
            className="flex-1 resize-none rounded-lg border border-border bg-background px-3 py-2 text-xs leading-relaxed text-foreground placeholder-muted-foreground outline-none focus:border-rose-500/50"
          />
          <Button
            type="button"
            size="sm"
            onClick={handleAdd}
            disabled={adding || loading || !draft.trim()}
            className="h-9 text-xs shrink-0 gap-1.5 bg-rose-600 hover:bg-rose-700 text-white dark:bg-rose-700 dark:hover:bg-rose-600 border border-rose-500/30"
          >
            {adding ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Plus className="h-3.5 w-3.5" />
            )}
            Adicionar
          </Button>
        </div>
      </div>

      {/* 3. Search Bar */}
      {!loading && rulesList.length > searchThreshold && (
        <div className="relative shrink-0">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar regra proibitiva por palavra-chave..."
            className="w-full rounded-lg border border-border bg-background py-1.5 pl-8 pr-3 text-xs text-foreground placeholder-muted-foreground outline-none focus:border-rose-500/50"
          />
        </div>
      )}

      {/* 4. Categorized Groups (Accordions) */}
      <div className="space-y-2">
        {loading ? (
          <div className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-rose-500" /> Carregando regras proibitivas...
          </div>
        ) : rulesList.length === 0 ? (
          <p className="p-3 text-center text-xs text-muted-foreground">{emptyLabel}</p>
        ) : totalVisibleItems === 0 ? (
          <p className="p-3 text-center text-xs text-muted-foreground">
            Nenhuma regra proibitiva corresponde à busca.
          </p>
        ) : (
          categorizedRules.map(({ category, items }) => {
            const Icon = category.icon;
            const isOpen = openGroups.has(category.id) || search.trim().length > 0;
            const count = items.length;

            return (
              <div
                key={category.id}
                className="overflow-hidden rounded-xl border border-border/70 bg-card shadow-xs transition-all"
              >
                {/* Group Accordion Header */}
                <button
                  type="button"
                  onClick={() => toggleGroup(category.id)}
                  className="flex w-full min-w-0 items-center justify-between gap-2 px-3.5 py-2.5 text-left transition-colors hover:bg-muted/40 cursor-pointer"
                >
                  <div className="flex min-w-0 items-center gap-2.5">
                    <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-rose-500/15 text-rose-600 dark:text-rose-400">
                      <Icon className="h-3.5 w-3.5" />
                    </div>
                    <span className="truncate text-xs font-semibold text-foreground">
                      {category.name}
                    </span>
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    <Badge variant="secondary" className="h-5 px-1.5 text-[10px] font-semibold">
                      {count}
                    </Badge>
                    {isOpen ? (
                      <ChevronUp className="h-4 w-4 text-muted-foreground" />
                    ) : (
                      <ChevronDown className="h-4 w-4 text-muted-foreground" />
                    )}
                  </div>
                </button>

                {/* Group Accordion Items */}
                {isOpen && (
                  <div className="border-t border-border/50 bg-background/50 p-2.5 space-y-1.5">
                    {items.length === 0 ? (
                      <p className="py-2 text-center text-[11px] text-muted-foreground italic">
                        Nenhuma regra cadastrada neste grupo ainda. Adicione acima selecionando &quot;{category.shortName}&quot;.
                      </p>
                    ) : (
                      items.map((item) => {
                        const isEditing = editingIndex === item.originalIndex;
                        const isExpanded = expanded.has(item.originalIndex);

                        if (isEditing) {
                          return (
                            <div
                              key={item.originalIndex}
                              className="rounded-lg border border-rose-500/40 bg-card p-2.5 space-y-2 shadow-xs"
                            >
                              <textarea
                                value={editDraft}
                                onChange={(e) => setEditDraft(e.target.value)}
                                autoFocus
                                rows={3}
                                className="w-full resize-none rounded-md border border-border bg-background px-2.5 py-1.5 text-xs leading-relaxed text-foreground outline-none focus:border-rose-500/50"
                              />
                              <div className="flex justify-end gap-1.5">
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="ghost"
                                  onClick={cancelEdit}
                                  disabled={savingEdit}
                                  className="h-7 text-xs"
                                >
                                  Cancelar
                                </Button>
                                <Button
                                  type="button"
                                  size="sm"
                                  onClick={() => saveEdit(item.originalIndex)}
                                  disabled={savingEdit || !editDraft.trim()}
                                  className="h-7 text-xs bg-rose-600 hover:bg-rose-700 text-white dark:bg-rose-700"
                                >
                                  {savingEdit ? (
                                    <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                                  ) : (
                                    <Check className="mr-1 h-3 w-3" />
                                  )}
                                  Salvar
                                </Button>
                              </div>
                            </div>
                          );
                        }

                        return (
                          <div
                            key={item.originalIndex}
                            className="flex items-start gap-2 rounded-lg border border-border/60 bg-card px-3 py-2 text-xs text-foreground shadow-2xs hover:border-rose-500/30 transition-colors"
                          >
                            <span
                              className={cn(
                                'flex-1 min-w-0 leading-relaxed whitespace-pre-wrap',
                                !isExpanded && 'line-clamp-2',
                              )}
                            >
                              {item.cleanText}
                            </span>
                            <div className="flex shrink-0 items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => toggleExpanded(item.originalIndex)}
                                className="text-muted-foreground hover:text-foreground cursor-pointer"
                                title={isExpanded ? 'Recolher' : 'Expandir'}
                              >
                                {isExpanded ? (
                                  <ChevronUp className="h-3.5 w-3.5" />
                                ) : (
                                  <ChevronDown className="h-3.5 w-3.5" />
                                )}
                              </button>
                              <button
                                type="button"
                                onClick={() => startEdit(item.originalIndex)}
                                disabled={removingIndex !== null}
                                className="text-muted-foreground hover:text-rose-500 disabled:opacity-40 cursor-pointer"
                                title="Editar regra"
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={() => handleRemove(item.originalIndex)}
                                disabled={removingIndex !== null}
                                className="text-muted-foreground hover:text-destructive disabled:opacity-40 cursor-pointer"
                                title="Remover regra"
                              >
                                {removingIndex === item.originalIndex ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin text-rose-500" />
                                ) : (
                                  <X className="h-3.5 w-3.5" />
                                )}
                              </button>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
