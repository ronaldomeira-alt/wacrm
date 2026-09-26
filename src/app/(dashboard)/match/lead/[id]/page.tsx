'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { SearchProfileTag } from '@/components/contacts/search-profile-tag';
import { toast } from 'sonner';
import {
  ArrowLeft,
  User,
  Phone,
  Gauge,
  Flame,
  CheckCircle2,
  AlertCircle,
  PauseCircle,
  Archive,
  PlayCircle,
  Building2,
  ExternalLink,
  Loader2,
  Calendar,
  Sparkles,
  ShoppingBag,
  Eye,
  Check,
  ChevronRight,
  Send,
} from 'lucide-react';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';

interface LeadDetailsData {
  lead: {
    id: string;
    name: string;
    phone: string;
    aiScore: number;
    isPaused: boolean;
    isArchived: boolean;
    hasPurchased?: boolean;
  };
  searchProfile: {
    operation: string;
    purpose: string[];
    propertyTypes: string[];
    propertyTypeStrict: boolean;
    locations: string[];
    locationStrict: boolean;
    priceMin: number | null;
    priceMax: number | null;
    priceStrictMax: boolean;
    priceFlexMax: number | null;
    bedrooms: number[];
    bedroomsStrict: boolean;
    deliveryStatus: string[];
    deliveryStrict: boolean;
    requiredFeatures: string[];
    preferredFeatures: string[];
    provenance: Record<string, string>;
  };
  maturity: {
    maturity: number;
    meetsThreshold: boolean;
    dimensions: Record<
      string,
      {
        baseWeight: number;
        normalizedWeight: number;
        earnedPoints: number;
        provenance: string;
        hasValue: boolean;
      }
    >;
  };
  tags: Array<{
    id: string;
    name: string;
    color: string;
    category?: string;
    source: string;
    originallyFromCtwa: boolean;
  }>;
  sentProperties: Array<{
    id: string;
    propertyId: string;
    propertyTitle: string;
    propertyNeighborhood: string;
    propertyCoverUrl?: string | null;
    sentAt: string;
    firstOpenedAt?: string | null;
    lastOpenedAt?: string | null;
    openCount: number;
    isInterested: boolean;
    interestedAt?: string | null;
  }>;
}

export default function LeadMatchProfilePage() {
  const params = useParams();
  const router = useRouter();
  const leadId = params?.id as string;

  const [data, setData] = useState<LeadDetailsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);

  const fetchLeadDetails = useCallback(async () => {
    if (!leadId) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/match/lead/${leadId}`);
      if (!res.ok) throw new Error('Falha ao carregar perfil do lead');
      const json = await res.json();
      setData(json);
    } catch (err) {
      console.error(err);
      toast.error('Erro ao carregar perfil comercial do lead');
    } finally {
      setLoading(false);
    }
  }, [leadId]);

  useEffect(() => {
    fetchLeadDetails();
  }, [fetchLeadDetails]);

  async function handleCycleAction(action: 'pause' | 'resume' | 'archive' | 'unarchive') {
    if (!leadId) return;
    setActionLoading(true);
    try {
      const res = await fetch(`/api/match/lead/${leadId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) throw new Error('Falha ao atualizar status');
      toast.success('Status do lead atualizado!');
      await fetchLeadDetails();
    } catch (err) {
      toast.error((err as Error).message || 'Erro ao atualizar');
    } finally {
      setActionLoading(false);
    }
  }

  const initials = (data?.lead.name || 'Lead')
    .split(' ')
    .filter(Boolean)
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  const totalSent = data?.sentProperties.length || 0;
  const lastSent = data?.sentProperties[0]?.sentAt
    ? format(new Date(data.sentProperties[0].sentAt), "dd/MM 'às' HH:mm", { locale: ptBR })
    : null;
  const openedSentCount = data?.sentProperties.filter((sp) => sp.openCount > 0).length || 0;

  return (
    <div className="-m-4 sm:-m-6 flex flex-col min-h-[calc(100%+2rem)] sm:min-h-[calc(100%+3rem)] bg-background text-foreground">
      {/* 1. Page Header Integrado ao Topo (sem gaps ou faixa cinza solta) */}
      <div className="border-b border-border bg-card/50 backdrop-blur-md px-6 sm:px-8 py-4">
        {/* Breadcrumb */}
        <div className="flex items-center gap-2 text-xs text-muted-foreground mb-3">
          <Link href="/match" className="hover:text-primary transition-colors flex items-center gap-1 font-medium">
            <ArrowLeft className="size-3" />
            <span>Central Match</span>
          </Link>
          <ChevronRight className="size-3 text-muted-foreground/60" />
          <span className="text-foreground font-semibold truncate max-w-[240px]">
            {data?.lead.name || 'Carregando lead...'}
          </span>
        </div>

        {/* Lead Profile Header */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-center gap-3.5">
            <div className="size-12 rounded-full bg-primary/10 border border-primary/25 text-primary font-bold text-sm flex items-center justify-center shrink-0">
              {initials}
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-xl font-bold tracking-tight text-foreground">
                  {data?.lead.name || (loading ? 'Carregando perfil...' : 'Lead')}
                </h1>
                {data?.lead.isPaused && (
                  <span className="rounded-full bg-amber-500/10 border border-amber-500/25 px-2.5 py-0.5 text-xs font-semibold text-amber-400">
                    Pausado
                  </span>
                )}
                {data?.lead.isArchived && (
                  <span className="rounded-full bg-muted border border-border px-2.5 py-0.5 text-xs font-semibold text-muted-foreground">
                    Arquivado
                  </span>
                )}
                {data?.lead.hasPurchased && (
                  <span className="rounded-full bg-emerald-500/10 border border-emerald-500/25 px-2.5 py-0.5 text-xs font-semibold text-emerald-400">
                    Já comprou
                  </span>
                )}
              </div>
              <p className="text-xs text-muted-foreground font-mono flex items-center gap-1.5 mt-0.5">
                <Phone className="size-3 text-muted-foreground/80" />
                {data?.lead.phone || '—'}
              </p>
            </div>
          </div>

          {/* Action Buttons */}
          <div className="flex items-center gap-2 flex-wrap">
            {data?.lead.isPaused ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => handleCycleAction('resume')}
                disabled={actionLoading}
                className="gap-1.5 text-xs text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/10"
              >
                <PlayCircle className="size-3.5" />
                Reativar Lead
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                onClick={() => handleCycleAction('pause')}
                disabled={actionLoading}
                className="gap-1.5 text-xs text-amber-400 border-amber-500/30 hover:bg-amber-500/10"
              >
                <PauseCircle className="size-3.5" />
                Pausar Matches
              </Button>
            )}

            {data?.lead.isArchived ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => handleCycleAction('unarchive')}
                disabled={actionLoading}
                className="gap-1.5 text-xs"
              >
                Desarquivar
              </Button>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => handleCycleAction('archive')}
                disabled={actionLoading}
                className="gap-1.5 text-xs text-muted-foreground hover:text-foreground"
              >
                <Archive className="size-3.5" />
                Arquivar
              </Button>
            )}

            <Button
              size="sm"
              variant="outline"
              onClick={() => router.push('/match')}
              className="gap-1.5 text-xs"
            >
              <ArrowLeft className="size-3.5" />
              Voltar
            </Button>
          </div>
        </div>
      </div>

      {/* 2. Conteúdo Principal da Página (w-full com gutters laterais elegantes de 24-32px) */}
      <div className="flex-1 p-6 sm:p-8 space-y-6 w-full">
        {loading ? (
          <div className="flex h-64 flex-col items-center justify-center gap-2">
            <Loader2 className="size-8 animate-spin text-primary" />
            <p className="text-xs text-muted-foreground">Carregando diagnóstico do perfil...</p>
          </div>
        ) : !data ? (
          <div className="flex h-64 flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-card/50 p-8 text-center">
            <AlertCircle className="size-8 text-muted-foreground/60 mb-2" />
            <h3 className="text-sm font-semibold text-foreground">Perfil não encontrado</h3>
            <p className="text-xs text-muted-foreground max-w-sm mt-1">
              Não foi possível localizar os dados comerciais deste lead.
            </p>
          </div>
        ) : (
          <div className="space-y-6 w-full">
            {/* Notificação Especial: Lead que já comprou */}
            {data.lead.hasPurchased && (
              <div className="rounded-xl border border-primary/30 bg-primary/5 p-4 text-xs">
                <div className="flex items-center gap-2 font-semibold text-foreground">
                  <ShoppingBag className="size-4 text-primary" />
                  Cliente já comprou com você anteriormente!
                </div>
                <p className="mt-1 text-muted-foreground">
                  O ciclo de recomendações pode ser encerrado ou mantido para futuras oportunidades de investimento.
                </p>
              </div>
            )}

            {/* SEÇÃO 1: LINHA DE 3 CARDS SUPERIORES BALANCEADOS (Desktop: 3 colunas, Mobile: 1 coluna) */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 sm:gap-6 w-full">
              {/* Card 1: Temperatura Comercial */}
              <Card className="p-4 bg-card/80 border-border/80 rounded-xl flex flex-col justify-between">
                <div>
                  <div className="flex items-center justify-between text-xs">
                    <span className="flex items-center gap-1.5 font-semibold text-foreground">
                      <Flame className="size-4 text-amber-500" />
                      Temperatura Comercial
                    </span>
                    <span className="font-bold text-foreground">{data.lead.aiScore} / 10</span>
                  </div>
                  <div className="mt-2.5 h-2 w-full rounded-full bg-muted overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-amber-500 to-rose-500 rounded-full transition-all"
                      style={{ width: `${(data.lead.aiScore / 10) * 100}%` }}
                    />
                  </div>
                </div>
                <p className="mt-3 text-[11px] text-muted-foreground">
                  Engajamento e momento de compra apurado pelas conversas no WhatsApp.
                </p>
              </Card>

              {/* Card 2: Maturidade do Perfil */}
              <Card className="p-4 bg-card/80 border-border/80 rounded-xl flex flex-col justify-between">
                <div>
                  <div className="flex items-center justify-between text-xs">
                    <span className="flex items-center gap-1.5 font-semibold text-foreground">
                      <Gauge className="size-4 text-blue-500" />
                      Maturidade do Perfil
                    </span>
                    <span className="font-bold text-foreground">{data.maturity.maturity}%</span>
                  </div>
                  <div className="mt-2.5 h-2 w-full rounded-full bg-muted overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${
                        data.maturity.meetsThreshold ? 'bg-emerald-500' : 'bg-blue-500'
                      }`}
                      style={{ width: `${data.maturity.maturity}%` }}
                    />
                  </div>
                </div>
                <p className="mt-3 text-[11px] text-muted-foreground">
                  {data.maturity.meetsThreshold
                    ? '🎯 Apto para recomendações automáticas (≥ 70%)'
                    : '⏳ Em qualificação comercial (< 70%)'}
                </p>
              </Card>

              {/* Card 3: Imóveis Enviados */}
              <Card className="p-4 bg-card/80 border-border/80 rounded-xl flex flex-col justify-between">
                <div>
                  <div className="flex items-center justify-between text-xs">
                    <span className="flex items-center gap-1.5 font-semibold text-foreground">
                      <Send className="size-4 text-emerald-500" />
                      Imóveis Enviados
                    </span>
                    <span className="font-bold text-foreground">
                      {totalSent} {totalSent === 1 ? 'imóvel' : 'imóveis'}
                    </span>
                  </div>
                  <div className="mt-2.5 flex items-center justify-between text-xs">
                    <span className="text-muted-foreground text-[11px]">
                      {lastSent ? `Último: ${lastSent}` : 'Nenhum envio registrado'}
                    </span>
                    {totalSent > 0 && (
                      <span className="rounded-full bg-emerald-500/10 border border-emerald-500/25 px-2 py-0.5 text-[10px] font-semibold text-emerald-400">
                        {openedSentCount} visualizado(s)
                      </span>
                    )}
                  </div>
                </div>
                <p className="mt-3 text-[11px] text-muted-foreground">
                  {totalSent > 0
                    ? 'Histórico de compartilhamentos via links rastreáveis do WhatsApp.'
                    : 'Nenhum imóvel foi enviado via WhatsApp até o momento.'}
                </p>
              </Card>
            </div>

            {/* SEÇÃO 2: DIAGNÓSTICO DAS 8 DIMENSÕES DE QUALIFICAÇÃO (GRID 4 COLUNAS EM DESKTOP) */}
            <Card className="p-5 bg-card/80 border-border/80 rounded-xl space-y-4 w-full">
              <div className="flex items-center justify-between border-b border-border/60 pb-2.5">
                <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                  <Sparkles className="size-4 text-primary" />
                  Diagnóstico das 8 Dimensões de Qualificação
                </h3>
                <span className="text-xs text-muted-foreground font-medium">Pesos Canônicos de Maturidade</span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 text-xs w-full">
                {Object.entries(data.maturity.dimensions || {}).map(([key, dim]) => {
                  const labelMap: Record<string, string> = {
                    operation: 'Operação (Compra/Aluguel)',
                    purpose: 'Finalidade (Moradia/Invest.)',
                    propertyTypes: 'Tipologias Desejadas',
                    locations: 'Localização / Bairros',
                    price: 'Faixa de Preço / Teto',
                    bedrooms: 'Quantidade de Quartos',
                    delivery: 'Fase de Entrega',
                    features: 'Comodidades / Diferenciais',
                  };

                  return (
                    <div
                      key={key}
                      className={`flex flex-col justify-between p-3 rounded-lg border text-xs gap-2 ${
                        dim.hasValue
                          ? 'bg-emerald-500/5 border-emerald-500/25 text-foreground'
                          : 'bg-muted/20 border-border/50 text-muted-foreground'
                      }`}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        {dim.hasValue ? (
                          <CheckCircle2 className="size-4 text-emerald-400 shrink-0" />
                        ) : (
                          <div className="size-4 rounded-full border border-border shrink-0" />
                        )}
                        <span className="truncate text-xs font-semibold">
                          {labelMap[key] || key}
                        </span>
                      </div>

                      <div className="flex items-center justify-between pt-1 border-t border-border/40 text-[11px]">
                        <span className="font-mono font-semibold">
                          {dim.earnedPoints} / {dim.normalizedWeight} pts
                        </span>
                        {dim.provenance && (
                          <span
                            className={`rounded px-1.5 py-0.2 font-mono text-[10px] ${
                              dim.provenance === 'ctwa'
                                ? 'bg-blue-500/10 text-blue-400 border border-blue-500/20'
                                : 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                            }`}
                          >
                            {dim.provenance}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </Card>

            {/* SEÇÃO 3: DUAS COLUNAS PRINCIPAIS BALANCEADAS (Desktop: 2 colunas, Mobile: 1 coluna) */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 w-full">
              {/* Coluna 1: Requisitos & Preferências + Tags */}
              <div className="space-y-6">
                {/* Requisitos Eliminatórios vs Preferências */}
                <Card className="p-5 bg-card/80 border-border/80 rounded-xl space-y-4">
                  <h3 className="text-sm font-semibold text-foreground">Requisitos Eliminatórios vs Preferências</h3>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
                    {/* Requisitos Obrigatórios */}
                    <div className="rounded-lg border border-border/70 bg-muted/20 p-3.5 space-y-2.5">
                      <div className="flex items-center gap-1.5 font-semibold text-rose-400 text-xs">
                        <AlertCircle className="size-3.5" />
                        Requisitos Eliminatórios
                      </div>
                      <ul className="space-y-1.5 text-[11px] text-foreground">
                        <li>
                          • Operação: <strong>{data.searchProfile.operation === 'venda' ? 'Compra' : 'Locação'}</strong>
                        </li>
                        {data.searchProfile.propertyTypeStrict && data.searchProfile.propertyTypes.length > 0 && (
                          <li>• Tipologia estrita: <strong>{data.searchProfile.propertyTypes.join(', ')}</strong></li>
                        )}
                        {data.searchProfile.locationStrict && data.searchProfile.locations.length > 0 && (
                          <li>• Bairro estrito: <strong>{data.searchProfile.locations.join(', ')}</strong></li>
                        )}
                        {data.searchProfile.priceStrictMax && data.searchProfile.priceMax && (
                          <li>• Teto absoluto: <strong>R$ {data.searchProfile.priceMax.toLocaleString('pt-BR')}</strong></li>
                        )}
                        {data.searchProfile.bedroomsStrict && data.searchProfile.bedrooms.length > 0 && (
                          <li>• Quartos mínimos: <strong>{Math.min(...data.searchProfile.bedrooms)} quarto(s)</strong></li>
                        )}
                        {data.searchProfile.deliveryStrict && data.searchProfile.deliveryStatus.length > 0 && (
                          <li>• Entrega: <strong>{data.searchProfile.deliveryStatus.join(', ')}</strong></li>
                        )}
                        {data.searchProfile.requiredFeatures.map((f, i) => (
                          <li key={i}>• Obrigatório: <strong>{f}</strong></li>
                        ))}
                        {!data.searchProfile.propertyTypeStrict &&
                          !data.searchProfile.locationStrict &&
                          !data.searchProfile.priceStrictMax &&
                          !data.searchProfile.bedroomsStrict &&
                          data.searchProfile.requiredFeatures.length === 0 && (
                            <li className="text-muted-foreground italic">Nenhum requisito eliminatório rígido.</li>
                          )}
                      </ul>
                    </div>

                    {/* Preferências Informadas */}
                    <div className="rounded-lg border border-border/70 bg-muted/20 p-3.5 space-y-2.5">
                      <div className="flex items-center gap-1.5 font-semibold text-emerald-400 text-xs">
                        <CheckCircle2 className="size-3.5" />
                        Preferências Informadas
                      </div>
                      <ul className="space-y-1.5 text-[11px] text-foreground">
                        {data.searchProfile.locations.length > 0 && (
                          <li>• Bairros de interesse: {data.searchProfile.locations.join(', ')}</li>
                        )}
                        {data.searchProfile.propertyTypes.length > 0 && (
                          <li>• Tipologias: {data.searchProfile.propertyTypes.join(', ')}</li>
                        )}
                        {data.searchProfile.priceMax && (
                          <li>• Orçamento alvo: R$ {data.searchProfile.priceMax.toLocaleString('pt-BR')}</li>
                        )}
                        {data.searchProfile.bedrooms.length > 0 && (
                          <li>• Quartos aceitos: {data.searchProfile.bedrooms.join(', ')}</li>
                        )}
                        {data.searchProfile.preferredFeatures.map((f, i) => (
                          <li key={i}>• Deseja: {f}</li>
                        ))}
                      </ul>
                    </div>
                  </div>
                </Card>

                {/* Tags do Perfil de Busca */}
                <Card className="p-5 bg-card/80 border-border/80 rounded-xl space-y-3">
                  <div className="flex items-center justify-between text-xs font-semibold text-foreground">
                    <span>Tags do Perfil de Busca</span>
                    <div className="flex items-center gap-2 text-[10px]">
                      <span className="inline-flex items-center gap-1 text-blue-400">
                        <span className="size-1.5 rounded-full bg-blue-400" />
                        Anúncio (CTWA)
                      </span>
                      <span className="inline-flex items-center gap-1 text-emerald-400">
                        <span className="size-1.5 rounded-full bg-emerald-400" />
                        Conversa
                      </span>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {data.tags.length === 0 ? (
                      <p className="text-xs text-muted-foreground italic">Nenhuma tag cadastrada.</p>
                    ) : (
                      data.tags.map((t) => (
                        <SearchProfileTag
                          key={t.id}
                          name={t.name}
                          category={t.category}
                          color={t.color}
                          source={t.source}
                          originallyFromCtwa={t.originallyFromCtwa}
                        />
                      ))
                    )}
                  </div>
                </Card>
              </div>

              {/* Coluna 2: Imóveis Enviados & Histórico de Interação */}
              <div>
                <Card className="p-5 bg-card/80 border-border/80 rounded-xl space-y-4">
                  <div className="flex items-center justify-between border-b border-border/60 pb-2.5">
                    <h3 className="text-sm font-semibold text-foreground">
                      Histórico de Imóveis Enviados ({totalSent})
                    </h3>
                    {lastSent && (
                      <span className="text-xs text-muted-foreground">Último envio: {lastSent}</span>
                    )}
                  </div>

                  {data.sentProperties.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-border/70 p-8 text-center text-xs text-muted-foreground">
                      <Building2 className="size-8 text-muted-foreground/40 mx-auto mb-2" />
                      <p className="font-medium text-foreground">Nenhum imóvel enviado ainda</p>
                      <p className="text-[11px] text-muted-foreground mt-0.5">
                        Os imóveis compartilhados pelo WhatsApp com link rastreável aparecerão aqui.
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {data.sentProperties.map((sp) => (
                        <div
                          key={sp.id}
                          className="rounded-lg border border-border/70 bg-muted/20 p-3.5 space-y-2.5 text-xs"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="flex gap-3 min-w-0">
                              <div className="size-12 rounded-md overflow-hidden bg-muted border border-border/60 shrink-0 relative">
                                {sp.propertyCoverUrl ? (
                                  // eslint-disable-next-line @next/next/no-img-element
                                  <img
                                    src={sp.propertyCoverUrl}
                                    alt={sp.propertyTitle}
                                    className="size-full object-cover"
                                  />
                                ) : (
                                  <div className="size-full flex items-center justify-center text-muted-foreground">
                                    <Building2 className="size-5" />
                                  </div>
                                )}
                              </div>
                              <div className="min-w-0">
                                <h5 className="font-semibold text-foreground truncate" title={sp.propertyTitle}>
                                  {sp.propertyTitle}
                                </h5>
                                <p className="text-[11px] text-muted-foreground truncate">
                                  {sp.propertyNeighborhood}
                                </p>
                                <p className="text-[10px] text-muted-foreground mt-0.5">
                                  Enviado em {format(new Date(sp.sentAt), "dd/MM/yyyy 'às' HH:mm", { locale: ptBR })}
                                </p>
                              </div>
                            </div>

                            {sp.isInterested && (
                              <span className="inline-flex items-center gap-1 rounded-full bg-rose-500/10 border border-rose-500/20 px-2 py-0.5 text-[10px] font-bold text-rose-400 shrink-0">
                                🔥 Interesse
                              </span>
                            )}
                          </div>

                          {/* Métricas de Abertura / Tracking */}
                          <div className="grid grid-cols-2 gap-2 pt-2 border-t border-border/60 text-[11px]">
                            <div>
                              <span className="text-muted-foreground">Abriu link: </span>
                              <span className="font-medium text-foreground">
                                {sp.openCount > 0 ? `Sim (${sp.openCount}x)` : 'Não'}
                              </span>
                            </div>
                            <div>
                              <span className="text-muted-foreground">Última abertura: </span>
                              <span className="font-medium text-foreground">
                                {sp.lastOpenedAt
                                  ? format(new Date(sp.lastOpenedAt), 'dd/MM HH:mm', { locale: ptBR })
                                  : '—'}
                              </span>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </Card>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
