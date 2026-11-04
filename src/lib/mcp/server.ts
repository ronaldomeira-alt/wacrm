// ============================================================
// WACRM MCP Server — Protocol Router & Tool Execution Engine
// Streamable HTTP JSON-RPC 2.0 implementation
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import {
  JsonRpcRequest,
  JsonRpcResponse,
  MCP_ERROR_CODES,
  DEFAULT_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  McpContext,
} from './types';
import { WACRM_MCP_TOOLS, dispatchMcpTool } from './tools';
import { validateToolScope } from './auth';

/**
 * Sanitiza parâmetros removendo segredos, senhas e tokens para proteger auditoria.
 */
function sanitizeAuditPayload(data: unknown): unknown {
  if (!data || typeof data !== 'object') return data;
  if (Array.isArray(data)) return data.map(sanitizeAuditPayload);

  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    const lower = key.toLowerCase();
    if (
      lower.includes('token') ||
      lower.includes('secret') ||
      lower.includes('password') ||
      lower.includes('authorization') ||
      lower.includes('api_key')
    ) {
      sanitized[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      sanitized[key] = sanitizeAuditPayload(value);
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

/**
 * Sanitiza o resultado da ferramenta para o log de auditoria,
 * omitindo textos completos de transcrições e mensagens (PII).
 */
function sanitizeAuditResult(toolName: string, result: unknown): unknown {
  if (!result || typeof result !== 'object') return result;

  if (toolName === 'obter_contexto_recente') {
    const structured = (result as any)?.structuredContent || result;
    return {
      ok: structured?.ok,
      lead_id: structured?.lead_id,
      conversation_id: structured?.conversation_id,
      total_mensagens: structured?.total_mensagens,
      limite: structured?.limite,
      mensagens_auditadas: (structured?.mensagens || []).length,
    };
  }

  return sanitizeAuditPayload(result);
}

/**
 * Registra a execução no mcp_audit_logs de forma segura e assíncrona.
 */
async function recordAuditLog(
  db: SupabaseClient,
  accountId: string,
  toolName: string,
  params: Record<string, unknown>,
  result: unknown,
  affectedIds: string[] = []
): Promise<void> {
  try {
    await db.from('mcp_audit_logs').insert({
      account_id: accountId,
      tool_name: toolName,
      affected_ids: affectedIds,
      payload: sanitizeAuditPayload(params),
      result: sanitizeAuditResult(toolName, result),
    });
  } catch (err) {
    console.error('[WACRM MCP Audit] Falha ao registrar log de auditoria:', err);
  }
}

/**
 * Valida se os campos obrigatórios do schema da ferramenta foram enviados.
 */
function validateToolArgs(toolName: string, args: Record<string, unknown>): string | null {
  const def = WACRM_MCP_TOOLS.find((t) => t.name === toolName);
  if (!def) return `Ferramenta "${toolName}" não encontrada.`;

  for (const req of def.inputSchema.required || []) {
    if (args[req] === undefined || args[req] === null || args[req] === '') {
      return `Campo obrigatório "${req}" não fornecido para a ferramenta "${toolName}".`;
    }
  }

  return null;
}

/**
 * Processador principal de requisições MCP JSON-RPC 2.0.
 */
export async function handleMcpRpc(
  request: JsonRpcRequest,
  context: McpContext
): Promise<JsonRpcResponse> {
  const { id = null, method, params = {} } = request;
  const db = supabaseAdmin();

  switch (method) {
    case 'initialize': {
      // Negociação de versão do protocolo MCP
      const clientVersion = (params.protocolVersion as string) || '';
      const negotiatedVersion = (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(clientVersion)
        ? clientVersion
        : DEFAULT_PROTOCOL_VERSION;

      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: negotiatedVersion,
          capabilities: {
            tools: { listChanged: false },
          },
          serverInfo: {
            name: MCP_SERVER_NAME,
            version: MCP_SERVER_VERSION,
          },
          instructions:
            'WACRM MCP Server (Fase 1: Ferramentas de Leitura Comercial). Respostas estruturadas em JSON. Recomendações e follow-ups requerem aprovação expressa do corretor responsável antes de qualquer disparo.',
        },
      };
    }

    case 'notifications/initialized':
    case 'initialized': {
      return { jsonrpc: '2.0', id: id ?? null, result: {} };
    }

    case 'server/discover': {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          serverInfo: {
            name: MCP_SERVER_NAME,
            version: MCP_SERVER_VERSION,
          },
          supportedProtocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
          capabilities: {
            tools: { listChanged: false },
          },
        },
      };
    }

    case 'ping': {
      return { jsonrpc: '2.0', id, result: {} };
    }

    case 'tools/list':
    case 'list_tools':
    case 'listTools': {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          tools: WACRM_MCP_TOOLS,
        },
      };
    }

    case 'tools/call': {
      const toolName = (params.name as string) || '';
      let toolArguments = (params.arguments as Record<string, unknown>) || {};

      if (typeof toolArguments === 'string') {
        try {
          toolArguments = JSON.parse(toolArguments);
        } catch {
          toolArguments = {};
        }
      }

      if (!toolName) {
        return {
          jsonrpc: '2.0',
          id,
          error: {
            code: MCP_ERROR_CODES.INVALID_PARAMS,
            message: 'O parâmetro "name" da ferramenta é obrigatório em tools/call.',
          },
        };
      }

      // Validação estrita de escopo por ferramenta
      const scopeCheck = validateToolScope(context, toolName);
      if (!scopeCheck.allowed) {
        return {
          jsonrpc: '2.0',
          id,
          error: {
            code: MCP_ERROR_CODES.FORBIDDEN,
            message: scopeCheck.error || 'Permissão insuficiente para esta ferramenta.',
          },
        };
      }

      const validationErr = validateToolArgs(toolName, toolArguments);
      if (validationErr) {
        return {
          jsonrpc: '2.0',
          id,
          error: {
            code: MCP_ERROR_CODES.INVALID_PARAMS,
            message: validationErr,
          },
        };
      }

      try {
        const executionResult = await dispatchMcpTool(db, context, toolName, toolArguments);

        // Identifica IDs afetados para auditoria
        const affectedIds: string[] = [];
        if (toolArguments.lead_id && typeof toolArguments.lead_id === 'string') {
          affectedIds.push(toolArguments.lead_id);
        }

        void recordAuditLog(
          db,
          context.accountId,
          toolName,
          toolArguments,
          executionResult.structuredContent || executionResult,
          affectedIds
        );

        return {
          jsonrpc: '2.0',
          id,
          result: executionResult,
        };
      } catch (err: any) {
        return {
          jsonrpc: '2.0',
          id,
          error: {
            code: MCP_ERROR_CODES.INTERNAL_ERROR,
            message: err?.message || 'Erro durante a execução da ferramenta MCP.',
          },
        };
      }
    }

    default: {
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: MCP_ERROR_CODES.METHOD_NOT_FOUND,
          message: `Método MCP não suportado: "${method}". Métodos válidos: initialize, ping, tools/list, tools/call.`,
        },
      };
    }
  }
}
