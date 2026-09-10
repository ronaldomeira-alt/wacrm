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
 * agent and bot messages become `assistant`. "Text-bearing" includes a
 * customer voice note that has been transcribed (content_type='audio'
 * with transcript_text set), plain text, and image/video/document/
 * location/interactive messages — the webhook already captures a caption,
 * filename, formatted address, or tapped-button label as `content_text`
 * for these (see parseMessageContent in the webhook route); without
 * including them here the AI silently "forgets" that the customer sent a
 * photo with a caption, a document, a location pin, or tapped a button.
 * `template` messages are excluded: they're only ever sent, never
 * customer-authored, so there's nothing here worth replaying to the model.
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
    .in('content_type', ['text', 'audio', 'image', 'video', 'document', 'location', 'interactive'])
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
