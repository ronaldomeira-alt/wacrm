import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import {
  transcribeInboundAudioMessage,
  transcribeAgentAudioMessage,
  resolveWhatsAppAccessToken,
} from '@/lib/ai/transcribe-audio'
import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { AiError } from '@/lib/ai/types'

/**
 * POST /api/ai/transcribe  (agent+)
 *
 * Body: { message_id }
 * Returns: { transcript, cached }
 *
 * Backs the Inbox's "Transcrever" message action. Most customer voice
 * notes are already transcribed by the time an agent thinks to click
 * this (the webhook transcribes every inbound one in the background,
 * see whatsapp/webhook/route.ts) — `cached: true` is the common case
 * and returns instantly. This route exists as the fallback for the
 * rest: a transcription that failed in the background (no key
 * configured at the time, a transient provider error) gets one more
 * shot, on demand.
 *
 * Accepts both a customer-sent voice note (downloaded from Meta) and a
 * corretor's own (Ronaldo/Thatianna — downloaded directly from our
 * Storage URL, see transcribeAgentAudioMessage) — reversed 2026-09-18: the
 * original 2026-09-01 customer-only restriction was blocking Clara from
 * ever learning from the team's own voice notes. Never a bot message —
 * Clara has no voice notes to transcribe. The RLS-scoped lookup below
 * already confines `message_id` to the caller's own account.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')

    const limit = checkRateLimit(`ai-transcribe:${userId}`, RATE_LIMITS.aiTranscribe)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    const messageId =
      body && typeof body.message_id === 'string' ? body.message_id : ''
    if (!messageId) {
      return NextResponse.json({ error: 'message_id is required' }, { status: 400 })
    }

    // RLS scopes this to the caller's own account — a message_id from
    // another account simply comes back not-found, same as /api/ai/draft.
    const { data: message, error: msgErr } = await supabase
      .from('messages')
      .select('id, sender_type, content_type, media_url, transcript_text')
      .eq('id', messageId)
      .maybeSingle()
    if (msgErr) {
      console.error('[ai/transcribe] message lookup error:', msgErr)
      return NextResponse.json({ error: 'Failed to load message' }, { status: 500 })
    }
    if (!message) {
      return NextResponse.json({ error: 'Message not found' }, { status: 404 })
    }
    if (message.content_type !== 'audio' || (message.sender_type !== 'customer' && message.sender_type !== 'agent')) {
      return NextResponse.json(
        { error: 'Only a customer or agent voice note can be transcribed.' },
        { status: 400 },
      )
    }

    if (message.transcript_text) {
      return NextResponse.json({ transcript: message.transcript_text, cached: true })
    }
    if (!message.media_url) {
      return NextResponse.json({ error: 'This voice note has no audio to transcribe.' }, { status: 400 })
    }

    // Mutation goes through the admin client, same as the webhook's own
    // call to this function — the RLS-scoped lookup above already
    // proved the caller may see this message; the write itself doesn't
    // need to also clear an UPDATE policy that was never written with
    // an AI-computed column in mind.
    let transcript: string | null
    if (message.sender_type === 'agent') {
      // The corretor's own recording — already a plain, public, directly
      // fetchable Supabase Storage URL (see message-composer.tsx's
      // upload-before-send), unlike the customer path below.
      transcript = await transcribeAgentAudioMessage(supabaseAdmin(), accountId, messageId, message.media_url)
    } else {
      // message.media_url is our own internal proxy path
      // (/api/whatsapp/media/{mediaId} — see verifyAndBuildUrl in
      // whatsapp/webhook/route.ts), not a fetchable URL: it needs a
      // browser session cookie, which this server-side route never has.
      // Pull the mediaId back out of that fixed-shape path and download
      // the real bytes from Meta directly instead, same as the webhook.
      const mediaId = message.media_url.split('/').pop()
      if (!mediaId) {
        return NextResponse.json({ error: 'This voice note has no audio to transcribe.' }, { status: 400 })
      }
      const accessToken = await resolveWhatsAppAccessToken(supabaseAdmin(), accountId)
      const mediaInfo = await getMediaUrl({ mediaId, accessToken })
      const { buffer } = await downloadMedia({ downloadUrl: mediaInfo.url, accessToken })
      transcript = await transcribeInboundAudioMessage(supabaseAdmin(), accountId, messageId, buffer)
    }
    if (!transcript) {
      return NextResponse.json(
        {
          error: 'Transcription is not set up. Add an embeddings API key in Settings → AI Assistant.',
          code: 'no_transcription_key',
        },
        { status: 400 },
      )
    }

    return NextResponse.json({ transcript, cached: false })
  } catch (err) {
    if (err instanceof AiError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status })
    }
    return toErrorResponse(err)
  }
}
