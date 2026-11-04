// ============================================================
// WACRM MCP Server — HTTP Security & CORS Policy
// Validates Origin and provides restrictive CORS headers
// ============================================================

import { DEFAULT_PROTOCOL_VERSION } from './types';

const ALLOWED_ORIGIN_PATTERNS = [
  /^https:\/\/(.*\.)?crmronaldomeira\.com(:\d+)?$/,
  /^https:\/\/(.*\.)?ronaldomeira\.com\.br(:\d+)?$/,
  /^http:\/\/localhost(:\d+)?$/,
  /^http:\/\/127\.0\.0\.1(:\d+)?$/,
];

/**
 * Validação segura de Origin: permite clientes que não enviam Origin (OpenBot CLI/daemon/backend)
 * e restringe navegadores exclusivamente aos domínios autorizados do CRM e ambiente local.
 */
export function validateOrigin(origin: string | null): boolean {
  if (!origin) return true;
  if (process.env.MCP_ALLOWED_ORIGINS) {
    const customAllowed = process.env.MCP_ALLOWED_ORIGINS.split(',').map((o) => o.trim());
    if (customAllowed.includes(origin)) return true;
  }
  return ALLOWED_ORIGIN_PATTERNS.some((pattern) => pattern.test(origin));
}

/**
 * Constrói cabeçalhos restritivos de CORS e protocolo MCP Streamable HTTP.
 */
export function getMcpHeaders(request?: Request): Record<string, string> {
  const origin = request?.headers?.get('origin') || null;
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept, X-Api-Key, MCP-Protocol-Version',
    'MCP-Protocol-Version': DEFAULT_PROTOCOL_VERSION,
    'Cache-Control': 'no-store',
  };

  if (origin && validateOrigin(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Credentials'] = 'true';
    headers['Vary'] = 'Origin';
  }

  return headers;
}
