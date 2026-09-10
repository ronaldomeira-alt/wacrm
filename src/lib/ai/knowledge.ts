import type { SupabaseClient } from '@supabase/supabase-js'
import type { AiConfig } from './types'
import type { PropertyStage } from '@/types'
import { chunkText } from './chunk'
import { embedTexts, toVectorLiteral } from './embeddings'

// ============================================================
// Knowledge base: ingest (chunk + optionally embed) and hybrid
// retrieve with strict per-property isolation.
// ============================================================

interface MatchRow {
  id: string
  content: string
  is_global?: boolean
}

/**
 * (Re)build the chunks for one document. Deletes the document's
 * existing chunks, re-chunks the content, and — when the account has an
 * embeddings key — embeds each chunk. If propertyId is provided, attaches
 * it to every chunk for strict isolation in RAG retrieval.
 */
export async function ingestDocument(
  db: SupabaseClient,
  accountId: string,
  config: Pick<AiConfig, 'embeddingsApiKey'>,
  documentId: string,
  content: string,
  propertyId: string | null = null,
): Promise<void> {
  const chunks = chunkText(content)

  // Replace, don't append — re-ingest must be idempotent.
  const { error: delErr } = await db
    .from('ai_knowledge_chunks')
    .delete()
    .eq('document_id', documentId)
  if (delErr) throw delErr

  if (chunks.length === 0) return

  let embeddings: number[][] | null = null
  let embedError: unknown = null
  if (config.embeddingsApiKey) {
    try {
      embeddings = await embedTexts(config.embeddingsApiKey, chunks)
    } catch (err) {
      embedError = err
    }
  }

  const rows = chunks.map((chunkContent, i) => ({
    document_id: documentId,
    account_id: accountId,
    property_id: propertyId,
    chunk_index: i,
    content: chunkContent,
    embedding: embeddings ? toVectorLiteral(embeddings[i]) : null,
  }))

  const { error: insErr } = await db.from('ai_knowledge_chunks').insert(rows)
  if (insErr) throw insErr

  if (embedError) throw embedError
}

/**
 * Replace a property's Book PDF document and chunks.
 * Purges prior book documents/chunks for this property only.
 */
export async function replacePropertyBook(
  db: SupabaseClient,
  accountId: string,
  config: Pick<AiConfig, 'embeddingsApiKey'>,
  propertyId: string,
  args: {
    filename: string
    extractedText: string
    storagePath?: string | null
    fileSize?: number | null
    pageCount?: number | null
  },
): Promise<void> {
  const { filename, extractedText, storagePath, fileSize, pageCount } = args

  // 1. Delete prior book documents for this property (chunks cascade-deleted)
  await db
    .from('ai_knowledge_documents')
    .delete()
    .eq('account_id', accountId)
    .eq('property_id', propertyId)
    .eq('source_type', 'pdf_book')

  // 2. Insert new book document
  const { data: doc, error: docErr } = await db
    .from('ai_knowledge_documents')
    .insert({
      account_id: accountId,
      property_id: propertyId,
      title: `Book: ${filename}`,
      content: extractedText,
      source_type: 'pdf_book',
    })
    .select('id')
    .single()

  if (docErr || !doc) throw docErr || new Error('Failed to create book document')

  // 3. Ingest chunks with property_id
  await ingestDocument(db, accountId, config, doc.id, extractedText, propertyId)

  // 4. Upsert property_ai_contexts
  const { error: ctxErr } = await db.from('property_ai_contexts').upsert(
    {
      account_id: accountId,
      property_id: propertyId,
      book_filename: filename,
      book_file_size: fileSize ?? null,
      book_page_count: pageCount ?? null,
      book_storage_path: storagePath ?? null,
      book_extracted_text: extractedText,
      book_indexed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'property_id' },
  )

  if (ctxErr) throw ctxErr
}

/**
 * Remove a property's Book and its indexed chunks.
 */
export async function removePropertyBook(
  db: SupabaseClient,
  accountId: string,
  propertyId: string,
): Promise<void> {
  // 1. Delete book documents (chunks cascade)
  await db
    .from('ai_knowledge_documents')
    .delete()
    .eq('account_id', accountId)
    .eq('property_id', propertyId)
    .eq('source_type', 'pdf_book')

  // 2. Clear book metadata on property_ai_contexts
  await db
    .from('property_ai_contexts')
    .update({
      book_filename: null,
      book_file_size: null,
      book_page_count: null,
      book_storage_path: null,
      book_extracted_text: null,
      book_indexed_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq('account_id', accountId)
    .eq('property_id', propertyId)
}

/**
/**
 * Save/replace a property's knowledge (both technical book summary and broker insights)
 * and indexes their chunks for isolated RAG retrieval.
 */
export async function replacePropertyKnowledge(
  db: SupabaseClient,
  accountId: string,
  config: Pick<AiConfig, 'embeddingsApiKey'>,
  propertyId: string,
  args: {
    subjectiveKnowledge?: string | null
    bookSummary?: string | null
    stage?: PropertyStage
    responseStyleInstructions?: string[] | null
  },
): Promise<void> {
  const { subjectiveKnowledge, bookSummary, stage, responseStyleInstructions } = args
  const hasSubjectiveKnowledge = subjectiveKnowledge !== undefined
  const trimmedSubj = (subjectiveKnowledge || '').trim()
  const hasBookSummary = bookSummary !== undefined
  const trimmedBook = (bookSummary || '').trim()

  // 1. Upsert property_ai_contexts
  const updatePayload: Record<string, unknown> = {
    account_id: accountId,
    property_id: propertyId,
    updated_at: new Date().toISOString(),
  }
  // subjective_knowledge, like book summary below, is only touched when the
  // caller actually sent it — a partial save (e.g. this Playground modal
  // saving only response_style_instructions) must not silently wipe the
  // broker's notes by writing subjective_knowledge: null over them.
  if (hasSubjectiveKnowledge) {
    updatePayload.subjective_knowledge = trimmedSubj || null
  }
  if (hasBookSummary) {
    updatePayload.book_extracted_text = trimmedBook || null
    updatePayload.book_indexed_at = trimmedBook ? new Date().toISOString() : null
  }
  if (stage) updatePayload.stage = stage
  if (responseStyleInstructions !== undefined) {
    updatePayload.response_style_instructions =
      responseStyleInstructions && responseStyleInstructions.length > 0
        ? responseStyleInstructions
        : null
  }

  const { error: ctxErr } = await db
    .from('property_ai_contexts')
    .upsert(updatePayload, { onConflict: 'property_id' })

  if (ctxErr) throw ctxErr

  // 2. Index subjective knowledge document (only when the caller sent it —
  // same partial-save guard as the context row above).
  if (hasSubjectiveKnowledge) {
    await db
      .from('ai_knowledge_documents')
      .delete()
      .eq('account_id', accountId)
      .eq('property_id', propertyId)
      .eq('source_type', 'subjective_text')

    if (trimmedSubj) {
      const { data: doc, error: docErr } = await db
        .from('ai_knowledge_documents')
        .insert({
          account_id: accountId,
          property_id: propertyId,
          title: 'Visão do Corretor',
          content: trimmedSubj,
          source_type: 'subjective_text',
        })
        .select('id')
        .single()

      if (docErr || !doc) throw docErr || new Error('Failed to create subjective document')

      await ingestDocument(db, accountId, config, doc.id, trimmedSubj, propertyId)
    }
  }

  // 3. Index book summary document if provided
  if (hasBookSummary) {
    await db
      .from('ai_knowledge_documents')
      .delete()
      .eq('account_id', accountId)
      .eq('property_id', propertyId)
      .eq('source_type', 'pdf_book')

    if (trimmedBook) {
      const { data: doc, error: docErr } = await db
        .from('ai_knowledge_documents')
        .insert({
          account_id: accountId,
          property_id: propertyId,
          title: 'Ficha Técnica / Resumo do Book',
          content: trimmedBook,
          source_type: 'pdf_book',
        })
        .select('id')
        .single()

      if (docErr || !doc) throw docErr || new Error('Failed to create book summary document')

      await ingestDocument(db, accountId, config, doc.id, trimmedBook, propertyId)
    }
  }
}

/**
 * Backward-compatible alias for replacePropertyKnowledge
 */
export async function replacePropertySubjectiveKnowledge(
  db: SupabaseClient,
  accountId: string,
  config: Pick<AiConfig, 'embeddingsApiKey'>,
  propertyId: string,
  args: {
    subjectiveKnowledge?: string | null
    bookSummary?: string | null
    stage?: PropertyStage
    responseStyleInstructions?: string[] | null
  },
): Promise<void> {
  return replacePropertyKnowledge(db, accountId, config, propertyId, args)
}

/**
 * Retrieve knowledge excerpts strictly scoped to:
 * - Chunks belonging to `propertyId`
 * - PLUS global chunks (where `property_id IS NULL`)
 *
 * NEVER returns chunks belonging to any other property.
 */
export async function retrievePropertyKnowledge(
  db: SupabaseClient,
  accountId: string,
  config: Pick<AiConfig, 'embeddingsApiKey'>,
  propertyId: string | null | undefined,
  queryText: string,
  k = 5,
): Promise<string[]> {
  const query = queryText.trim()
  if (!query || k <= 0) return []

  // Skip when the account has no chunks
  try {
    const { count, error } = await db
      .from('ai_knowledge_chunks')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId)
    if (error || !count) return []
  } catch {
    return []
  }

  const picked = new Map<string, string>() // id → content, preserves order
  const targetPropertyId = propertyId || null

  // Semantic path with property isolation RPC
  if (config.embeddingsApiKey) {
    try {
      const [queryEmbedding] = await embedTexts(config.embeddingsApiKey, [query])
      if (queryEmbedding) {
        const { data, error } = await db.rpc('match_property_ai_knowledge_semantic', {
          p_account_id: accountId,
          p_property_id: targetPropertyId,
          p_query_embedding: toVectorLiteral(queryEmbedding),
          p_match_count: k,
        })
        if (!error && Array.isArray(data)) {
          for (const row of data as MatchRow[]) picked.set(row.id, row.content)
        }
      }
    } catch (err) {
      console.error('[ai knowledge] semantic retrieval failed, falling back to FTS:', err)
    }
  }

  // Lexical top-up with property isolation RPC
  if (picked.size < k) {
    try {
      const { data, error } = await db.rpc('match_property_ai_knowledge_fts', {
        p_account_id: accountId,
        p_property_id: targetPropertyId,
        p_query: query,
        p_match_count: k,
      })
      if (!error && Array.isArray(data)) {
        for (const row of data as MatchRow[]) {
          if (picked.size >= k) break
          if (!picked.has(row.id)) picked.set(row.id, row.content)
        }
      }
    } catch (err) {
      console.error('[ai knowledge] lexical retrieval failed:', err)
    }
  }

  return Array.from(picked.values()).slice(0, k)
}

/**
 * Retrieve global knowledge (backward-compatible wrapper).
 */
export async function retrieveKnowledge(
  db: SupabaseClient,
  accountId: string,
  config: Pick<AiConfig, 'embeddingsApiKey'>,
  queryText: string,
  k = 5,
): Promise<string[]> {
  return retrievePropertyKnowledge(db, accountId, config, null, queryText, k)
}
