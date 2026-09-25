import React from 'react';
import { CATEGORY_ORDER } from '@/lib/contacts/tag-categories';

export interface SearchProfileTagProps {
  name: string;
  category?: string | null;
  color?: string;
  source?: 'ctwa' | 'conversation' | 'manual' | string;
  originallyFromCtwa?: boolean;
  className?: string;
}

export function isSearchProfileCategory(category?: string | null): boolean {
  if (!category) return false;
  return CATEGORY_ORDER.includes(category.trim());
}

/**
 * Renderiza uma tag com diferenciação visual estrita de proveniência (FASE 2):
 * - Tags do perfil de busca:
 *   - AZUL = herdada do CTWA / anúncio
 *   - VERDE = aprendida ou confirmada na conversa / manual
 * - Tags de outras categorias preservam sua cor semântica original.
 */
export function SearchProfileTag({
  name,
  category,
  color = '#3b82f6',
  source = 'conversation',
  originallyFromCtwa = false,
  className = '',
}: SearchProfileTagProps) {
  const isProfileTag = isSearchProfileCategory(category);

  if (isProfileTag) {
    const isCtwa = source === 'ctwa';
    if (isCtwa) {
      return (
        <span
          title="Origem: herdada do anúncio (CTWA)"
          className={`inline-flex items-center gap-1 rounded-full border border-blue-500/30 bg-blue-500/10 px-2 py-0.5 text-[10px] font-medium text-blue-400 ${className}`}
        >
          <span className="size-1.5 rounded-full bg-blue-400" />
          {name}
        </span>
      );
    }

    // Conversa ou manual = Verde
    return (
      <span
        title={originallyFromCtwa ? 'Origem: confirmada na conversa (originada do CTWA)' : 'Origem: confirmada na conversa'}
        className={`inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-400 ${className}`}
      >
        <span className="size-1.5 rounded-full bg-emerald-400" />
        {name}
      </span>
    );
  }

  // Tags não pertencentes ao perfil de busca preservam sua cor livre original
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${className}`}
      style={{
        backgroundColor: `${color}20`,
        color,
      }}
    >
      {name}
    </span>
  );
}
