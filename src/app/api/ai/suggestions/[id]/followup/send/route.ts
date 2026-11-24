import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import {
  getConversationSessionStatus,
  renderApprovedTemplatePreview,
  validateApprovedTemplateSubmission,
} from '@/lib/whatsapp/session-window';
import {
  sendMessageToConversation,
  SendMessageError,
} from '@/lib/whatsapp/send-message';
import { resolveValidatedPublicPropertyUrl } from '@/lib/match/smart-send';
import { generateTrackingToken } from '@/lib/match/tokens';
import { ensurePropertyUuid } from '@/lib/tunnel/auth';
import { updateMatchStatus } from '@/lib/match/service';
import {
  FOLLOWUP_REQUIRED_TEMPLATE_NAME,
  extractPropertyUrlSlug,
} from '@/lib/followup/engine';
import type { MessageTemplate, TemplateButton } from '@/types';

function bad(message: string, status = 400, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error: message, ...extra }, { status });
}

interface SelectedPropertyInput {
  propertyId: string;
  matchId?: string | null;
  title: string;
  operation: string;
  publicUrl: string;
}

function parseSelectedProperties(raw: unknown): {
  valid: SelectedPropertyInput[];
  hasRental: boolean;
  hasInvalidUrl: boolean;
} {
  if (!Array.isArray(raw)) {
    return { valid: [], hasRental: false, hasInvalidUrl: false };
  }
  const valid: SelectedPropertyInput[] = [];
  let hasRental = false;
  let hasInvalidUrl = false;

  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const propertyId = typeof obj.propertyId === 'string' ? obj.propertyId.trim() : '';
    if (!propertyId) continue;

    const operation = String(obj.operation || '').trim().toLowerCase();
    if (operation !== 'venda') {
      hasRental = true;
      continue;
    }

    const rawUrl = typeof obj.publicUrl === 'string' ? obj.publicUrl.trim() : '';
    const resolved = resolveValidatedPublicPropertyUrl(rawUrl, null);
    if (!resolved.url) {
      hasInvalidUrl = true;
      continue;
    }

    valid.push({
      propertyId,
      matchId: typeof obj.matchId === 'string' && obj.matchId.trim() ? obj.matchId.trim() : null,
      title: typeof obj.title === 'string' && obj.title.trim() ? obj.title.trim() : 'Imóvel',
      operation: 'venda',
      publicUrl: resolved.url,
    });
  }

  return { valid, hasRental, hasInvalidUrl };
}

/**
 * POST /api/ai/suggestions/[id]/followup/send (agent+)
 *
 * Executa o envio real do Follow-up pela WhatsApp Cloud API com segurança operacional:
 * - Revalida operação comercial (exclusivamente vendas).
 * - Revalida a janela de conversação de 24h imediatamente antes do envio.
 * - Com janela aberta (`mode: 'free'`): envia texto livre com 1 ou mais imóveis selecionados.
 * - Com janela encerrada (`mode: 'template'`): utiliza EXCLUSIVAMENTE `match_imovel_personalizado`
 *   para exatamente 1 imóvel selecionado, bloqueando se não estiver APPROVED na Meta.
 * - Em caso de falha no envio, NUNCA conclui o Follow-up.
 * - Em caso de sucesso confirmado, conclui o Follow-up registrando imóveis enviados, tipo de mensagem,
 *   data do envio e `property_shares`.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const { supabase, accountId, userId } = await requireRole('agent');

    const limit = checkRateLimit(`followup-send:${userId}`, RATE_LIMITS.send);
    if (!limit.success) return rateLimitResponse(limit);

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return bad('Payload inválido.');
    }

    const mode = body.mode;
    if (mode !== 'free' && mode !== 'template') {
      return bad('mode deve ser "free" ou "template".');
    }

    const clientRef =
      typeof body.client_ref === 'string' && body.client_ref.trim()
        ? body.client_ref.trim()
        : null;

    const { valid: selectedProperties, hasRental, hasInvalidUrl } = parseSelectedProperties(
      body.selectedProperties
    );

    if (hasRental) {
      return bad(
        'O módulo de Follow-up trabalha exclusivamente com imóveis de venda. Imóveis de locação não podem ser enviados.',
        422,
        { code: 'sale_only_violation' }
      );
    }

    if (hasInvalidUrl) {
      return bad(
        'Um ou mais imóveis selecionados não possuem link público válido para compartilhamento.',
        422,
        { code: 'invalid_property_url' }
      );
    }

    if (selectedProperties.length === 0) {
      return bad('Selecione ao menos um imóvel compatível de venda antes de enviar.');
    }

    const { data: suggestion, error: fetchError } = await supabase
      .from('ai_suggestions')
      .select('id, category, status, contact_id, conversation_id, payload')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle();

    if (fetchError) return bad('Falha ao carregar sugestão de follow-up.', 500);
    if (!suggestion) return bad('Sugestão de follow-up não encontrada.', 404);
    if (suggestion.category !== 'followup') return bad('Esta sugestão não é um follow-up.');
    if (!suggestion.conversation_id || !suggestion.contact_id) {
      return bad('Sugestão sem conversa ou contato vinculado.');
    }

    // Validação de estoque/operação no banco para os imóveis selecionados (defesa em profundidade)
    const propIds = selectedProperties.map((p) => p.propertyId);
    const { data: projRows } = await supabase
      .from('property_match_projections')
      .select('property_id, status, operation')
      .eq('account_id', accountId)
      .in('property_id', propIds);

    if (Array.isArray(projRows) && projRows.length > 0) {
      for (const proj of projRows as Array<Record<string, unknown>>) {
        const status = String(proj.status || '').toLowerCase();
        const op = String(proj.operation || '').toLowerCase();
        if (status !== 'ativo') {
          return bad(
            'Um dos imóveis selecionados não está mais disponível no estoque ativo.',
            422,
            { code: 'property_unavailable' }
          );
        }
        if (op !== 'venda') {
          return bad(
            'Imóveis de locação não são permitidos no fluxo de Follow-up.',
            422,
            { code: 'sale_only_violation' }
          );
        }
      }
    }

    // Revalidação obrigatória da janela de 24h imediatamente antes do envio (Seção 12)
    const sessionStatus = await getConversationSessionStatus(supabase, suggestion.conversation_id);

    let sentMessageId: string;
    let whatsappMessageId: string;
    let realizedMessageText: string;
    let realizedTemplateName: string | null = null;

    if (mode === 'free') {
      if (!sessionStatus.windowOpen) {
        return bad(
          'A janela de conversação de 24 horas foi encerrada. Selecione apenas um imóvel para enviar usando o template match_imovel_personalizado.',
          409,
          {
            code: 'window_expired',
            sessionWindowOpen: false,
            sessionWindowRemainingMs: 0,
          }
        );
      }

      const contentText = typeof body.text === 'string' ? body.text.trim() : '';
      if (!contentText) {
        return bad('O texto da mensagem livre não pode estar vazio.');
      }

      try {
        const result = await sendMessageToConversation(supabase, accountId, {
          conversationId: suggestion.conversation_id,
          messageType: 'text',
          contentText,
          senderId: userId,
          clientRef,
        });
        sentMessageId = result.messageId;
        whatsappMessageId = result.whatsappMessageId;
        realizedMessageText = contentText;
      } catch (err) {
        if (err instanceof SendMessageError) {
          return bad(err.message, err.status, {
            code: err.code === 'session_expired' ? 'window_expired' : err.code,
            sessionWindowOpen: err.code === 'session_expired' ? false : sessionStatus.windowOpen,
          });
        }
        throw err;
      }
    } else {
      // mode === 'template': EXCLUSIVAMENTE match_imovel_personalizado com 1 imóvel
      if (selectedProperties.length !== 1) {
        return bad(
          'Com a janela encerrada, selecione exatamente um imóvel para envio pelo template match_imovel_personalizado.',
          422,
          { code: 'single_property_required' }
        );
      }

      const requestedTemplateName =
        typeof body.template_name === 'string' && body.template_name.trim()
          ? body.template_name.trim()
          : FOLLOWUP_REQUIRED_TEMPLATE_NAME;

      if (requestedTemplateName !== FOLLOWUP_REQUIRED_TEMPLATE_NAME) {
        return bad(
          `Fora da janela de 24h, o fluxo de Follow-up permite exclusivamente o template "${FOLLOWUP_REQUIRED_TEMPLATE_NAME}".`,
          422,
          { code: 'invalid_template_name' }
        );
      }

      const { data: templateRows, error: tmplErr } = await supabase
        .from('message_templates')
        .select('*')
        .eq('account_id', accountId)
        .eq('name', FOLLOWUP_REQUIRED_TEMPLATE_NAME);

      if (tmplErr) {
        return bad('Falha ao consultar o template match_imovel_personalizado.', 500);
      }

      const approvedTemplate = ((templateRows || []) as MessageTemplate[]).find(
        (t) => String(t.status || '').toUpperCase() === 'APPROVED'
      );

      if (!approvedTemplate) {
        const existing = ((templateRows || []) as MessageTemplate[])[0];
        return bad(
          `O template obrigatório "${FOLLOWUP_REQUIRED_TEMPLATE_NAME}" não está aprovado pela Meta para envio (${existing ? `status atual: ${existing.status}` : 'não cadastrado'}).`,
          422,
          { code: 'template_not_approved' }
        );
      }

      const bodyValues = Array.isArray(body.body_values)
        ? body.body_values.map((v: unknown) => (typeof v === 'string' ? v.trim() : ''))
        : [];
      const targetProp = selectedProperties[0];
      const buttonUrlSuffix =
        typeof body.button_url_suffix === 'string' && body.button_url_suffix.trim()
          ? body.button_url_suffix.trim()
          : extractPropertyUrlSlug(targetProp.publicUrl);

      if (!buttonUrlSuffix) {
        return bad(
          'Não foi possível extrair o identificador do link público do imóvel para o botão do template.',
          422,
          { code: 'invalid_property_url' }
        );
      }

      const validation = validateApprovedTemplateSubmission(approvedTemplate, bodyValues, null);
      if (!validation.valid) {
        return bad(
          validation.reason || 'Variáveis obrigatórias do template ausentes ou inválidas.',
          422,
          { code: 'template_validation_failed' }
        );
      }

      const buttons = Array.isArray(approvedTemplate.buttons)
        ? (approvedTemplate.buttons as TemplateButton[])
        : [];
      const urlButtonIdx = buttons.findIndex(
        (b) => b.type === 'URL' && typeof b.url === 'string' && b.url.includes('{{')
      );
      const buttonParams: Record<number, string> =
        urlButtonIdx >= 0 ? { [urlButtonIdx]: buttonUrlSuffix } : { 0: buttonUrlSuffix };

      const renderedBody = renderApprovedTemplatePreview(
        approvedTemplate.body_text,
        bodyValues
      );

      // Enrich property snapshot (best-effort) with cover photo, neighborhood, city, and bedrooms
      let snapshotCoverUrl: string | null = null;
      let snapshotNeighborhood: string | null = null;
      let snapshotCity: string | null = null;
      let snapshotBedroomsLabel: string | null = null;
      try {
        const canonicalPropId = ensurePropertyUuid(targetProp.propertyId);
        const { data: proj } = await supabase
          .from('property_match_projections')
          .select('cover_url, neighborhood, city, bedrooms_min, bedrooms_max')
          .eq('account_id', accountId)
          .eq('property_id', canonicalPropId)
          .maybeSingle();
        if (proj) {
          snapshotCoverUrl = (proj.cover_url as string | null) ?? null;
          snapshotNeighborhood = (proj.neighborhood as string | null) ?? null;
          snapshotCity = (proj.city as string | null) ?? null;
          const bMin = typeof proj.bedrooms_min === 'number' ? proj.bedrooms_min : null;
          const bMax = typeof proj.bedrooms_max === 'number' ? proj.bedrooms_max : null;
          if (bMin && bMax && bMin !== bMax) {
            snapshotBedroomsLabel = `${bMin} a ${bMax} quartos`;
          } else if (bMax && bMax > 0) {
            snapshotBedroomsLabel = bMax === 1 ? '1 quarto' : `${bMax} quartos`;
          } else if (bMin && bMin > 0) {
            snapshotBedroomsLabel = bMin === 1 ? '1 quarto' : `${bMin} quartos`;
          }
        }
      } catch {
        // Non-blocking enrichment; never fail send if projection lookup fails
      }

      try {
        const result = await sendMessageToConversation(supabase, accountId, {
          conversationId: suggestion.conversation_id,
          messageType: 'template',
          contentText: renderedBody,
          templateName: approvedTemplate.name,
          templateLanguage: approvedTemplate.language || 'pt_BR',
          templateParams: bodyValues,
          templateMessageParams: {
            body: bodyValues,
            buttonParams,
          },
          templateProperty: {
            id: targetProp.propertyId,
            title: targetProp.title,
            public_url: targetProp.publicUrl,
            match_id: targetProp.matchId ?? null,
            cover_url: snapshotCoverUrl,
            neighborhood: snapshotNeighborhood,
            city: snapshotCity,
            bedrooms_label: snapshotBedroomsLabel,
          },
          senderId: userId,
          clientRef,
        });
        sentMessageId = result.messageId;
        whatsappMessageId = result.whatsappMessageId;
        realizedTemplateName = approvedTemplate.name;
        realizedMessageText = renderedBody;
      } catch (err) {
        if (err instanceof SendMessageError) {
          return bad(err.message, err.status, { code: err.code });
        }
        throw err;
      }
    }

    // Somente após o envio ser confirmado pela Meta: conclui o follow-up e registra imóveis enviados
    const nowIso = new Date().toISOString();
    const existingPayload = (suggestion.payload ?? {}) as Record<string, unknown>;

    const { error: updateErr } = await supabase
      .from('ai_suggestions')
      .update({
        status: 'done',
        resolved_by: userId,
        resolved_at: nowIso,
        snoozed_until: null,
        payload: {
          ...existingPayload,
          realized_mode: mode === 'free' ? 'free_crm' : 'template_crm',
          realized_message: realizedMessageText,
          realized_template_name: realizedTemplateName,
          realized_properties: selectedProperties.map((p) => ({
            propertyId: p.propertyId,
            matchId: p.matchId ?? null,
            title: p.title,
            publicUrl: p.publicUrl,
          })),
          realized_at: nowIso,
          realized_manual: false,
          realized_message_id: sentMessageId,
        },
      })
      .eq('id', id)
      .eq('account_id', accountId);

    if (updateErr) {
      console.error('[followup/send] failed to mark suggestion done after send:', updateErr);
    }

    // Registra property_shares e marca os matches como 'enviado' (best-effort)
    for (const prop of selectedProperties) {
      try {
        const canonicalPropertyId = ensurePropertyUuid(prop.propertyId);
        await supabase.from('property_shares').insert({
          account_id: accountId,
          lead_id: suggestion.contact_id,
          property_id: canonicalPropertyId,
          match_id: prop.matchId ?? null,
          tracking_token: generateTrackingToken(),
          channel: mode === 'template' ? 'whatsapp_template_followup' : 'whatsapp_followup',
          message_text: realizedMessageText,
          sent_at: nowIso,
        });

        if (prop.matchId) {
          await updateMatchStatus(supabase, accountId, prop.matchId, 'enviado');
        } else {
          await supabase
            .from('lead_property_matches')
            .update({
              match_status: 'enviado',
              sent_at: nowIso,
              updated_at: nowIso,
            })
            .eq('account_id', accountId)
            .eq('lead_id', suggestion.contact_id)
            .in('property_id', [canonicalPropertyId, prop.propertyId]);
        }
      } catch (shareErr) {
        console.error('[followup/send] property_share registration error:', shareErr);
      }
    }

    return NextResponse.json({
      success: true,
      message_id: sentMessageId,
      whatsapp_message_id: whatsappMessageId,
      mode,
      template_name: realizedTemplateName,
      sent_properties: selectedProperties.map((p) => p.propertyId),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
