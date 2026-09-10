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
