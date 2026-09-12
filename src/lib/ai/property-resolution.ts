import type { SupabaseClient } from '@supabase/supabase-js'
import type { CtwaReferral } from '@/lib/whatsapp/ctwa-referral'

export interface PropertyResolutionInput {
  db: SupabaseClient
  accountId: string
  conversationId?: string | null
  currentPropertyId?: string | null
  referral?: CtwaReferral | null
  firstUserMessage?: string | null
  latestUserMessage?: string | null
  userMessages?: string[] | null
}

export type PropertyResolutionMethod =
  | 'existing_conversation'
  | 'explicit_switch'
  | 'ctwa_ad_mapping'
  | 'ctwa_headline_match'
  | 'first_message_match'
  | 'unresolved'

export interface PropertyResolutionResult {
  propertyId: string | null
  propertyName: string | null
  resolutionMethod: PropertyResolutionMethod
  confidence: number
}

/**
 * Normalize text for string matching: removes accents, lowers case, trims extra spaces.
 */
export function normalizeTextForMatching(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\w\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Resolves which real estate development (property) a conversation belongs to
 * following a strict 5-level deterministic cascade.
 *
 * Cascade Order:
 * 1. PRIORIDADE 1: Current conversation.property_id is already set and valid
 *    (unless the user's latest message explicitly mentions another registered property).
 * 2. PRIORIDADE 2: Deterministic Meta Ad mapping (property_ad_mappings table via referral.source_id)
 * 3. PRIORIDADE 3: CTWA referral headline or body contains property name
 * 4. PRIORIDADE 4: Initial lead message explicitly mentions property name
 * 5. PRIORIDADE 5: Unresolved -> UNKNOWN / NULL (AI uses global knowledge, never hallucinates)
 */
export async function resolvePropertyForConversation(
  input: PropertyResolutionInput,
): Promise<PropertyResolutionResult> {
  const { db, accountId, currentPropertyId, referral, firstUserMessage, latestUserMessage } = input

  // ============================================================
  // PRIORIDADE 1: Conversa já possui property_id válido
  // (Verifica se houve menção explícita a OUTRO empreendimento no turno atual)
  // ============================================================
  if (currentPropertyId) {
    try {
      const activeMsg = latestUserMessage || firstUserMessage || ''
      let allProps: Array<{ id: string; name: string }> | null = null

      try {
        const { data } = await db
          .from('properties')
          .select('id, name')
          .eq('account_id', accountId)
        allProps = data as Array<{ id: string; name: string }> | null
      } catch {
        // Continue to single lookup
      }

      if (allProps && allProps.length > 0) {
        if (activeMsg.trim()) {
          const normMsg = normalizeTextForMatching(activeMsg)
          for (const p of allProps) {
            if (p.id === currentPropertyId) continue
            const normName = normalizeTextForMatching(p.name)
            if (normName.length >= 3 && normMsg.includes(normName)) {
              return {
                propertyId: p.id,
                propertyName: p.name,
                resolutionMethod: 'explicit_switch',
                confidence: 0.95,
              }
            }
          }
        }

        const matchedCurrent = allProps.find((p) => p.id === currentPropertyId)
        if (matchedCurrent) {
          return {
            propertyId: matchedCurrent.id,
            propertyName: matchedCurrent.name,
            resolutionMethod: 'existing_conversation',
            confidence: 1.0,
          }
        }
      }

      const { data: prop } = await db
        .from('properties')
        .select('id, name')
        .eq('id', currentPropertyId)
        .eq('account_id', accountId)
        .maybeSingle()

      if (prop) {
        return {
          propertyId: prop.id,
          propertyName: prop.name,
          resolutionMethod: 'existing_conversation',
          confidence: 1.0,
        }
      }
    } catch (err) {
      console.warn('[property-resolution] Priority 1 lookup failed:', err)
    }
  }

  // ============================================================
  // PRIORIDADE 2: Mapeamento Determinístico Meta CTWA (property_ad_mappings)
  // ============================================================
  const adSourceId = referral?.source_id ? String(referral.source_id).trim() : null
  if (adSourceId) {
    try {
      const { data: mapping } = await db
        .from('property_ad_mappings')
        .select('property_id, properties(id, name)')
        .eq('account_id', accountId)
        .eq('ad_source_id', adSourceId)
        .maybeSingle()

      if (mapping && mapping.properties) {
        const prop = Array.isArray(mapping.properties)
          ? mapping.properties[0]
          : mapping.properties

        if (prop && prop.id) {
          return {
            propertyId: prop.id,
            propertyName: prop.name,
            resolutionMethod: 'ctwa_ad_mapping',
            confidence: 1.0,
          }
        }
      }
    } catch (err) {
      console.warn('[property-resolution] Priority 2 CTWA mapping lookup failed:', err)
    }
  }

  // ============================================================
  // PRIORIDADE 3 & 4: Match textual contra nome dos empreendimentos
  // ============================================================
  try {
    const { data: properties } = await db
      .from('properties')
      .select('id, name')
      .eq('account_id', accountId)

    if (properties && properties.length > 0) {
      // 3. PRIORIDADE 3: Análise de Headline e Body do Anúncio CTWA
      const referralHeadline = referral?.headline ? normalizeTextForMatching(referral.headline) : ''
      const referralBody = referral?.body ? normalizeTextForMatching(referral.body) : ''
      const referralText = `${referralHeadline} ${referralBody}`.trim()

      if (referralText) {
        for (const prop of properties) {
          const normPropName = normalizeTextForMatching(prop.name)
          if (normPropName.length >= 3 && referralText.includes(normPropName)) {
            return {
              propertyId: prop.id,
              propertyName: prop.name,
              resolutionMethod: 'ctwa_headline_match',
              confidence: 0.95,
            }
          }
        }
      }

      // 4. PRIORIDADE 4: Mensagens enviadas pelo lead (da mais recente à primeira)
      const candidateMessages: Array<{ text: string; isFirst: boolean }> = []
      if (latestUserMessage && latestUserMessage.trim()) {
        candidateMessages.push({ text: latestUserMessage, isFirst: latestUserMessage === firstUserMessage })
      }
      if (Array.isArray(input.userMessages)) {
        for (let i = input.userMessages.length - 1; i >= 0; i--) {
          const msg = input.userMessages[i]
          if (msg && msg.trim() && !candidateMessages.some((c) => c.text === msg)) {
            candidateMessages.push({ text: msg, isFirst: msg === firstUserMessage })
          }
        }
      }
      if (firstUserMessage && firstUserMessage.trim() && !candidateMessages.some((c) => c.text === firstUserMessage)) {
        candidateMessages.push({ text: firstUserMessage, isFirst: true })
      }

      for (const candidate of candidateMessages) {
        const normMsg = normalizeTextForMatching(candidate.text)
        for (const prop of properties) {
          const normPropName = normalizeTextForMatching(prop.name)
          if (normPropName.length >= 3 && normMsg.includes(normPropName)) {
            return {
              propertyId: prop.id,
              propertyName: prop.name,
              resolutionMethod: candidate.isFirst ? 'first_message_match' : 'first_message_match',
              confidence: candidate.isFirst ? 0.85 : 0.90,
            }
          }
        }
      }
    }
  } catch (err) {
    console.warn('[property-resolution] Textual matching lookup failed:', err)
  }

  // ============================================================
  // PRIORIDADE 5: Não resolvido / Desconhecido (Unknown)
  // ============================================================
  return {
    propertyId: null,
    propertyName: null,
    resolutionMethod: 'unresolved',
    confidence: 0.0,
  }
}
