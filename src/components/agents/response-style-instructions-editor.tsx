'use client';

import { useMemo, useState } from 'react';
import { Loader2, Plus, X, Pencil, Check, ChevronDown, ChevronUp, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface ResponseStyleInstructionsEditorProps {
  instructions: string[];
  loading?: boolean;
  /** Called with the new instruction's text. May persist immediately
   *  (Playground: save on every add) or just update local state for a
   *  later batch save (Comportamento: saved together with the rest of
   *  the form) — the component only cares that the promise settles. */
  onAdd: (text: string) => Promise<void>;
  onRemove: (index: number) => Promise<void>;
  /** Replaces the text at `index` in place (same array position) — never
   *  remove-and-append-at-end, so editing doesn't reorder the list. */
  onEdit: (index: number, text: string) => Promise<void>;
  placeholder?: string;
  emptyLabel?: string;
  className?: string;
  /** Show the substring filter once the list passes this length. Filtering
   *  only changes what's rendered — never the underlying stored order. */
  searchThreshold?: number;
}

/**
 * Each response-style instruction is its own item, with three per-item
 * actions: expand/collapse (read the full text), edit in place (same array
 * index — not remove+recreate), and remove. Shared between the Playground,
 * the Comportamento tab, and the per-property knowledge dialog.
 */
export function ResponseStyleInstructionsEditor({
  instructions,
  loading = false,
  onAdd,
  onRemove,
  onEdit,
  placeholder = 'Ex: Responda em no máximo 2 frases curtas.',
  emptyLabel = 'Nenhuma instrução salva ainda.',
  className,
  searchThreshold = 8,
}: ResponseStyleInstructionsEditorProps) {
  const [draft, setDraft] = useState('');
  const [adding, setAdding] = useState(false);
  const [removingIndex, setRemovingIndex] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);
  const [search, setSearch] = useState('');

  const handleAdd = async () => {
    const trimmed = draft.trim();
    if (!trimmed || adding) return;
    setAdding(true);
    try {
      await onAdd(trimmed);
      setDraft('');
    } finally {
      setAdding(false);
    }
  };

  const handleRemove = async (index: number) => {
    if (removingIndex !== null) return;
    setRemovingIndex(index);
    try {
      await onRemove(index);
    } finally {
      setRemovingIndex(null);
    }
  };

  const startEdit = (index: number) => {
    if (editingIndex !== null) return;
    setEditingIndex(index);
    setEditDraft(instructions[index]);
  };

  const cancelEdit = () => {
    setEditingIndex(null);
    setEditDraft('');
  };

  const saveEdit = async (index: number) => {
    const trimmed = editDraft.trim();
    if (!trimmed || savingEdit) return;
    setSavingEdit(true);
    try {
      await onEdit(index, trimmed);
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

  const visibleIndices = useMemo(() => {
    const all = instructions.map((_, i) => i);
    const q = search.trim().toLowerCase();
    if (!q) return all;
    return all.filter((i) => instructions[i].toLowerCase().includes(q));
  }, [instructions, search]);

  return (
    <div className={className}>
      <div className="flex items-end gap-2 shrink-0">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void handleAdd();
            }
          }}
          disabled={loading}
          placeholder={placeholder}
          rows={2}
          className="flex-1 resize-none rounded-lg border border-border bg-background px-3 py-2 text-xs leading-relaxed text-foreground placeholder-muted-foreground outline-none focus:border-primary/50"
        />
        <Button
          type="button"
          size="sm"
          onClick={() => void handleAdd()}
          disabled={adding || loading || !draft.trim()}
          className="h-9 text-xs shrink-0"
        >
          {adding ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Plus className="mr-1.5 h-3.5 w-3.5" />
          )}
          Adicionar
        </Button>
      </div>

      {!loading && instructions.length > searchThreshold && (
        <div className="mt-3 relative shrink-0">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar instrução..."
            className="w-full rounded-lg border border-border bg-background py-1.5 pl-8 pr-3 text-xs text-foreground placeholder-muted-foreground outline-none focus:border-primary/50"
          />
        </div>
      )}

      <div className="mt-3 flex-1 min-h-0 overflow-y-auto space-y-1.5">
        {loading ? (
          <p className="text-xs text-muted-foreground">Carregando...</p>
        ) : instructions.length === 0 ? (
          <p className="text-xs text-muted-foreground">{emptyLabel}</p>
        ) : visibleIndices.length === 0 ? (
          <p className="text-xs text-muted-foreground">Nenhuma instrução corresponde à busca.</p>
        ) : (
          visibleIndices.map((i) => {
            const instr = instructions[i];
            const isEditing = editingIndex === i;
            const isExpanded = expanded.has(i);

            if (isEditing) {
              return (
                <div
                  key={i}
                  className="rounded-lg border border-primary/40 bg-muted/20 p-2 space-y-2"
                >
                  <textarea
                    value={editDraft}
                    onChange={(e) => setEditDraft(e.target.value)}
                    autoFocus
                    rows={3}
                    className="w-full resize-none rounded-md border border-border bg-background px-2 py-1.5 text-xs leading-relaxed text-foreground outline-none focus:border-primary/50"
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
                      onClick={() => void saveEdit(i)}
                      disabled={savingEdit || !editDraft.trim()}
                      className="h-7 text-xs"
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
                key={i}
                className="flex items-start gap-2 rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-xs text-foreground"
              >
                <span
                  className={cn(
                    'flex-1 min-w-0 leading-relaxed whitespace-pre-wrap',
                    !isExpanded && 'line-clamp-2',
                  )}
                >
                  {instr}
                </span>
                <div className="flex shrink-0 items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => toggleExpanded(i)}
                    className="text-muted-foreground hover:text-foreground cursor-pointer"
                    title={isExpanded ? 'Recolher' : 'Expandir'}
                  >
                    {isExpanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                  </button>
                  <button
                    type="button"
                    onClick={() => startEdit(i)}
                    disabled={removingIndex !== null}
                    className="text-muted-foreground hover:text-primary disabled:opacity-40 cursor-pointer"
                    title="Editar instrução"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleRemove(i)}
                    disabled={removingIndex !== null}
                    className="text-muted-foreground hover:text-destructive disabled:opacity-40 cursor-pointer"
                    title="Remover instrução"
                  >
                    {removingIndex === i ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
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
    </div>
  );
}
