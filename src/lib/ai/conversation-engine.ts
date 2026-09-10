import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  AiConfig,
  AiDecision,
  AiUsage,
  BoundaryType,
  ChatMessage,
} from './types';
import { HANDOFF_SENTINEL, aiRequestTimeoutMs } from './defaults';
import { generateOpenAi } from './providers/openai';
import { generateAnthropic } from './providers/anthropic';
import { retrievePropertyKnowledge } from './knowledge';
import { latestUserMessage } from './query';
import { getLeadContext, type FormattedLeadContext } from './lead-context';
import { getBusinessHoursContext, type BusinessHoursContext } from './business-hours';
import { buildConversationalSystemPrompt } from './prompt-builder';
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
}

export interface ConversationalTurnResult {
  responseText: string;
  handoff: boolean;
  decision: AiDecision;
  usage: AiUsage | null;
  retrievedKnowledgeCount: number;
  retrievedKnowledge: string[];
  systemPrompt: string;
  propertyInfo: { id: string; name: string; stage?: string | null } | null;
  businessHoursContext: BusinessHoursContext;
  leadContext: FormattedLeadContext | null;
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
      businessHoursContext: businessHours,
      leadContext: null,
    };
  }

  // 2. Load Property Details if propertyId is provided
  let propertyInfo: { id: string; name: string; stage?: string | null } | null = null;
  if (propertyId) {
    try {
      const [propRes, ctxRes] = await Promise.all([
        db.from('properties').select('id, name').eq('id', propertyId).maybeSingle(),
        db.from('property_ai_contexts').select('stage').eq('property_id', propertyId).maybeSingle(),
      ]);

      if (propRes.data) {
        const rawStage = (ctxRes.data?.stage as PropertyStage) || 'lancamento';
        propertyInfo = {
          id: propRes.data.id,
          name: propRes.data.name,
          stage: STAGE_LABELS[rawStage] || rawStage,
        };
      }
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
  const knowledgeExcerpts = await retrievePropertyKnowledge(
    db,
    accountId,
    config,
    propertyId,
    lastUserMsg,
    5,
  );

  // 5. Build Modular System Prompt with structured decision requirement
  const systemPrompt = buildConversationalSystemPrompt({
    config,
    mode: 'auto_reply',
    property: propertyInfo,
    propertyKnowledge: propertyId ? knowledgeExcerpts : [],
    globalKnowledge: !propertyId ? knowledgeExcerpts : [],
    leadContext,
    businessHours,
    structuredOutputRequired: true,
  });

  // 6. Invoke Provider
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

  // 7. Parse Decision
  const decision = parseStructuredDecision(rawResult.text);

  return {
    responseText: decision.response_text,
    handoff: decision.transfer_required,
    decision,
    usage: rawResult.usage,
    retrievedKnowledgeCount: knowledgeExcerpts.length,
    retrievedKnowledge: knowledgeExcerpts,
    systemPrompt,
    propertyInfo,
    businessHoursContext: businessHours,
    leadContext,
  };
}
