'use client';

import { useState } from 'react';
import { Loader2, Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface ResponseStyleInstructionsEditorProps {
  instructions: string[];
  loading?: boolean;
  /** Called with the new instruction's text. May persist immediately
   *  (Playground: save on every add) or just update local state for a
   *  later batch save (Comportamento: saved together with the rest of
   *  the form) — the component only cares that the promise settles. */
  onAdd: (text: string) => Promise<void>;
  onRemove: (index: number) => Promise<void>;
  placeholder?: string;
  emptyLabel?: string;
  className?: string;
}

/**
 * Each response-style instruction is its own removable item — reversing
 * one ("mudei de ideia") is a single click here, instead of hand-editing
 * a shared text blob. Shared between the Playground (instant save per
 * action) and the Comportamento tab (batched with the rest of the form).
 */
export function ResponseStyleInstructionsEditor({
  instructions,
  loading = false,
  onAdd,
  onRemove,
  placeholder = 'Ex: Responda em no máximo 2 frases curtas.',
  emptyLabel = 'Nenhuma instrução salva ainda.',
  className,
}: ResponseStyleInstructionsEditorProps) {
  const [draft, setDraft] = useState('');
  const [adding, setAdding] = useState(false);
  const [removingIndex, setRemovingIndex] = useState<number | null>(null);

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

      <div className="mt-3 flex-1 min-h-0 overflow-y-auto space-y-1.5">
        {loading ? (
          <p className="text-xs text-muted-foreground">Carregando...</p>
        ) : instructions.length === 0 ? (
          <p className="text-xs text-muted-foreground">{emptyLabel}</p>
        ) : (
          instructions.map((instr, i) => (
            <div
              key={i}
              className="flex items-start gap-2 rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-xs text-foreground"
            >
              <span className="flex-1 leading-relaxed whitespace-pre-wrap">{instr}</span>
              <button
                type="button"
                onClick={() => void handleRemove(i)}
                disabled={removingIndex !== null}
                className="shrink-0 text-muted-foreground hover:text-destructive disabled:opacity-40 cursor-pointer"
                title="Remover instrução"
              >
                {removingIndex === i ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <X className="h-3.5 w-3.5" />
                )}
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
