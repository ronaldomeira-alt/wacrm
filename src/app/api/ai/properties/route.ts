import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import type { PropertyWithAiContext, PropertyAiContext } from '@/types';

/**
 * GET /api/ai/properties (agent+)
 *
 * Lists all properties for the caller's account, hydrated with their
 * `property_ai_contexts` row (stage, book status, subjective knowledge summary).
 */
export async function GET() {
  try {
    const { supabase, accountId } = await requireRole('agent');

    const { data: properties, error: propErr } = await supabase
      .from('properties')
      .select('*')
      .eq('account_id', accountId)
      .order('name');

    if (propErr) throw propErr;

    const { data: contexts, error: ctxErr } = await supabase
      .from('property_ai_contexts')
      .select('*')
      .eq('account_id', accountId);

    if (ctxErr) throw ctxErr;

    const contextByPropertyId = new Map<string, PropertyAiContext>();
    for (const ctx of (contexts ?? []) as PropertyAiContext[]) {
      contextByPropertyId.set(ctx.property_id, ctx);
    }

    const items: PropertyWithAiContext[] = (properties ?? []).map((p) => ({
      ...p,
      ai_context: contextByPropertyId.get(p.id) ?? null,
    }));

    return NextResponse.json({ properties: items });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * POST /api/ai/properties (agent+)
 *
 * Creates a new property and initializes its `property_ai_contexts` row.
 */
export async function POST(req: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent');
    const body = await req.json().catch(() => ({}));
    const name = typeof body.name === 'string' ? body.name.trim() : '';

    if (!name) {
      return NextResponse.json(
        { error: 'Nome do empreendimento é obrigatório' },
        { status: 400 },
      );
    }

    const stage = ['lancamento', 'na_planta', 'em_construcao', 'pronto'].includes(body.stage)
      ? body.stage
      : 'lancamento';
    const subjectiveKnowledge =
      typeof body.subjective_knowledge === 'string' && body.subjective_knowledge.trim()
        ? body.subjective_knowledge.trim()
        : null;

    // 1. Insert property
    const { data: property, error: propErr } = await supabase
      .from('properties')
      .insert({
        account_id: accountId,
        user_id: userId,
        name,
      })
      .select('*')
      .single();

    if (propErr) throw propErr;

    // 2. Insert property_ai_contexts
    const { data: aiContext, error: ctxErr } = await supabase
      .from('property_ai_contexts')
      .insert({
        account_id: accountId,
        property_id: property.id,
        stage,
        subjective_knowledge: subjectiveKnowledge,
      })
      .select('*')
      .single();

    if (ctxErr) {
      console.error('[properties.POST] failed inserting property_ai_contexts:', ctxErr);
    }

    const item: PropertyWithAiContext = {
      ...property,
      ai_context: aiContext ?? null,
    };

    return NextResponse.json({ property: item }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
