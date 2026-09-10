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
 * `transcript_text` is only ever populated for inbound (customer) audio
 * — see the migration adding the column — so this never needs to check
 * sender_type itself to keep the agent's own voice notes out of it.
 */
export function effectiveMessageText(message: {
  content_type: string
  content_text?: string | null
  transcript_text?: string | null
}): string | null {
  if (message.content_type === 'audio') {
    const trimmed = message.transcript_text?.trim()
    return trimmed ? trimmed : null
  }

  const caption = message.content_text?.trim() || null

  switch (message.content_type) {
    case 'text':
      return caption
    case 'image':
      return caption ? `[Cliente enviou uma imagem: "${caption}"]` : '[Cliente enviou uma imagem]'
    case 'video':
      return caption ? `[Cliente enviou um vídeo: "${caption}"]` : '[Cliente enviou um vídeo]'
    case 'document':
      return caption ? `[Cliente enviou um documento: "${caption}"]` : '[Cliente enviou um documento]'
    case 'location':
      return caption ? `[Cliente enviou a localização: ${caption}]` : '[Cliente enviou uma localização]'
    case 'interactive':
      return caption ? `[Cliente selecionou: "${caption}"]` : null
    default:
      return caption
  }
}
