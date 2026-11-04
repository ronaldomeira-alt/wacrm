// ============================================================
// Model Context Protocol (MCP) — Type Definitions & Schemas
// WACRM Server Implementation (Phase 1: Read-Only Tools)
// ============================================================

export const SUPPORTED_PROTOCOL_VERSIONS = [
  '2024-11-05',
  '2025-03-26',
  '2026-07-28',
] as const;

export type SupportedProtocolVersion = (typeof SUPPORTED_PROTOCOL_VERSIONS)[number];

export const DEFAULT_PROTOCOL_VERSION: SupportedProtocolVersion = '2024-11-05';
export const MCP_PROTOCOL_VERSION = DEFAULT_PROTOCOL_VERSION;
export const MCP_SERVER_NAME = 'wacrm-mcp-server';
export const MCP_SERVER_VERSION = '1.0.0';

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: JsonRpcError;
}

export const MCP_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  // Application specific error codes
  UNAUTHORIZED: 1001,
  FORBIDDEN: 1002,
  RATE_LIMITED: 1003,
  NOT_FOUND: 1004,
  VALIDATION_ERROR: 1005,
} as const;

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface McpContext {
  accountId: string;
  authMethod: 'api_key' | 'token';
  keyId?: string;
  scopes?: string[];
}

export interface ToolExecutionResult {
  content: Array<{
    type: 'text';
    text: string;
  }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}
