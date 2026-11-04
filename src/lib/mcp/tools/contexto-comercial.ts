// ============================================================
// Tool: obter_contexto_comercial_lead
// Recupera o entendimento comercial já interpretado pela Clara
// Prioriza lead_intelligence.summary sem reler histórico
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import type { McpContext, ToolExecutionResult } from '../types';

export interface ContextoComercialParams {
  lead_id: string;
}

export async function executeObterContextoComercial(
  db: SupabaseClient,
  context: McpContext,
  params: ContextoComercialParams
): Promise<ToolExecutionResult> {
  const accountId = context.accountId;
  const leadId = (params.lead_id || '').trim();

  if (!leadId) {
    throw new Error('Parâmetro lead_id é obrigatório.');
  }

  // 1. Busca dados cadastrais e conversa associada
  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select(`
      id,
      name,
      phone,
      ai_score,
      ai_score_reason,
      paused_at,
      archived_at,
      created_at
    `)
    .eq('id', leadId)
    .eq('account_id', accountId)
    .maybeSingle();

  if (contactErr || !contact) {
    throw new Error(`Lead não encontrado ou não pertence a esta conta: ${leadId}`);
  }

  // 2. Busca em paralelo: conversa, inteligência da Clara, negócio no pipeline, compromissos e último share
  const [
    { data: conv },
    { data: intel },
    { data: deal },
    { data: actionItems },
    { data: appointments },
    { data: latestShare },
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
        ai_transfer_status,
        ai_transfer_reason
      `)
      .eq('contact_id', leadId)
      .eq('account_id', accountId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    db
      .from('lead_intelligence')
      .select('summary, last_analyzed_at, last_message_id')
      .eq('contact_id', leadId)
      .maybeSingle(),
    db
      .from('deals')
      .select('id, stage_id, status, pipeline_stages(id, name)')
      .eq('contact_id', leadId)
      .eq('account_id', accountId)
      .eq('status', 'open')
      .order('created_at', { ascending: true })
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
      .select('id, title, description, scheduled_date, scheduled_time, status, notes')
      .eq('contact_id', leadId)
      .eq('account_id', accountId)
      .eq('status', 'scheduled')
      .order('scheduled_date', { ascending: true }),
    db
      .from('property_shares')
      .select('property_id, sent_at, open_count, is_interested')
      .eq('lead_id', leadId)
      .eq('account_id', accountId)
      .order('sent_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  // 3. Resolve nome do responsável humano
  let assignedAgent: { id: string; nome: string; email: string } | null = null;
  if (conv?.assigned_agent_id) {
    const { data: profile } = await db
      .from('profiles')
      .select('id, full_name, email')
      .eq('id', conv.assigned_agent_id)
      .maybeSingle();
    if (profile) {
      assignedAgent = { id: profile.id, nome: profile.full_name, email: profile.email };
    }
  }

  // 4. Analisa estado do resumo estruturado da Clara
  const rawSummary = (intel?.summary as Record<string, unknown>) || {};
  const hasSummary = Object.keys(rawSummary).length > 0;

  let resumoStatus: 'atualizado' | 'desatualizado' | 'ausente' = 'ausente';
  let novasMensagensContagem = 0;

  if (!hasSummary) {
    resumoStatus = 'ausente';
  } else {
    const lastMsgDate = conv?.last_message_at ? new Date(conv.last_message_at) : null;
    const lastAnalyzed = intel?.last_analyzed_at ? new Date(intel.last_analyzed_at) : null;

    if (lastMsgDate && lastAnalyzed && lastMsgDate > lastAnalyzed) {
      resumoStatus = 'desatualizado';
      // Conta quantas mensagens novas chegaram após a última análise
      if (conv?.id && intel?.last_analyzed_at) {
        const { count } = await db
          .from('messages')
          .select('id', { count: 'exact', head: true })
          .eq('conversation_id', conv.id)
          .gt('created_at', intel.last_analyzed_at);
        novasMensagensContagem = count || 1;
      }
    } else {
      resumoStatus = 'atualizado';
    }
  }

  const payload = {
    ok: true,
    lead: {
      id: contact.id,
      nome: contact.name || 'Lead sem nome',
      telefone: contact.phone,
      etapa_pipeline: (deal as any)?.pipeline_stages?.name || 'Novo Lead',
      deal_id: deal?.id || null,
      responsavel: assignedAgent,
      atendimento_humano_ativo: conv?.ai_autoreply_disabled === true,
      needs_review: conv?.needs_review === true,
      bloqueios: {
        pausado: contact.paused_at !== null,
        pausado_em: contact.paused_at,
        arquivado: contact.archived_at !== null,
        arquivado_em: contact.archived_at,
      },
    },
    resumo_inteligencia: {
      status: resumoStatus,
      ultima_analise_em: intel?.last_analyzed_at || null,
      mensagens_novas_pendentes_analise: novasMensagensContagem,
      alerta_desatualizacao:
        resumoStatus === 'desatualizado'
          ? `Há ${novasMensagensContagem} nova(s) mensagem(ns) após a última análise da Clara. Use obter_contexto_recente se houver ambiguidade.`
          : null,
      finalidade: rawSummary.purpose || [],
      tipologia: rawSummary.property_type || [],
      localizacao: rawSummary.location || [],
      orcamento: {
        minimo: rawSummary.price_min ?? null,
        maximo: rawSummary.price_max ?? null,
        teto_flexivel: rawSummary.price_flex_max ?? null,
      },
      quartos: rawSummary.bedrooms || [],
      diferenciais: rawSummary.features || [],
      perfil: rawSummary.profile || [],
      intencao: rawSummary.intent || null,
      momento_compra_ou_etapa: rawSummary.stage_signal || null,
      notas_comerciais: rawSummary.notes || null,
      requisitos_obrigatorios: rawSummary.requirements || null,
      preferencias_flexiveis: rawSummary.preferences || null,
    },
    score_comercial: {
      valor: contact.ai_score ?? null,
      justificativa: contact.ai_score_reason || null,
    },
    compromissos_retorno: {
      followups_pendentes: (actionItems || []).map((a) => ({
        id: a.id,
        tipo: a.type,
        titulo: a.title,
        data_limite: a.due_date,
        hora_limite: a.due_time,
      })),
      agendamentos: (appointments || []).map((ap) => ({
        id: ap.id,
        titulo: ap.title,
        data: ap.scheduled_date,
        hora: ap.scheduled_time,
        notas: ap.notes,
      })),
    },
    historico_compartilhamento: {
      ultimo_imovel: latestShare
        ? {
            property_id: latestShare.property_id,
            enviado_em: latestShare.sent_at,
            visualizacoes: latestShare.open_count,
            marcou_interesse: latestShare.is_interested,
          }
        : null,
    },
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
