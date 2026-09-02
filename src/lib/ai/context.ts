import type { SupabaseClient } from '@supabase/supabase-js'
import type { ChatMessage } from './types'
import { aiContextMessageLimit } from './defaults'
import { effectiveMessageText } from './message-text'

interface DbMessage {
  sender_type: 'customer' | 'agent' | 'bot'
  content_type: string
  content_text: string | null
  transcript_text: string | null
}

/**
 * Fetch the last N text-bearing messages of a conversation and map them
 * to the provider-neutral chat shape. Customer messages become `user`;
 * agent and bot messages become `assistant`. "Text-bearing" now includes
 * a customer voice note that has been transcribed (content_type='audio'
 * with transcript_text set — see effectiveMessageText) alongside plain
 * text messages; every other media type (image, video, document,
 * templates, interactive) still has no text to model and stays excluded.
 *
 * Ordered oldest-first (chronological) so the transcript reads
 * naturally and the most recent customer message lands last.
 */
export async function buildConversationContext(
  db: SupabaseClient,
  conversationId: string,
  limit: number = aiContextMessageLimit(),
): Promise<ChatMessage[]> {
  const { data, error } = await db
    .from('messages')
    .select('sender_type, content_type, content_text, transcript_text')
    .eq('conversation_id', conversationId)
    .in('content_type', ['text', 'audio'])
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) throw error

  const rows = ((data ?? []) as DbMessage[]).reverse()
  return rows
    .map((m) => ({ m, text: effectiveMessageText(m) }))
    .filter((r): r is { m: DbMessage; text: string } => r.text !== null)
    .map((r) => ({
      role: r.m.sender_type === 'customer' ? 'user' : 'assistant',
      content: r.text,
    }))
}
