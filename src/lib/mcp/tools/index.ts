// ============================================================
// WACRM MCP Server — Tool Definitions & Registry (Phase 1)
// 5 Mandatory Read-Only Commercial Tools
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import type { McpContext, McpToolDefinition, ToolExecutionResult } from '../types';
import { executeObterCandidatosFollowup } from './candidatos-followup';
import { executeObterContextoComercial } from './contexto-comercial';
import { executeObterContextoRecente } from './contexto-recente';
import { executeBuscarMatches } from './buscar-matches';
import { executeConsultarEstado } from './consultar-estado';

export const WACRM_MCP_TOOLS: McpToolDefinition[] = [
  {
    name: 'obter_candidatos_followup_matinal',
    description:
      'Identifica leads que merecem avaliação comercial matinal na carteira de corretores (incluindo Thatianna). Avalia mensagens recentes com a Clara ou humanos, cadência de reengajamento (cooldown de 5 dias), compromissos do dia e status de inteligência. Não exclui atendimento humano nem usa score como barreira eliminatória.',
    inputSchema: {
      type: 'object',
      properties: {
        limite: {
          type: 'integer',
          default: 20,
          description: 'Quantidade máxima de candidatos a retornar (1 a 50). Padrão: 20',
        },
        cursor: {
          type: 'string',
          description: 'Cursor opcional para paginação estável',
        },
        apenas_com_resumo: {
          type: 'boolean',
          default: false,
          description: 'Se true, filtra apenas leads que já possuem resumo de inteligência gerado pela Clara',
        },
        responsavel_email: {
          type: 'string',
          description: 'Filtra por email do corretor responsável (ex: "thatiannaoliveira@hotmail.com")',
        },
        somente_pendencias_hoje: {
          type: 'boolean',
          default: false,
          description: 'Se true, retorna apenas leads com compromissos ou follow-ups agendados para hoje ou atrasados',
        },
      },
    },
  },
  {
    name: 'obter_contexto_comercial_lead',
    description:
      'Recupera as informações comerciais já interpretadas pela Clara a partir de lead_intelligence.summary, sem reler histórico de mensagens. Inclui perfil, tipologias, bairros, teto financeiro, flexibilidade, intenção, momento de compra, requisitos e notas comerciais.',
    inputSchema: {
      type: 'object',
      required: ['lead_id'],
      properties: {
        lead_id: {
          type: 'string',
          description: 'UUID do lead (contact_id) no WACRM',
        },
      },
    },
  },
  {
    name: 'obter_contexto_recente',
    description:
      'Consulta um pequeno trecho cirúrgico de mensagens recentes (padrão 10, máximo 30) somente quando necessário para resolver ambiguidades ou contradições pontuais. Preserva a origem (cliente, clara, atendente humano) e notas internas.',
    inputSchema: {
      type: 'object',
      required: ['lead_id'],
      properties: {
        lead_id: {
          type: 'string',
          description: 'UUID do lead (contact_id) no WACRM',
        },
        limite: {
          type: 'integer',
          default: 10,
          description: 'Quantidade de mensagens recentes (1 a 30). Padrão: 10',
        },
      },
    },
  },
  {
    name: 'buscar_matches_lead',
    description:
      'Consulta correspondências já calculadas pelo motor Match do WACRM para o lead informado. Retorna property_id, código para localização no MCP Meus Imóveis, score, justificativas e características. Consulta estritamente somente leitura.',
    inputSchema: {
      type: 'object',
      required: ['lead_id'],
      properties: {
        lead_id: {
          type: 'string',
          description: 'UUID do lead (contact_id) no WACRM',
        },
        score_minimo: {
          type: 'number',
          default: 50,
          description: 'Score mínimo de aderência para filtrar (0 a 100). Padrão: 50',
        },
        incluir_suprimidos: {
          type: 'boolean',
          default: false,
          description: 'Se true, inclui imóveis descartados/suprimidos pelo corretor',
        },
        limite: {
          type: 'integer',
          default: 10,
          description: 'Quantidade de matches (1 a 30). Padrão: 10',
        },
      },
    },
  },
  {
    name: 'consultar_estado_lead',
    description:
      'Consulta a situação operacional completa do lead: etapa da pipeline, atendente responsável, estado da conversa, supervisão (needs_review), follow-ups agendados, bloqueios e histórico de imóveis apresentados.',
    inputSchema: {
      type: 'object',
      required: ['lead_id'],
      properties: {
        lead_id: {
          type: 'string',
          description: 'UUID do lead (contact_id) no WACRM',
        },
      },
    },
  },
];

export async function dispatchMcpTool(
  db: SupabaseClient,
  context: McpContext,
  name: string,
  args: Record<string, unknown> = {}
): Promise<ToolExecutionResult> {
  switch (name) {
    case 'obter_candidatos_followup_matinal':
      return executeObterCandidatosFollowup(db, context, args as any);

    case 'obter_contexto_comercial_lead':
      return executeObterContextoComercial(db, context, args as any);

    case 'obter_contexto_recente':
      return executeObterContextoRecente(db, context, args as any);

    case 'buscar_matches_lead':
      return executeBuscarMatches(db, context, args as any);

    case 'consultar_estado_lead':
      return executeConsultarEstado(db, context, args as any);

    default:
      throw new Error(`Ferramenta desconhecida ou não autorizada: "${name}".`);
  }
}
