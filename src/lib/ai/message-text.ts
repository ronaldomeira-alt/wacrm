/**
 * The "effective text" of a message for anything that reads message
 * content as plain text (AI context builders, lead analysis, learning
 * generation, message search): the literal `content_text` for a text
 * message, or the AI transcript for a customer voice note. Every
 * consumer of message content should go through this instead of reading
 * `content_text` directly, so a future content_type gaining its own
 * text-equivalent (a transcript, an OCR'd caption, whatever) only needs
 * to be taught here once.
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
  const text =
    message.content_type === 'audio' ? message.transcript_text : message.content_text
  const trimmed = text?.trim()
  return trimmed ? trimmed : null
}
