import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { getConversationSessionStatus, validateApprovedTemplateSubmission } from '@/lib/whatsapp/session-window';
import { resolveValidatedPublicPropertyUrl } from '@/lib/match/smart-send';
import {
  FOLLOWUP_REQUIRED_TEMPLATE_NAME,
  buildMatchImovelPersonalizadoParams,
  buildMultiPropertyFreeFollowupMessage,
  type CompatiblePropertySummary,
} from '@/lib/followup/engine';
import type { MessageTemplate, TemplateButton } from '@/types';

function bad(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

interface FollowupPayload {
  reason?: string | null;
  approach_summary?: string | null;
  [key: string]: unknown;
}

function normalizeSelectedProperties(rawList: unknown): CompatiblePropertySummary[] {
  if (!Array.isArray(rawList)) return [];
  const out: CompatiblePropertySummary[] = [];
  for (const item of rawList) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const propertyId = typeof obj.propertyId === 'string' ? obj.propertyId.trim() : '';
    if (!propertyId) continue;
    const operation = String(obj.operation || 'venda').trim().toLowerCase();
    // Regra de ouro: nunca aceitar imóvel de locação
    if (operation !== 'venda') continue;

    const rawPublicUrl =
      typeof obj.publicUrl === 'string' && obj.publicUrl.trim() ? obj.publicUrl.trim() : null;
    const resolved = resolveValidatedPublicPropertyUrl(rawPublicUrl, null);
    if (!resolved.url) continue;

    out.push({
      matchId: typeof obj.matchId === 'string' ? obj.matchId : '',
      propertyId,
      title: typeof obj.title === 'string' && obj.title.trim() ? obj.title.trim() : 'Imóvel',
      code: typeof obj.code === 'string' ? obj.code : null,
      neighborhood: typeof obj.neighborhood === 'string' ? obj.neighborhood : '',
      city: typeof obj.city === 'string' ? obj.city : 'João Pessoa',
      operation: 'venda',
      propertyType: typeof obj.propertyType === 'string' ? obj.propertyType : null,
      priceMin: Number(obj.priceMin || 0),
      priceMax: Number(obj.priceMax || 0),
      bedroomsMin: obj.bedroomsMin != null ? Number(obj.bedroomsMin) : null,
      bedroomsMax: obj.bedroomsMax != null ? Number(obj.bedroomsMax) : null,
      areaMin: obj.areaMin != null ? Number(obj.areaMin) : null,
      deliveryStatus: typeof obj.deliveryStatus === 'string' ? obj.deliveryStatus : null,
      coverUrl: typeof obj.coverUrl === 'string' ? obj.coverUrl : null,
      publicUrl: resolved.url,
      matchScore: Number(obj.matchScore || 0),
      commercialPriority: Number(obj.commercialPriority || 0),
      matchStatus: typeof obj.matchStatus === 'string' ? obj.matchStatus : 'novo',
      reasons: Array.isArray(obj.reasons) ? obj.reasons.map(String) : [],
    });
  }
  return out;
}

/**
 * POST /api/ai/suggestions/[id]/followup/generate (agent+)
 *
 * Prepara o rascunho de Follow-up sem enviar nem concluir a oportunidade:
 * - Janela aberta (`mode: 'free'`): mensagem livre personalizada com 1 ou mais imóveis selecionados.
 * - Janela encerrada (`mode: 'template'`): utiliza EXCLUSIVAMENTE o template `match_imovel_personalizado`
 *   para exatamente 1 imóvel selecionado, validando status APPROVED e estrutura real na Meta.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const { supabase, accountId, userId } = await requireRole('agent');

    const limit = checkRateLimit(`followup-generate:${userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const body = await request.json().catch(() => null);
    const mode = body?.mode;
    if (mode !== 'free' && mode !== 'template') {
      return bad('mode must be "free" or "template"');
    }

    const interestProperty =
      typeof body?.interestProperty === 'string' && body.interestProperty.trim()
        ? body.interestProperty.trim()
        : null;

    // Aceita tanto `selectedProperties` (array) quanto `selectedProperty` (legado)
    const rawSelectedList = Array.isArray(body?.selectedProperties)
      ? body.selectedProperties
      : body?.selectedProperty
        ? [body.selectedProperty]
        : [];
    const selectedProperties = normalizeSelectedProperties(rawSelectedList);

    const { data: suggestion, error: fetchError } = await supabase
      .from('ai_suggestions')
      .select('id, category, contact_id, conversation_id, payload, contact:contacts(name)')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle();

    if (fetchError) return bad('Failed to load suggestion', 500);
    if (!suggestion) return bad('Not found', 404);
    if (suggestion.category !== 'followup') return bad('Suggestion is not a follow-up');
    if (!suggestion.conversation_id) return bad('Suggestion has no conversation to draft for');

    const payload = (suggestion.payload ?? {}) as FollowupPayload;
    const contactName = (suggestion.contact as { name?: string } | null)?.name || 'Cliente';

    // Revalida status real da janela de 24h no servidor
    const sessionStatus = await getConversationSessionStatus(supabase, suggestion.conversation_id);

    if (mode === 'free') {
      if (!sessionStatus.windowOpen) {
        return NextResponse.json(
          {
            code: 'window_expired',
            error:
              'A janela de conversação de 24 horas foi encerrada. Selecione apenas um imóvel para preparar o envio com o template match_imovel_personalizado.',
            sessionWindowOpen: false,
            sessionWindowRemainingMs: 0,
          },
          { status: 409 }
        );
      }

      if (selectedProperties.length === 0) {
        return bad('Selecione ao menos um imóvel de venda com link válido para preparar a mensagem.');
      }

      const text = buildMultiPropertyFreeFollowupMessage({
        contactName,
        properties: selectedProperties,
        interestProperty,
      });

      const draft = {
        mode: 'free' as const,
        text,
        selected_property_ids: selectedProperties.map((p) => p.propertyId),
      };

      await supabase
        .from('ai_suggestions')
        .update({ payload: { ...payload, draft } })
        .eq('id', id)
        .eq('account_id', accountId);

      return NextResponse.json({
        draft,
        sessionWindowOpen: sessionStatus.windowOpen,
        sessionWindowRemainingMs: sessionStatus.remainingMs,
      });
    }

    // mode === 'template': EXCLUSIVAMENTE template `match_imovel_personalizado` com 1 imóvel
    if (selectedProperties.length !== 1) {
      return bad(
        'Com a janela de conversação encerrada, selecione exatamente um imóvel para preparar o template match_imovel_personalizado.'
      );
    }

    const targetProperty = selectedProperties[0];

    const { data: templateRows, error: tmplError } = await supabase
      .from('message_templates')
      .select('*')
      .eq('account_id', accountId)
      .eq('name', FOLLOWUP_REQUIRED_TEMPLATE_NAME);

    if (tmplError) {
      return bad('Falha ao consultar o template match_imovel_personalizado.', 500);
    }

    const candidates = (templateRows || []) as MessageTemplate[];
    const approvedTemplate = candidates.find(
      (t) => String(t.status || '').toUpperCase() === 'APPROVED'
    );

    if (!approvedTemplate) {
      const existing = candidates[0];
      const statusHint = existing
        ? `Status atual na conta: ${existing.status}.`
        : 'Template não encontrado na conta.';
      return NextResponse.json({
        draft: null,
        sessionWindowOpen: sessionStatus.windowOpen,
        sessionWindowRemainingMs: sessionStatus.remainingMs,
        failureCode: 'template_not_approved',
        failureReason: `O template obrigatório "${FOLLOWUP_REQUIRED_TEMPLATE_NAME}" não está aprovado pela Meta para envio. ${statusHint}`,
      });
    }

    const built = buildMatchImovelPersonalizadoParams({
      contactName,
      property: targetProperty,
    });

    if (!built.buttonUrlSuffix) {
      return NextResponse.json({
        draft: null,
        sessionWindowOpen: sessionStatus.windowOpen,
        sessionWindowRemainingMs: sessionStatus.remainingMs,
        failureCode: 'invalid_property_url',
        failureReason: 'O imóvel selecionado não possui um link público válido para o botão do template.',
      });
    }

    const validation = validateApprovedTemplateSubmission(approvedTemplate, built.body, null);
    if (!validation.valid) {
      return NextResponse.json({
        draft: null,
        sessionWindowOpen: sessionStatus.windowOpen,
        sessionWindowRemainingMs: sessionStatus.remainingMs,
        failureCode: 'template_validation_failed',
        failureReason:
          validation.reason ||
          `As variáveis do template "${FOLLOWUP_REQUIRED_TEMPLATE_NAME}" não atenderam à estrutura aprovada.`,
      });
    }

    const buttons = Array.isArray(approvedTemplate.buttons)
      ? (approvedTemplate.buttons as TemplateButton[])
      : [];
    const urlButtonIdx = buttons.findIndex(
      (b) => b.type === 'URL' && typeof b.url === 'string' && b.url.includes('{{')
    );
    const buttonParams: Record<number, string> =
      urlButtonIdx >= 0 ? { [urlButtonIdx]: built.buttonUrlSuffix } : { 0: built.buttonUrlSuffix };
    const urlButton = urlButtonIdx >= 0 ? buttons[urlButtonIdx] : buttons[0];

    const draft = {
      mode: 'template' as const,
      template_id: approvedTemplate.id,
      template_name: approvedTemplate.name,
      template_language: approvedTemplate.language || 'pt_BR',
      body_text: approvedTemplate.body_text,
      values: {
        body: built.body,
        buttonParams,
      },
      button_text: urlButton?.text || 'Ver imóvel',
      button_url: targetProperty.publicUrl,
      selected_property_id: targetProperty.propertyId,
      supports_public_url: true,
    };

    await supabase
      .from('ai_suggestions')
      .update({ payload: { ...payload, draft } })
      .eq('id', id)
      .eq('account_id', accountId);

    return NextResponse.json({
      draft,
      sessionWindowOpen: sessionStatus.windowOpen,
      sessionWindowRemainingMs: sessionStatus.remainingMs,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
