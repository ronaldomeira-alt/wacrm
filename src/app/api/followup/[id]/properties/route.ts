import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  buildProfileFromData,
  type ContactRow,
  type TagWithJoin,
} from '@/lib/match/profile-builder';
import { extractExplicitPropertyRestrictions } from '@/lib/followup/engine';
import { buildCompatibleSalePropertiesForLead } from '@/lib/followup/compatible-properties';

const DEFAULT_EXPANSION_LIMIT = 12;
const MAX_EXPANSION_LIMIT = 24;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: suggestionId } = await params;
    const { supabase, accountId } = await requireRole('agent');

    const url = new URL(request.url);
    const excludeRaw = (url.searchParams.get('exclude_ids') || '').trim();
    const excludeSet = new Set(
      excludeRaw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    );
    const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
    const limit = Math.min(
      MAX_EXPANSION_LIMIT,
      Math.max(
        1,
        parseInt(url.searchParams.get('limit') || String(DEFAULT_EXPANSION_LIMIT), 10) ||
          DEFAULT_EXPANSION_LIMIT
      )
    );

    const { data: suggestion, error: suggError } = await supabase
      .from('ai_suggestions')
      .select(
        'id, account_id, category, contact_id, conversation_id, contact:contacts(id, name, phone, ai_score, paused_at, archived_at)'
      )
      .eq('id', suggestionId)
      .eq('account_id', accountId)
      .maybeSingle();

    if (suggError) {
      console.error('[api/followup/[id]/properties] error fetching suggestion:', suggError);
      return NextResponse.json({ error: 'Falha ao carregar sugestão de follow-up' }, { status: 500 });
    }
    if (!suggestion || suggestion.category !== 'followup' || !suggestion.contact_id) {
      return NextResponse.json({ error: 'Sugestão de follow-up não encontrada' }, { status: 404 });
    }

    const contactId = String(suggestion.contact_id);
    const conversationId =
      typeof suggestion.conversation_id === 'string' ? suggestion.conversation_id : null;
    const rawContactSource = Array.isArray(suggestion.contact)
      ? suggestion.contact[0]
      : suggestion.contact;
    const rawContact = ((rawContactSource ?? {}) as unknown) as Record<string, unknown>;

    // Consultas paralelas sob demanda apenas para este cliente (sem N+1 e sem chamada de IA)
    const [convRes, msgRes, intelRes, tagsRes, matchesRes, sharesRes, projectionsRes] =
      await Promise.all([
        conversationId
          ? supabase
              .from('conversations')
              .select('id, last_message_text, ctwa_referral')
              .eq('account_id', accountId)
              .eq('id', conversationId)
              .maybeSingle()
          : supabase
              .from('conversations')
              .select('id, last_message_text, ctwa_referral')
              .eq('account_id', accountId)
              .eq('contact_id', contactId)
              .order('last_message_at', { ascending: false })
              .limit(1)
              .maybeSingle(),
        conversationId
          ? supabase
              .from('messages')
              .select('sender_type, content_text, transcript_text, created_at')
              .eq('conversation_id', conversationId)
              .order('created_at', { ascending: false })
              .limit(20)
          : Promise.resolve({ data: [], error: null }),
        supabase
          .from('lead_intelligence')
          .select('summary')
          .eq('contact_id', contactId)
          .maybeSingle(),
        supabase
          .from('contact_tags')
          .select('source, originally_from_ctwa, tags(id, name, color, category)')
          .eq('contact_id', contactId),
        supabase
          .from('lead_property_matches')
          .select(
            'id, lead_id, property_id, match_score, commercial_priority, match_status, suppressed, score_breakdown'
          )
          .eq('account_id', accountId)
          .eq('suppressed', false)
          .eq('lead_id', contactId)
          .order('match_score', { ascending: false })
          .order('commercial_priority', { ascending: false }),
        supabase
          .from('property_shares')
          .select('property_id')
          .eq('account_id', accountId)
          .eq('lead_id', contactId),
        supabase
          .from('property_match_projections')
          .select(
            'property_id, account_id, status, operation, title, code, property_type, neighborhood, city, price_min, price_max, bedrooms_min, bedrooms_max, area_min, area_max, delivery_status, delivery_deadline, features, cover_url, public_url'
          )
          .eq('account_id', accountId)
          .eq('status', 'ativo')
          .eq('operation', 'venda'),
      ]);

    if (projectionsRes.error) {
      console.error(
        '[api/followup/[id]/properties] error fetching property_match_projections:',
        projectionsRes.error
      );
      return NextResponse.json(
        { error: 'Falha ao consultar imóveis compatíveis disponíveis' },
        { status: 500 }
      );
    }
    if (msgRes.error) {
      console.error('[api/followup/[id]/properties] error fetching messages:', msgRes.error);
    }

    const msgRows = (msgRes.data || []) as Array<{
      sender_type?: string | null;
      content_text?: string | null;
      transcript_text?: string | null;
    }>;
    const customerMsgs = msgRows
      .filter(
        (m) =>
          String(m.sender_type || '').toLowerCase() === 'customer' &&
          (m.content_text || m.transcript_text)
      )
      .slice(0, 12)
      .map((m) => String(m.content_text || m.transcript_text || '').trim())
      .filter(Boolean);

    const recentCustomerTexts = customerMsgs.join(' ');
    const lastCustomerText = customerMsgs[0] ?? convRes.data?.last_message_text ?? null;

    const summary =
      intelRes.data?.summary && typeof intelRes.data.summary === 'object'
        ? (intelRes.data.summary as Record<string, unknown>)
        : null;

    const contactTags: TagWithJoin[] = ((tagsRes.data || []) as Array<Record<string, unknown>>)
      .filter((ct) => ct.tags)
      .map((ct) => {
        const t = ct.tags as { id: string; name: string; category: string | null };
        return {
          source: String(ct.source || 'conversation'),
          originally_from_ctwa: Boolean(ct.originally_from_ctwa),
          tags: {
            id: String(t.id || ''),
            name: String(t.name || ''),
            category: t.category ? String(t.category) : null,
          },
        };
      });

    const contactForProfile: ContactRow = {
      id: contactId,
      account_id: accountId,
      name: String(rawContact.name || 'Cliente'),
      phone: String(rawContact.phone || ''),
      ai_score: Number(rawContact.ai_score ?? 0) || 0,
      paused_at: (rawContact.paused_at as string | null) ?? null,
      archived_at: (rawContact.archived_at as string | null) ?? null,
    };

    const profile = buildProfileFromData(
      contactForProfile,
      summary ? { summary } : null,
      contactTags,
      convRes.data
        ? { ctwa_referral: (convRes.data.ctwa_referral as Record<string, unknown> | null) ?? null }
        : null,
      recentCustomerTexts
    );

    // Regra de ouro: exclusivamente venda
    if (profile.isShortStayOnly || profile.operation !== 'venda' || profile.isSellerOrOutOfArea) {
      return NextResponse.json({
        properties: [],
        totalCount: 0,
        totalRemainingCount: 0,
        hasMore: false,
        nextOffset: 0,
      });
    }

    const restrictions = extractExplicitPropertyRestrictions({
      summary,
      messagesText: recentCustomerTexts,
      lastCustomerText,
    });

    const projectionsMap = new Map<string, Record<string, unknown>>();
    for (const p of (projectionsRes.data || []) as Array<Record<string, unknown>>) {
      if (String(p.operation || '').toLowerCase() !== 'venda') continue;
      if (String(p.status || 'ativo').toLowerCase() !== 'ativo') continue;
      projectionsMap.set(String(p.property_id || ''), p);
    }

    const sharedSet = new Set<string>(
      ((sharesRes.data || []) as Array<{ property_id?: string }>)
        .map((s) => String(s.property_id || ''))
        .filter(Boolean)
    );

    const rawMatches = ((matchesRes.data || []) as Array<Record<string, unknown>>).filter(
      (m) => m.match_status !== 'ignorado'
    );

    const allCompatible = buildCompatibleSalePropertiesForLead({
      accountId,
      contactId,
      profile,
      rawMatches,
      projectionsMap,
      sharedPropertyIds: sharedSet,
      extraExcludedTypes: restrictions.excludedTypes,
      includeCatalogExpansion: true,
    });

    const remaining = allCompatible.filter((p) => !excludeSet.has(p.propertyId));
    const pageSlice = remaining.slice(offset, offset + limit);
    const nextOffset = offset + pageSlice.length;
    const hasMore = nextOffset < remaining.length;

    return NextResponse.json({
      properties: pageSlice,
      totalCount: allCompatible.length,
      totalRemainingCount: remaining.length,
      hasMore,
      nextOffset,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
