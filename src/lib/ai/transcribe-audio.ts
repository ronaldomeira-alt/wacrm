import type { SupabaseClient } from '@supabase/supabase-js'
import { AiError } from './types'
import { providerHttpError, toNetworkError } from './providers/shared'
import { loadEmbeddingsKey } from './config'

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
 * Downloads a WhatsApp media URL and transcribes it via OpenAI's
 * Whisper endpoint. Used both for the background job that runs on every
 * inbound customer voice note (see whatsapp/webhook/route.ts) and for
 * the on-demand "Transcrever" click (see /api/ai/transcribe) — same
 * function either way, the caller decides whether to await it inline or
 * fire it and move on.
 *
 * Throws AiError on any failure (missing key, download failure, empty
 * result) — callers that run this in the background (webhook) must
 * catch it themselves; this never silently returns an empty string, so
 * a caller can't mistake "failed" for "genuinely silent audio".
 */
export async function transcribeAudioUrl(
  apiKey: string,
  audioUrl: string,
): Promise<string> {
  let mediaRes: Response
  try {
    mediaRes = await fetch(audioUrl, { signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS) })
  } catch (err) {
    throw toNetworkError(err)
  }
  if (!mediaRes.ok) {
    throw new AiError(`Could not download the audio file (${mediaRes.status}).`, {
      code: 'network_error',
      status: 502,
    })
  }
  const audioBlob = await mediaRes.blob()
  if (audioBlob.size === 0) {
    throw new AiError('Downloaded audio file is empty.', { code: 'empty_response' })
  }
  if (audioBlob.size > OPENAI_MAX_AUDIO_BYTES) {
    throw new AiError('Audio file is too large to transcribe (over 25MB).', {
      code: 'provider_error',
    })
  }

  const form = new FormData()
  // WhatsApp voice notes are Ogg/Opus (see message-composer.tsx's own
  // recorder) — Whisper accepts ogg directly, no transcode needed here.
  form.append('file', audioBlob, 'voice-note.ogg')
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
  audioUrl: string,
): Promise<string | null> {
  const { key } = await loadEmbeddingsKey(db, accountId)
  if (!key) return null

  const text = await transcribeAudioUrl(key, audioUrl)

  const { error } = await db
    .from('messages')
    .update({ transcript_text: text, transcript_generated_at: new Date().toISOString() })
    .eq('id', messageId)
  if (error) throw error

  return text
}
