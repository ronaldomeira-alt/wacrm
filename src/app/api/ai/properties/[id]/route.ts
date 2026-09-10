import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { loadEmbeddingsKey } from '@/lib/ai/config';
import { replacePropertySubjectiveKnowledge } from '@/lib/ai/knowledge';
import { AiError } from '@/lib/ai/types';
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
    // typeof-string handles a real value; explicit `null` means "clear the
    // field"; the key being absent entirely means "leave it untouched" —
    // replacePropertySubjectiveKnowledge only touches fields it receives as
    // non-undefined, so collapsing null into undefined here would silently
    // stop the "clear this field" save from taking effect.
    const subjectiveKnowledge = typeof body.subjective_knowledge === 'string'
      ? body.subjective_knowledge
      : body.subjective_knowledge === null
        ? null
        : undefined;

    const bookSummary = typeof body.book_summary === 'string'
      ? body.book_summary
      : typeof body.book_extracted_text === 'string'
        ? body.book_extracted_text
        : body.book_summary === null || body.book_extracted_text === null
          ? null
          : undefined;

    const responseStyleInstructions = Array.isArray(body.response_style_instructions)
      ? body.response_style_instructions
          .filter((v: unknown): v is string => typeof v === 'string' && v.trim().length > 0)
          .map((v: string) => v.trim())
      : body.response_style_instructions === null
        ? null
        : undefined;

    // Optional name update on properties table
    if (typeof body.name === 'string' && body.name.trim()) {
      await supabase
        .from('properties')
        .update({ name: body.name.trim() })
        .eq('id', propertyId)
        .eq('account_id', accountId);
    }

    const embeddingsKeyResult = await loadEmbeddingsKey(supabase, accountId);
    const config = { embeddingsApiKey: embeddingsKeyResult.key };

    // Same reasoning as the POST route: an embedding-only failure shouldn't
    // surface as a hard error once the underlying data is already written.
    let indexingWarning: string | undefined;
    try {
      await replacePropertySubjectiveKnowledge(supabase, accountId, config, propertyId, {
        subjectiveKnowledge,
        bookSummary,
        stage,
        responseStyleInstructions,
      });
    } catch (err) {
      if (err instanceof AiError) {
        console.error('[ai/properties PATCH] ingest error:', err);
        indexingWarning = `Salvo, mas a indexação semântica falhou (${err.message}). A busca por palavra-chave ainda funciona; use Reindexar para tentar novamente.`;
      } else {
        throw err;
      }
    }

    const { data: updatedContext } = await supabase
      .from('property_ai_contexts')
      .select('*')
      .eq('property_id', propertyId)
      .eq('account_id', accountId)
      .single();

    const { data: updatedProp } = await supabase
      .from('properties')
      .select('*')
      .eq('id', propertyId)
      .eq('account_id', accountId)
      .single();

    return NextResponse.json({
      success: true,
      ...(indexingWarning ? { warning: indexingWarning } : {}),
      property: {
        ...updatedProp,
        ai_context: updatedContext,
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * DELETE /api/ai/properties/[id] (agent+)
 *
 * Deletes a property and all associated AI context, documents, chunks, and ad mappings.
 */
export async function DELETE(_req: Request, context: RouteContext) {
  try {
    const { id: propertyId } = await context.params;
    const { supabase, accountId } = await requireRole('agent');

    // 1. Delete associated AI knowledge chunks & documents for this property
    await supabase
      .from('ai_knowledge_chunks')
      .delete()
      .eq('property_id', propertyId)
      .eq('account_id', accountId);

    await supabase
      .from('ai_knowledge_documents')
      .delete()
      .eq('property_id', propertyId)
      .eq('account_id', accountId);

    // 2. Delete ad mappings for this property
    await supabase
      .from('property_ad_mappings')
      .delete()
      .eq('property_id', propertyId)
      .eq('account_id', accountId);

    // 3. Delete AI context
    await supabase
      .from('property_ai_contexts')
      .delete()
      .eq('property_id', propertyId)
      .eq('account_id', accountId);

    // 4. Delete the property itself
    const { error: delErr } = await supabase
      .from('properties')
      .delete()
      .eq('id', propertyId)
      .eq('account_id', accountId);

    if (delErr) throw delErr;

    return NextResponse.json({ success: true, message: 'Empreendimento excluído com sucesso' });
  } catch (err) {
    return toErrorResponse(err);
  }
}
