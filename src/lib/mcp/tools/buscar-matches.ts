// ============================================================
// Tool: buscar_matches_lead
// Consulta correspondências calculadas pelo Match do WACRM
// Leitura estrita — sem recálculo e sem gerar links rastreados
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import type { McpContext, ToolExecutionResult } from '../types';

export interface BuscarMatchesParams {
  lead_id: string;
  score_minimo?: number;
  incluir_suprimidos?: boolean;
  limite?: number;
}

export async function executeBuscarMatches(
  db: SupabaseClient,
  context: McpContext,
  params: BuscarMatchesParams
): Promise<ToolExecutionResult> {
  const accountId = context.accountId;
  const leadId = (params.lead_id || '').trim();
  const minScore = params.score_minimo ?? 50;
  const limit = Math.min(Math.max(params.limite ?? 10, 1), 30);
  const includeSuppressed = params.incluir_suprimidos === true;

  if (!leadId) {
    throw new Error('Parâmetro lead_id é obrigatório.');
  }

  // 1. Consulta matches existentes na conta para o lead informado
  let query = db
    .from('lead_property_matches')
    .select(`
      id,
      property_id,
      match_score,
      score_breakdown,
      profile_maturity,
      commercial_priority,
      match_status,
      suppressed,
      origin,
      sent_at,
      created_at,
      updated_at,
      property_match_projections!inner(
        id,
        code,
        title,
        operation,
        property_type,
        neighborhood,
        city,
        price_min,
        price_max,
        area_min,
        area_max,
        bedrooms_min,
        bedrooms_max,
        delivery_status,
        delivery_deadline,
        features,
        cover_url,
        status
      )
    `)
    .eq('account_id', accountId)
    .eq('lead_id', leadId)
    .gte('match_score', minScore);

  if (!includeSuppressed) {
    query = query.eq('suppressed', false);
  }

  const { data: rows, error } = await query
    .order('match_score', { ascending: false })
    .limit(limit);
  if (error) {
    throw new Error(`Falha ao buscar matches do lead: ${error.message}`);
  }

  const matchesFormatados = (rows || []).map((r) => {
    const prop = (r as any).property_match_projections;
    const breakdown = (r.score_breakdown as Record<string, unknown>) || {};

    return {
      match_id: r.id,
      property_id: r.property_id,
      // Código e identificador para busca no MCP Meus Imóveis (obter_empreendimento)
      codigo_meus_imoveis: prop?.code || r.property_id,
      titulo: prop?.title || 'Imóvel sem título',
      score: r.match_score,
      score_classificacao:
        r.match_score >= 80 ? 'forte' : r.match_score >= 70 ? 'medio' : 'fraco',
      status_match: r.match_status,
      suprimido: r.suppressed,
      imovel: {
        tipo: prop?.property_type,
        operacao: prop?.operation,
        bairro: prop?.neighborhood,
        cidade: prop?.city,
        preco_minimo: prop?.price_min,
        preco_maximo: prop?.price_max,
        area_privativa: {
          min_m2: prop?.area_min,
          max_m2: prop?.area_max,
        },
        quartos: {
          min: prop?.bedrooms_min,
          max: prop?.bedrooms_max,
        },
        fase_obra: prop?.delivery_status,
        previsao_entrega: prop?.delivery_deadline,
        diferenciais: prop?.features || [],
        foto_capa_url: prop?.cover_url,
        status_estoque: prop?.status,
        link_previa_meus_imoveis: prop?.code
          ? `https://ronaldomeira.com.br/imovel/${prop.code}`
          : `https://ronaldomeira.com.br/imovel/${r.property_id}`,
      },
      justificativa_match: {
        motivos: breakdown.reasons || [],
        penalidades: breakdown.penalties || [],
        pontos_detalhados: {
          preco: breakdown.price,
          localizacao: breakdown.location,
          tipologia: breakdown.propertyType,
          quartos: breakdown.bedrooms,
          finalidade: breakdown.purpose,
          prazo: breakdown.delivery,
        },
      },
      enviado_anteriormente_em: r.sent_at,
      atualizado_em: r.updated_at,
    };
  });

  const payload = {
    ok: true,
    lead_id: leadId,
    total_matches: matchesFormatados.length,
    score_corte: minScore,
    matches: matchesFormatados,
    nota_operacional:
      'Apresente ao corretor o link_previa_meus_imoveis. Links rastreados (/imoveis/p/{token}) só devem ser gerados após aprovação humana.',
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
