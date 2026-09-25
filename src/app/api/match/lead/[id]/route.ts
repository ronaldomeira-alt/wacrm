import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { buildLeadSearchProfile } from '@/lib/match/profile-builder';
import { calculateProfileMaturity } from '@/lib/match/maturity';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('agent');
    const { id: contactId } = await params;

    const profile = await buildLeadSearchProfile(ctx.supabase, ctx.accountId, contactId);
    if (!profile) {
      return NextResponse.json({ error: 'Lead não encontrado' }, { status: 404 });
    }

    const maturity = calculateProfileMaturity(profile);

    // 1. Busca os imóveis enviados a este lead
    const { data: shares } = await ctx.supabase
      .from('property_shares')
      .select('*')
      .eq('account_id', ctx.accountId)
      .eq('lead_id', contactId)
      .order('sent_at', { ascending: false });

    // 2. Busca dados dos imóveis referenciados nos shares
    const propIds = [...new Set((shares || []).map((s) => s.property_id))];
    let propertyMap = new Map<string, { title: string; neighborhood: string; coverUrl?: string }>();
    if (propIds.length > 0) {
      const { data: props } = await ctx.supabase
        .from('property_match_projections')
        .select('property_id, title, neighborhood, cover_url')
        .eq('account_id', ctx.accountId)
        .in('property_id', propIds);

      for (const p of props || []) {
        propertyMap.set(p.property_id, {
          title: p.title,
          neighborhood: p.neighborhood,
          coverUrl: p.cover_url,
        });
      }
    }

    const enrichedShares = (shares || []).map((s) => {
      const p = propertyMap.get(s.property_id);
      return {
        id: s.id,
        propertyId: s.property_id,
        propertyTitle: p?.title || 'Imóvel em Catálogo',
        propertyNeighborhood: p?.neighborhood || 'João Pessoa',
        propertyCoverUrl: p?.coverUrl || null,
        sentAt: s.sent_at,
        firstOpenedAt: s.first_opened_at,
        lastOpenedAt: s.last_opened_at,
        openCount: s.open_count || 0,
        isInterested: s.is_interested || false,
        interestedAt: s.interested_at,
      };
    });

    // 3. Busca tags com proveniência
    const { data: contactTags } = await ctx.supabase
      .from('contact_tags')
      .select('source, originally_from_ctwa, tags(id, name, color, category)')
      .eq('contact_id', contactId);

    const mappedTags = (contactTags || [])
      .filter((ct: Record<string, unknown>) => ct.tags)
      .map((ct: Record<string, unknown>) => {
        const t = ct.tags as { id: string; name: string; color: string; category?: string };
        return {
          id: t.id,
          name: t.name,
          color: t.color,
          category: t.category,
          source: (ct.source as string) || 'conversation',
          originallyFromCtwa: (ct.originally_from_ctwa as boolean) || false,
        };
      });

    return NextResponse.json({
      lead: {
        id: profile.leadId,
        name: profile.name,
        phone: profile.phone,
        aiScore: profile.aiScore,
        isPaused: profile.isPaused,
        isArchived: profile.isArchived,
      },
      searchProfile: {
        operation: profile.operation,
        purpose: profile.purpose,
        propertyTypes: profile.propertyTypes,
        propertyTypeStrict: profile.propertyTypeStrict,
        locations: profile.locations,
        locationStrict: profile.locationStrict,
        priceMin: profile.priceMin,
        priceMax: profile.priceMax,
        priceStrictMax: profile.priceStrictMax,
        priceFlexMax: profile.priceFlexMax,
        bedrooms: profile.bedrooms,
        bedroomsStrict: profile.bedroomsStrict,
        deliveryStatus: profile.deliveryStatus,
        deliveryStrict: profile.deliveryStrict,
        requiredFeatures: profile.requiredFeatures,
        preferredFeatures: profile.preferredFeatures,
        provenance: profile.provenance,
      },
      maturity,
      tags: mappedTags,
      sentProperties: enrichedShares,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * PATCH: Alterna status do lead entre ativo, pausado e arquivado (FASE 10 & 20).
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('agent');
    const { id: contactId } = await params;

    const body = (await request.json().catch(() => null)) as {
      action?: 'pause' | 'resume' | 'archive' | 'unarchive';
    } | null;

    if (!body?.action) {
      return NextResponse.json({ error: 'action é obrigatória' }, { status: 400 });
    }

    const now = new Date().toISOString();
    let updates: Record<string, unknown> = { updated_at: now };

    if (body.action === 'pause') {
      updates.paused_at = now;
    } else if (body.action === 'resume') {
      updates.paused_at = null;
    } else if (body.action === 'archive') {
      updates.archived_at = now;
    } else if (body.action === 'unarchive') {
      updates.archived_at = null;
    }

    const { error } = await ctx.supabase
      .from('contacts')
      .update(updates)
      .eq('id', contactId)
      .eq('account_id', ctx.accountId);

    if (error) {
      console.error('[PATCH /api/match/lead/:id] Erro ao atualizar status do contato:', error);
      return NextResponse.json({ error: 'Falha ao atualizar status' }, { status: 500 });
    }

    return NextResponse.json({ ok: true, action: body.action });
  } catch (err) {
    return toErrorResponse(err);
  }
}
