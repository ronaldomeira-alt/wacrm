/**
 * The "effective text" of a message for anything that reads message
 * content as plain text (AI context builders, lead analysis, learning
 * generation, message search): the literal `content_text` for a text
 * message, the AI transcript for a customer voice note, or a bracketed
 * system-style description for media the AI can't see but whose
 * `content_text` the webhook already captured (an image/video caption, a
 * document filename, a formatted location, or the label of a tapped
 * interactive button/list reply). Every consumer of message content
 * should go through this instead of reading `content_text` directly, so
 * a future content_type gaining its own text-equivalent only needs to be
 * taught here once.
 *
 * `transcript_text` is populated for both inbound (customer) and outbound
 * (agent) audio (see transcribe-audio.ts) — this deliberately never checks
 * sender_type itself, since every consumer (learning scan included) wants
 * the transcript whoever spoke it.
 */
export function effectiveMessageText(message: {
  content_type: string
  content_text?: string | null
  transcript_text?: string | null
  sender_type?: 'customer' | 'agent' | 'bot' | string | null
  media_url?: string | null
}): string | null {
  if (message.content_type === 'audio') {
    const trimmed = message.transcript_text?.trim()
    return trimmed ? trimmed : null
  }

  const caption = message.content_text?.trim() || null
  const isCustomer = !message.sender_type || message.sender_type === 'customer'
  const senderLabel = isCustomer ? 'Cliente' : 'Assistente'

  switch (message.content_type) {
    case 'text':
      return caption
    case 'image': {
      const fileName = message.media_url ? message.media_url.split('/').pop()?.split('?')[0] : null
      const desc = caption || fileName
      return desc ? `[${senderLabel} enviou uma imagem: "${desc}"]` : `[${senderLabel} enviou uma imagem]`
    }
    case 'video': {
      const fileName = message.media_url ? message.media_url.split('/').pop()?.split('?')[0] : null
      const desc = caption || fileName
      return desc ? `[${senderLabel} enviou um vídeo: "${desc}"]` : `[${senderLabel} enviou um vídeo]`
    }
    case 'document':
      return caption ? `[${senderLabel} enviou um documento: "${caption}"]` : `[${senderLabel} enviou um documento]`
    case 'location':
      return caption ? `[${senderLabel} enviou a localização: ${caption}]` : `[${senderLabel} enviou uma localização]`
    case 'interactive':
      return caption ? `[${senderLabel} selecionou: "${caption}"]` : null
    default:
      return caption
  }
}
