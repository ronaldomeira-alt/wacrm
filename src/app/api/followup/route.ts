import { NextResponse } from 'next/server';
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { AI_SUGGESTION_STATUSES } from '@/lib/ai-suggestion-status';
import { saoPauloDayKey } from '@/lib/dashboard/date-utils';
import {
  buildProfileFromData,
  type ContactRow,
  type TagWithJoin,
} from '@/lib/match/profile-builder';
import { calculateProfileMaturity } from '@/lib/match/maturity';
import type { LeadSearchProfile } from '@/lib/match/types';
import {
  calculateFollowupCommercialPriority,
  classifyFollowupTimingAndType,
  compareFollowupItems,
  extractInterestProperty,
  extractLeadPrimaryNeed,
  filterFollowupItems,
  type CompatiblePropertySummary,
  type EnrichedFollowupItem,
  type FollowupDateFilter,
  type FollowupMaturityBand,
  type FollowupOpportunityType,
  type FollowupSortBy,
} from '@/lib/followup/engine';
import type { AiSuggestion, AiSuggestionStatus } from '@/types';

const DEFAULT_PAGE_SIZE = 36;
const MAX_PAGE_SIZE = 100;

interface RawFollowupPayload {
  stage_name?: string | null;
  has_purchased?: boolean;
  hours_since_contact?: number | null;
  reason?: string | null;
  approach_summary?: string | null;
  score?: number | null;
  [key: string]: unknown;
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

    const dateFilter = (url.searchParams.get('date_filter') || '7d').trim() as FollowupDateFilter;
    const customFrom = url.searchParams.get('custom_from');
    const customTo = url.searchParams.get('custom_to');
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

    // 1. Carrega todas as sugestões de follow-up da conta em lotes seguros (evita limite de 1000 linhas)
    const rawSuggestions: Array<Record<string, unknown>> = [];
    const CHUNK_SIZE = 1000;
    for (let scanPage = 0; scanPage < 10; scanPage++) {
      const from = scanPage * CHUNK_SIZE;
      const to = from + CHUNK_SIZE - 1;
      const { data: batch, error: batchErr } = await supabase
        .from('ai_suggestions')
        .select(
          '*, contact:contacts(id, name, phone, avatar_url, ai_score, ai_score_reason, has_purchased, is_personal_whatsapp, paused_at, archived_at)'
        )
        .eq('account_id', accountId)
        .eq('category', 'followup')
        .order('created_at', { ascending: false })
        .range(from, to);

      if (batchErr) {
        console.error('[api/followup GET] error fetching suggestions:', batchErr);
        return NextResponse.json(
          { error: 'Falha ao carregar sugestões de follow-up' },
          { status: 500 }
        );
      }

      if (!batch || batch.length === 0) break;
      rawSuggestions.push(...(batch as Array<Record<string, unknown>>));
      if (batch.length < CHUNK_SIZE) break;
    }

    // 2. Contabiliza totais por status (ocultando sugestões adiadas para o futuro na aba 'pending')
    const statusCounts: Record<AiSuggestionStatus, number> = {
      pending: 0,
      approved: 0,
      rejected: 0,
      ignored: 0,
      done: 0,
    };

    const visibleSuggestions: Array<Record<string, unknown>> = [];
    for (const row of rawSuggestions) {
      const rowStatus = (row.status as AiSuggestionStatus) || 'pending';
      const snoozedUntil = typeof row.snoozed_until === 'string' ? row.snoozed_until : null;
      const isSnoozedFuture = Boolean(snoozedUntil && snoozedUntil > nowIso);

      if (rowStatus === 'pending' && isSnoozedFuture) {
        continue;
      }

      if (rowStatus in statusCounts) {
        statusCounts[rowStatus] += 1;
      }
      visibleSuggestions.push(row);
    }

    // Filtra pelo status da aba ativa antes de hidratar metadados pesados
    const statusRows = visibleSuggestions.filter((r) => r.status === statusParam);

    // 3. Carrega etapas de pipeline disponíveis na conta + metadados dos contatos da aba ativa
    const distinctContactIds = Array.from(
      new Set(
        statusRows
          .map((r) => (typeof r.contact_id === 'string' ? r.contact_id : ''))
          .filter(Boolean)
      )
    );
    const distinctConversationIds = Array.from(
      new Set(
        statusRows
          .map((r) => (typeof r.conversation_id === 'string' ? r.conversation_id : ''))
          .filter(Boolean)
      )
    );

    const [pipelinesRes, propertiesRes] = await Promise.all([
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

    const availableStagesMap = new Map<string, { id: string; name: string; color: string; position: number }>();
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

    const conversationsMap = new Map<string, Record<string, unknown>>();
    const latestConvByContactMap = new Map<string, Record<string, unknown>>();
    const dealsByContactMap = new Map<string, { stageId: string; stageName: string; stageColor: string | null }>();
    const intelligenceByContactMap = new Map<string, Record<string, unknown>>();
    const tagsByContactMap = new Map<string, TagWithJoin[]>();

    const BATCH_IDS = 200;

    // Busca conversas vinculadas
    for (let i = 0; i < distinctConversationIds.length; i += BATCH_IDS) {
      const chunk = distinctConversationIds.slice(i, i + BATCH_IDS);
      const { data: convs } = await supabase
        .from('conversations')
        .select(
          'id, contact_id, last_message_at, last_message_text, status, ai_reply_count, ctwa_referral'
        )
        .eq('account_id', accountId)
        .in('id', chunk);

      for (const c of (convs || []) as Array<Record<string, unknown>>) {
        const cid = String(c.id || '');
        if (cid) conversationsMap.set(cid, c);
        const contactId = String(c.contact_id || '');
        if (contactId && !latestConvByContactMap.has(contactId)) {
          latestConvByContactMap.set(contactId, c);
        }
      }
    }

    // Busca deals, inteligência e tags em paralelo por lote de contatos
    for (let i = 0; i < distinctContactIds.length; i += BATCH_IDS) {
      const chunk = distinctContactIds.slice(i, i + BATCH_IDS);
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
    }

    // 4. Constrói os itens enriquecidos e os perfis de busca em memória
    const profilesByContactMap = new Map<string, LeadSearchProfile>();
    const enrichedItems: EnrichedFollowupItem[] = [];

    for (const raw of statusRows) {
      const suggestion = raw as unknown as AiSuggestion;
      const payload = (raw.payload ?? {}) as RawFollowupPayload;
      const rawContact = (raw.contact ?? {}) as Record<string, unknown>;
      const contactId = String(raw.contact_id || rawContact.id || '');
      const conversationId = typeof raw.conversation_id === 'string' ? raw.conversation_id : '';
      const conv =
        (conversationId ? conversationsMap.get(conversationId) : null) ||
        (contactId ? latestConvByContactMap.get(contactId) : null) ||
        null;

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

      const lastMessageAt =
        conv && typeof conv.last_message_at === 'string' ? conv.last_message_at : null;
      const lastMessageText =
        conv && typeof conv.last_message_text === 'string' ? conv.last_message_text : null;
      const aiReplyCount =
        conv && typeof conv.ai_reply_count === 'number' ? conv.ai_reply_count : null;

      const timing = classifyFollowupTimingAndType({
        lastMessageAt,
        lastMessageText,
        aiReplyCount,
        payloadHoursSinceContact:
          typeof payload.hours_since_contact === 'number' ? payload.hours_since_contact : null,
        stageName,
        nowMs,
      });

      const reason =
        (typeof payload.reason === 'string' && payload.reason.trim()) ||
        (typeof suggestion.title === 'string' && suggestion.title.trim()) ||
        'Oportunidade comercial identificada para acompanhamento.';
      const approachSummary =
        (typeof payload.approach_summary === 'string' && payload.approach_summary.trim()) ||
        (typeof suggestion.description === 'string' && suggestion.description.trim()) ||
        null;

      const ctwaReferral =
        conv && conv.ctwa_referral && typeof conv.ctwa_referral === 'object'
          ? (conv.ctwa_referral as Record<string, unknown>)
          : null;
      const ctwaHeadline =
        ctwaReferral && typeof ctwaReferral.headline === 'string'
          ? ctwaReferral.headline
          : null;

      const interestProperty = extractInterestProperty({
        tagByCategory,
        ctwaHeadline,
        reasonText: `${reason} ${approachSummary || ''}`,
        knownPropertyNames,
      });

      const primaryNeed = extractLeadPrimaryNeed({
        summary,
        tagByCategory,
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
      });

      const suggestionCreatedAt = String(suggestion.created_at || nowIso);
      const suggestionDayKeySp = saoPauloDayKey(suggestionCreatedAt);
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
        profileMaturity,
        aiScore,
        confidenceScore,
        commercialPriorityScore: priorityEval.score,
        priorityTier: priorityEval.tier,
        suggestionCreatedAt,
        suggestionDayKeySp,
        suggestionSignificantUpdatedAt,
        lastCommunicationAt: timing.lastCommunicationAt,
        hoursSinceLastCommunication: timing.hoursSinceLastCommunication,
        neverContacted: timing.neverContacted,
        reason,
        approachSummary,
        interestProperty,
        primaryNeed,
        lastMessagePreview: lastMessageText,
        compatiblePropertiesCount: 0,
        compatibleProperties: [],
      });
    }

    // 5. Aplica os filtros combinados e ordenação determinística
    const filteredItems = filterFollowupItems(enrichedItems, {
      status: statusParam,
      dateFilter,
      customFrom,
      customTo,
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

    // 6. Integração inteligente e leve com o Match (Seção 9):
    //    Consulta imóveis compatíveis APENAS para os leads exibidos na página atual (máx 36),
    //    evitando consultas pesadas ou recálculos para todos os 193+ registros.
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
          publicUrl: prop.public_url ? String(prop.public_url) : null,
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
