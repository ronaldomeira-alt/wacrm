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
  FOLLOWUP_MAX_RECOMMENDED_PROPERTIES,
  calculateFollowupCommercialPriority,
  classifyFollowupTimingAndType,
  compareFollowupItems,
  detectPendingTeamCommitment,
  evaluateFollowupCommercialEligibility,
  evaluateFollowupSessionWindow,
  extractExplicitPropertyRestrictions,
  extractInterestProperty,
  extractLeadPrimaryNeed,
  filterFollowupItems,
  getFollowupRecencyTier,
  propertyViolatesExplicitRestrictions,
  reconcileFollowupReasonAndApproach,
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
 * público (`dev-...`) do `cover_url` quando `public_url` estiver nulo na tabela de projeções.
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

    // Padrão da fila prioritária unificada: 'all' (todas as oportunidades elegíveis ativas,
    // ordenadas por faixa de recência + relevância comercial). Dashboard e aba Follow-up
    // compartilham exatamente esta mesma fonte e ordenação.
    const dateFilter = (
      url.searchParams.get('date_filter') || 'all'
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

    // 1. Consulta paralela inicial (sem varrer histórico gigante de ignored e sem rodar geração síncrona)
    const [activeBatch0Res, ignoredBatchRes, pipelinesRes, propertiesRes, adMappingsRes] =
      await Promise.all([
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
        Promise.resolve(
          supabase
            .from('property_ad_mappings')
            .select('ad_source_id, ad_name, property_id, properties(name)')
            .eq('account_id', accountId)
        ).catch(() => ({ data: null })),
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

    const rawIgnoredSuggestions = (
      (ignoredBatchRes.data || []) as Array<Record<string, unknown>>
    ).filter((row) => {
      const refDate = String(row.resolved_at || row.updated_at || row.created_at || '');
      const refMs = refDate ? new Date(refDate).getTime() : NaN;
      if (!Number.isFinite(refMs)) return true;
      return refMs >= ignoredRetentionCutoffMs;
    });

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

    // Mapa oficial: ad_source_id -> nome real do empreendimento (Seção 6)
    const adSourceToPropertyName = new Map<string, string>();
    const knownPropertyNamesSet = new Set<string>();
    for (const row of ((adMappingsRes as { data?: unknown })?.data || []) as Array<
      Record<string, unknown>
    >) {
      const adSourceId = typeof row.ad_source_id === 'string' ? row.ad_source_id.trim() : '';
      const propObj = row.properties as { name?: string } | null;
      const propName = propObj?.name ? String(propObj.name).trim() : '';
      if (adSourceId && propName) {
        adSourceToPropertyName.set(adSourceId, propName);
      }
      if (propName) {
        knownPropertyNamesSet.add(propName);
      }
    }

    for (const p of (propertiesRes.data || []) as Array<Record<string, unknown>>) {
      const propOp = String(p.operation || 'venda').toLowerCase();
      if (propOp !== 'venda') continue;
      const title = String(p.title || '').trim();
      if (title) knownPropertyNamesSet.add(title);
    }
    const knownPropertyNames = Array.from(knownPropertyNamesSet);

    // 2. Deduplicação por (status, contact_id) mantendo a sugestão mais recente de cada lead.
    //    Para status === 'pending', já descarta contatos arquivados, pausados, comprados ou adiados
    //    ANTES de carregar metadados pesados (elimina >65% de consultas desnecessárias).
    const statusCounts: Record<AiSuggestionStatus, number> = {
      pending: 0,
      approved: 0,
      rejected: 0,
      ignored: 0,
      done: 0,
    };

    const seenByStatusAndContact = new Set<string>();
    const visibleSuggestions: Array<Record<string, unknown>> = [];

    for (const row of rawSuggestions) {
      const rowStatus = ((row.status as AiSuggestionStatus) || 'pending') as AiSuggestionStatus;
      const contactId = typeof row.contact_id === 'string' ? row.contact_id.trim() : '';
      const rawContact = (row.contact ?? {}) as Record<string, unknown>;

      const snoozedUntil = typeof row.snoozed_until === 'string' ? row.snoozed_until : null;
      const isSnoozedFuture = Boolean(snoozedUntil && snoozedUntil > nowIso);

      if (rowStatus === 'pending') {
        if (isSnoozedFuture) continue;
        if (rawContact.archived_at || rawContact.paused_at || Boolean(rawContact.has_purchased)) {
          continue;
        }
      }

      if (contactId) {
        const dedupKey = `${rowStatus}:${contactId}`;
        if (seenByStatusAndContact.has(dedupKey)) {
          continue;
        }
        seenByStatusAndContact.add(dedupKey);
      }

      if (rowStatus !== 'pending' && rowStatus in statusCounts) {
        statusCounts[rowStatus] += 1;
      }
      visibleSuggestions.push(row);
    }

    // 3. Para calcular `counts.pending` com exatidão comercial (sem divergência entre contador e fila ativa),
    //    precisamos avaliar a elegibilidade real dos itens `pending`. Se a aba ativa for `pending`,
    //    usamos os mesmos dados hidratados. Se for outra aba, avaliamos os itens da aba ativa e
    //    hidratamos levemente os pendentes para o contador exato.
    const statusRows = visibleSuggestions.filter((r) => r.status === statusParam);
    const pendingCandidateRows = visibleSuggestions.filter((r) => r.status === 'pending');

    const rowsToHydrateMap = new Map<string, Record<string, unknown>>();
    for (const r of statusRows) {
      rowsToHydrateMap.set(String(r.id), r);
    }
    for (const r of pendingCandidateRows) {
      rowsToHydrateMap.set(String(r.id), r);
    }
    const rowsToHydrate = Array.from(rowsToHydrateMap.values());

    // 4. Carrega conversas, mensagens, deals, inteligência, tags, planos ativos, matches de venda e envios em lote
    const distinctConversationIds = Array.from(
      new Set(
        rowsToHydrate
          .map((r) => (typeof r.conversation_id === 'string' ? r.conversation_id : ''))
          .filter(Boolean)
      )
    );
    const distinctContactIds = Array.from(
      new Set(
        rowsToHydrate
          .map((r) => (typeof r.contact_id === 'string' ? r.contact_id : ''))
          .filter(Boolean)
      )
    );

    const BATCH_IDS = 200;
    const convChunks: string[][] = [];
    for (let i = 0; i < distinctConversationIds.length; i += BATCH_IDS) {
      convChunks.push(distinctConversationIds.slice(i, i + BATCH_IDS));
    }
    const contactChunks: string[][] = [];
    for (let i = 0; i < distinctContactIds.length; i += BATCH_IDS) {
      contactChunks.push(distinctContactIds.slice(i, i + BATCH_IDS));
    }

    const conversationsMap = new Map<string, Record<string, unknown>>();
    const latestConvByContactMap = new Map<string, Record<string, unknown>>();
    const msgStatsByConversationMap = new Map<string, ConversationMessageStats>();
    const recentMessagesTextByConvMap = new Map<string, string>();
    const dealsByContactMap = new Map<
      string,
      { stageId: string; stageName: string; stageColor: string | null }
    >();
    const intelligenceByContactMap = new Map<string, Record<string, unknown>>();
    const tagsByContactMap = new Map<string, TagWithJoin[]>();
    const activePlanContactIds = new Set<string>();
    const sharedPropertyKeysByLead = new Map<string, Set<string>>();
    const lastShareAtByLead = new Map<string, number>();
    const rawMatchesByLead = new Map<string, Array<Record<string, unknown>>>();

    await Promise.all([
      ...convChunks.map(async (chunk) => {
        const [convRes, msgRes] = await Promise.all([
          supabase
            .from('conversations')
            .select(
              'id, contact_id, last_message_at, last_message_text, status, ai_reply_count, ctwa_referral, ctwa_fep_started_at, ctwa_fep_expires_at'
            )
            .eq('account_id', accountId)
            .in('id', chunk),
          Promise.resolve(
            supabase
              .from('messages')
              .select(
                'conversation_id, sender_type, content_type, content_text, media_url, template_name, created_at, private, event'
              )
              .in('conversation_id', chunk)
              .order('created_at', { ascending: false })
          ).catch(() => ({ data: null })),
        ]);

        for (const c of (convRes.data || []) as Array<Record<string, unknown>>) {
          const cid = String(c.id || '');
          if (cid) conversationsMap.set(cid, c);
          const contactId = String(c.contact_id || '');
          if (contactId && !latestConvByContactMap.has(contactId)) {
            latestConvByContactMap.set(contactId, c);
          }
        }

        const grouped = new Map<string, RawConversationMessageRow[]>();
        for (const m of ((msgRes as { data?: unknown })?.data || []) as RawConversationMessageRow[]) {
          const cid = String(m.conversation_id || '');
          if (!cid) continue;
          const list = grouped.get(cid) ?? [];
          list.push(m);
          grouped.set(cid, list);
        }
        for (const [cid, list] of grouped.entries()) {
          msgStatsByConversationMap.set(cid, summarizeConversationMessages(list));
          const customerTexts = list
            .filter((m) => String(m.sender_type || '').toLowerCase() === 'customer' && m.content_text)
            .slice(0, 12)
            .map((m) => String(m.content_text || '').trim())
            .filter(Boolean)
            .join(' ');
          if (customerTexts) {
            recentMessagesTextByConvMap.set(cid, customerTexts);
          }
        }
      }),
      ...contactChunks.map(async (chunk) => {
        const [dealsRes, intelRes, tagsRes, matchesRes, plansRes, sharesRes] = await Promise.all([
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
          supabase
            .from('lead_property_matches')
            .select(
              'id, lead_id, property_id, match_score, commercial_priority, match_status, suppressed, score_breakdown'
            )
            .eq('account_id', accountId)
            .eq('suppressed', false)
            .in('lead_id', chunk)
            .order('match_score', { ascending: false })
            .order('commercial_priority', { ascending: false }),
          Promise.resolve(
            supabase
              .from('followup_plans')
              .select('contact_id, status')
              .eq('account_id', accountId)
              .eq('status', 'active')
              .in('contact_id', chunk)
          ).catch(() => ({ data: null })),
          Promise.resolve(
            supabase
              .from('property_shares')
              .select('lead_id, property_id, sent_at')
              .eq('account_id', accountId)
              .in('lead_id', chunk)
          ).catch(() => ({ data: null })),
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

        for (const m of (matchesRes.data || []) as Array<Record<string, unknown>>) {
          if (m.match_status === 'ignorado' || Number(m.match_score ?? 0) < 70) continue;
          const lid = String(m.lead_id || '');
          if (!lid) continue;
          const list = rawMatchesByLead.get(lid) || [];
          list.push(m);
          rawMatchesByLead.set(lid, list);
        }

        for (const plan of ((plansRes as { data?: unknown })?.data || []) as Array<
          Record<string, unknown>
        >) {
          const cid = String(plan.contact_id || '');
          if (cid && plan.status === 'active') activePlanContactIds.add(cid);
        }

        for (const sh of ((sharesRes as { data?: unknown })?.data || []) as Array<
          Record<string, unknown>
        >) {
          const lid = String(sh.lead_id || '');
          const pid = String(sh.property_id || '');
          if (!lid || !pid) continue;
          const set = sharedPropertyKeysByLead.get(lid) ?? new Set<string>();
          set.add(pid);
          sharedPropertyKeysByLead.set(lid, set);
          const sentMs = sh.sent_at ? new Date(String(sh.sent_at)).getTime() : 0;
          if (Number.isFinite(sentMs) && sentMs > (lastShareAtByLead.get(lid) ?? 0)) {
            lastShareAtByLead.set(lid, sentMs);
          }
        }
      }),
    ]);

    // 5. Carrega projeções de imóveis ATIVOS e EXCLUSIVAMENTE DE VENDA para os matches encontrados
    const allMatchedPropIds = Array.from(
      new Set(
        Array.from(rawMatchesByLead.values())
          .flat()
          .map((m) => String(m.property_id || ''))
          .filter(Boolean)
      )
    );

    const projectionsMap = new Map<string, Record<string, unknown>>();
    if (allMatchedPropIds.length > 0) {
      const propChunks: string[][] = [];
      for (let i = 0; i < allMatchedPropIds.length; i += BATCH_IDS) {
        propChunks.push(allMatchedPropIds.slice(i, i + BATCH_IDS));
      }
      const projResults = await Promise.all(
        propChunks.map((chunk) =>
          supabase
            .from('property_match_projections')
            .select(
              'property_id, status, operation, title, code, property_type, neighborhood, city, price_min, price_max, bedrooms_min, bedrooms_max, area_min, delivery_status, cover_url, public_url'
            )
            .eq('account_id', accountId)
            .eq('status', 'ativo')
            .in('property_id', chunk)
        )
      );
      for (const res of projResults) {
        for (const p of (res.data || []) as Array<Record<string, unknown>>) {
          // Regra de ouro (Seção 1): nunca recomendar imóveis de locação
          const op = String(p.operation || '').trim().toLowerCase();
          if (op !== 'venda') continue;
          projectionsMap.set(String(p.property_id), p);
        }
      }
    }

    // 6. Enriquece cada candidato, aplica regra de ouro (exclusivamente vendas),
    //    restrições explícitas de tipologia, link público válido e elegibilidade comercial real.
    const eligibleItemsForActiveTab: EnrichedFollowupItem[] = [];
    let eligiblePendingCount = 0;

    for (const raw of rowsToHydrate) {
      const suggestion = raw as unknown as AiSuggestion;
      const rowStatus = ((raw.status as AiSuggestionStatus) || 'pending') as AiSuggestionStatus;
      const payload = (raw.payload ?? {}) as RawFollowupPayload;
      const rawContact = (raw.contact ?? {}) as Record<string, unknown>;
      const contactId = String(raw.contact_id || rawContact.id || '');
      const conversationId = typeof raw.conversation_id === 'string' ? raw.conversation_id : '';
      const conv =
        (conversationId ? conversationsMap.get(conversationId) : null) ||
        (contactId ? latestConvByContactMap.get(contactId) : null) ||
        null;
      const msgStats = conversationId ? msgStatsByConversationMap.get(conversationId) : undefined;
      const recentCustomerTexts = conversationId
        ? recentMessagesTextByConvMap.get(conversationId) || ''
        : '';

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

      let profile: LeadSearchProfile | null = null;
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
        profile = buildProfileFromData(
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
        activePlanContactIds.has(contactId) ||
          (payload.draft && typeof payload.draft === 'object' && payload.draft.mode === 'plan')
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
      const ctwaSourceId =
        ctwaReferral && typeof ctwaReferral.source_id === 'string'
          ? ctwaReferral.source_id.trim()
          : null;
      const mappedAdPropertyName = ctwaSourceId
        ? adSourceToPropertyName.get(ctwaSourceId) || null
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
        '';
      const rawApproachSummary =
        (typeof payload.approach_summary === 'string' && payload.approach_summary.trim()) ||
        (typeof suggestion.description === 'string' && suggestion.description.trim()) ||
        null;

      // Empreendimento de origem estruturado (Seção 6 — nunca usa chamada publicitária)
      const interestProperty = extractInterestProperty({
        mappedAdPropertyName,
        tagByCategory,
        ctwaHeadline,
        reasonText: `${rawReason} ${msgStats?.lastCustomerText || ''}`,
        knownPropertyNames,
      });

      const primaryNeed = extractLeadPrimaryNeed({
        summary,
        tagByCategory,
      });

      // Restrições explícitas declaradas pelo cliente (ex.: "não quer flat nem estúdio")
      const restrictions = extractExplicitPropertyRestrictions({
        summary,
        messagesText: recentCustomerTexts,
        lastCustomerText: msgStats?.lastCustomerText ?? convLastMessageText,
      });

      // Imóveis compatíveis de VENDA com link público válido e respeitando restrições explícitas (Seção 8)
      const sharedSet = sharedPropertyKeysByLead.get(contactId) ?? new Set<string>();
      const leadRawMatches = rawMatchesByLead.get(contactId) || [];
      const compatibleList: CompatiblePropertySummary[] = [];
      const seenPropIds = new Set<string>();

      for (const m of leadRawMatches) {
        const propId = String(m.property_id || '');
        if (!propId || seenPropIds.has(propId)) continue;
        const prop = projectionsMap.get(propId);
        if (!prop) continue;

        const propOperation = String(prop.operation || '').toLowerCase();
        if (propOperation !== 'venda') continue;

        const propTitle = String(prop.title || 'Imóvel compatível');
        const propType = prop.property_type ? String(prop.property_type) : null;

        // Restrição explícita é obrigatória
        if (
          propertyViolatesExplicitRestrictions(
            { propertyType: propType, title: propTitle },
            restrictions.excludedTypes
          )
        ) {
          continue;
        }

        // Cada imóvel recomendado precisa de um link público válido e compartilhável
        const resolvedPublicUrl = resolveCompatiblePropertyPublicUrl(prop);
        if (!resolvedPublicUrl) continue;

        const breakdown =
          m.score_breakdown && typeof m.score_breakdown === 'object'
            ? (m.score_breakdown as Record<string, unknown>)
            : {};
        const reasons = Array.isArray(breakdown.reasons)
          ? (breakdown.reasons as unknown[]).map((r) => String(r)).filter(Boolean)
          : [];

        seenPropIds.add(propId);
        compatibleList.push({
          matchId: String(m.id || ''),
          propertyId: propId,
          title: propTitle,
          code: prop.code ? String(prop.code) : null,
          neighborhood: String(prop.neighborhood || ''),
          city: String(prop.city || 'João Pessoa'),
          operation: 'venda',
          propertyType: propType,
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
          alreadyShared: sharedSet.has(propId) || String(m.match_status || '') === 'enviado',
        });
      }

      // Prioriza opções ainda não apresentadas quando houver empate próximo de compatibilidade
      compatibleList.sort((a, b) => {
        if (Boolean(a.alreadyShared) !== Boolean(b.alreadyShared)) {
          return a.alreadyShared ? 1 : -1;
        }
        if (b.matchScore !== a.matchScore) return b.matchScore - a.matchScore;
        return b.commercialPriority - a.commercialPriority;
      });

      const topCompatibleProperties = compatibleList.slice(0, FOLLOWUP_MAX_RECOMMENDED_PROPERTIES);

      // Compromisso comercial pendente da equipe (somente se evidenciado na conversa)
      const lastBusinessMs = timing.lastBusinessMessageAt
        ? new Date(timing.lastBusinessMessageAt).getTime()
        : 0;
      const lastShareMs = lastShareAtByLead.get(contactId) ?? 0;
      const commitment = detectPendingTeamCommitment({
        lastBusinessText: msgStats?.lastBusinessText ?? null,
        lastCustomerMessageAt: timing.lastCustomerMessageAt,
        lastBusinessMessageAt: timing.lastBusinessMessageAt,
        hasSharedPropertiesAfterLastBusiness:
          lastShareMs > 0 && lastBusinessMs > 0 && lastShareMs >= lastBusinessMs,
      });

      // Avaliação de elegibilidade comercial (Seções 1, 2 e 8)
      const eligibility = evaluateFollowupCommercialEligibility({
        profile,
        hasPurchased,
        stageName,
        lastCustomerText: msgStats?.lastCustomerText ?? convLastMessageText,
        lastCustomerMessageAt: timing.lastCustomerMessageAt,
        lastAgentMessageAt: msgStats?.lastAgentMessageAt ?? null,
        hasPendingCommitment: commitment.hasPendingCommitment,
        hasActiveFollowupPlan: hasActivePlan,
        isSnoozedFuture: Boolean(suggestion.snoozed_until && suggestion.snoozed_until > nowIso),
        compatibleSalePropertiesCount: topCompatibleProperties.length,
        profileMaturity,
        aiScore,
        interestProperty,
        awaitingBusinessReply: timing.awaitingBusinessReply,
        teamCooldownHours: FOLLOWUP_RECENT_TEAM_CONTACT_COOLDOWN_HOURS,
        nowMs,
        isHistoricalView: rowStatus !== 'pending',
      });

      if (rowStatus === 'pending') {
        if (!eligibility.eligible) {
          continue;
        }
        eligiblePendingCount += 1;
      } else {
        // Mesmo em abas históricas (ex.: approved), nunca exibir locação como oportunidade de venda
        if (eligibility.operation === 'locacao' || profile?.isShortStayOnly) {
          continue;
        }
      }

      if (rowStatus !== statusParam) {
        continue;
      }

      // Motivo comercial personalizado e natural (Seção 7)
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
        contactName,
        profile,
        excludedTypeLabels: restrictions.labels,
        hasPendingCommitment: commitment.hasPendingCommitment,
        compatiblePropertiesCount: topCompatibleProperties.length,
        isCtwaOrigin: isCtwaLead,
      });

      const hasRealConvOrMsgData = Boolean(conv || msgStats || resolvedLastCustomerAt);
      const effectiveCustomerAtForWindow =
        timing.lastCustomerMessageAt ??
        (!hasRealConvOrMsgData ? String(suggestion.created_at || nowIso) : null);

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

      const bestMatchScore =
        topCompatibleProperties.length > 0 ? topCompatibleProperties[0].matchScore : null;

      const priorityEval = calculateFollowupCommercialPriority({
        confidenceScore,
        aiScore,
        profileMaturity,
        hasInterestProperty: Boolean(interestProperty),
        hasPrimaryNeed: Boolean(primaryNeed),
        stageName,
        awaitingBusinessReply: timing.awaitingBusinessReply,
        windowStatus: sessionWindow.status,
        bestMatchScore,
        hasPendingCommitment: commitment.hasPendingCommitment,
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

      const recencyTier = getFollowupRecencyTier(
        timing.lastCustomerMessageAt ?? (!hasRealConvOrMsgData ? suggestionCreatedAt : null),
        nowMs
      );

      eligibleItemsForActiveTab.push({
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
        primaryNeed: null,
        lastMessagePreview: msgStats?.lastCustomerText ?? convLastMessageText,
        lastCustomerMessagePreview: msgStats?.lastCustomerText ?? null,
        lastBusinessMessagePreview: msgStats?.lastBusinessText ?? null,
        compatiblePropertiesCount: topCompatibleProperties.length,
        compatibleProperties: topCompatibleProperties,
        commercialOperation: eligibility.operation,
        hasPendingCommitment: commitment.hasPendingCommitment,
        excludedPropertyTypes: restrictions.excludedTypes,
        recencyTier,
      });
    }

    statusCounts.pending = eligiblePendingCount;

    // 7. Aplica filtros combinados e ordenação sobre o conjunto COMPLETO de oportunidades elegíveis
    //    ANTES da paginação e da seleção do Top 3 (Seção 4).
    const filteredItems = filterFollowupItems(eligibleItemsForActiveTab, {
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
        totalInActiveStatusAllDates: eligibleItemsForActiveTab.length,
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
