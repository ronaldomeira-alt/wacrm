'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Cpu, Loader2, RefreshCw, Search, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import type { AiProvider } from '@/lib/ai/types';
import type { CatalogModel, ProviderCatalogResult } from '@/lib/ai/model-catalog';

export interface ModelSelectorProps {
  provider: AiProvider | 'none';
  value: string;
  onChange: (modelId: string) => void;
  models: CatalogModel[];
  loading?: boolean;
  refreshing?: boolean;
  source?: ProviderCatalogResult['source'];
  onRefresh?: () => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  /** Playground card-style trigger matching adjacent Simulation Controls selectors */
  playgroundLabel?: string;
}

export function ModelSelector({
  provider,
  value,
  onChange,
  models,
  loading = false,
  refreshing = false,
  source,
  onRefresh,
  disabled = false,
  placeholder = 'Selecione um modelo...',
  className,
  playgroundLabel,
}: ModelSelectorProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [coords, setCoords] = useState<{ top: number; left: number; width: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const updateCoords = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const minWidth = Math.max(rect.width, 280);
    const maxLeft = Math.max(8, window.innerWidth - minWidth - 8);
    setCoords({
      top: rect.bottom + 6,
      left: Math.min(rect.left, maxLeft),
      width: minWidth,
    });
  }, []);

  useEffect(() => {
    if (!open) {
      setQuery('');
      return;
    }
    updateCoords();
    const timer = setTimeout(() => {
      searchInputRef.current?.focus();
    }, 20);
    window.addEventListener('resize', updateCoords);
    window.addEventListener('scroll', updateCoords, true);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('resize', updateCoords);
      window.removeEventListener('scroll', updateCoords, true);
    };
  }, [open, updateCoords]);

  useEffect(() => {
    if (!open) return;
    function handleOutside(e: MouseEvent | TouchEvent) {
      const target = e.target as Node;
      if (
        containerRef.current &&
        !containerRef.current.contains(target) &&
        (!dropdownRef.current || !dropdownRef.current.contains(target))
      ) {
        setOpen(false);
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', handleOutside);
    document.addEventListener('touchstart', handleOutside);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleOutside);
      document.removeEventListener('touchstart', handleOutside);
      document.removeEventListener('keydown', handleKey);
    };
  }, [open]);

  const selectedModel = useMemo(
    () => models.find((m) => m.id === value) ?? null,
    [models, value],
  );

  const filteredModels = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return models;
    return models.filter(
      (m) =>
        m.name.toLowerCase().includes(q) ||
        m.id.toLowerCase().includes(q) ||
        (m.description && m.description.toLowerCase().includes(q)),
    );
  }, [models, query]);

  if (provider === 'none') {
    return (
      <Button
        type="button"
        variant="outline"
        disabled
        className={cn('w-full justify-between font-normal text-muted-foreground', className)}
      >
        <span className="truncate">Nenhum provedor selecionado</span>
        <ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
      </Button>
    );
  }

  const dropdownContent =
    open && coords && typeof document !== 'undefined'
      ? createPortal(
          <div
            ref={dropdownRef}
            role="listbox"
            style={{
              position: 'fixed',
              top: `${coords.top}px`,
              left: `${coords.left}px`,
              width: `${coords.width}px`,
              zIndex: 90,
            }}
            className="overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-xl"
          >
            <div className="flex items-center gap-2 border-b border-border px-2.5 py-2">
              <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <input
                ref={searchInputRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Buscar modelo por nome ou ID..."
                className="w-full bg-transparent text-xs text-foreground placeholder:text-muted-foreground focus:outline-none"
              />
              {models.length > 0 && (
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  {filteredModels.length}/{models.length}
                </span>
              )}
            </div>

            <div className="max-h-72 overflow-y-auto p-1">
              {loading && models.length === 0 ? (
                <div className="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Carregando catálogo oficial...
                </div>
              ) : filteredModels.length === 0 ? (
                <div className="py-5 text-center text-xs text-muted-foreground">
                  Nenhum modelo encontrado para &ldquo;{query}&rdquo;.
                </div>
              ) : (
                filteredModels.map((m) => {
                  const isSelected = m.id === value;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      onClick={() => {
                        onChange(m.id);
                        setOpen(false);
                      }}
                      className={cn(
                        'flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left text-xs transition-colors',
                        isSelected
                          ? 'bg-primary/10 text-foreground'
                          : 'hover:bg-accent hover:text-accent-foreground',
                      )}
                    >
                      <Check
                        className={cn(
                          'mt-0.5 h-3.5 w-3.5 shrink-0',
                          isSelected ? 'text-primary opacity-100' : 'opacity-0',
                        )}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate font-medium">{m.name}</span>
                          {m.featured && (
                            <Sparkles className="h-3 w-3 shrink-0 text-amber-500" />
                          )}
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
                          <span className="font-mono">{m.id}</span>
                          {m.recommendedApi && m.recommendedApi !== 'chat-completions' && (
                            <span className="rounded bg-muted px-1 py-0.2">
                              {m.recommendedApi}
                            </span>
                          )}
                        </div>
                      </div>
                    </button>
                  );
                })
              )}

              {value && !selectedModel && !loading && (
                <button
                  type="button"
                  role="option"
                  aria-selected
                  onClick={() => setOpen(false)}
                  className="mt-1 flex w-full items-start gap-2 rounded-md border-t border-border bg-primary/5 px-2.5 py-2 text-left text-xs"
                >
                  <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{value}</div>
                    <div className="text-[10px] text-muted-foreground">
                      Identificador salvo atualmente
                    </div>
                  </div>
                </button>
              )}
            </div>

            {source && (
              <div className="flex items-center justify-between border-t border-border bg-muted/40 px-2.5 py-1 text-[10px] text-muted-foreground">
                <span>
                  Catálogo:{' '}
                  {source === 'live'
                    ? 'API oficial (ao vivo)'
                    : source === 'cache'
                      ? 'Cache do servidor'
                      : source === 'fallback'
                        ? 'Fallback local'
                        : 'Catálogo do provedor'}
                </span>
                {onRefresh && (
                  <button
                    type="button"
                    onClick={() => onRefresh()}
                    className="font-medium text-primary hover:underline"
                  >
                    Atualizar
                  </button>
                )}
              </div>
            )}
          </div>,
          document.body,
        )
      : null;

  return (
    <div ref={containerRef} className={cn('relative w-full', className)}>
      <div className="flex items-center gap-1.5">
        <button
          ref={triggerRef}
          type="button"
          disabled={disabled}
          aria-expanded={open}
          aria-haspopup="listbox"
          onClick={() => setOpen((prev) => !prev)}
          className={cn(
            'flex w-full min-w-0 items-center justify-between gap-2 text-left ring-offset-background transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
            'disabled:cursor-not-allowed disabled:opacity-50',
            playgroundLabel
              ? 'h-auto rounded-xl border border-border/70 bg-background/60 py-1.5 pr-3 pl-2 shadow-none hover:bg-background/80'
              : 'h-10 rounded-md border border-input bg-background px-3 py-2 text-sm hover:bg-accent/40',
          )}
        >
          {playgroundLabel ? (
            <>
              <div className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                {loading ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Cpu className="size-4" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[10px] leading-none font-medium tracking-wide text-muted-foreground uppercase">
                  {playgroundLabel}
                </p>
                <p className="mt-1 truncate text-xs font-semibold leading-none text-foreground">
                  {selectedModel ? selectedModel.name : value || placeholder}
                </p>
              </div>
            </>
          ) : (
            <span className="flex min-w-0 flex-1 items-center gap-2">
              {loading ? (
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
              ) : null}
              <span className="truncate font-medium text-foreground">
                {selectedModel ? selectedModel.name : value || placeholder}
              </span>
              {selectedModel && selectedModel.name !== selectedModel.id && (
                <span className="hidden truncate font-mono text-[11px] text-muted-foreground sm:inline">
                  ({selectedModel.id})
                </span>
              )}
            </span>
          )}
          <ChevronDown
            className={cn(
              'h-4 w-4 shrink-0 text-muted-foreground transition-transform',
              open && 'rotate-180',
            )}
          />
        </button>

        {onRefresh && (
          <Button
            type="button"
            variant="outline"
            size="icon"
            disabled={disabled || refreshing || loading}
            title="Atualizar catálogo de modelos"
            aria-label="Atualizar catálogo de modelos"
            onClick={(e) => {
              e.stopPropagation();
              onRefresh();
            }}
            className={cn(
              'shrink-0',
              playgroundLabel ? 'h-[46px] w-[46px] rounded-xl border-border/70 bg-background/60' : 'h-10 w-10',
            )}
          >
            <RefreshCw className={cn('h-3.5 w-3.5', (refreshing || loading) && 'animate-spin')} />
          </Button>
        )}
      </div>

      {dropdownContent}
    </div>
  );
}
