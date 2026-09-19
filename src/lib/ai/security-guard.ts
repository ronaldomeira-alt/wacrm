// ============================================================
// Deterministic post-generation security guard for Clara.
//
// Structural principle this file exists to enforce:
//
//   O QUE A CLARA SABE  ≠  O QUE A CLARA TEM PERMISSÃO PARA DIZER/FAZER
//
// Every protection in prompt-builder.ts (§4/§7, "Fronteiras Rígidas" /
// "Hierarquia de Autoridade") is TEXTUAL — it depends on the LLM reading
// and obeying instructions. That's necessary but not sufficient: nothing
// stops the model from citing a fact that sits right there in the
// "authorized" knowledge/memory sections of its own prompt. This module
// is the deterministic backstop that runs AFTER the LLM responds and
// BEFORE anything is sent to WhatsApp:
//
//   MEMÓRIA → PROMPT → LLM → RESPOSTA → SECURITY GUARD → ENVIO
//
// It does not care WHERE a leaked fact came from (ai_memories, the
// legacy RAG's "Visão do Corretor", an uploaded Ficha Técnica, or a
// hallucination) — it inspects only the final outgoing text, which is
// what makes it apply equally to every knowledge source without needing
// per-source trust bookkeeping. See conversation-engine.ts for the single
// call site (applySecurityGuard), right before media resolution.
// ============================================================

export type SecurityViolationCategory =
  | 'exact_address'
  | 'unauthorized_price'
  | 'builder_disclosure'
  | 'visit_self_confirmation'

export interface SecurityViolation {
  category: SecurityViolationCategory
  /** Human-readable reason, safe to log — never shown to the customer. */
  detail: string
  /** The literal snippet(s) from the response that triggered this violation. */
  matches: string[]
}

export interface SecurityGuardPropertyContext {
  stage?: string | null
  /** 'provisorio' properties have zero confirmed data — mirrors
   *  prompt-builder.ts's isPropertyProvisional check exactly; see
   *  isReadyForPriceDisclosure below. */
  status?: string | null
  name?: string | null
}

export interface SecurityGuardContext {
  responseText: string
  transferRequired: boolean
  property: SecurityGuardPropertyContext | null
  /**
   * Every text source fed into the prompt as "knowledge" or "memory" for
   * this turn — Book/Ficha Técnica chunks, Visão do Corretor chunks,
   * ai_memories of every scope (global/style/property/ad/conversation),
   * ad context, lead context. Used ONLY to extract candidate protected
   * entity names (builder/incorporator) to check the output against —
   * never treated as an authorization source. Presence here does not
   * grant permission to disclose; see isReadyForPriceDisclosure for the
   * one place a source's provenance actually matters (price).
   */
  allKnowledgeAndMemoryTexts: string[]
  /**
   * ONLY the officially uploaded Ficha Técnica / Book text (source_type
   * 'pdf_book' in ai_knowledge_chunks) — never Visão do Corretor, never
   * ai_memories. This is the single legitimate source that can ground a
   * price disclosure on a "pronto" property. Keeping it separate from
   * allKnowledgeAndMemoryTexts is what stops a learned/memory-only price
   * from being laundered into "authorized" just because it also happens
   * to sit in the property's knowledge section of the prompt.
   */
  officialPriceKnowledgeTexts: string[]
}

export interface SecurityGuardResult {
  violated: boolean
  violations: SecurityViolation[]
}

// ------------------------------------------------------------
// 1. Stage/price-authorization predicate — deliberately mirrors
//    prompt-builder.ts's `isPropertyReady` check verbatim (same
//    inputs, same boolean logic) so the guard and the prompt text can
//    never silently drift apart. If that rule ever changes, this must
//    change with it.
// ------------------------------------------------------------
export function isReadyForPriceDisclosure(property: SecurityGuardPropertyContext | null): boolean {
  if (!property) return false
  const isProvisional = property.status === 'provisorio'
  const isReady = Boolean(property.stage && property.stage.toLowerCase().includes('pronto'))
  return !isProvisional && isReady
}

// ------------------------------------------------------------
// 2. Builder / incorporator name extraction — heuristic, best-effort.
//    Pulls candidate proper names out of whatever knowledge/memory text
//    was fed into this turn's prompt, scoped tightly around the trigger
//    words "construtora"/"incorporadora" so it doesn't just grab any
//    capitalized phrase in the document. This list is NEVER used to
//    authorize anything — only to know what string(s) must never appear
//    in the outgoing message.
// ------------------------------------------------------------
const BUILDER_TRIGGER_SEGMENT =
  /\b(?:constru(?:tora|iu|[íi]d[ao])?|incorporador[ae]?|executad[ao])\b[^.\n]{0,100}/gi

// NOTE: deliberately NOT case-insensitive (`/i`) — under `/i`, the
// capitalized-word character classes below (`[A-ZÀ-Ý]`) would also match
// lowercase letters, letting the capture run on into unrelated lowercase
// words ("desde", "com", …) instead of stopping at the proper-noun
// boundary. Trigger words are spelled out with both cases instead.
const CAP_WORD = `[A-ZÀ-Ý][\\wÀ-ÿ&.'-]*(?:\\s+[A-ZÀ-Ý][\\wÀ-ÿ&.'-]*){0,4}`
const BUILDER_NAME_IN_SEGMENT: RegExp[] = [
  new RegExp(`[Éé]\\s+(?:a|da|de)\\s+(${CAP_WORD})`),
  new RegExp(`(?:[Cc]onstrutora|[Ii]ncorporadora)\\s*[:\\-]\\s*(${CAP_WORD})`),
  new RegExp(`[Cc]onstru[íi]d[ao]\\s+pela\\s+(${CAP_WORD})`),
  new RegExp(`[Ee]xecutad[ao]\\s+por\\s+(${CAP_WORD})`),
]

/** Generic words extraction can pick up that are never themselves the
 *  protected fact — filtered out so they never trigger a false block. */
const BUILDER_NAME_STOPWORDS = new Set([
  'nossa equipe',
  'a equipe',
  'equipe',
  'nossa',
  'nossos parceiros',
])

export function extractBuilderNameCandidates(
  texts: string[],
  propertyName?: string | null,
): string[] {
  const found = new Set<string>()
  const normalizedPropertyName = propertyName?.trim().toLowerCase() || null

  for (const text of texts) {
    if (!text) continue
    const segments = text.match(BUILDER_TRIGGER_SEGMENT)
    if (!segments) continue
    for (const segment of segments) {
      for (const pattern of BUILDER_NAME_IN_SEGMENT) {
        const m = segment.match(pattern)
        const candidate = m?.[1]?.trim()
        if (!candidate || candidate.length < 2) continue
        const lower = candidate.toLowerCase()
        if (BUILDER_NAME_STOPWORDS.has(lower)) continue
        if (normalizedPropertyName && lower === normalizedPropertyName) continue
        found.add(candidate)
        break // one hit per segment is enough
      }
    }
  }
  return Array.from(found)
}

function checkBuilderDisclosure(ctx: SecurityGuardContext): SecurityViolation[] {
  const candidates = extractBuilderNameCandidates(
    ctx.allKnowledgeAndMemoryTexts,
    ctx.property?.name ?? null,
  )
  if (candidates.length === 0) return []

  const responseLower = ctx.responseText.toLowerCase()
  const leaked = candidates.filter((name) => responseLower.includes(name.toLowerCase()))
  if (leaked.length === 0) return []

  return [
    {
      category: 'builder_disclosure',
      detail:
        'A resposta menciona um nome de construtora/incorporadora conhecido internamente ' +
        '(via conhecimento/memória), o que é proibido pela regra de sigilo institucional ' +
        'independentemente da fonte.',
      matches: leaked,
    },
  ]
}

// ------------------------------------------------------------
// 3. Exact address detection — unconditional (no prompt text currently
//    authorizes exact street address either, this closes that gap
//    structurally). No structured "address" field exists anywhere in
//    the schema to cross-reference against, so — per instruction to
//    prefer a structural approach only "quando existir" — this one is
//    necessarily pattern-based.
// ------------------------------------------------------------
const NAMED_STREET_ADDRESS =
  /\b(?:rua|av\.?|avenida|alameda|travessa|rodovia|estrada|pra[çc]a)\s+[A-ZÀ-Ýa-zà-ÿ0-9'.\-]+(?:\s+[A-ZÀ-Ýa-zà-ÿ0-9'.\-]+){0,4}?(?:,\s*(?:n[ºo°.]?\s*)?|\s+n[úu]mero\s+|\s+n[ºo°.]\s*)\d{1,6}\b/gi

const BLOCK_LOT_ADDRESS = /\b(?:quadra|qd\.?)\s*n?[ºo°.]?\s*\d{1,4}\b|\b(?:lote|lt\.?)\s*n?[ºo°.]?\s*\d{1,4}\b/gi

const CEP_PATTERN = /\b\d{5}-\d{3}\b/g

function checkExactAddress(ctx: SecurityGuardContext): SecurityViolation[] {
  const text = ctx.responseText
  const matches = [
    ...(text.match(NAMED_STREET_ADDRESS) ?? []),
    ...(text.match(BLOCK_LOT_ADDRESS) ?? []),
    ...(text.match(CEP_PATTERN) ?? []),
  ]
  if (matches.length === 0) return []
  return [
    {
      category: 'exact_address',
      detail:
        'A resposta contém um padrão de endereço exato (rua/número, quadra/lote ou CEP). ' +
        'Localização geral (bairro/proximidade) é autorizada; endereço exato nunca é.',
      matches,
    },
  ]
}

// ------------------------------------------------------------
// 4. Price / monetary value detection, grounded against the property's
//    stage-based authorization rule AND, when that rule does allow
//    price talk, against the OFFICIAL Ficha Técnica text only — never
//    against ai_memories or Visão do Corretor. This is what stops a
//    memory-learned price from being laundered into "authorized" simply
//    because the property later transitions to "pronto".
// ------------------------------------------------------------
const MONEY_REGEX =
  /R\$\s?\d{1,3}(?:\.\d{3})*(?:,\d{2})?(?:\s*mil)?|\b\d{1,3}(?:\.\d{3}){1,3}(?:,\d{2})?\b|\b\d{2,4}\s*mil(?:\s+reais)?\b/gi

function normalizeMoneyToken(raw: string): string {
  const isMil = /mil\b/i.test(raw)
  const digitsAndComma = raw.replace(/[^\d,]/g, '')
  const intPart = digitsAndComma.split(',')[0]?.replace(/\D/g, '') ?? ''
  if (!intPart) return ''
  return isMil ? `${intPart}000` : intPart
}

function extractMoneyMentions(text: string): string[] {
  const matches = text.match(MONEY_REGEX) ?? []
  // Drop anything that normalizes to a too-small/meaningless number (m²
  // figures like "37" never reach here anyway since MONEY_REGEX requires
  // either an R$ prefix, a thousands-separated group, or "mil").
  return matches.filter((m) => normalizeMoneyToken(m).length >= 3)
}

function checkPriceDisclosure(ctx: SecurityGuardContext): SecurityViolation[] {
  const moneyMentions = extractMoneyMentions(ctx.responseText)
  if (moneyMentions.length === 0) return []

  if (!isReadyForPriceDisclosure(ctx.property)) {
    return [
      {
        category: 'unauthorized_price',
        detail:
          'A resposta menciona valores monetários, mas o estágio atual do imóvel ' +
          '(pré-lançamento/lançamento/planta/obra/desconhecido) NUNCA autoriza divulgar preço, ' +
          'independentemente do que conste em conhecimento ou memória.',
        matches: moneyMentions,
      },
    ]
  }

  // Stage allows price talk — but only values actually grounded in the
  // OFFICIAL Ficha Técnica may be repeated. Anything else (memory-only,
  // Visão do Corretor-only, or hallucinated) is still blocked.
  const officialNormalized = new Set(
    extractMoneyMentions(ctx.officialPriceKnowledgeTexts.join('\n')).map(normalizeMoneyToken),
  )
  const ungrounded = moneyMentions.filter((m) => !officialNormalized.has(normalizeMoneyToken(m)))
  if (ungrounded.length === 0) return []

  return [
    {
      category: 'unauthorized_price',
      detail:
        'O imóvel está no estágio "pronto", mas o(s) valor(es) mencionado(s) não constam na ' +
        'Ficha Técnica oficial — a origem provável é uma memória aprendida/Visão do Corretor ' +
        '(nunca revalidada por um humano como tabela oficial) ou alucinação do modelo.',
      matches: ungrounded,
    },
  ]
}

// ------------------------------------------------------------
// 5. Visit/appointment self-confirmation — a memory describing HOW the
//    team usually schedules visits must never read as the AI being
//    authorized to close one itself. Only fires when the model is NOT
//    already escalating (transfer_required === false): if it IS
//    transferring, mentioning a day/time while explaining the handoff is
//    fine.
// ------------------------------------------------------------
const VISIT_SELF_CONFIRMATION_PATTERNS: RegExp[] = [
  /\b(?:visita|hor[aá]rio)\s+(?:est[aá]|fica|foi)?\s*confirmad[oa]/i,
  /\b(?:combinado|fechado|marcado|agendado)[,!]?\s+(?:te\s+espero|nos\s+vemos|at[eé]\s+(?:amanh[ãa]|logo|l[aá]))/i,
  /\bte\s+espero\s+(?:l[áa]|amanh[ãa]|hoje)\b/i,
  /\b(?:pode\s+ser|vamos\s+marcar\s+para|combinamos\s+para|fica\s+marcado\s+para)\s+(?:amanh[ãa]|hoje|segunda|ter[çc]a|quarta|quinta|sexta|s[áa]bado|domingo)[^.!?\n]{0,25}(?:às?\s*\d{1,2}h?|\d{1,2}:\d{2})/i,
]

function checkVisitSelfConfirmation(ctx: SecurityGuardContext): SecurityViolation[] {
  if (ctx.transferRequired) return []
  const matches: string[] = []
  for (const pattern of VISIT_SELF_CONFIRMATION_PATTERNS) {
    const m = ctx.responseText.match(pattern)
    if (m) matches.push(m[0])
  }
  if (matches.length === 0) return []
  return [
    {
      category: 'visit_self_confirmation',
      detail:
        'A resposta confirma/agenda uma visita ou horário por conta própria (transfer_required ' +
        'estava false). Saber como a equipe costuma agendar visitas não autoriza a Clara a fazê-lo.',
      matches,
    },
  ]
}

// ------------------------------------------------------------
// Orchestration
// ------------------------------------------------------------
export function runSecurityGuard(ctx: SecurityGuardContext): SecurityGuardResult {
  if (!ctx.responseText || !ctx.responseText.trim()) {
    return { violated: false, violations: [] }
  }

  const violations: SecurityViolation[] = [
    ...checkExactAddress(ctx),
    ...checkPriceDisclosure(ctx),
    ...checkBuilderDisclosure(ctx),
    ...checkVisitSelfConfirmation(ctx),
  ]

  return { violated: violations.length > 0, violations }
}

/**
 * Sanitizes any accidental or model-generated references to individual team members
 * specifically in handoff, transfer, or continuity contexts (e.g. "vou passar para o Ronaldo",
 * "o Ronaldo ou a Thatianna darão sequência").
 *
 * NOTE: Identifying as "assistente do Ronaldo Meira" / "da equipe do Ronaldo Meira"
 * is perfectly valid (the ads/Instagram are his). What is strictly forbidden is naming
 * who will answer or assume the chat on handoff ("vou direcionar para a equipe").
 */
export function sanitizeTeamMemberNames(text: string): string {
  if (!text) return text;
  return text
    // With preposition in handoff: "para o Ronaldo ou (a) Thatianna" -> "para a nossa equipe"
    .replace(/\bpara\s+(?:o\s+)?Ronaldo\s+(?:ou|e)\s+(?:a\s+)?Thatianna\b/gi, 'para a nossa equipe')
    // With preposition in handoff: "com o Ronaldo ou (a) Thatianna" -> "com a nossa equipe"
    .replace(/\bcom\s+(?:o\s+)?Ronaldo\s+(?:ou|e)\s+(?:a\s+)?Thatianna\b/gi, 'com a nossa equipe')
    // Standalone subject in handoff: "o Ronaldo ou a Thatianna" -> "nossa equipe"
    .replace(/\b(?:o\s+)?Ronaldo\s+(?:ou|e)\s+(?:a\s+)?Thatianna\b/gi, 'nossa equipe')
    // Verb agreement: "nossa equipe darão" -> "nossa equipe dará"
    .replace(/\bnossa\s+equipe\s+dar[aã]o\b/gi, 'nossa equipe dará')
    .replace(/\bnossa\s+equipe\s+v[aã]o\b/gi, 'nossa equipe vai')
    // Direct mentions in handoff context: "vou direcionar/passar/transferir para o Ronaldo / a Thatianna"
    .replace(/\b(?:vou\s+(?:direcionar|encaminhar|passar|transferir|conectar))\s+(?:nossa\s+conversa\s+|nosso\s+atendimento\s+|voc[eê]\s+)?(?:para\s+|com\s+)?(?:o\s+Ronaldo|a\s+Thatianna)\b/gi, 'vou direcionar para a nossa equipe')
    // "o Ronaldo ou a Thatianna darão sequência/continuidade"
    .replace(/\b(?:o\s+Ronaldo|a\s+Thatianna)\s+dar[aá]\s+(?:sequ[eê]ncia|continuidade)\b/gi, 'nossa equipe dará continuidade')
    .replace(/\b(?:o\s+Ronaldo|a\s+Thatianna)\s+vai\s+(?:dar\s+sequ[eê]ncia|dar\s+continuidade|falar)\b/gi, 'nossa equipe vai dar continuidade')
    // Clean up any double prepositions / spaces created
    .replace(/\bpara\s+para\s+a\s+nossa\s+equipe\b/gi, 'para a nossa equipe')
    .replace(/\bpara\s+a\s+para\s+a\s+nossa\s+equipe\b/gi, 'para a nossa equipe')
    .replace(/\bnossa\s+nossa\s+equipe\b/gi, 'nossa equipe')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Builds the safe replacement message sent instead of a blocked response.
 * Mirrors the tone/structure already used for the safety-message-limit and
 * off-hours fallbacks in conversation-engine.ts — never a robotic
 * "I can't answer that", always a warm handoff that tells the lead what
 * happens next.
 */
export function buildSecuritySafeResponse(isBusinessHoursNow: boolean): string {
  return isBusinessHoursNow
    ? 'Essa é uma informação que nossa equipe confirma diretamente com você para garantir total precisão. Vou direcionar para a nossa equipe dar sequência ao seu atendimento agora.'
    : 'Essa é uma informação que nossa equipe confirma diretamente com você para garantir total precisão. Já deixei tudo registrado por aqui e, como estamos fora do horário de atendimento, nossa equipe dará continuidade ao seu atendimento no próximo horário comercial.';
}

