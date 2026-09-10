import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { loadEmbeddingsKey } from '@/lib/ai/config';
import { replacePropertySubjectiveKnowledge } from '@/lib/ai/knowledge';
import type { PropertyStage } from '@/types';

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/ai/properties/[id] (agent+)
 *
 * Fetches one property and its property_ai_contexts row.
 */
export async function GET(_req: Request, context: RouteContext) {
  try {
    const { id: propertyId } = await context.params;
    const { supabase, accountId } = await requireRole('agent');

    const { data: property, error: propErr } = await supabase
      .from('properties')
      .select('*')
      .eq('id', propertyId)
      .eq('account_id', accountId)
      .single();

    if (propErr || !property) {
      return NextResponse.json({ error: 'Empreendimento não encontrado' }, { status: 404 });
    }

    const { data: aiContext } = await supabase
      .from('property_ai_contexts')
      .select('*')
      .eq('property_id', propertyId)
      .eq('account_id', accountId)
      .maybeSingle();

    return NextResponse.json({
      property: {
        ...property,
        ai_context: aiContext ?? null,
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * PATCH /api/ai/properties/[id] (agent+)
 *
 * Updates stage and/or subjective knowledge ("Meu conhecimento sobre este empreendimento").
 * Automatically indexes the subjective text into the property's isolated RAG knowledge.
 */
export async function PATCH(req: Request, context: RouteContext) {
  try {
    const { id: propertyId } = await context.params;
    const { supabase, accountId } = await requireRole('agent');

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Payload inválido' }, { status: 400 });
    }

    const { data: property, error: propErr } = await supabase
      .from('properties')
      .select('id')
      .eq('id', propertyId)
      .eq('account_id', accountId)
      .single();

    if (propErr || !property) {
      return NextResponse.json({ error: 'Empreendimento não encontrado' }, { status: 404 });
    }

    const stage = body.stage as PropertyStage | undefined;
    const subjectiveKnowledge = typeof body.subjective_knowledge === 'string'
      ? body.subjective_knowledge
      : '';

    const embeddingsKeyResult = await loadEmbeddingsKey(supabase, accountId);
    const config = { embeddingsApiKey: embeddingsKeyResult.key };

    await replacePropertySubjectiveKnowledge(supabase, accountId, config, propertyId, {
      subjectiveKnowledge,
      stage,
    });

    const { data: updatedContext } = await supabase
      .from('property_ai_contexts')
      .select('*')
      .eq('property_id', propertyId)
      .eq('account_id', accountId)
      .single();

    return NextResponse.json({
      success: true,
      ai_context: updatedContext,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
