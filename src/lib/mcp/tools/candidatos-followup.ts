// ============================================================
// Tool: obter_candidatos_followup_matinal
// Seleciona leads elegíveis para avaliação comercial matinal
// com respeito estrito à cadência, sem exclusão cega de humanos
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import type { McpContext, ToolExecutionResult } from '../types';

export interface CandidatosFollowupParams {
  limite?: number;
  cursor?: string | null;
  apenas_com_resumo?: boolean;
  responsavel_email?: string | null;
  somente_pendencias_hoje?: boolean;
}

export async function executeObterCandidatosFollowup(
  db: SupabaseClient,
  context: McpContext,
  params: CandidatosFollowupParams = {}
): Promise<ToolExecutionResult> {
  const accountId = context.accountId;
  const limit = Math.min(Math.max(params.limite ?? 20, 1), 50);

  // Decodifica cursor simples (data ISO de corte)
  let cursorTimestamp: string | null = null;
  if (params.cursor) {
    try {
      const decoded = Buffer.from(params.cursor, 'base64').toString('utf-8');
      if (decoded.includes(':')) {
        cursorTimestamp = decoded.split(':')[1];
      }
    } catch {
      cursorTimestamp = null;
    }
  }

  // 1. Resolve usuário responsável se especificado por email
  let filterAgentId: string | null = null;
  if (params.responsavel_email) {
    const { data: agentProfile } = await db
      .from('profiles')
      .select('id')
      .eq('account_id', accountId)
      .eq('email', params.responsavel_email.trim().toLowerCase())
      .maybeSingle();
    filterAgentId = agentProfile?.id || null;
  }

  // 2. Busca conversas abertas e contatos ativos da conta
  let query = db
    .from('conversations')
    .select(`
      id,
      contact_id,
      status,
      assigned_agent_id,
      last_message_text,
      last_message_at,
      unread_count,
      ai_autoreply_disabled,
      needs_review,
      contacts!inner(
        id,
        name,
        phone,
        ai_score,
        paused_at,
        archived_at
      )
    `)
    .eq('account_id', accountId)
    .eq('status', 'open')
    .is('contacts.archived_at', null)
    .is('contacts.paused_at', null)
    .order('last_message_at', { ascending: false })
    .limit(limit * 2); // Busca margem para aplicar filtros de negócio e paginação

  if (cursorTimestamp) {
    query = query.lt('last_message_at', cursorTimestamp);
  }

  if (filterAgentId) {
    query = query.eq('assigned_agent_id', filterAgentId);
  }

  const { data: convRows, error: convErr } = await query;
  if (convErr) {
    throw new Error(`Falha ao buscar conversas para follow-up: ${convErr.message}`);
  }

  const contactIds = (convRows || []).map((r) => r.contact_id as string);
  if (contactIds.length === 0) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              ok: true,
              candidatos: [],
              total: 0,
              proximo_cursor: null,
              mensagem: 'Nenhum lead elegível para follow-up matinal no momento.',
            },
            null,
            2
          ),
        },
      ],
      structuredContent: { ok: true, candidatos: [], total: 0 },
    };
  }

  // 3. Busca em paralelo: inteligência (Clara), follow-ups agendados, compromissos e último share
  const [
    { data: intelligenceRows },
    { data: actionItemsRows },
    { data: appointmentRows },
    { data: sharesRows },
    { data: dealsRows },
    { data: profilesRows },
  ] = await Promise.all([
    db
      .from('lead_intelligence')
      .select('contact_id, summary, last_analyzed_at')
      .in('contact_id', contactIds),
    db
      .from('action_items')
      .select('contact_id, type, status, title, due_date, due_time')
      .eq('account_id', accountId)
      .eq('status', 'pending')
      .in('contact_id', contactIds),
    db
      .from('appointments')
      .select('contact_id, title, scheduled_date, scheduled_time, status')
      .eq('account_id', accountId)
      .eq('status', 'scheduled')
      .in('contact_id', contactIds),
    db
      .from('property_shares')
      .select('lead_id, sent_at, open_count, is_interested')
      .eq('account_id', accountId)
      .in('lead_id', contactIds)
      .order('sent_at', { ascending: false }),
    db
      .from('deals')
      .select('contact_id, stage_id, status, pipeline_stages(name)')
      .eq('account_id', accountId)
      .eq('status', 'open')
      .in('contact_id', contactIds),
    db
      .from('profiles')
      .select('id, full_name, email')
      .eq('account_id', accountId),
  ]);

  const intelMap = new Map((intelligenceRows || []).map((i) => [i.contact_id, i]));
  const actionMap = new Map<string, typeof actionItemsRows>();
  for (const a of actionItemsRows || []) {
    const list = actionMap.get(a.contact_id) || [];
    list.push(a);
    actionMap.set(a.contact_id, list);
  }

  const apptMap = new Map<string, typeof appointmentRows>();
  for (const ap of appointmentRows || []) {
    const list = apptMap.get(ap.contact_id) || [];
    list.push(ap);
    apptMap.set(ap.contact_id, list);
  }

  type ShareRow = { lead_id: string; sent_at: string; open_count: number; is_interested: boolean | null };
  const sharesMap = new Map<string, ShareRow>();
  for (const s of (sharesRows || []) as ShareRow[]) {
    if (!sharesMap.has(s.lead_id)) {
      sharesMap.set(s.lead_id, s);
    }
  }

  const dealMap = new Map((dealsRows || []).map((d) => [d.contact_id, d]));
  const profileMap = new Map((profilesRows || []).map((p) => [p.id, p]));

  const now = new Date();
  const cincoDiasAtras = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);
  const candidatos: Array<Record<string, unknown>> = [];

  for (const conv of convRows || []) {
    const contact = (conv as any).contacts;
    if (!contact) continue;

    const intel = intelMap.get(contact.id);
    const summary = intel?.summary as Record<string, unknown> | null;
    const hasSummary = summary && Object.keys(summary).length > 0;

    if (params.apenas_com_resumo && !hasSummary) {
      continue;
    }

    const lastMsgDate = conv.last_message_at ? new Date(conv.last_message_at) : null;
    const actions = actionMap.get(contact.id) || [];
    const appointments = apptMap.get(contact.id) || [];
    const latestShare = sharesMap.get(contact.id);
    const deal = dealMap.get(contact.id);
    const assignedAgent = conv.assigned_agent_id ? profileMap.get(conv.assigned_agent_id) : null;

    // Checa compromissos pendentes para hoje ou atrasados
    const hojeIso = now.toISOString().slice(0, 10);
    const hasPendingFollowupToday = actions.some(
      (a) => a.due_date && a.due_date <= hojeIso
    );
    const hasAppointmentToday = appointments.some(
      (ap) => ap.scheduled_date && ap.scheduled_date <= hojeIso
    );

    if (params.somente_pendencias_hoje && !hasPendingFollowupToday && !hasAppointmentToday) {
      continue;
    }

    // Identifica cadência e elegibilidade de contato:
    // Se houve share nos últimos 5 dias e sem interação posterior, respeita cooldown
    const shareRecente = latestShare?.sent_at ? new Date(latestShare.sent_at) > cincoDiasAtras : false;

    let motivoElegibilidade = 'avaliacao_geral';
    let prioridade: 'alta' | 'media' | 'baixa' = 'media';
    let elegivelParaEnvio = true;
    let motivoBloqueioEnvio: string | null = null;

    if (hasPendingFollowupToday || hasAppointmentToday) {
      motivoElegibilidade = 'compromisso_agendado_para_hoje';
      prioridade = 'alta';
    } else if (lastMsgDate && lastMsgDate > cincoDiasAtras) {
      // Mensagem trocada recentemente
      motivoElegibilidade = 'conversa_recente_em_andamento';
      prioridade = 'alta';
    } else if (lastMsgDate && lastMsgDate <= cincoDiasAtras) {
      // Mais de 5 dias sem mensagens
      motivoElegibilidade = 'reengajamento_apos_cooldown_5_dias';
      prioridade = 'media';
    }

    if (shareRecente) {
      elegivelParaEnvio = false;
      motivoBloqueioEnvio = 'Imóvel já compartilhado nos últimos 5 dias. Aguardando reação do lead.';
    }

    // Status do resumo da Clara
    let resumoStatus: 'atualizado' | 'desatualizado' | 'ausente' = 'ausente';
    if (hasSummary) {
      const lastAnalyzed = intel?.last_analyzed_at ? new Date(intel.last_analyzed_at) : null;
      if (lastMsgDate && lastAnalyzed && lastMsgDate > lastAnalyzed) {
        resumoStatus = 'desatualizado';
      } else {
        resumoStatus = 'atualizado';
      }
    }

    const candidatoItem = {
      lead_id: contact.id,
      nome: contact.name || 'Lead sem nome',
      telefone: contact.phone,
      etapa_atual: (deal as any)?.pipeline_stages?.name || 'Sem Etapa',
      responsavel: assignedAgent
        ? { id: assignedAgent.id, nome: assignedAgent.full_name, email: assignedAgent.email }
        : null,
      atendimento_humano_ativo: conv.ai_autoreply_disabled === true,
      needs_review: conv.needs_review === true,
      score_ia: contact.ai_score ?? null,
      ultima_interacao_em: conv.last_message_at,
      ultimo_texto_resumo: conv.last_message_text,
      motivo_elegibilidade: motivoElegibilidade,
      prioridade,
      elegivel_para_envio_imediato: elegivelParaEnvio,
      motivo_bloqueio_envio: motivoBloqueioEnvio,
      resumo_clara_status: resumoStatus,
      compromissos_pendentes: {
        followups_count: actions.length,
        tem_pendencia_hoje: hasPendingFollowupToday,
        agendamentos_count: appointments.length,
        tem_agendamento_hoje: hasAppointmentToday,
      },
      ultimo_imovel_compartilhado: latestShare
        ? {
            enviado_em: latestShare.sent_at,
            visualizacoes: latestShare.open_count,
            marcou_interesse: latestShare.is_interested,
          }
        : null,
      autorizacao_disparo_exigida: 'Aprovação expressa de Thatianna necessária antes do envio',
    };

    candidatos.push(candidatoItem);

    if (candidatos.length >= limit) {
      break;
    }
  }

  // Gera próximo cursor estável
  let proximoCursor: string | null = null;
  if (candidatos.length > 0 && convRows && convRows.length > candidatos.length) {
    const ultimo = candidatos[candidatos.length - 1];
    proximoCursor = Buffer.from(`cur:${ultimo.ultima_interacao_em}:${ultimo.lead_id}`).toString('base64');
  }

  const payload = {
    ok: true,
    total_retornados: candidatos.length,
    limite: limit,
    proximo_cursor: proximoCursor,
    candidatos,
  };

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload, null, 2),
      },
    ],
    structuredContent: payload,
  };
}
