import type { SupabaseClient } from '@supabase/supabase-js'
import { AiError } from './types'
import { providerHttpError, toNetworkError } from './providers/shared'
import { loadEmbeddingsKey } from './config'
import { decrypt } from '@/lib/whatsapp/encryption'

const OPENAI_TRANSCRIPTION_URL = 'https://api.openai.com/v1/audio/transcriptions'
// Whisper's ceiling. WhatsApp voice notes are already capped well under
// this by the composer (MAX_RECORDING_SECONDS = 5min in
// message-composer.tsx), so this is a defensive check, not an expected
// path — a customer-sent file arriving via a channel other than our own
// composer (e.g. a long voice memo forwarded from elsewhere) could still
// exceed it.
const OPENAI_MAX_AUDIO_BYTES = 25 * 1024 * 1024
const TRANSCRIBE_TIMEOUT_MS = 30_000

interface OpenAiTranscriptionResponse {
  text?: string
}

/**
 * Resolves an account's decrypted WhatsApp access token — the same
 * account_id → whatsapp_config → decrypt(access_token) lookup already
 * duplicated in send-message.ts and the media proxy route
 * (whatsapp/media/[mediaId]/route.ts), extracted here so
 * transcribeInboundAudioMessage's caller (the on-demand /api/ai/transcribe
 * route, which has no access token of its own) doesn't need to re-derive
 * it. Not wired into those other two call sites — out of scope for this
 * fix, they already work.
 */
export async function resolveWhatsAppAccessToken(
  db: SupabaseClient,
  accountId: string,
): Promise<string> {
  const { data: config, error } = await db
    .from('whatsapp_config')
    .select('access_token')
    .eq('account_id', accountId)
    .single()
  if (error || !config) {
    throw new AiError('WhatsApp not configured.', { code: 'whatsapp_not_configured', status: 400 })
  }
  return decrypt(config.access_token)
}

/**
 * Transcribes an already-downloaded audio buffer via OpenAI's Whisper
 * endpoint. Takes a Buffer, not a URL: `messages.media_url` stores our
 * OWN internal proxy path (`/api/whatsapp/media/{id}`, see
 * verifyAndBuildUrl in whatsapp/webhook/route.ts), which requires a
 * browser session cookie to authenticate — a server-side `fetch()` (no
 * cookie, and a relative path Node can't resolve anyway) always fails
 * against it. Callers must download the real bytes from Meta themselves
 * (getMediaUrl + downloadMedia from lib/whatsapp/meta-api, same as the
 * PDF-preview block a few lines above this one's call site in the
 * webhook) and pass the buffer in here.
 *
 * Throws AiError on any failure (missing key, empty/oversized buffer,
 * provider error) — callers that run this in the background (webhook)
 * must catch it themselves.
 */
export async function transcribeAudioBuffer(
  apiKey: string,
  audioBuffer: Buffer,
): Promise<string> {
  if (audioBuffer.length === 0) {
    throw new AiError('Downloaded audio file is empty.', { code: 'empty_response' })
  }
  if (audioBuffer.length > OPENAI_MAX_AUDIO_BYTES) {
    throw new AiError('Audio file is too large to transcribe (over 25MB).', {
      code: 'provider_error',
    })
  }

  const form = new FormData()
  // WhatsApp voice notes are Ogg/Opus (see message-composer.tsx's own
  // recorder) — Whisper accepts ogg directly, no transcode needed here.
  form.append('file', new Blob([new Uint8Array(audioBuffer)]), 'voice-note.ogg')
  form.append('model', 'whisper-1')

  let res: Response
  try {
    res = await fetch(OPENAI_TRANSCRIPTION_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
    })
  } catch (err) {
    throw toNetworkError(err)
  }
  if (!res.ok) {
    throw await providerHttpError('OpenAI', res)
  }

  const data = (await res.json().catch(() => null)) as OpenAiTranscriptionResponse | null
  const text = data?.text?.trim()
  if (!text) {
    throw new AiError('OpenAI returned an empty transcription.', { code: 'empty_response' })
  }
  return text
}

/**
 * Transcribes one inbound (customer) audio message and saves the result
 * on the row — the single entry point both the webhook (background, on
 * every customer voice note) and the on-demand "Transcrever" menu action
 * (POST /api/ai/transcribe) go through, so there's exactly one code path
 * that ever writes `transcript_text`.
 *
 * Caller contract: only call this for `sender_type='customer'` audio
 * messages — never for the agent's own voice notes. Nothing here checks
 * sender_type itself (it isn't loaded), by design: this is a low-level
 * "transcribe this specific message" primitive, and the customer-only
 * restriction is a product decision enforced once, at the two call
 * sites, not duplicated into a query here.
 *
 * Returns null (never throws) when there's no embeddings key configured
 * for the account — same "silently unavailable rather than broken"
 * behavior loadEmbeddingsKey's other callers already rely on. Reuses the
 * embeddings key (not the main chat/auto-reply key) because it's the
 * one OpenAI-compatible key guaranteed to exist independent of which
 * provider the account picked for chat (see loadEmbeddingsKey) — an
 * account running Anthropic for auto-reply still has this key if
 * semantic search / the knowledge base is set up.
 */
export async function transcribeInboundAudioMessage(
  db: SupabaseClient,
  accountId: string,
  messageId: string,
  audioBuffer: Buffer,
): Promise<string | null> {
  const { key } = await loadEmbeddingsKey(db, accountId)
  if (!key) return null

  const text = await transcribeAudioBuffer(key, audioBuffer)

  const { error } = await db
    .from('messages')
    .update({ transcript_text: text, transcript_generated_at: new Date().toISOString() })
    .eq('id', messageId)
  if (error) throw error

  return text
}
