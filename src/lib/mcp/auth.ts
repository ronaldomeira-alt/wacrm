// ============================================================
// WACRM MCP Server — Authentication & Context Resolution
// Validates Bearer tokens against api_keys table & env tokens
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { findActiveKeyByHash, touchLastUsed } from '@/lib/api-keys/store';
import { hashApiKey, looksLikeApiKey } from '@/lib/api-keys/keys';
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit';
import type { McpContext } from './types';

export interface McpAuthResult {
  authorized: boolean;
  context?: McpContext;
  error?: string;
  statusCode?: number;
}

/**
 * Extrai o token de autenticação a partir de:
 * 1. Cabeçalho Authorization: Bearer <token>
 * 2. Cabeçalho X-Api-Key: <token>
 * 3. Parâmetro de query ?token=<token> ou ?apiKey=<token> (suporte para OpenBot e clientes MCP)
 */
export function extractTokenFromRequest(request: Request): string | null {
  const authHeader = (request.headers.get('authorization') || '').trim();
  if (authHeader.toLowerCase().startsWith('bearer ')) {
    const token = authHeader.slice(7).trim();
    if (token) return token;
  } else if (authHeader && !authHeader.includes(' ')) {
    return authHeader;
  }

  const apiKeyHeader =
    request.headers.get('x-api-key') ||
    request.headers.get('api-key') ||
    request.headers.get('x-token');
  if (apiKeyHeader?.trim()) {
    return apiKeyHeader.trim();
  }

  try {
    const url = new URL(request.url);
    const queryToken =
      url.searchParams.get('token') ||
      url.searchParams.get('apiKey') ||
      url.searchParams.get('api_key') ||
      url.searchParams.get('access_token');
    if (queryToken?.trim()) {
      return queryToken.trim();
    }
  } catch {
    // URL malformada
  }

  return null;
}

/**
 * Resolves the primary canonical account ID for environment tokens.
 */
async function resolveCanonicalAccountId(db: SupabaseClient): Promise<string | null> {
  if (process.env.MATCH_CANONICAL_ACCOUNT_ID?.trim()) {
    return process.env.MATCH_CANONICAL_ACCOUNT_ID.trim();
  }

  const { data: profile } = await db
    .from('profiles')
    .select('account_id')
    .eq('email', 'ronaldomeiracorretor@gmail.com')
    .not('account_id', 'is', null)
    .limit(1)
    .maybeSingle();

  if (profile?.account_id) {
    return profile.account_id;
  }

  // Fallback para conta ativa com maior volume de leads
  const { data: fallbackAccount } = await db
    .from('accounts')
    .select('id')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  return fallbackAccount?.id || null;
}

/**
 * Validates the authentication token and builds the isolated McpContext.
 * Dedicated WACRM API keys (hashed in database) are prioritized first.
 */
export async function authenticateMcpRequest(request: Request): Promise<McpAuthResult> {
  const token = extractTokenFromRequest(request);
  if (!token) {
    return {
      authorized: false,
      error: 'Token de autenticação não fornecido no cabeçalho Authorization: Bearer <token>',
      statusCode: 401,
    };
  }

  const db = supabaseAdmin();

  // 1. PRIORIDADE MÁXIMA: Chave de API dedicada do WACRM (armazenada por hash SHA-256)
  if (looksLikeApiKey(token) || token.length >= 32) {
    const hashed = hashApiKey(token);
    const keyRow = await findActiveKeyByHash(hashed);

    if (keyRow) {
      // Rate limiting por chave de API
      const limit = checkRateLimit(`mcp:key:${keyRow.id}`, RATE_LIMITS.publicApi);
      if (!limit.success) {
        return {
          authorized: false,
          error: 'Limite de requisições excedido para esta API Key.',
          statusCode: 429,
        };
      }

      // Atualiza timestamp de último uso de forma assíncrona
      void touchLastUsed(keyRow.id);

      return {
        authorized: true,
        context: {
          accountId: keyRow.account_id,
          authMethod: 'api_key',
          keyId: keyRow.id,
          scopes: keyRow.scopes || [],
        },
      };
    }
  }

  // 2. Chave de ambiente dedicada (permitida APENAS em ambiente de desenvolvimento/teste local, desabilitada estritamente em produção)
  const isProduction = process.env.NODE_ENV === 'production';
  const dedicatedMcpToken = !isProduction ? process.env.CRM_MCP_TOKEN?.trim() : null;
  if (dedicatedMcpToken && token === dedicatedMcpToken) {
    const accountId = await resolveCanonicalAccountId(db);
    if (!accountId) {
      return {
        authorized: false,
        error: 'Conta canônica do CRM não encontrada para o token de ambiente.',
        statusCode: 500,
      };
    }

    // Rate limiting para token de ambiente
    const limit = checkRateLimit(`mcp:env:${accountId}`, RATE_LIMITS.publicApi);
    if (!limit.success) {
      return {
        authorized: false,
        error: 'Limite de requisições excedido para o token MCP.',
        statusCode: 429,
      };
    }

    return {
      authorized: true,
      context: {
        accountId,
        authMethod: 'token',
        scopes: ['contacts:read', 'messages:read', 'conversations:read', 'mcp:read'],
      },
    };
  }

  return {
    authorized: false,
    error: 'Credencial inválida, revogada ou expirada.',
    statusCode: 401,
  };
}

/**
 * Checks if the context has permissions for read-only MCP tools.
 */
export function hasMcpReadPermission(context: McpContext): boolean {
  const scopes = context.scopes || [];
  return (
    scopes.includes('mcp:all') ||
    scopes.includes('mcp:read') ||
    scopes.includes('contacts:read') ||
    scopes.includes('conversations:read') ||
    scopes.includes('messages:read')
  );
}

/**
 * Validação granular de escopo por ferramenta MCP.
 * Ferramentas de mensagens, notas e transcrições exigem messages:read ou conversations:read.
 * Ferramentas comerciais exigem contacts:read.
 */
export function validateToolScope(
  context: McpContext,
  toolName: string
): { allowed: boolean; error?: string } {
  const scopes = context.scopes || [];
  if (scopes.includes('mcp:all') || scopes.includes('*')) {
    return { allowed: true };
  }

  if (toolName === 'obter_contexto_recente') {
    const allowed =
      scopes.includes('messages:read') ||
      scopes.includes('conversations:read') ||
      scopes.includes('mcp:read');
    if (!allowed) {
      return {
        allowed: false,
        error: 'Permissão insuficiente: a ferramenta "obter_contexto_recente" exige o escopo "messages:read" ou "conversations:read".',
      };
    }
    return { allowed: true };
  }

  // Demais ferramentas comerciais de leitura
  const allowed = scopes.includes('contacts:read') || scopes.includes('mcp:read');
  if (!allowed) {
    return {
      allowed: false,
      error: `Permissão insuficiente: a ferramenta "${toolName}" exige o escopo "contacts:read".`,
    };
  }
  return { allowed: true };
}
