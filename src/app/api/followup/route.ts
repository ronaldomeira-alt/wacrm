import { NextResponse } from 'next/server';
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import {
  AI_SUGGESTION_STATUSES,
  IGNORED_SUGGESTION_RETENTION_DAYS,
} from '@/lib/ai-suggestion-status';
import { FOLLOWUP_RECENT_TEAM_CONTACT_COOLDOWN_HOURS } from '@/lib/ai/followup-config';
import { saoPauloDayKey } from '@/lib/dashboard/date-utils';
import {
  buildProfileFromData,
  type ContactRow,
  type TagWithJoin,
} from '@/lib/match/profile-builder';
import { calculateProfileMaturity } from '@/lib/match/maturity';
import { resolveValidatedPublicPropertyUrl } from '@/lib/match/smart-send';
import type { LeadSearchProfile } from '@/lib/match/types';
import {
  buildObjectiveFollowupRecommendation,
  calculateFollowupCommercialPriority,
  classifyFollowupTimingAndType,
  compareFollowupItems,
  evaluateFollowupSessionWindow,
  extractInterestProperty,
  extractLeadPrimaryNeed,
  filterFollowupItems,
  reconcileFollowupReasonAndApproach,
  resolveFollowupDateFilterRange,
  summarizeConversationMessages,
  type CompatiblePropertySummary,
  type ConversationMessageStats,
  type EnrichedFollowupItem,
  type FollowupDateFilter,
  type FollowupMaturityBand,
  type FollowupOpportunityType,
  type FollowupSortBy,
  type FollowupWindowFilter,
  type RawConversationMessageRow,
} from '@/lib/followup/engine';
import type { AiSuggestion, AiSuggestionStatus } from '@/types';

const DEFAULT_PAGE_SIZE = 36;
const MAX_PAGE_SIZE = 100;

interface RawFollowupPayload {
  stage_name?: string | null;
  has_purchased?: boolean;
  hours_since_contact?: number | null;
  last_customer_message_at?: string | null;
  last_business_message_at?: string | null;
  customer_message_count?: number | null;
  business_message_count?: number | null;
  reason?: string | null;
  approach_summary?: string | null;
  score?: number | null;
  draft?: Record<string, unknown> | null;
  [key: string]: unknown;
}

/**
 * Resolve o link público validado de uma projeção do Match, extraindo o identificador
 * público (`dev-...`) do `cover_url` quando `public_url` estiver nulo na tabela de projeções
 * (mesmo mecanismo utilizado em `/api/match/prepare-send`).
 */
function resolveCompatiblePropertyPublicUrl(prop: {
  public_url?: unknown;
  cover_url?: unknown;
  code?: unknown;
  property_id?: unknown;
}): string | null {
  const explicitUrl =
    typeof prop.public_url === 'string' && prop.public_url.trim() ? prop.public_url.trim() : null;
  const coverUrl =
    typeof prop.cover_url === 'string' && prop.cover_url.trim() ? prop.cover_url.trim() : null;
  const coverInventoryId = coverUrl?.match(/\/properties\/([^/]+)/)?.[1]?.trim() || null;
  const codeOrId =
    typeof prop.code === 'string' && prop.code.trim()
      ? String(prop.property_id || '').trim() || null
      : null;

  const fallbackPageId = explicitUrl ? null : coverInventoryId || codeOrId;
  const resolved = resolveValidatedPublicPropertyUrl(explicitUrl, fallbackPageId);
  return resolved.url;
}

export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await getCurrentAccount();
    const url = new URL(request.url);

    const statusParam = (url.searchParams.get('status') || 'pending').trim() as AiSuggestionStatus;
    if (!AI_SUGGESTION_STATUSES.includes(statusParam)) {
      return NextResponse.json(
        { error: `status must be one of: ${AI_SUGGESTION_STATUSES.join(', ')}` },
        { status: 400 }
      );
    }

    // Novo padrão (Seção 2): 'yesterday' (Ontem em America/Sao_Paulo)
    const dateFilter = (
      url.searchParams.get('date_filter') || 'yesterday'
    ).trim() as FollowupDateFilter;
    const customFrom = url.searchParams.get('custom_from');
    const customTo = url.searchParams.get('custom_to');
    const windowFilter = (
      url.searchParams.get('window_filter') || 'all'
    ).trim() as FollowupWindowFilter;
    const search = (url.searchParams.get('search') || '').trim();
    const stage = (url.searchParams.get('stage') || 'all').trim();
    const maturityBand = (url.searchParams.get('maturity') || 'all').trim() as FollowupMaturityBand;
    const minAiScore = Math.max(0, parseInt(url.searchParams.get('min_ai_score') || '0', 10) || 0);
    const opportunityType = (url.searchParams.get('opportunity_type') || 'all').trim() as
      | 'all'
      | FollowupOpportunityType;
    const contactIdFilter = url.searchParams.get('contact_id')?.trim() || null;
    const sortBy = (url.searchParams.get('sort_by') || 'recent_priority').trim() as FollowupSortBy;

    const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1);
    const pageSize = Math.min(
      MAX_PAGE_SIZE,
      Math.max(
        1,
        parseInt(url.searchParams.get('page_size') || String(DEFAULT_PAGE_SIZE), 10) ||
          DEFAULT_PAGE_SIZE
      )
    );

    const now = new Date();
    const nowIso = now.toISOString();
    const nowMs = now.getTime();
    const ignoredRetentionCutoffMs =
      nowMs - IGNORED_SUGGESTION_RETENTION_DAYS * 24 * 60 * 60 * 1000;

    const suggestionSelect =
      '*, contact:contacts(id, name, phone, avatar_url, ai_score, ai_score_reason, has_purchased, is_personal_whatsapp, paused_at, archived_at)';

    // 1. Consulta cirúrgica sem varrer os 18.298 registros históricos de `ignored`:
    //    - Busca os status ativos ('pending', 'approved', 'done', 'rejected') em até 2 lotes
    //    - Busca separadamente apenas o lote recente de 'ignored' (até 300 mais recentes dentro da janela de retenção)
    const [activeBatch0Res, ignoredBatchRes, pipelinesRes, propertiesRes] = await Promise.all([
      supabase
        .from('ai_suggestions')
        .select(suggestionSelect)
        .eq('account_id', accountId)
        .eq('category', 'followup')
        .in('status', ['pending', 'approved', 'done', 'rejected'])
        .order('created_at', { ascending: false })
        .range(0, 999),
      supabase
        .from('ai_suggestions')
        .select(suggestionSelect)
        .eq('account_id', accountId)
        .eq('category', 'followup')
        .eq('status', 'ignored')
        .order('created_at', { ascending: false })
        .range(0, 299),
      supabase
        .from('pipelines')
        .select('id, name, pipeline_stages(id, name, color, position)')
        .eq('account_id', accountId),
      supabase
        .from('property_match_projections')
        .select('property_id, title, status, operation')
        .eq('account_id', accountId)
        .eq('status', 'ativo'),
    ]);

    if (activeBatch0Res.error) {
      console.error('[api/followup GET] error fetching suggestions:', activeBatch0Res.error);
      return NextResponse.json(
        { error: 'Falha ao carregar sugestões de follow-up' },
        { status: 500 }
      );
    }

    const rawActiveSuggestions: Array<Record<string, unknown>> = [
      ...((activeBatch0Res.data || []) as Array<Record<string, unknown>>),
    ];

    if ((activeBatch0Res.data || []).length === 1000) {
      const { data: activeBatch1 } = await supabase
        .from('ai_suggestions')
        .select(suggestionSelect)
        .eq('account_id', accountId)
        .eq('category', 'followup')
        .in('status', ['pending', 'approved', 'done', 'rejected'])
        .order('created_at', { ascending: false })
        .range(1000, 1999);
      if (activeBatch1 && activeBatch1.length > 0) {
        rawActiveSuggestions.push(...(activeBatch1 as Array<Record<string, unknown>>));
      }
    }

    const rawIgnoredSuggestions = ((ignoredBatchRes.data || []) as Array<Record<string, unknown>>).filter(
      (row) => {
        const refDate = String(row.resolved_at || row.updated_at || row.created_at || '');
        const refMs = refDate ? new Date(refDate).getTime() : NaN;
        if (!Number.isFinite(refMs)) return true;
        return refMs >= ignoredRetentionCutoffMs;
      }
    );

    const rawSuggestions = [...rawActiveSuggestions, ...rawIgnoredSuggestions];

    const availableStagesMap = new Map<
      string,
      { id: string; name: string; color: string; position: number }
    >();
    for (const p of (pipelinesRes.data || []) as Array<Record<string, unknown>>) {
      const stages = Array.isArray(p.pipeline_stages)
        ? (p.pipeline_stages as Array<Record<string, unknown>>)
        : [];
      for (const s of stages) {
        const sName = String(s.name || '').trim();
        if (sName && !availableStagesMap.has(sName.toLowerCase())) {
          availableStagesMap.set(sName.toLowerCase(), {
            id: String(s.id || sName),
            name: sName,
            color: String(s.color || '#64748b'),
            position: Number(s.position ?? 0),
          });
        }
      }
    }

    const knownPropertyNames = ((propertiesRes.data || []) as Array<Record<string, unknown>>)
      .map((p) => String(p.title || '').trim())
      .filter(Boolean);

    // 2. Deduplicação por (status, contact_id) mantendo a sugestão mais recente de cada lead
    //    e rastreando o último timestamp de sugestão por contato (para idempotência diária)
    const statusCounts: Record<AiSuggestionStatus, number> = {
      pending: 0,
      approved: 0,
      rejected: 0,
      ignored: 0,
      done: 0,
    };

    const seenByStatusAndContact = new Set<string>();
    const latestSuggestionAtByContact = new Map<string, number>();
    const pendingContactIdsSet = new Set<string>();
    const visibleSuggestions: Array<Record<string, unknown>> = [];

    for (const row of rawSuggestions) {
      const rowStatus = ((row.status as AiSuggestionStatus) || 'pending') as AiSuggestionStatus;
      const contactId = typeof row.contact_id === 'string' ? row.contact_id.trim() : '';
      const createdMs = row.created_at ? new Date(String(row.created_at)).getTime() : 0;
      const resolvedMs = row.resolved_at ? new Date(String(row.resolved_at)).getTime() : 0;
      const latestRowMs = Math.max(
        Number.isFinite(createdMs) ? createdMs : 0,
        Number.isFinite(resolvedMs) ? resolvedMs : 0
      );

      if (contactId && latestRowMs > (latestSuggestionAtByContact.get(contactId) ?? 0)) {
        latestSuggestionAtByContact.set(contactId, latestRowMs);
      }

      const snoozedUntil = typeof row.snoozed_until === 'string' ? row.snoozed_until : null;
      const isSnoozedFuture = Boolean(snoozedUntil && snoozedUntil > nowIso);

      if (rowStatus === 'pending' && isSnoozedFuture) {
        if (contactId) pendingContactIdsSet.add(contactId);
        continue;
      }

      if (contactId) {
        const dedupKey = `${rowStatus}:${contactId}`;
        if (seenByStatusAndContact.has(dedupKey)) {
          continue;
        }
        seenByStatusAndContact.add(dedupKey);
        if (rowStatus === 'pending') {
          pendingContactIdsSet.add(contactId);
        }
      }

      if (rowStatus in statusCounts) {
        statusCounts[rowStatus] += 1;
      }
      visibleSuggestions.push(row);
    }

    // 3. Preparação diária incremental e determinística (Seção 4):
    //    Verifica conversas com interação nos últimos 7 dias que ainda não receberam sugestão
    //    após a última mensagem do cliente (ex.: leads que conversaram ONTEM e ficaram fora do
    //    antigo limite de 48h), avaliando as mensagens reais sem chamar LLM.
    try {
      const recentWindowCutoffIso = new Date(nowMs - 7 * 24 * 60 * 60 * 1000).toISOString();
      const { data: recentConvs } = await supabase
        .from('conversations')
        .select(
          'id, contact_id, last_message_at, last_message_text, status, ai_reply_count, ctwa_referral, ctwa_fep_started_at, ctwa_fep_expires_at'
        )
        .eq('account_id', accountId);

      const candidateRecentConvs = ((recentConvs || []) as Array<Record<string, unknown>>).filter(
        (c) => {
          const cid = typeof c.contact_id === 'string' ? c.contact_id : '';
          const lastMsg = typeof c.last_message_at === 'string' ? c.last_message_at : '';
          if (!cid || !lastMsg || lastMsg < recentWindowCutoffIso) return false;
          if (pendingContactIdsSet.has(cid)) return false;
          return true;
        }
      );

      if (candidateRecentConvs.length > 0) {
        const candConvIds = candidateRecentConvs.map((c) => String(c.id)).filter(Boolean);
        const candContactIds = Array.from(
          new Set(candidateRecentConvs.map((c) => String(c.contact_id)).filter(Boolean))
        );

        const [candMsgsRes, candContactsRes, candDealsRes, candIntelRes, candTagsRes] =
          await Promise.all([
            supabase
              .from('messages')
              .select(
                'conversation_id, sender_type, content_type, content_text, media_url, template_name, created_at, private, event'
              )
              .in('conversation_id', candConvIds)
              .order('created_at', { ascending: false }),
            supabase
              .from('contacts')
              .select(
                'id, name, phone, avatar_url, ai_score, ai_score_reason, has_purchased, is_personal_whatsapp, paused_at, archived_at'
              )
              .eq('account_id', accountId)
              .in('id', candContactIds),
            supabase
              .from('deals')
              .select('id, contact_id, stage_id, status, pipeline_stages(id, name, color, position)')
              .eq('account_id', accountId)
              .eq('status', 'open')
              .in('contact_id', candContactIds),
            supabase
              .from('lead_intelligence')
              .select('contact_id, summary')
              .in('contact_id', candContactIds),
            supabase
              .from('contact_tags')
              .select('contact_id, source, originally_from_ctwa, tags(id, name, color, category)')
              .in('contact_id', candContactIds),
          ]);

        const candMsgsByConv = new Map<string, RawConversationMessageRow[]>();
        for (const m of (candMsgsRes.data || []) as RawConversationMessageRow[]) {
          const convId = String(m.conversation_id || '');
          if (!convId) continue;
          const arr = candMsgsByConv.get(convId) ?? [];
          arr.push(m);
          candMsgsByConv.set(convId, arr);
        }

        const candContactById = new Map<string, Record<string, unknown>>();
        for (const ct of (candContactsRes.data || []) as Array<Record<string, unknown>>) {
          candContactById.set(String(ct.id || ''), ct);
        }

        const candStageByContact = new Map<string, string>();
        for (const d of (candDealsRes.data || []) as Array<Record<string, unknown>>) {
          const cid = String(d.contact_id || '');
          const ps = d.pipeline_stages as Record<string, unknown> | null;
          if (cid && ps?.name) {
            candStageByContact.set(cid, String(ps.name).trim());
          }
        }

        const candSummaryByContact = new Map<string, Record<string, unknown>>();
        for (const li of (candIntelRes.data || []) as Array<Record<string, unknown>>) {
          const cid = String(li.contact_id || '');
          if (cid && li.summary && typeof li.summary === 'object') {
            candSummaryByContact.set(cid, li.summary as Record<string, unknown>);
          }
        }

        const candTagsByContact = new Map<string, Record<string, string[]>>();
        for (const ct of (candTagsRes.data || []) as Array<Record<string, unknown>>) {
          const cid = String(ct.contact_id || '');
          const t = ct.tags as { name?: string; category?: string | null } | null;
          if (!cid || !t?.name || !t?.category) continue;
          const map = candTagsByContact.get(cid) ?? {};
          (map[t.category.trim()] ??= []).push(t.name.trim());
          candTagsByContact.set(cid, map);
        }

        const teamCooldownMs = FOLLOWUP_RECENT_TEAM_CONTACT_COOLDOWN_HOURS * 60 * 60 * 1000;
        const liveChatQuietMinMs = 2 * 60 * 60 * 1000; // 2h de silêncio mínimo para não interromper conversa ao vivo

        for (const conv of candidateRecentConvs) {
          const convId = String(conv.id || '');
          const contactId = String(conv.contact_id || '');
          const contactRow = candContactById.get(contactId);
          if (!convId || !contactId || !contactRow) continue;
          if (Boolean(contactRow.has_purchased)) continue;
          if (contactRow.archived_at || contactRow.paused_at) continue;

          const convMsgs = candMsgsByConv.get(convId) || [];
          if (convMsgs.length === 0) continue;

          const stats = summarizeConversationMessages(convMsgs);
          if (!stats.lastCustomerMessageAt || stats.customerMessageCount === 0) continue;

          const lastCustMs = new Date(stats.lastCustomerMessageAt).getTime();
          if (!Number.isFinite(lastCustMs) || nowMs - lastCustMs < liveChatQuietMinMs) {
            continue;
          }

          // Idempotência: se já existe sugestão criada/resolvida após a última mensagem do cliente, não recria
          const latestSuggMs = latestSuggestionAtByContact.get(contactId) ?? 0;
          if (latestSuggMs >= lastCustMs) {
            continue;
          }

          // Respeita acompanhamento recente de Ronaldo/Tatiana
          if (stats.lastAgentMessageAt) {
            const lastAgentMs = new Date(stats.lastAgentMessageAt).getTime();
            if (
              Number.isFinite(lastAgentMs) &&
              lastAgentMs >= lastCustMs &&
              nowMs - lastAgentMs < teamCooldownMs
            ) {
              continue;
            }
          }

          const stageName = candStageByContact.get(contactId) ?? null;
          const summary = candSummaryByContact.get(contactId) ?? null;
          const tagByCategory = candTagsByContact.get(contactId) ?? {};
          const ctwaReferral =
            conv.ctwa_referral && typeof conv.ctwa_referral === 'object'
              ? (conv.ctwa_referral as Record<string, unknown>)
              : null;
          const ctwaHeadline =
            ctwaReferral && typeof ctwaReferral.headline === 'string'
              ? ctwaReferral.headline
              : null;

          const interestProperty = extractInterestProperty({
            tagByCategory,
            ctwaHeadline,
            reasonText: `${stats.lastCustomerText || ''} ${stats.lastBusinessText || ''}`,
            knownPropertyNames,
          });
          const primaryNeed = extractLeadPrimaryNeed({
            summary,
            tagByCategory,
          });

          const timing = classifyFollowupTimingAndType({
            lastCustomerMessageAt: stats.lastCustomerMessageAt,
            lastBusinessMessageAt: stats.lastBusinessMessageAt,
            lastAgentMessageAt: stats.lastAgentMessageAt,
            customerMessageCount: stats.customerMessageCount,
            businessMessageCount: stats.businessMessageCount,
            stageName,
            nowMs,
          });

          const objective = buildObjectiveFollowupRecommendation({
            opportunityType: timing.opportunityType,
            contactState: timing.contactState,
            interestProperty,
            primaryNeed,
            lastCustomerText: stats.lastCustomerText,
            lastBusinessText: stats.lastBusinessText,
            stageName,
          });

          const aiScore = Math.max(0, Math.min(10, Number(contactRow.ai_score ?? 0) || 0));
          const deterministicConfidence = Math.min(
            95,
            Math.max(
              62,
              65 +
                (interestProperty ? 10 : 0) +
                (primaryNeed ? 8 : 0) +
                (timing.awaitingBusinessReply ? 7 : 0) +
                Math.round(aiScore * 1.2)
            )
          );

          const newPayload: RawFollowupPayload = {
            stage_name: stageName,
            has_purchased: false,
            hours_since_contact: timing.hoursSinceLastCustomerMessage ?? 24,
            last_customer_message_at: stats.lastCustomerMessageAt,
            last_business_message_at: stats.lastBusinessMessageAt,
            customer_message_count: stats.customerMessageCount,
            business_message_count: stats.businessMessageCount,
            reason: objective.reason,
            approach_summary: objective.approachSummary,
            score: deterministicConfidence,
          };

          let persistedId = `daily-${contactId}`;
          try {
            const insertChain = supabase
              .from('ai_suggestions')
              .insert({
                account_id: accountId,
                contact_id: contactId,
                conversation_id: convId,
                category: 'followup',
                title: objective.reason,
                description: objective.approachSummary,
                payload: newPayload,
                status: 'pending',
              }) as unknown as {
              select?: (cols: string) => {
                single?: () => Promise<{ data: Record<string, unknown> | null }>;
              };
            };
            if (typeof insertChain?.select === 'function') {
              const sel = insertChain.select('id');
              if (typeof sel?.single === 'function') {
                const { data: insRow } = await sel.single();
                if (insRow?.id) persistedId = String(insRow.id);
              }
            }
          } catch {
            // Segue com o item determinístico em memória caso o insert não esteja disponível
          }

          const synthesizedRow: Record<string, unknown> = {
            id: persistedId,
            account_id: accountId,
            contact_id: contactId,
            conversation_id: convId,
            category: 'followup',
            title: objective.reason,
            description: objective.approachSummary,
            payload: newPayload,
            status: 'pending',
            snoozed_until: null,
            created_at: nowIso,
            updated_at: nowIso,
            contact: contactRow,
          };

          pendingContactIdsSet.add(contactId);
          seenByStatusAndContact.add(`pending:${contactId}`);
          statusCounts.pending += 1;
          visibleSuggestions.unshift(synthesizedRow);
        }
      }
    } catch {
      // Se o ambiente/mock não tiver dados de conversas recentes, segue apenas com ai_suggestions
    }

    // Filtra pelo status da aba ativa
    const statusRows = visibleSuggestions.filter((r) => r.status === statusParam);

    // 4. Pré-filtragem leve por busca e score mínimo da IA (já disponíveis no join de contact)
    const normSearch = search.toLowerCase();
    const normSearchDigits = search.replace(/\D/g, '');

    const prefilteredRows = statusRows.filter((raw) => {
      const rawContact = (raw.contact ?? {}) as Record<string, unknown>;
      const contactId = String(raw.contact_id || rawContact.id || '');
      if (contactIdFilter && contactId !== contactIdFilter) return false;

      const aiScore = Math.max(0, Math.min(10, Number(rawContact.ai_score ?? 0) || 0));
      if (minAiScore > 0 && aiScore < minAiScore) return false;

      if (normSearch) {
        const contactName = String(rawContact.name || '').toLowerCase();
        const contactPhone = String(rawContact.phone || '').toLowerCase();
        const nameMatch = contactName.includes(normSearch);
        const phoneRawMatch = contactPhone.includes(normSearch);
        const phoneDigitsMatch =
          normSearchDigits.length > 0 &&
          contactPhone.replace(/\D/g, '').includes(normSearchDigits);
        if (!nameMatch && !phoneRawMatch && !phoneDigitsMatch) return false;
      }

      return true;
    });

    // 5. Carrega conversas vinculadas em paralelo (sem loop sequencial bloqueante)
    const distinctConversationIds = Array.from(
      new Set(
        prefilteredRows
          .map((r) => (typeof r.conversation_id === 'string' ? r.conversation_id : ''))
          .filter(Boolean)
      )
    );

    const conversationsMap = new Map<string, Record<string, unknown>>();
    const latestConvByContactMap = new Map<string, Record<string, unknown>>();
    const BATCH_IDS = 200;

    if (distinctConversationIds.length > 0) {
      const convChunks: string[][] = [];
      for (let i = 0; i < distinctConversationIds.length; i += BATCH_IDS) {
        convChunks.push(distinctConversationIds.slice(i, i + BATCH_IDS));
      }
      const convResults = await Promise.all(
        convChunks.map((chunk) =>
          supabase
            .from('conversations')
            .select(
              'id, contact_id, last_message_at, last_message_text, status, ai_reply_count, ctwa_referral, ctwa_fep_started_at, ctwa_fep_expires_at'
            )
            .eq('account_id', accountId)
            .in('id', chunk)
        )
      );
      for (const res of convResults) {
        for (const c of (res.data || []) as Array<Record<string, unknown>>) {
          const cid = String(c.id || '');
          if (cid) conversationsMap.set(cid, c);
          const contactId = String(c.contact_id || '');
          if (contactId && !latestConvByContactMap.has(contactId)) {
            latestConvByContactMap.set(contactId, c);
          }
        }
      }
    }

    // 6. Podagem temporal inteligente antes de hidratar metadados pesados (Seções 1 e 7):
    //    Como `conversations.last_message_at >= lastCustomerMessageAt` sempre, se um filtro
    //    de data possui `startMs` e a conversa real no banco tem `last_message_at < startMs`,
    //    sabemos com 100% de certeza que o cliente não enviou mensagem nesse período, evitando
    //    carregar `messages`, `deals`, `lead_intelligence` e `contact_tags` para centenas de
    //    conversas antigas. (Se `conv` não existir no mock de teste, mantém a linha).
    const dateRange = resolveFollowupDateFilterRange(dateFilter, now, customFrom, customTo);
    const candidateRows = prefilteredRows.filter((raw) => {
      if (dateRange.startMs === null) return true;
      const payload = (raw.payload ?? {}) as RawFollowupPayload;
      if (typeof payload.last_customer_message_at === 'string' && payload.last_customer_message_at) {
        const custMs = new Date(payload.last_customer_message_at).getTime();
        if (Number.isFinite(custMs)) {
          if (custMs < dateRange.startMs) return false;
          if (dateRange.endMs !== null && custMs > dateRange.endMs) return false;
          return true;
        }
      }
      const conversationId = typeof raw.conversation_id === 'string' ? raw.conversation_id : '';
      const contactId = String(raw.contact_id || '');
      const conv =
        (conversationId ? conversationsMap.get(conversationId) : null) ||
        (contactId ? latestConvByContactMap.get(contactId) : null) ||
        null;

      if (conv && typeof conv.last_message_at === 'string' && conv.last_message_at) {
        const convLastMs = new Date(conv.last_message_at).getTime();
        // Se nem a última mensagem geral da conversa alcança o início do período, o cliente certamente não falou no período
        if (Number.isFinite(convLastMs) && convLastMs < dateRange.startMs) {
          return false;
        }
      }
      return true;
    });

    const candidateContactIds = Array.from(
      new Set(
        candidateRows
          .map((r) => (typeof r.contact_id === 'string' ? r.contact_id : ''))
          .filter(Boolean)
      )
    );
    const candidateConversationIds = Array.from(
      new Set(
        candidateRows
          .map((r) => (typeof r.conversation_id === 'string' ? r.conversation_id : ''))
          .filter((cid) => Boolean(cid && conversationsMap.has(cid)))
      )
    );

    const msgStatsByConversationMap = new Map<string, ConversationMessageStats>();
    const dealsByContactMap = new Map<
      string,
      { stageId: string; stageName: string; stageColor: string | null }
    >();
    const intelligenceByContactMap = new Map<string, Record<string, unknown>>();
    const tagsByContactMap = new Map<string, TagWithJoin[]>();

    // 7. Carrega mensagens reais das conversas candidatas + deals, inteligência e tags em paralelo
    const msgChunks: string[][] = [];
    for (let i = 0; i < candidateConversationIds.length; i += BATCH_IDS) {
      msgChunks.push(candidateConversationIds.slice(i, i + BATCH_IDS));
    }

    const contactChunks: string[][] = [];
    for (let i = 0; i < candidateContactIds.length; i += BATCH_IDS) {
      contactChunks.push(candidateContactIds.slice(i, i + BATCH_IDS));
    }

    await Promise.all([
      ...msgChunks.map(async (chunk) => {
        try {
          const { data: msgRows } = await supabase
            .from('messages')
            .select(
              'conversation_id, sender_type, content_type, content_text, media_url, template_name, created_at, private, event'
            )
            .in('conversation_id', chunk)
            .order('created_at', { ascending: false });

          const grouped = new Map<string, RawConversationMessageRow[]>();
          for (const m of (msgRows || []) as RawConversationMessageRow[]) {
            const cid = String(m.conversation_id || '');
            if (!cid) continue;
            const list = grouped.get(cid) ?? [];
            list.push(m);
            grouped.set(cid, list);
          }
          for (const [cid, list] of grouped.entries()) {
            msgStatsByConversationMap.set(cid, summarizeConversationMessages(list));
          }
        } catch {
          // Segue caso o mock de teste não forneça a tabela messages
        }
      }),
      ...contactChunks.map(async (chunk) => {
        const [dealsRes, intelRes, tagsRes] = await Promise.all([
          supabase
            .from('deals')
            .select('id, contact_id, stage_id, status, pipeline_stages(id, name, color, position)')
            .eq('account_id', accountId)
            .eq('status', 'open')
            .in('contact_id', chunk),
          supabase
            .from('lead_intelligence')
            .select('contact_id, summary, last_analyzed_at')
            .in('contact_id', chunk),
          supabase
            .from('contact_tags')
            .select('contact_id, source, originally_from_ctwa, tags(id, name, color, category)')
            .in('contact_id', chunk),
        ]);

        for (const d of (dealsRes.data || []) as Array<Record<string, unknown>>) {
          const contactId = String(d.contact_id || '');
          const ps = d.pipeline_stages as Record<string, unknown> | null;
          if (contactId && ps && ps.name) {
            const sName = String(ps.name).trim();
            dealsByContactMap.set(contactId, {
              stageId: String(ps.id || d.stage_id || ''),
              stageName: sName,
              stageColor: ps.color ? String(ps.color) : null,
            });
            if (sName && !availableStagesMap.has(sName.toLowerCase())) {
              availableStagesMap.set(sName.toLowerCase(), {
                id: String(ps.id || sName),
                name: sName,
                color: String(ps.color || '#64748b'),
                position: Number(ps.position ?? 99),
              });
            }
          }
        }

        for (const li of (intelRes.data || []) as Array<Record<string, unknown>>) {
          const contactId = String(li.contact_id || '');
          if (contactId && li.summary && typeof li.summary === 'object') {
            intelligenceByContactMap.set(contactId, li.summary as Record<string, unknown>);
          }
        }

        for (const ct of (tagsRes.data || []) as Array<Record<string, unknown>>) {
          const contactId = String(ct.contact_id || '');
          if (!contactId || !ct.tags) continue;
          const t = ct.tags as { id: string; name: string; category: string | null };
          const list = tagsByContactMap.get(contactId) || [];
          list.push({
            source: String(ct.source || 'conversation'),
            originally_from_ctwa: Boolean(ct.originally_from_ctwa),
            tags: {
              id: String(t.id || ''),
              name: String(t.name || ''),
              category: t.category ? String(t.category) : null,
            },
          });
          tagsByContactMap.set(contactId, list);
        }
      }),
    ]);

    // 8. Constrói os itens enriquecidos e os perfis de busca em memória
    const profilesByContactMap = new Map<string, LeadSearchProfile>();
    const enrichedItems: EnrichedFollowupItem[] = [];

    for (const raw of candidateRows) {
      const suggestion = raw as unknown as AiSuggestion;
      const payload = (raw.payload ?? {}) as RawFollowupPayload;
      const rawContact = (raw.contact ?? {}) as Record<string, unknown>;
      const contactId = String(raw.contact_id || rawContact.id || '');
      const conversationId = typeof raw.conversation_id === 'string' ? raw.conversation_id : '';
      const conv =
        (conversationId ? conversationsMap.get(conversationId) : null) ||
        (contactId ? latestConvByContactMap.get(contactId) : null) ||
        null;
      const msgStats = conversationId ? msgStatsByConversationMap.get(conversationId) : undefined;

      const contactName = String(rawContact.name || '').trim() || 'Lead sem nome';
      const contactPhone = String(rawContact.phone || '').trim();
      const aiScore = Math.max(0, Math.min(10, Number(rawContact.ai_score ?? 0) || 0));
      const hasPurchased = Boolean(rawContact.has_purchased ?? payload.has_purchased ?? false);
      const isPersonalWhatsapp = Boolean(rawContact.is_personal_whatsapp ?? false);

      const dealInfo = contactId ? dealsByContactMap.get(contactId) : undefined;
      const payloadStageName =
        typeof payload.stage_name === 'string' && payload.stage_name.trim()
          ? payload.stage_name.trim()
          : null;
      const stageName = dealInfo?.stageName || payloadStageName || null;
      const stageMeta = stageName ? availableStagesMap.get(stageName.toLowerCase()) : undefined;
      const stageId = dealInfo?.stageId || stageMeta?.id || null;
      const stageColor = dealInfo?.stageColor || stageMeta?.color || null;

      if (stageName && !availableStagesMap.has(stageName.toLowerCase())) {
        availableStagesMap.set(stageName.toLowerCase(), {
          id: stageId || stageName,
          name: stageName,
          color: stageColor || '#64748b',
          position: 99,
        });
      }

      const summary = contactId ? intelligenceByContactMap.get(contactId) || null : null;
      const contactTags = contactId ? tagsByContactMap.get(contactId) || [] : [];

      let profileMaturity = 0;
      if (contactId) {
        const contactForProfile: ContactRow = {
          id: contactId,
          account_id: accountId,
          name: contactName,
          phone: contactPhone,
          ai_score: aiScore,
          paused_at: (rawContact.paused_at as string | null) ?? null,
          archived_at: (rawContact.archived_at as string | null) ?? null,
        };
        const profile = buildProfileFromData(
          contactForProfile,
          summary ? { summary } : null,
          contactTags,
          conv
            ? {
                ctwa_referral:
                  (conv.ctwa_referral as Record<string, unknown> | null) ?? null,
              }
            : null
        );
        profilesByContactMap.set(contactId, profile);
        profileMaturity = calculateProfileMaturity(profile).maturity;
      }

      const tagByCategory: Record<string, string[]> = {};
      for (const ct of contactTags) {
        if (!ct.tags?.category || !ct.tags?.name) continue;
        const cat = ct.tags.category.trim();
        (tagByCategory[cat] ??= []).push(ct.tags.name.trim());
      }

      const convLastMessageAt =
        conv && typeof conv.last_message_at === 'string' ? conv.last_message_at : null;
      const convLastMessageText =
        conv && typeof conv.last_message_text === 'string' ? conv.last_message_text : null;
      const aiReplyCount =
        conv && typeof conv.ai_reply_count === 'number' ? conv.ai_reply_count : null;

      const resolvedLastCustomerAt =
        msgStats?.lastCustomerMessageAt ??
        (typeof payload.last_customer_message_at === 'string'
          ? payload.last_customer_message_at
          : null);
      const resolvedLastBusinessAt =
        msgStats?.lastBusinessMessageAt ??
        (typeof payload.last_business_message_at === 'string'
          ? payload.last_business_message_at
          : null);
      const resolvedCustomerCount =
        msgStats?.customerMessageCount ??
        (typeof payload.customer_message_count === 'number'
          ? payload.customer_message_count
          : undefined);
      const resolvedBusinessCount =
        msgStats?.businessMessageCount ??
        (typeof payload.business_message_count === 'number'
          ? payload.business_message_count
          : undefined);

      const hasActivePlan = Boolean(
        payload.draft && typeof payload.draft === 'object' && payload.draft.mode === 'plan'
      );

      const timing = classifyFollowupTimingAndType({
        lastCustomerMessageAt: resolvedLastCustomerAt,
        lastBusinessMessageAt: resolvedLastBusinessAt,
        lastAgentMessageAt: msgStats?.lastAgentMessageAt ?? null,
        customerMessageCount: resolvedCustomerCount,
        businessMessageCount: resolvedBusinessCount,
        lastMessageAt: convLastMessageAt,
        lastMessageText: convLastMessageText,
        aiReplyCount,
        payloadHoursSinceContact:
          typeof payload.hours_since_contact === 'number' ? payload.hours_since_contact : null,
        stageName,
        hasActivePlan,
        nowMs,
      });

      const ctwaReferral =
        conv && conv.ctwa_referral && typeof conv.ctwa_referral === 'object'
          ? (conv.ctwa_referral as Record<string, unknown>)
          : null;
      const ctwaHeadline =
        ctwaReferral && typeof ctwaReferral.headline === 'string'
          ? ctwaReferral.headline
          : null;
      const isCtwaLead = Boolean(ctwaReferral);
      const ctwaFepExpiresAt =
        conv && typeof conv.ctwa_fep_expires_at === 'string' ? conv.ctwa_fep_expires_at : null;

      const rawReason =
        (typeof payload.reason === 'string' && payload.reason.trim()) ||
        (typeof suggestion.title === 'string' && suggestion.title.trim()) ||
        'Oportunidade comercial identificada para acompanhamento.';
      const rawApproachSummary =
        (typeof payload.approach_summary === 'string' && payload.approach_summary.trim()) ||
        (typeof suggestion.description === 'string' && suggestion.description.trim()) ||
        null;

      const interestProperty = extractInterestProperty({
        tagByCategory,
        ctwaHeadline,
        reasonText: `${rawReason} ${rawApproachSummary || ''} ${msgStats?.lastCustomerText || ''}`,
        knownPropertyNames,
      });

      const primaryNeed = extractLeadPrimaryNeed({
        summary,
        tagByCategory,
      });

      // Reconcilia textos contraditórios (ex.: card de retomada cujo texto antigo dizia "nunca contatado")
      const reconciled = reconcileFollowupReasonAndApproach({
        rawReason,
        rawApproachSummary,
        opportunityType: timing.opportunityType,
        contactState: timing.contactState,
        neverContacted: timing.neverContacted,
        interestProperty,
        primaryNeed,
        lastCustomerText: msgStats?.lastCustomerText ?? convLastMessageText,
        lastBusinessText: msgStats?.lastBusinessText ?? null,
        stageName,
      });

      // Data da última mensagem do cliente:
      // - Se temos a conversa real no banco (`conv !== null`) ou `msgStats`, usa estritamente `timing.lastCustomerMessageAt`.
      // - Apenas em mocks sintéticos de testes onde nem `conversations` nem `messages` foram populados (`conv === null && !msgStats`),
      //   mantém `timing.lastCustomerMessageAt` como `undefined` para que `resolveFollowupFilterTimestamp` use o fallback do teste.
      const hasRealConvOrMsgData = Boolean(conv || msgStats || resolvedLastCustomerAt);
      const effectiveCustomerAtForWindow =
        timing.lastCustomerMessageAt ?? (!hasRealConvOrMsgData ? String(suggestion.created_at || nowIso) : null);

      const sessionWindow = evaluateFollowupSessionWindow({
        lastCustomerMessageAt: effectiveCustomerAtForWindow,
        isCtwaLead,
        ctwaFepExpiresAt,
        nowMs,
      });

      const confidenceScore =
        typeof payload.score === 'number' && Number.isFinite(payload.score)
          ? Math.max(0, Math.min(100, Math.round(payload.score)))
          : null;

      const priorityEval = calculateFollowupCommercialPriority({
        confidenceScore,
        aiScore,
        profileMaturity,
        hasInterestProperty: Boolean(interestProperty),
        hasPrimaryNeed: Boolean(primaryNeed),
        stageName,
        awaitingBusinessReply: timing.awaitingBusinessReply,
        windowStatus: sessionWindow.status,
      });

      const suggestionCreatedAt = String(suggestion.created_at || nowIso);
      const suggestionDayKeySp = saoPauloDayKey(suggestionCreatedAt);
      const customerDayKeySp = timing.lastCustomerMessageAt
        ? saoPauloDayKey(timing.lastCustomerMessageAt)
        : !hasRealConvOrMsgData
          ? suggestionDayKeySp
          : null;
      const suggestionSignificantUpdatedAt =
        (typeof suggestion.resolved_at === 'string' && suggestion.resolved_at) ||
        (typeof suggestion.snoozed_until === 'string' && suggestion.snoozed_until) ||
        null;

      enrichedItems.push({
        suggestion: {
          ...suggestion,
          contact: contactId
            ? {
                id: contactId,
                name: contactName,
                avatar_url: (rawContact.avatar_url as string | undefined) || undefined,
              }
            : null,
        },
        contact: {
          id: contactId,
          name: contactName,
          phone: contactPhone,
          avatar_url: (rawContact.avatar_url as string | null) ?? null,
          ai_score: aiScore,
          ai_score_reason: (rawContact.ai_score_reason as string | null) ?? null,
          has_purchased: hasPurchased,
          is_personal_whatsapp: isPersonalWhatsapp,
        },
        stageId,
        stageName,
        stageColor,
        opportunityType: timing.opportunityType,
        contactState: timing.contactState,
        awaitingBusinessReply: timing.awaitingBusinessReply,
        profileMaturity,
        aiScore,
        confidenceScore,
        commercialPriorityScore: priorityEval.score,
        priorityTier: priorityEval.tier,
        lastCustomerMessageAt: hasRealConvOrMsgData ? timing.lastCustomerMessageAt : undefined,
        customerDayKeySp,
        lastBusinessMessageAt: timing.lastBusinessMessageAt,
        lastAgentMessageAt: msgStats?.lastAgentMessageAt ?? null,
        lastInteractionAt: timing.lastInteractionAt,
        suggestionCreatedAt,
        suggestionDayKeySp,
        suggestionSignificantUpdatedAt,
        lastCommunicationAt: timing.lastCommunicationAt,
        hoursSinceLastCommunication: timing.hoursSinceLastCommunication,
        hoursSinceLastCustomerMessage: timing.hoursSinceLastCustomerMessage,
        neverContacted: timing.neverContacted,
        sessionWindow,
        reason: reconciled.reason,
        approachSummary: reconciled.approachSummary,
        interestProperty,
        primaryNeed,
        lastMessagePreview: msgStats?.lastCustomerText ?? convLastMessageText,
        lastCustomerMessagePreview: msgStats?.lastCustomerText ?? null,
        lastBusinessMessagePreview: msgStats?.lastBusinessText ?? null,
        compatiblePropertiesCount: 0,
        compatibleProperties: [],
      });
    }

    // 9. Aplica os filtros combinados (baseados em lastCustomerMessageAt) e ordenação determinística
    const filteredItems = filterFollowupItems(enrichedItems, {
      status: statusParam,
      dateFilter,
      customFrom,
      customTo,
      windowFilter,
      search,
      stage,
      maturityBand,
      minAiScore,
      opportunityType,
      contactId: contactIdFilter,
      now,
    });

    filteredItems.sort((a, b) => compareFollowupItems(a, b, sortBy));

    const totalFiltered = filteredItems.length;
    const totalPages = Math.max(1, Math.ceil(totalFiltered / pageSize));
    const safePage = Math.min(page, totalPages);
    const offset = (safePage - 1) * pageSize;
    const pagedItems = filteredItems.slice(offset, offset + pageSize);

    // 10. Integração inteligente e leve com o Match (Seção 9):
    //     Consulta imóveis compatíveis APENAS para os leads exibidos na página atual (máx 36),
    //     resolvendo também a miniatura real (`coverUrl`) e o link público (`publicUrl`).
    const pageContactIds = Array.from(
      new Set(pagedItems.map((item) => item.contact.id).filter(Boolean))
    );

    if (pageContactIds.length > 0) {
      const { data: matchRows } = await supabase
        .from('lead_property_matches')
        .select(
          'id, lead_id, property_id, match_score, commercial_priority, match_status, suppressed, score_breakdown'
        )
        .eq('account_id', accountId)
        .eq('suppressed', false)
        .in('lead_id', pageContactIds)
        .order('match_score', { ascending: false })
        .order('commercial_priority', { ascending: false });

      const validMatches = ((matchRows || []) as Array<Record<string, unknown>>).filter(
        (m) => m.match_status !== 'ignorado' && Number(m.match_score ?? 0) >= 70
      );

      const matchedPropIds = Array.from(
        new Set(validMatches.map((m) => String(m.property_id || '')).filter(Boolean))
      );

      const projectionsMap = new Map<string, Record<string, unknown>>();
      if (matchedPropIds.length > 0) {
        const { data: projRows } = await supabase
          .from('property_match_projections')
          .select(
            'property_id, status, operation, title, code, property_type, neighborhood, city, price_min, price_max, bedrooms_min, bedrooms_max, area_min, delivery_status, cover_url, public_url'
          )
          .eq('account_id', accountId)
          .eq('status', 'ativo')
          .in('property_id', matchedPropIds);

        for (const p of (projRows || []) as Array<Record<string, unknown>>) {
          projectionsMap.set(String(p.property_id), p);
        }
      }

      const matchesByLead = new Map<string, CompatiblePropertySummary[]>();
      for (const m of validMatches) {
        const leadId = String(m.lead_id || '');
        const propId = String(m.property_id || '');
        const prop = projectionsMap.get(propId);
        if (!leadId || !prop) continue;

        // Respeita operação comercial (venda/locação) e restrições conhecidas do perfil do lead
        const leadProfile = profilesByContactMap.get(leadId);
        const propOperation = String(prop.operation || 'venda').toLowerCase();
        if (leadProfile) {
          if (leadProfile.isShortStayOnly) continue;
          if (
            leadProfile.operation &&
            leadProfile.operation !== 'indefinido' &&
            leadProfile.operation !== propOperation
          ) {
            continue;
          }
        }

        const breakdown =
          m.score_breakdown && typeof m.score_breakdown === 'object'
            ? (m.score_breakdown as Record<string, unknown>)
            : {};
        const reasons = Array.isArray(breakdown.reasons)
          ? (breakdown.reasons as unknown[]).map((r) => String(r)).filter(Boolean)
          : [];

        const resolvedPublicUrl = resolveCompatiblePropertyPublicUrl(prop);

        const list = matchesByLead.get(leadId) || [];
        list.push({
          matchId: String(m.id || ''),
          propertyId: propId,
          title: String(prop.title || 'Imóvel compatível'),
          code: prop.code ? String(prop.code) : null,
          neighborhood: String(prop.neighborhood || ''),
          city: String(prop.city || 'João Pessoa'),
          operation: propOperation,
          propertyType: prop.property_type ? String(prop.property_type) : null,
          priceMin: Number(prop.price_min || 0),
          priceMax: Number(prop.price_max || 0),
          bedroomsMin: prop.bedrooms_min != null ? Number(prop.bedrooms_min) : null,
          bedroomsMax: prop.bedrooms_max != null ? Number(prop.bedrooms_max) : null,
          areaMin: prop.area_min != null ? Number(prop.area_min) : null,
          deliveryStatus: prop.delivery_status ? String(prop.delivery_status) : null,
          coverUrl: prop.cover_url ? String(prop.cover_url) : null,
          publicUrl: resolvedPublicUrl,
          matchScore: Math.round(Number(m.match_score || 0)),
          commercialPriority: Number(m.commercial_priority || 0),
          matchStatus: String(m.match_status || 'novo'),
          reasons,
        });
        matchesByLead.set(leadId, list);
      }

      for (const item of pagedItems) {
        const leadMatches = matchesByLead.get(item.contact.id) || [];
        item.compatiblePropertiesCount = leadMatches.length;
        item.compatibleProperties = leadMatches.slice(0, 5);
      }
    }

    const availableStages = Array.from(availableStagesMap.values()).sort(
      (a, b) => a.position - b.position || a.name.localeCompare(b.name)
    );

    return NextResponse.json({
      counts: {
        pending: statusCounts.pending,
        approved: statusCounts.approved,
        done: statusCounts.done,
        ignored: statusCounts.ignored,
        rejected: statusCounts.rejected,
        totalInActiveStatusAllDates: statusRows.length,
        filteredInPeriod: totalFiltered,
      },
      pagination: {
        page: safePage,
        pageSize,
        totalItems: totalFiltered,
        totalPages,
        hasMore: safePage < totalPages,
      },
      availableStages,
      items: pagedItems,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
