import type { SupabaseClient } from '@supabase/supabase-js';
import {
  MAX_AI_MEDIA_PER_TURN,
  type AiConfig,
  type AiDecision,
  type AiMediaSendAction,
  type AiUsage,
  type BoundaryType,
  type ChatMessage,
  type PropertyMediaSummary,
} from './types';
import { HANDOFF_SENTINEL, aiRequestTimeoutMs } from './defaults';
import { generateOpenAi } from './providers/openai';
import { generateAnthropic } from './providers/anthropic';
import { retrievePropertyKnowledge } from './knowledge';
import { latestUserMessage } from './query';
import { getLeadContext, type FormattedLeadContext } from './lead-context';
import { getBusinessHoursContext, type BusinessHoursContext } from './business-hours';
import { buildConversationalSystemPrompt } from './prompt-builder';
import {
  getAvailablePropertyMedia,
  validateAndResolveMediaToSend,
  type ResolvedMediaToSend,
} from './property-media-service';
import { STAGE_LABELS, type PropertyStage } from '@/types';

export interface ConversationalTurnArgs {
  db: SupabaseClient;
  accountId: string;
  config: AiConfig;
  conversationId?: string | null;
  contactId?: string | null;
  propertyId?: string | null;
  messages: ChatMessage[];
  currentDate?: Date;
  simulatedHours?: 'business_hours' | 'off_hours' | 'real_time';
  simulatedLeadContext?: FormattedLeadContext | null;
  replyCount?: number;
  mode?: 'draft' | 'auto_reply';
}

export interface ConversationalTurnResult {
  responseText: string;
  handoff: boolean;
  decision: AiDecision;
  usage: AiUsage | null;
  retrievedKnowledgeCount: number;
  retrievedKnowledge: string[];
  systemPrompt: string;
  propertyInfo: { id: string; name: string; stage?: string | null; status?: string | null } | null;
  availableMedia: PropertyMediaSummary[];
  validatedMediaToSend: ResolvedMediaToSend[];
  businessHoursContext: BusinessHoursContext;
  leadContext: FormattedLeadContext | null;
  mediaSendAllowed?: boolean;
}

const VALID_BOUNDARIES = new Set<string>([
  'price',
  'payment_terms',
  'discount_negotiation',
  'availability_check',
  'visit_request',
  'financing_inquiry',
  'reservation',
  'commercial_decision',
  'knowledge_limit',
  'incompatible_demand',
  'human_requested',
  'safety_limit_reached',
  'custom_never_rule',
]);

function normalizeBoundaryType(val: unknown, transferRequired: boolean): BoundaryType {
  if (typeof val === 'string' && VALID_BOUNDARIES.has(val)) {
    return val as BoundaryType;
  }
  return transferRequired ? 'commercial_decision' : null;
}

/**
 * Parses the raw output from the model, supporting JSON structured decision
 * or graceful fallback to plaintext and [[HANDOFF]] sentinel.
 */
export function parseStructuredDecision(rawText: string): AiDecision {
  if (!rawText || typeof rawText !== 'string') {
    return {
      response_text: '',
      transfer_required: false,
      boundary_type: null,
      reason: null,
      context_summary: null,
      suggested_next_action: null,
    };
  }

  // 1. Try to extract JSON from code block or raw string
  let candidateJson = rawText.trim();

  const fenceMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch && fenceMatch[1]) {
    candidateJson = fenceMatch[1].trim();
  } else {
    const firstBrace = rawText.indexOf('{');
    const lastBrace = rawText.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      candidateJson = rawText.slice(firstBrace, lastBrace + 1).trim();
    }
  }

  try {
    const parsed = JSON.parse(candidateJson);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const rec = parsed as Record<string, unknown>;

      const response_text =
        typeof rec.response_text === 'string'
          ? rec.response_text.trim()
          : typeof rec.responseText === 'string'
            ? rec.responseText.trim()
            : typeof rec.reply === 'string'
              ? rec.reply.trim()
              : typeof rec.message === 'string'
                ? rec.message.trim()
                : typeof rec.text === 'string'
                  ? rec.text.trim()
                  : typeof rec.content === 'string'
                    ? rec.content.trim()
                    : typeof rec.resposta === 'string'
                      ? rec.resposta.trim()
                      : typeof rec.texto === 'string'
                        ? rec.texto.trim()
                        : '';

      const transfer_required =
        rec.transfer_required === true ||
        rec.transferRequired === true ||
        rec.transfer === true ||
        rec.handoff === true ||
        (typeof rec.boundary_type === 'string' && rec.boundary_type.length > 0 && rec.boundary_type !== 'none');

      const rawVal = rec.boundary_type ?? rec.boundaryType;
      const boundary_type = normalizeBoundaryType(rawVal, transfer_required);

      const reason =
        typeof rec.reason === 'string'
          ? rec.reason.trim()
          : typeof rec.motivo === 'string'
            ? rec.motivo.trim()
            : null;

      const context_summary =
        typeof rec.context_summary === 'string'
          ? rec.context_summary.trim()
          : typeof rec.contextSummary === 'string'
            ? rec.contextSummary.trim()
            : typeof rec.resumo === 'string'
              ? rec.resumo.trim()
              : null;

      const suggested_next_action =
        typeof rec.suggested_next_action === 'string'
          ? rec.suggested_next_action.trim()
          : typeof rec.suggestedNextAction === 'string'
            ? rec.suggestedNextAction.trim()
            : typeof rec.proxima_acao === 'string'
              ? rec.proxima_acao.trim()
              : null;

      const rawMedia =
        rec.send_media ??
        rec.sendMedia ??
        rec.send_property_media ??
        rec.sendPropertyMedia ??
        rec.media ??
        null;

      let send_media: AiMediaSendAction[] | null = null;
      if (Array.isArray(rawMedia)) {
        send_media = rawMedia
          .filter((m): m is Record<string, unknown> => Boolean(m && typeof m === 'object'))
          .map((m) => ({
            property_id: typeof m.property_id === 'string' ? m.property_id : undefined,
            media_id:
              typeof m.media_id === 'string'
                ? m.media_id.trim()
                : typeof m.id === 'string'
                  ? m.id.trim()
                  : '',
            caption:
              typeof m.caption === 'string'
                ? m.caption.trim()
                : typeof m.description === 'string'
                  ? m.description.trim()
                  : null,
          }))
          .filter((m) => Boolean(m.media_id))
          .slice(0, MAX_AI_MEDIA_PER_TURN);
        if (send_media.length === 0) send_media = null;
      } else if (rawMedia && typeof rawMedia === 'object') {
        const m = rawMedia as Record<string, unknown>;
        const media_id =
          typeof m.media_id === 'string'
            ? m.media_id.trim()
            : typeof m.id === 'string'
              ? m.id.trim()
              : '';
        if (media_id) {
          send_media = [
            {
              property_id: typeof m.property_id === 'string' ? m.property_id : undefined,
              media_id,
              caption:
                typeof m.caption === 'string'
                  ? m.caption.trim()
                  : typeof m.description === 'string'
                    ? m.description.trim()
                    : null,
            },
          ];
        }
      }

      return {
        response_text:
          response_text ||
          (transfer_required
            ? 'Vou conectar você com nossa equipe de especialistas.'
            : rawText.split(HANDOFF_SENTINEL).join('').trim()),
        transfer_required,
        boundary_type,
        reason,
        context_summary,
        suggested_next_action,
        send_media,
      };
    }
  } catch {
    // Fallback if model responded in free text
  }

  const hasSentinel = rawText.includes(HANDOFF_SENTINEL);
  const cleanText = rawText.split(HANDOFF_SENTINEL).join('').trim();

  return {
    response_text: cleanText,
    transfer_required: hasSentinel,
    boundary_type: hasSentinel ? 'commercial_decision' : null,
    reason: hasSentinel ? 'Limite comercial identificado na conversa' : null,
    context_summary: null,
    suggested_next_action: hasSentinel ? 'Atendimento humano para continuidade' : null,
  };
}

export type MediaFilterTopic = 'lazer' | 'fachada' | 'planta' | 'piscina' | 'decorado' | 'geral';

export interface MediaAuthorizationResult {
  authorized: boolean;
  reason: string;
  filterTopic?: MediaFilterTopic;
}

/**
 * Checks whether user explicitly requested media (photos, videos, floorplans, etc.)
 */
export function isExplicitMediaRequest(text: string): { requested: boolean; topic?: MediaFilterTopic } {
  if (!text || typeof text !== 'string') return { requested: false };
  const trimmed = text.trim();

  // Negative check: If user says "não precisa de fotos" or "sem fotos"
  const negativeRegex = /\b(n[aã]o|sem)\s+(?:precisa\s+)?(?:me\s+)?(?:de\s+)?(?:enviar|mandar|compartilhar)?\s*(?:fotos?|imagens?|v[ií]deos?|plantas?)\b/i;
  if (negativeRegex.test(trimmed)) {
    return { requested: false };
  }

  // Direct media noun keywords:
  const directMediaNoun = /\b(fotos?|fotografia|imagens?|imagem|v[ií]deos?|plantas?(?:\s+baixas?)?|perspectivas?|renders?|panor[aâ]micas?)\b/i.test(trimmed);

  // Visual action verbs targeted at specific visual aspects:
  // e.g., "quero ver a área de lazer", "mostra a piscina", "quero ver o apartamento decorado", "mostra a fachada"
  const visualTargetMatch = trimmed.match(
    /\b(ver|olhar|mostr(?:ar?|a|e)|conhecer\s+visualmente)\b.*?(\b(?:[aá]rea\s+de\s+lazer|lazer|piscina|fachada|apartamento(?:\s+decorado)?|decorado|interna|espa[cç]o\s+gourmet|academia|vista|varanda)\b)/i
  );

  if (!directMediaNoun && !visualTargetMatch) {
    return { requested: false };
  }

  // Determine specific topic if present
  let topic: MediaFilterTopic = 'geral';
  if (/\b(fachada|frontal|externa)\b/i.test(trimmed)) {
    topic = 'fachada';
  } else if (/\b(lazer|[aá]rea\s+de\s+lazer|gourmet|quadra|recrea|playground)\b/i.test(trimmed)) {
    topic = 'lazer';
  } else if (/\b(piscina|deck)\b/i.test(trimmed)) {
    topic = 'piscina';
  } else if (/\b(planta|plantas|planta\s+baixa)\b/i.test(trimmed)) {
    topic = 'planta';
  } else if (/\b(decorado|interna|apartamento\s+decorado)\b/i.test(trimmed)) {
    topic = 'decorado';
  }

  return { requested: true, topic };
}

/**
 * Checks if the assistant offered media in the immediately preceding turn
 */
export function didAssistantOfferMedia(lastAssistantText: string): boolean {
  if (!lastAssistantText) return false;
  const offerRegex = /(?:quer(?: que eu)?|posso|gostaria que eu|deseja que eu|posso te|se quiser posso|posso enviar|posso mandar)\s+(?:te\s+)?(?:envi(?:ar|e|asse)|mand(?:ar|e|asse)|compartilh(?:ar|e)|mostr(?:ar|e))\s+(?:algumas?\s+)?(?:fotos?|imagens?|plantas?|v[ií]deos?)/i;
  const questionOfferRegex = /(?:fotos?|imagens?|plantas?|v[ií]deos?).*?\b(?:quer|gostaria|deseja|posso|te envio|te mando)\b.*?\?/i;
  const directOfferRegex = /(?:posso te enviar|quer que eu mande|quer ver)\s+(?:as\s+|algumas?\s+)?(?:fotos?|imagens?|plantas?)/i;
  return offerRegex.test(lastAssistantText) || questionOfferRegex.test(lastAssistantText) || directOfferRegex.test(lastAssistantText);
}

/**
 * Checks if the user gave an affirmative confirmation (e.g. to a previous media offer)
 */
export function isAffirmativeConfirmation(userText: string): boolean {
  if (!userText) return false;
  const trimmed = userText.trim().toLowerCase();
  return (
    /^(?:sim|claro|pode(?:\s*(?:mandar|enviar|ser|sim))?|manda(?:\s*(?:a[ií]|sim|por\s*favor))?|envia(?:\s*(?:a[ií]|sim|por\s*favor))?|quero(?:\s*sim)?|com\s*certeza|por\s*favor|fique\s*a\s*vontade|mande|manda\s*fotos?|quero\s*ver)[.!]*$/i.test(trimmed) ||
    /^(?:sim|claro|com\s*certeza)[,\s]+(?:pode|manda|envia|quero|por\s*favor)/i.test(trimmed)
  );
}

/**
 * Low-level Architectural Guard for property media dispatch.
 */
export function isMediaSendAuthorized(args: {
  messages: ChatMessage[];
  isInitialContact: boolean;
  userMessageCount: number;
}): MediaAuthorizationResult {
  const { messages, isInitialContact, userMessageCount } = args;

  // 1. Get user messages for the current turn (all user messages after the last assistant response)
  const lastAssistantIndex = messages.map((m) => m.role).lastIndexOf('assistant');
  const currentTurnUserMessages = messages
    .slice(lastAssistantIndex + 1)
    .filter((m) => m.role === 'user');

  // 2. Check if the user explicitly requested media in any message of the current turn
  let explicitCheck: { requested: boolean; topic?: MediaFilterTopic } = { requested: false };
  for (const uMsg of currentTurnUserMessages) {
    const check = isExplicitMediaRequest(uMsg.content);
    if (check.requested) {
      explicitCheck = check;
      break;
    }
  }

  // 3. Absolute First Turn Gate:
  // If isInitialContact is true or userMessageCount <= 1:
  // Media is ONLY allowed if the user explicitly requested photos/media.
  if (isInitialContact || userMessageCount <= 1) {
    if (explicitCheck.requested) {
      return {
        authorized: true,
        reason: 'Lead explicitou pedido de mídia no primeiro contato.',
        filterTopic: explicitCheck.topic,
      };
    }
    return {
      authorized: false,
      reason: 'Primeiro contato sem solicitação explícita de mídia. Envio proibido.',
    };
  }

  // 4. Ongoing Turns:
  // 4a. If user explicitly requested media in this turn
  if (explicitCheck.requested) {
    return {
      authorized: true,
      reason: 'Lead explicitou pedido de mídia na conversa.',
      filterTopic: explicitCheck.topic,
    };
  }

  // 4b. If Clara offered media in the previous assistant message and lead confirmed
  const assistantMessages = messages.filter((m) => m.role === 'assistant');
  const lastAssistantText = assistantMessages.length > 0 ? assistantMessages[assistantMessages.length - 1].content : '';
  const latestUserText = currentTurnUserMessages.length > 0 ? currentTurnUserMessages[currentTurnUserMessages.length - 1].content : '';

  if (didAssistantOfferMedia(lastAssistantText) && isAffirmativeConfirmation(latestUserText)) {
    return {
      authorized: true,
      reason: 'Lead confirmou afirmativamente oferta de fotos feita pela Clara no turno anterior.',
      filterTopic: 'geral',
    };
  }

  return {
    authorized: false,
    reason: 'Nenhuma solicitação ou confirmação de mídia identificada neste turno.',
  };
}

/**
 * Execute a complete conversational turn using Stage 4 behavioral architecture.
 */
export async function executeConversationalTurn(
  args: ConversationalTurnArgs,
): Promise<ConversationalTurnResult> {
  const {
    db,
    accountId,
    config,
    contactId,
    propertyId,
    messages,
    currentDate = new Date(),
    simulatedHours = 'real_time',
    simulatedLeadContext = null,
    replyCount = 0,
    mode = 'auto_reply',
  } = args;

  // Determine effective date/time based on simulated hours
  let effectiveDate = currentDate;
  if (simulatedHours === 'business_hours') {
    // 14:30 on a Wednesday (America/Sao_Paulo)
    effectiveDate = new Date('2026-09-09T14:30:00-03:00');
  } else if (simulatedHours === 'off_hours') {
    // 22:30 on a Wednesday (America/Sao_Paulo)
    effectiveDate = new Date('2026-09-09T22:30:00-03:00');
  }

  const safetyLimit = config.safetyMessageLimit || 8;
  const businessHours: BusinessHoursContext = getBusinessHoursContext(config, effectiveDate);

  // 1. Check Safety Message Limit threshold
  if (replyCount >= safetyLimit) {
    const isHours = businessHours.isBusinessHours;
    const fallbackText = isHours
      ? 'Para garantir o melhor atendimento e tirar todas as suas dúvidas com precisão, vou transferir nossa conversa para nossos especialistas (Ronaldo ou Thatianna) que darão sequência imediata ao seu contato.'
      : 'Para garantir o melhor atendimento com precisão, já deixei nossa conversa registrada para que o Ronaldo ou a Thatianna entrem em contato diretamente com você logo no início do nosso expediente.';

    const decision: AiDecision = {
      response_text: fallbackText,
      transfer_required: true,
      boundary_type: 'safety_limit_reached',
      reason: `Limite de segurança de mensagens atingido (${safetyLimit} mensagens).`,
      context_summary: 'Conversa atingiu o limite de mensagens do atendimento automático.',
      suggested_next_action: 'Assumir conversa humana no Inbox.',
    };

    return {
      responseText: decision.response_text,
      handoff: true,
      decision,
      usage: null,
      retrievedKnowledgeCount: 0,
      retrievedKnowledge: [],
      systemPrompt: 'System prompt omitted for safety limit early-out.',
      propertyInfo: null,
      availableMedia: [],
      validatedMediaToSend: [],
      businessHoursContext: businessHours,
      leadContext: null,
    };
  }

  // 2. Load Property Details & Media if propertyId is provided
  let propertyInfo: { id: string; name: string; stage?: string | null; status?: string | null } | null = null;
  let propertyStyleInstructions: string[] = [];
  let availableMedia: PropertyMediaSummary[] = [];
  if (propertyId) {
    try {
      const [propRes, ctxRes, mediaList] = await Promise.all([
        db.from('properties').select('id, name, status').eq('id', propertyId).maybeSingle(),
        db
          .from('property_ai_contexts')
          .select('stage, response_style_instructions')
          .eq('property_id', propertyId)
          .maybeSingle(),
        getAvailablePropertyMedia(db, accountId, propertyId),
      ]);

      if (propRes.data) {
        const rawStage = (ctxRes.data?.stage as PropertyStage) || 'lancamento';
        propertyInfo = {
          id: propRes.data.id,
          name: propRes.data.name,
          stage: STAGE_LABELS[rawStage] || rawStage,
          status: (propRes.data.status as string | null) ?? 'ativo',
        };
      }
      propertyStyleInstructions = Array.isArray(ctxRes.data?.response_style_instructions)
        ? ctxRes.data.response_style_instructions
        : [];
      availableMedia = mediaList;
    } catch (err) {
      console.error('[conversation engine] error loading property info:', err);
    }
  }

  // 3. Load pre-extracted Lead Context (simulated or real DB)
  let leadContext: FormattedLeadContext | null = simulatedLeadContext;
  if (!leadContext && contactId) {
    leadContext = await getLeadContext(db, accountId, contactId);
  }

  // 4. Retrieve isolated RAG Knowledge
  const lastUserMsg = latestUserMessage(messages);
  const rawKnowledge = await retrievePropertyKnowledge(
    db,
    accountId,
    config,
    propertyId,
    lastUserMsg,
    5,
  );

  const knowledgeResult = Array.isArray(rawKnowledge)
    ? {
        propertyChunks: propertyId ? (rawKnowledge as string[]) : [],
        globalChunks: propertyId ? [] : (rawKnowledge as string[]),
        allChunks: rawKnowledge as string[],
        chunks: [],
      }
    : (rawKnowledge || {
        propertyChunks: [],
        globalChunks: [],
        allChunks: [],
        chunks: [],
      });

  // 5. Determine Greeting State (Initial Contact vs Ongoing Conversation)
  const previousAssistantMessages = messages.filter((m) => m.role === 'assistant');
  const userMessages = messages.filter((m) => m.role === 'user');
  const isInitialContact = (replyCount === 0 && previousAssistantMessages.length === 0);
  const userMessageCount = userMessages.length;
  const totalTurns = previousAssistantMessages.length;
  const communicatedContent = previousAssistantMessages
    .map((m) => m.content.trim())
    .filter((txt) => txt.length > 0);

  // 6. Build Modular System Prompt with structured decision requirement
  const systemPrompt = buildConversationalSystemPrompt({
    config,
    mode: mode || 'auto_reply',
    isInitialContact,
    property: propertyInfo,
    propertyKnowledge: propertyId ? knowledgeResult.propertyChunks : [],
    propertyMedia: availableMedia,
    propertyStyleInstructions: propertyId ? propertyStyleInstructions : [],
    globalKnowledge: knowledgeResult.globalChunks,
    leadContext,
    businessHours,
    structuredOutputRequired: true,
    userMessageCount,
    totalTurns,
    communicatedContent,
  });

  // 7. Invoke Provider
  const timeoutMs = aiRequestTimeoutMs();
  const providerArgs = {
    apiKey: config.apiKey,
    model: config.model,
    systemPrompt,
    messages,
    timeoutMs,
  };

  const rawResult =
    config.provider === 'openai'
      ? await generateOpenAi(providerArgs)
      : await generateAnthropic(providerArgs);

  // 8. Parse Decision
  const decision = parseStructuredDecision(rawResult.text);

  // Defensive Post-Processing: Strip accidental greeting formula on ongoing conversations
  if (!isInitialContact && decision.response_text) {
    const stripped = decision.response_text
      .replace(/^(?:boa\s*(?:tarde|noite|madrugada)|bom\s*dia|ol[aá]|oi)[!.,\s-]*/i, '')
      .trim();
    if (stripped.length > 0) {
      decision.response_text = stripped.charAt(0).toUpperCase() + stripped.slice(1);
    }
  }

  // 8b. Media Authorization Architectural Guard (HARD BLOCK)
  const mediaAuth = isMediaSendAuthorized({
    messages,
    isInitialContact,
    userMessageCount,
  });

  if (!mediaAuth.authorized) {
    // Hard block: Strip any media that LLM hallucinates or suggests
    decision.send_media = null;

    // Defensive Sanitization: If LLM generated text claiming to attach/send photos when unauthorized,
    // sanitize to avoid confusing the lead.
    if (decision.response_text) {
      decision.response_text = decision.response_text
        .replace(/(?:estou\s+te\s+enviando|aqui\s+est[aã]o|seguem|segue)\s+(?:algumas?\s+)?(?:fotos?|imagens?|as\s+fotos?)[^.!?]*[.!?]/gi, '')
        .trim();
    }
  } else {
    // 8c. Media Auto-Resolution / Topic Filtering when authorized:
    // Filter matching media by requested topic (e.g. lazer, fachada, piscina)
    const getTopicRegex = (topic?: MediaFilterTopic): RegExp | null => {
      if (!topic || topic === 'geral') return null;
      switch (topic) {
        case 'lazer':
          return /lazer|[aá]rea\s+de\s+lazer|piscina|deck|churrasqueira|gourmet|quadra|recrea|playground/i;
        case 'piscina':
          return /piscina|deck|molhado/i;
        case 'fachada':
          return /fachada|frontal|externa|perspectiva|render/i;
        case 'planta':
          return /planta|layout|baixa/i;
        case 'decorado':
          return /decorado|interna|apartamento|sala|quarto|su[ií]te/i;
        default:
          return null;
      }
    };

    const topicRegex = getTopicRegex(mediaAuth.filterTopic);

    // If decision.send_media is empty or null, auto-resolve from availableMedia
    if (
      propertyId &&
      availableMedia.length > 0 &&
      (!decision.send_media || decision.send_media.length === 0)
    ) {
      let filteredMedia = availableMedia;
      if (topicRegex) {
        const matches = availableMedia.filter(
          (m) => (m.description && topicRegex.test(m.description)) || topicRegex.test(m.file_name),
        );
        if (matches.length > 0) {
          filteredMedia = matches;
        }
      }

      console.log(`[conversation engine] Auto-resolving send_media for property ${propertyId} (${filteredMedia.length} filtered items, topic=${mediaAuth.filterTopic || 'geral'})`);
      decision.send_media = filteredMedia.slice(0, 5).map((m) => ({
        property_id: propertyId,
        media_id: m.id,
        caption: null,
      }));
    } else if (decision.send_media && decision.send_media.length > 0 && topicRegex) {
      // If LLM returned media but lead asked for a specific topic, prioritize matching items
      const matchingMediaIds = new Set(
        availableMedia
          .filter((m) => (m.description && topicRegex.test(m.description)) || topicRegex.test(m.file_name))
          .map((m) => m.id),
      );
      if (matchingMediaIds.size > 0) {
        const filtered = decision.send_media.filter((sm) => matchingMediaIds.has(sm.media_id));
        if (filtered.length > 0) {
          decision.send_media = filtered;
        }
      }
    }
  }

  // 9. Validate and Resolve any media items requested by the model (strictly when authorized)
  const validatedMediaToSend = mediaAuth.authorized
    ? await validateAndResolveMediaToSend(
        db,
        accountId,
        propertyId || null,
        decision.send_media,
      )
    : [];

  return {
    responseText: decision.response_text,
    handoff: decision.transfer_required,
    decision,
    usage: rawResult.usage,
    retrievedKnowledgeCount: knowledgeResult.allChunks.length,
    retrievedKnowledge: knowledgeResult.allChunks,
    systemPrompt,
    propertyInfo,
    availableMedia,
    validatedMediaToSend,
    businessHoursContext: businessHours,
    leadContext,
    mediaSendAllowed: mediaAuth.authorized,
  };
}
