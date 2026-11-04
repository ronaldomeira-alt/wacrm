// ============================================================
// Tool: obter_contexto_recente
// Consulta trecho cirúrgico de mensagens recentes para
// resolver ambiguidades ou contradições pontuais
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import type { McpContext, ToolExecutionResult } from '../types';

export interface ContextoRecenteParams {
  lead_id: string;
  limite?: number;
}

export async function executeObterContextoRecente(
  db: SupabaseClient,
  context: McpContext,
  params: ContextoRecenteParams
): Promise<ToolExecutionResult> {
  const accountId = context.accountId;
  const leadId = (params.lead_id || '').trim();
  const limit = Math.min(Math.max(params.limite ?? 10, 1), 30);

  if (!leadId) {
    throw new Error('Parâmetro lead_id é obrigatório.');
  }

  // 1. Localiza a conversa aberta ou mais recente do contato
  const { data: conv, error: convErr } = await db
    .from('conversations')
    .select('id, status, assigned_agent_id')
    .eq('contact_id', leadId)
    .eq('account_id', accountId)
    .order('last_message_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (convErr || !conv) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              ok: true,
              lead_id: leadId,
              mensagens: [],
              total: 0,
              aviso: 'Nenhuma conversa localizada para este lead.',
            },
            null,
            2
          ),
        },
      ],
      structuredContent: { ok: true, lead_id: leadId, mensagens: [], total: 0 },
    };
  }

  // 2. Busca mensagens ordenadas por data (mais recentes)
  const { data: msgRows, error: msgErr } = await db
    .from('messages')
    .select(`
      id,
      sender_type,
      content_type,
      content_text,
      transcript_text,
      private,
      created_at
    `)
    .eq('conversation_id', conv.id)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (msgErr) {
    throw new Error(`Falha ao ler mensagens recentes: ${msgErr.message}`);
  }

  // Reverte para ordem cronológica de leitura humana
  const chronological = (msgRows || []).reverse();

  const mensagensFormatadas = chronological.map((m) => {
    let origem: 'cliente' | 'clara' | 'atendente_humano' = 'cliente';
    if (m.sender_type === 'bot') {
      origem = 'clara';
    } else if (m.sender_type === 'agent') {
      origem = 'atendente_humano';
    }

    const textoFinal = m.content_type === 'audio' && m.transcript_text
      ? `[Áudio Transcrito]: ${m.transcript_text}`
      : m.content_text || (m.content_type === 'audio' ? '[Áudio sem transcrição]' : `[Mídia: ${m.content_type}]`);

    return {
      id: m.id,
      origem,
      remetente_tipo: m.sender_type,
      tipo_conteudo: m.content_type,
      texto: textoFinal,
      is_nota_interna: m.private === true,
      enviado_em: m.created_at,
    };
  });

  const payload = {
    ok: true,
    lead_id: leadId,
    conversation_id: conv.id,
    total_mensagens: mensagensFormatadas.length,
    limite: limit,
    mensagens: mensagensFormatadas,
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
