'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { Loader2, CheckCircle2, RefreshCw } from 'lucide-react';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';

interface MetaCapiQualifyButtonProps {
  conversationId?: string | null;
  contactId?: string | null;
  initialQualifiedAt?: string | null;
  hasCtwaClid?: boolean;
  onQualified?: (qualifiedAt: string) => void;
  className?: string;
}

function MetaInfinityIcon({ className = 'size-3.5' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M18.178 8c5.096 0 5.096 8 0 8-5.095 0-7.267-8-12.356-8-5.096 0-5.096 8 0 8 5.09 0 7.261-8 12.356-8Z" />
    </svg>
  );
}

export function MetaCapiQualifyButton({
  conversationId,
  contactId,
  initialQualifiedAt,
  hasCtwaClid,
  onQualified,
  className = '',
}: MetaCapiQualifyButtonProps) {
  const [qualifiedAt, setQualifiedAt] = useState<string | null>(
    initialQualifiedAt ?? null
  );
  const [loading, setLoading] = useState(false);
  const [knownHasClid, setKnownHasClid] = useState<boolean | undefined>(
    hasCtwaClid
  );

  // Sincroniza se a prop mudar
  useEffect(() => {
    if (initialQualifiedAt !== undefined) {
      setQualifiedAt(initialQualifiedAt);
    }
  }, [initialQualifiedAt]);

  useEffect(() => {
    if (hasCtwaClid !== undefined) {
      setKnownHasClid(hasCtwaClid);
    }
  }, [hasCtwaClid]);

  // Se não foi fornecido initialQualifiedAt nem hasCtwaClid, busca status leve via GET
  useEffect(() => {
    if (initialQualifiedAt === undefined && (conversationId || contactId)) {
      const param = conversationId
        ? `conversationId=${conversationId}`
        : `contactId=${contactId}`;
      fetch(`/api/meta-capi/qualify-lead?${param}`)
        .then((r) => r.json())
        .then((data) => {
          if (data && !data.error) {
            if (data.qualified_at) setQualifiedAt(data.qualified_at);
            if (data.has_ctwa_clid !== undefined) setKnownHasClid(data.has_ctwa_clid);
          }
        })
        .catch(() => {
          // Falha silenciosa na consulta inicial
        });
    }
  }, [conversationId, contactId, initialQualifiedAt]);

  async function handleQualify() {
    if (!conversationId && !contactId) return;

    setLoading(true);
    try {
      const res = await fetch('/api/meta-capi/qualify-lead', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId, contactId }),
      });

      const data = await res.json();

      if (!res.ok || !data.ok) {
        throw new Error(data.error || 'Falha ao qualificar lead na Meta');
      }

      const now = data.qualified_at || new Date().toISOString();
      setQualifiedAt(now);
      setKnownHasClid(true);
      toast.success('Lead qualificado comunicado à Meta com sucesso! (CAPI)');
      if (onQualified) onQualified(now);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Erro ao qualificar lead';
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  }

  const formattedDate = qualifiedAt
    ? format(new Date(qualifiedAt), "dd/MM 'às' HH:mm", { locale: ptBR })
    : null;

  return (
    <div className={`space-y-1.5 ${className}`}>
      {qualifiedAt ? (
        <div className="flex items-center justify-between gap-2 rounded-xl border border-emerald-500/25 bg-emerald-500/10 p-2.5 text-xs">
          <div className="flex items-center gap-2 min-w-0">
            <CheckCircle2 className="size-4 shrink-0 text-emerald-400" />
            <div className="min-w-0">
              <p className="font-semibold text-emerald-400 truncate text-[11px] leading-tight">
                Qualificado na Meta
              </p>
              {formattedDate && (
                <p className="text-[10px] text-muted-foreground truncate">
                  Enviado em {formattedDate}
                </p>
              )}
            </div>
          </div>

          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={handleQualify}
            disabled={loading}
            title="Reenviar evento QualifiedLead à Meta Conversions API"
            className="h-7 px-2 text-[10px] text-muted-foreground hover:text-foreground shrink-0 gap-1"
          >
            {loading ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <RefreshCw className="size-3" />
            )}
            <span>Reenviar</span>
          </Button>
        </div>
      ) : (
        <div className="space-y-1">
          <Button
            type="button"
            onClick={handleQualify}
            disabled={loading}
            size="sm"
            className="w-full bg-[#0081FB] hover:bg-[#0074e4] text-white flex items-center justify-center gap-2 text-xs font-semibold shadow-sm transition-all rounded-xl h-9"
          >
            {loading ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                <span>Comunicando à Meta...</span>
              </>
            ) : (
              <>
                <MetaInfinityIcon className="size-4 shrink-0" />
                <span>Qualificar Lead na Meta</span>
              </>
            )}
          </Button>

          {knownHasClid === false && (
            <p className="text-[10px] text-muted-foreground/80 px-1 text-center">
              Requer que o lead tenha chegado via anúncio da Meta (CTWA).
            </p>
          )}
        </div>
      )}
    </div>
  );
}
