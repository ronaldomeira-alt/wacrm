import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { loadEmbeddingsKey } from '@/lib/ai/config';
import { replacePropertyBook, removePropertyBook } from '@/lib/ai/knowledge';
import { extractTextFromPdf } from '@/lib/documents/pdf-extract';

interface RouteContext {
  params: Promise<{ id: string }>;
}

const MAX_PDF_BYTES = 50 * 1024 * 1024; // 50MB ceiling

/**
 * POST /api/ai/properties/[id]/book (agent+)
 *
 * Receives multipart/form-data with a `file` (PDF Book).
 * Extracts text server-side, chunks & embeds it into property-isolated RAG.
 */
export async function POST(req: Request, context: RouteContext) {
  try {
    const { id: propertyId } = await context.params;
    const { supabase, accountId } = await requireRole('agent');

    const { data: property, error: propErr } = await supabase
      .from('properties')
      .select('id, name')
      .eq('id', propertyId)
      .eq('account_id', accountId)
      .single();

    if (propErr || !property) {
      return NextResponse.json({ error: 'Empreendimento não encontrado' }, { status: 404 });
    }

    const formData = await req.formData().catch(() => null);
    if (!formData) {
      return NextResponse.json({ error: 'Form data não enviado' }, { status: 400 });
    }

    const file = formData.get('file') as File | null;
    if (!file || typeof file.arrayBuffer !== 'function') {
      return NextResponse.json({ error: 'Arquivo PDF é obrigatório' }, { status: 400 });
    }

    if (file.size > MAX_PDF_BYTES) {
      return NextResponse.json({ error: 'O arquivo PDF excede o limite de 50MB' }, { status: 400 });
    }

    const arrayBuf = await file.arrayBuffer();
    const pdfBuffer = Buffer.from(arrayBuf);

    const extracted = await extractTextFromPdf(pdfBuffer);
    if (!extracted || !extracted.text.trim()) {
      return NextResponse.json(
        { error: 'Não foi possível extrair texto legível deste PDF. Verifique se o arquivo contém texto indexável.' },
        { status: 422 },
      );
    }

    const embeddingsKeyResult = await loadEmbeddingsKey(supabase, accountId);
    const config = { embeddingsApiKey: embeddingsKeyResult.key };

    await replacePropertyBook(supabase, accountId, config, propertyId, {
      filename: file.name,
      extractedText: extracted.text,
      fileSize: file.size,
      pageCount: extracted.pageCount,
    });

    const { data: updatedContext } = await supabase
      .from('property_ai_contexts')
      .select('*')
      .eq('property_id', propertyId)
      .eq('account_id', accountId)
      .single();

    return NextResponse.json({
      success: true,
      filename: file.name,
      pageCount: extracted.pageCount,
      ai_context: updatedContext,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * DELETE /api/ai/properties/[id]/book (agent+)
 *
 * Removes the property's PDF Book and deletes all related chunks from RAG.
 */
export async function DELETE(_req: Request, context: RouteContext) {
  try {
    const { id: propertyId } = await context.params;
    const { supabase, accountId } = await requireRole('agent');

    const { data: property, error: propErr } = await supabase
      .from('properties')
      .select('id')
      .eq('id', propertyId)
      .eq('account_id', accountId)
      .single();

    if (propErr || !property) {
      return NextResponse.json({ error: 'Empreendimento não encontrado' }, { status: 404 });
    }

    await removePropertyBook(supabase, accountId, propertyId);

    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
