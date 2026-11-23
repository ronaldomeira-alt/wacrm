import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { loadAiConfig } from '@/lib/ai/config';
import { logAiUsage } from '@/lib/ai/usage';
import { ensurePropertyUuid } from '@/lib/tunnel/auth';
import { getConversationSessionStatus } from '@/lib/whatsapp/session-window';
import {
  generateMatchPropertyMessage,
  resolveValidatedPublicPropertyUrl,
  selectApprovedMatchTemplate,
  type SmartSendPropertyContext,
} from '@/lib/match/smart-send';

interface PropertyProjectionRow {
  property_id: string;
  account_id?: string;
  code: string | null;
  title: string;
  operation: string;
  property_type: string;
  neighborhood: string | null;
  city: string | null;
  price_min: number | string | null;
  price_max: number | string | null;
  area_min: number | string | null;
  bedrooms_min: number | null;
  bedrooms_max: number | null;
  delivery_status: string | null;
  delivery_deadline: string | null;
  features: string[] | null;
  cover_url: string | null;
  public_url: string | null;
  status: string;
}

interface DuplicateShareInfo {
  alreadySent: boolean;
  lastSentAt: string | null;
  sendCount: number;
  channel: string | null;
}

async function resolveActiveProperty(
  db: SupabaseClient,
  accountId: string,
  lookupIds: string[]
): Promise<{
  property: SmartSendPropertyContext | null;
  rawPublicUrl: string | null;
  publicPageId: string | null;
  unavailable: boolean;
}> {
  const selectCols =
    'property_id, account_id, code, title, operation, property_type, neighborhood, city, price_min, price_max, area_min, bedrooms_min, bedrooms_max, delivery_status, delivery_deadline, features, cover_url, public_url, status';

  const { data: scopedRows } = await db
    .from('property_match_projections')
    .select(selectCols)
    .eq('account_id', accountId)
    .in('property_id', lookupIds);

  let row: PropertyProjectionRow | null =
    ((scopedRows || []) as PropertyProjectionRow[]).find((r) => r.status === 'ativo') ??
    ((scopedRows || []) as PropertyProjectionRow[])[0] ??
    null;

  if (!row) {
    const { data: teamRows } = await db
      .from('property_match_projections')
      .select(selectCols)
      .in('property_id', lookupIds)
      .eq('status', 'ativo')
      .limit(1);
    row = ((teamRows || []) as PropertyProjectionRow[])[0] ?? null;
  }

  const coverInventoryId =
    row?.cover_url?.match(/\/properties\/([^/]+)/)?.[1]?.trim() || null;
  const invLookupIds = Array.from(
    new Set([...(coverInventoryId ? [coverInventoryId] : []), ...lookupIds])
  );

  let invPropertyId: string | null = null;
  let invData: Record<string, unknown> | null = null;
  if (!row || !row.public_url) {
    try {
      const invTable = db.from('inventory_properties');
      if (typeof invTable?.select === 'function') {
        const { data: invRow } = await invTable
          .select('property_id, property_data')
          .eq('account_id', accountId)
          .in('property_id', invLookupIds)
          .limit(1)
          .maybeSingle();
        if (invRow?.property_id) {
          invPropertyId = String(invRow.property_id).trim() || null;
        }
        if (invRow?.property_data && typeof invRow.property_data === 'object') {
          invData = invRow.property_data as Record<string, unknown>;
        }
      }
    } catch {
      // Fallback opcional ignorado quando a tabela não está disponível no ambiente/mock
    }
  }

  if (row) {
    if (row.status !== 'ativo' || (row.operation && row.operation !== 'venda')) {
      return { property: null, rawPublicUrl: null, publicPageId: null, unavailable: true };
    }

    const explicitProjUrl =
      typeof row.public_url === 'string' && row.public_url.trim() ? row.public_url.trim() : null;
    const invPublicPageId =
      typeof invData?.public_page_id === 'string' && invData.public_page_id.trim()
        ? invData.public_page_id.trim()
        : null;
    const invPublicUrl =
      typeof invData?.public_url === 'string' && invData.public_url.trim()
        ? invData.public_url.trim()
        : null;

    const fallbackPageId = explicitProjUrl
      ? null
      : invPublicPageId || coverInventoryId || invPropertyId || (row.code ? row.property_id : null);

    return {
      unavailable: false,
      rawPublicUrl: explicitProjUrl || invPublicUrl,
      publicPageId: fallbackPageId,
      property: {
        propertyId: row.property_id,
        code: row.code,
        title: row.title,
        operation: row.operation || 'venda',
        propertyType: row.property_type || 'imovel',
        neighborhood: row.neighborhood,
        city: row.city,
        priceMin: row.price_min !== null ? Number(row.price_min) : null,
        priceMax: row.price_max !== null ? Number(row.price_max) : null,
        areaMin: row.area_min !== null ? Number(row.area_min) : null,
        bedroomsMin: row.bedrooms_min,
        bedroomsMax: row.bedrooms_max,
        deliveryStatus: row.delivery_status || 'pronto',
        deliveryDeadline: row.delivery_deadline,
        features: Array.isArray(row.features) ? row.features : [],
      },
    };
  }

  if (!invData) {
    return { property: null, rawPublicUrl: null, publicPageId: null, unavailable: true };
  }

  const isAtivo = invData.ativo !== false && invData.status !== 'vendido' && invData.status !== 'inativo';
  if (!isAtivo) {
    return { property: null, rawPublicUrl: null, publicPageId: null, unavailable: true };
  }

  const publicPageId =
    typeof invData.public_page_id === 'string' && invData.public_page_id.trim()
      ? invData.public_page_id.trim()
      : null;
  const invPublicUrl =
    typeof invData.public_url === 'string' && invData.public_url.trim()
      ? invData.public_url.trim()
      : null;

  return {
    unavailable: false,
    rawPublicUrl: invPublicUrl,
    publicPageId,
    property: {
      propertyId: lookupIds[0],
      code: typeof invData.code === 'string' ? invData.code : null,
      title: String(invData.title || invData.name || 'Imóvel'),
      operation: typeof invData.operation === 'string' ? invData.operation : 'venda',
      propertyType: typeof invData.property_type === 'string' ? invData.property_type : 'imovel',
      neighborhood: typeof invData.neighborhood === 'string' ? invData.neighborhood : null,
      city: typeof invData.city === 'string' ? invData.city : null,
      priceMin: invData.price_min ? Number(invData.price_min) : null,
      priceMax: invData.price_max ? Number(invData.price_max) : null,
      areaMin: invData.area_min ? Number(invData.area_min) : null,
      bedroomsMin: typeof invData.bedrooms_min === 'number' ? invData.bedrooms_min : null,
      bedroomsMax: typeof invData.bedrooms_max === 'number' ? invData.bedrooms_max : null,
      deliveryStatus:
        typeof invData.delivery_status === 'string' ? invData.delivery_status : 'pronto',
      deliveryDeadline:
        typeof invData.delivery_deadline === 'string' ? invData.delivery_deadline : null,
      features: Array.isArray(invData.features)
        ? invData.features.filter((f): f is string => typeof f === 'string')
        : [],
    },
  };
}

/**
 * POST /api/match/prepare-send
 *
 * Prepara o rascunho contextualizado com IA + link público validado para o corretor
 * revisar no Inbox antes de confirmar o envio real.
 *
 * NÃO dispara mensagem via WhatsApp, NÃO cria registro em `property_shares`
 * e NÃO marca o Match como `enviado`.
 */
export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent');
    const limit = checkRateLimit(`match-prepare-send:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as {
      lead_id?: string;
      property_id?: string;
      match_id?: string | null;
      force_resend?: boolean;
    } | null;

    const leadId = typeof body?.lead_id === 'string' ? body.lead_id.trim() : '';
    const rawPropertyId = typeof body?.property_id === 'string' ? body.property_id.trim() : '';
    const matchIdInput = typeof body?.match_id === 'string' ? body.match_id.trim() : null;
    const forceResend = Boolean(body?.force_resend);

    if (!leadId || !rawPropertyId) {
      return NextResponse.json(
        { error: 'lead_id e property_id são obrigatórios.' },
        { status: 400 }
      );
    }

    const canonicalPropertyId = ensurePropertyUuid(rawPropertyId);
    const propertyLookupIds =
      canonicalPropertyId === rawPropertyId ? [canonicalPropertyId] : [canonicalPropertyId, rawPropertyId];

    // 1. Confirma lead na conta (RLS) e localiza conversa ativa no Inbox
    const [{ data: contact, error: contactErr }, { data: conv, error: convErr }] = await Promise.all([
      ctx.supabase
        .from('contacts')
        .select('id, name, phone, ai_score')
        .eq('id', leadId)
        .eq('account_id', ctx.accountId)
        .maybeSingle(),
      ctx.supabase
        .from('conversations')
        .select('id, last_message_at, created_at')
        .eq('account_id', ctx.accountId)
        .eq('contact_id', leadId)
        .order('last_message_at', { ascending: false, nullsFirst: false })
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

    if (contactErr || !contact) {
      return NextResponse.json(
        { error: 'Lead não encontrado nesta conta.' },
        { status: 404 }
      );
    }

    if (convErr || !conv) {
      return NextResponse.json(
        { error: 'Conversa não localizada no Inbox para este lead.' },
        { status: 404 }
      );
    }

    // 2. Valida que o imóvel existe e está ativo no catálogo
    const resolvedProp = await resolveActiveProperty(ctx.supabase, ctx.accountId, propertyLookupIds);
    if (resolvedProp.unavailable || !resolvedProp.property) {
      return NextResponse.json(
        { error: 'Imóvel indisponível no cadastro para compartilhamento.' },
        { status: 409 }
      );
    }

    // 3. Valida o link público do imóvel antes de continuar
    const resolvedLink = resolveValidatedPublicPropertyUrl(
      resolvedProp.rawPublicUrl,
      resolvedProp.publicPageId
    );
    if (!resolvedLink.url) {
      return NextResponse.json(
        { error: resolvedLink.error || 'Link público do imóvel ausente ou inválido.' },
        { status: 422 }
      );
    }

    // 4. Checa duplicidade real de envio anterior sem criar nenhum registro
    const [{ data: priorPropertyShares }, { data: matchRow }] = await Promise.all([
      ctx.supabase
        .from('property_shares')
        .select('id, sent_at, channel')
        .eq('account_id', ctx.accountId)
        .eq('lead_id', leadId)
        .in('property_id', propertyLookupIds)
        .is('revoked_at', null)
        .order('sent_at', { ascending: false }),
      matchIdInput
        ? ctx.supabase
            .from('lead_property_matches')
            .select('id, match_status, sent_at, match_score, score_breakdown')
            .eq('id', matchIdInput)
            .eq('account_id', ctx.accountId)
            .maybeSingle()
        : ctx.supabase
            .from('lead_property_matches')
            .select('id, match_status, sent_at, match_score, score_breakdown')
            .eq('account_id', ctx.accountId)
            .eq('lead_id', leadId)
            .in('property_id', propertyLookupIds)
            .limit(1)
            .maybeSingle(),
    ]);

    const sharesForThisProp = (priorPropertyShares || []) as Array<{
      id: string;
      sent_at: string | null;
      channel: string | null;
    }>;
    const matchAlreadySent = matchRow?.match_status === 'enviado';
    const alreadySent = sharesForThisProp.length > 0 || matchAlreadySent;

    const duplicateInfo: DuplicateShareInfo = {
      alreadySent,
      lastSentAt: sharesForThisProp[0]?.sent_at || (matchAlreadySent ? matchRow?.sent_at || null : null),
      sendCount: sharesForThisProp.length > 0 ? sharesForThisProp.length : matchAlreadySent ? 1 : 0,
      channel: sharesForThisProp[0]?.channel || (matchAlreadySent ? 'match' : null),
    };

    if (alreadySent && !forceResend) {
      return NextResponse.json({
        ok: true,
        requiresConfirmation: true,
        duplicateInfo,
        conversationId: conv.id,
        matchId: matchRow?.id || matchIdInput || null,
        propertyId: canonicalPropertyId,
        propertyTitle: resolvedProp.property.title,
        publicUrl: resolvedLink.url,
      });
    }

    // 5. Carrega contexto comercial do lead (inteligência, tags, envios prévios de outros imóveis)
    const [{ data: intel }, { data: tagRows }, { data: allLeadShares }] = await Promise.all([
      ctx.supabase
        .from('lead_intelligence')
        .select('summary')
        .eq('contact_id', leadId)
        .maybeSingle(),
      ctx.supabase
        .from('contact_tags')
        .select('tags(name)')
        .eq('contact_id', leadId),
      ctx.supabase
        .from('property_shares')
        .select('property_id')
        .eq('account_id', ctx.accountId)
        .eq('lead_id', leadId)
        .is('revoked_at', null)
        .order('sent_at', { ascending: false })
        .limit(10),
    ]);

    const otherPropIds = Array.from(
      new Set(
        ((allLeadShares || []) as Array<{ property_id: string }>)
          .map((s) => s.property_id)
          .filter((pid) => pid && !propertyLookupIds.includes(pid))
      )
    );

    let priorSharedTitles: string[] = [];
    if (otherPropIds.length > 0) {
      const { data: sharedPropRows } = await ctx.supabase
        .from('property_match_projections')
        .select('title')
        .eq('account_id', ctx.accountId)
        .in('property_id', otherPropIds);
      priorSharedTitles = ((sharedPropRows || []) as Array<{ title: string }>)
        .map((r) => r.title)
        .filter(Boolean);
    }

    const tags = ((tagRows || []) as unknown as Array<{ tags?: { name?: string } | null }>)
      .map((row) => row.tags?.name)
      .filter((name): name is string => Boolean(name));

    const breakdown =
      matchRow?.score_breakdown && typeof matchRow.score_breakdown === 'object'
        ? (matchRow.score_breakdown as { reasons?: unknown })
        : null;
    const matchReasons = Array.isArray(breakdown?.reasons)
      ? breakdown.reasons.filter((r): r is string => typeof r === 'string')
      : [];

    let aiConfig = null;
    try {
      aiConfig = await loadAiConfig(ctx.supabase, ctx.accountId);
    } catch (err) {
      console.error('[match/prepare-send] Falha ao carregar config de IA, usando fallback:', err);
      aiConfig = null;
    }

    const matchContext = {
      lead: {
        leadId,
        leadName: contact.name || 'Cliente',
        aiScore: contact.ai_score,
        tags,
        intelligenceSummary: (intel?.summary as Record<string, unknown> | undefined) || null,
      },
      property: resolvedProp.property,
      publicUrl: resolvedLink.url,
      matchScore: matchRow?.match_score ? Number(matchRow.match_score) : null,
      matchReasons,
      priorSharesCount: (allLeadShares || []).length,
      priorSharedTitles,
      lastMessageAt: conv.last_message_at || conv.created_at || null,
    };

    // 6. Avalia a janela de atendimento de 24 horas da conversa no WhatsApp Cloud API
    const sessionStatus = await getConversationSessionStatus(ctx.supabase, conv.id);

    if (!sessionStatus.windowOpen) {
      // CENÁRIO B / C — Janela de 24h encerrada: exige template aprovado da Meta (nunca texto livre)
      const templateResult = await selectApprovedMatchTemplate({
        db: ctx.supabase,
        accountId: ctx.accountId,
        config: aiConfig,
        conversationId: conv.id,
        context: matchContext,
      });

      if (aiConfig && templateResult.generatedBy === 'ai' && templateResult.usage) {
        void logAiUsage(ctx.supabase, {
          accountId: ctx.accountId,
          conversationId: conv.id,
          mode: 'followup',
          provider: aiConfig.provider,
          model: aiConfig.model,
          usage: templateResult.usage,
        });
      }

      if (!templateResult.selection) {
        // CENÁRIO C — Janela fechada e sem template aprovado compatível
        return NextResponse.json({
          ok: true,
          requiresConfirmation: false,
          mode: 'no_template',
          sessionWindowOpen: false,
          sessionStatus,
          conversationId: conv.id,
          matchId: matchRow?.id || matchIdInput || null,
          propertyId: canonicalPropertyId,
          propertyTitle: resolvedProp.property.title,
          publicUrl: resolvedLink.url,
          draftText: null,
          template: null,
          noTemplateReason:
            templateResult.noTemplateReason ||
            'A janela de 24 horas está encerrada e não há um template aprovado compatível disponível para esta abordagem.',
          availableApprovedTemplatesCount: templateResult.availableApprovedTemplatesCount,
          templateAngle: templateResult.templateAngle,
          templateLabel: templateResult.templateLabel,
          generatedBy: 'none',
          fallbackReason: null,
          duplicateInfo,
        });
      }

      // CENÁRIO B — Janela fechada e template aprovado compatível selecionado com variáveis preenchidas
      const sel = templateResult.selection;
      return NextResponse.json({
        ok: true,
        requiresConfirmation: false,
        mode: 'template',
        sessionWindowOpen: false,
        sessionStatus,
        conversationId: conv.id,
        matchId: matchRow?.id || matchIdInput || null,
        propertyId: canonicalPropertyId,
        propertyTitle: resolvedProp.property.title,
        publicUrl: resolvedLink.url,
        draftText: null,
        template: {
          id: sel.template.id,
          name: sel.template.name,
          language: sel.template.language,
          category: sel.template.category,
          bodyText: sel.template.body_text,
          headerType: sel.template.header_type,
          headerContent: sel.template.header_content,
          values: sel.values,
          previewText: sel.previewText,
        },
        templateAngle: templateResult.templateAngle,
        templateLabel: templateResult.templateLabel,
        generatedBy: templateResult.generatedBy,
        fallbackReason: null,
        duplicateInfo,
      });
    }

    // CENÁRIO A — Janela de 24h aberta: permite mensagem livre contextualizada
    const generated = await generateMatchPropertyMessage({
      db: ctx.supabase,
      config: aiConfig,
      conversationId: conv.id,
      context: matchContext,
    });

    if (aiConfig && generated.generatedBy === 'ai' && generated.usage) {
      void logAiUsage(ctx.supabase, {
        accountId: ctx.accountId,
        conversationId: conv.id,
        mode: 'followup',
        provider: aiConfig.provider,
        model: aiConfig.model,
        usage: generated.usage,
      });
    }

    return NextResponse.json({
      ok: true,
      requiresConfirmation: false,
      mode: 'free',
      sessionWindowOpen: true,
      sessionStatus,
      conversationId: conv.id,
      matchId: matchRow?.id || matchIdInput || null,
      propertyId: canonicalPropertyId,
      propertyTitle: resolvedProp.property.title,
      publicUrl: resolvedLink.url,
      draftText: generated.text,
      template: null,
      templateAngle: generated.templateAngle,
      templateLabel: generated.templateLabel,
      generatedBy: generated.generatedBy,
      fallbackReason: generated.fallbackReason ?? null,
      duplicateInfo,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
