// ============================================================
// Tool: consultar_estado_lead
// Consulta a situação operacional completa do lead antes de
// qualquer ação comercial ou recomendação
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import type { McpContext, ToolExecutionResult } from '../types';

export interface ConsultarEstadoParams {
  lead_id: string;
}

export async function executeConsultarEstado(
  db: SupabaseClient,
  context: McpContext,
  params: ConsultarEstadoParams
): Promise<ToolExecutionResult> {
  const accountId = context.accountId;
  const leadId = (params.lead_id || '').trim();

  if (!leadId) {
    throw new Error('Parâmetro lead_id é obrigatório.');
  }

  // 1. Busca contato
  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select(`
      id,
      name,
      phone,
      ai_score,
      paused_at,
      archived_at,
      created_at,
      updated_at
    `)
    .eq('id', leadId)
    .eq('account_id', accountId)
    .maybeSingle();

  if (contactErr || !contact) {
    throw new Error(`Lead não encontrado: ${leadId}`);
  }

  // 2. Busca conversa, deal, follow-ups e histórico de shares
  const [
    { data: conv },
    { data: deal },
    { data: actionItems },
    { data: appointments },
    { data: recentShares },
  ] = await Promise.all([
    db
      .from('conversations')
      .select(`
        id,
        status,
        assigned_agent_id,
        last_message_text,
        last_message_at,
        unread_count,
        ai_autoreply_disabled,
        needs_review,
        last_reviewed_at,
        last_reviewed_by,
        ai_transfer_status,
        ai_transfer_reason,
        ai_transfer_boundary_type,
        ai_transfer_at
      `)
      .eq('contact_id', leadId)
      .eq('account_id', accountId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    db
      .from('deals')
      .select('id, stage_id, status, pipeline_stages(id, name, position)')
      .eq('contact_id', leadId)
      .eq('account_id', accountId)
      .eq('status', 'open')
      .limit(1)
      .maybeSingle(),
    db
      .from('action_items')
      .select('id, type, title, description, due_date, due_time, status')
      .eq('contact_id', leadId)
      .eq('account_id', accountId)
      .eq('status', 'pending')
      .order('due_date', { ascending: true }),
    db
      .from('appointments')
      .select('id, title, scheduled_date, scheduled_time, status')
      .eq('contact_id', leadId)
      .eq('account_id', accountId)
      .eq('status', 'scheduled'),
    db
      .from('property_shares')
      .select(`
        id,
        property_id,
        sent_at,
        open_count,
        first_opened_at,
        last_opened_at,
        is_interested,
        message_text
      `)
      .eq('lead_id', leadId)
      .eq('account_id', accountId)
      .order('sent_at', { ascending: false })
      .limit(5),
  ]);

  // 3. Resolve atendente e revisor
  let assignedAgent: { id: string; nome: string; email: string } | null = null;
  let reviewedBy: { id: string; nome: string } | null = null;

  const agentIdsToLookup = [conv?.assigned_agent_id, conv?.last_reviewed_by].filter(Boolean) as string[];
  if (agentIdsToLookup.length > 0) {
    const { data: profiles } = await db
      .from('profiles')
      .select('id, full_name, email')
      .in('id', agentIdsToLookup);
    const pMap = new Map((profiles || []).map((p) => [p.id, p]));
    if (conv?.assigned_agent_id && pMap.has(conv.assigned_agent_id)) {
      const a = pMap.get(conv.assigned_agent_id)!;
      assignedAgent = { id: a.id, nome: a.full_name, email: a.email };
    }
    if (conv?.last_reviewed_by && pMap.has(conv.last_reviewed_by)) {
      const r = pMap.get(conv.last_reviewed_by)!;
      reviewedBy = { id: r.id, nome: r.full_name };
    }
  }

  // 4. Calcula regra de cadência (cooldown de 5 dias)
  const now = new Date();
  const cincoDiasAtras = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);
  const latestShare = (recentShares || [])[0];

  const shareNosUltimos5Dias = latestShare?.sent_at
    ? new Date(latestShare.sent_at) > cincoDiasAtras
    : false;

  const msgNosUltimos5Dias = conv?.last_message_at
    ? new Date(conv.last_message_at) > cincoDiasAtras
    : false;

  const payload = {
    ok: true,
    lead: {
      id: contact.id,
      nome: contact.name || 'Lead sem nome',
      telefone: contact.phone,
      score_ia: contact.ai_score,
      criado_em: contact.created_at,
      atualizado_em: contact.updated_at,
    },
    pipeline: {
      deal_id: deal?.id || null,
      etapa_atual: (deal as any)?.pipeline_stages?.name || 'Novo Lead',
      etapa_posicao: (deal as any)?.pipeline_stages?.position ?? 0,
    },
    atendimento: {
      responsavel: assignedAgent,
      atendimento_humano_ativo: conv?.ai_autoreply_disabled === true,
      conversa_status: conv?.status || 'inexistente',
      mensagens_nao_lidas: conv?.unread_count || 0,
      ultima_interacao_em: conv?.last_message_at || null,
      ultimo_texto_resumo: conv?.last_message_text || null,
    },
    supervisao: {
      needs_review: conv?.needs_review === true,
      ultima_revisao_em: conv?.last_reviewed_at || null,
      revisado_por: reviewedBy,
      handoff_status: conv?.ai_transfer_status || 'none',
      handoff_motivo: conv?.ai_transfer_reason || null,
      handoff_tipo_fronteira: conv?.ai_transfer_boundary_type || null,
      handoff_em: conv?.ai_transfer_at || null,
    },
    bloqueios_e_cadencia: {
      pausado_manualmente: contact.paused_at !== null,
      pausado_em: contact.paused_at,
      arquivado: contact.archived_at !== null,
      arquivado_em: contact.archived_at,
      cooldown_5_dias_ativo: shareNosUltimos5Dias,
      motivo_cooldown: shareNosUltimos5Dias
        ? 'Um imóvel já foi compartilhado nos últimos 5 dias. Não enviar novo imóvel antes de interação do lead.'
        : null,
      teve_mensagem_ultimos_5_dias: msgNosUltimos5Dias,
    },
    agenda_e_followups: {
      pendencias_count: (actionItems || []).length,
      itens_pendentes: (actionItems || []).map((a) => ({
        id: a.id,
        tipo: a.type,
        titulo: a.title,
        data_limite: a.due_date,
        hora_limite: a.due_time,
      })),
      agendamentos_ativos: (appointments || []).map((ap) => ({
        id: ap.id,
        titulo: ap.title,
        data: ap.scheduled_date,
        hora: ap.scheduled_time,
      })),
    },
    historico_imoveis_apresentados: (recentShares || []).map((s) => ({
      share_id: s.id,
      property_id: s.property_id,
      enviado_em: s.sent_at,
      visualizacoes: s.open_count,
      primeira_abertura_em: s.first_opened_at,
      ultima_abertura_em: s.last_opened_at,
      marcou_interesse: s.is_interested,
    })),
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
