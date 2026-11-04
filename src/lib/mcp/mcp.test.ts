// ============================================================
// WACRM MCP Server — Automated Unit & Integration Tests
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleMcpRpc } from './server';
import { WACRM_MCP_TOOLS } from './tools';
import { authenticateMcpRequest, hasMcpReadPermission, validateToolScope } from './auth';
import { GET, POST, OPTIONS } from '@/app/api/mcp/route';
import type { McpContext } from './types';

// Mock do supabaseAdmin para testes unitários isolados
vi.mock('@/lib/flows/admin-client', () => {
  return {
    supabaseAdmin: vi.fn(),
  };
});

describe('WACRM MCP Protocol & Router', () => {
  const mockContext: McpContext = {
    accountId: 'f8d2ae51-e393-4a74-a432-ddab0610837e',
    authMethod: 'token',
    scopes: ['mcp:all', 'mcp:read'],
  };

  it('1. initialize: retorna protocolVersion 2024-11-05 e serverInfo correto', async () => {
    const res = await handleMcpRpc(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {},
      },
      mockContext
    );

    expect(res.jsonrpc).toBe('2.0');
    expect(res.id).toBe(1);
    expect(res.result).toBeDefined();
    const result = res.result as any;
    expect(result.protocolVersion).toBe('2024-11-05');
    expect(result.serverInfo.name).toBe('wacrm-mcp-server');
    expect(result.capabilities.tools).toBeDefined();
  });

  it('2. ping: responde com objeto vazio de sucesso', async () => {
    const res = await handleMcpRpc(
      {
        jsonrpc: '2.0',
        id: 'req-ping',
        method: 'ping',
      },
      mockContext
    );

    expect(res.jsonrpc).toBe('2.0');
    expect(res.id).toBe('req-ping');
    expect(res.result).toEqual({});
  });

  it('2.1. initialize com negociação de versão Streamable HTTP (2025-03-26)', async () => {
    const res = await handleMcpRpc(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'initialize',
        params: { protocolVersion: '2025-03-26' },
      },
      mockContext
    );

    const result = res.result as any;
    expect(result.protocolVersion).toBe('2025-03-26');
    expect(result.capabilities.tools.listChanged).toBe(false);
  });

  it('2.2. notifications/initialized: aceita confirmação do cliente', async () => {
    const res = await handleMcpRpc(
      {
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      },
      mockContext
    );

    expect(res.jsonrpc).toBe('2.0');
  });

  it('2.3. server/discover: retorna capacidades e versões suportadas', async () => {
    const res = await handleMcpRpc(
      {
        jsonrpc: '2.0',
        id: 'disc-1',
        method: 'server/discover',
      },
      mockContext
    );

    const result = res.result as any;
    expect(result.serverInfo.name).toBe('wacrm-mcp-server');
    expect(result.supportedProtocolVersions).toContain('2024-11-05');
    expect(result.supportedProtocolVersions).toContain('2025-03-26');
  });

  it('3. tools/list: lista as 5 ferramentas obrigatórias de leitura comercial', async () => {
    const res = await handleMcpRpc(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
      },
      mockContext
    );

    expect(res.result).toBeDefined();
    const tools = (res.result as any).tools;
    expect(Array.isArray(tools)).toBe(true);
    expect(tools.length).toBe(5);

    const toolNames = tools.map((t: any) => t.name);
    expect(toolNames).toContain('obter_candidatos_followup_matinal');
    expect(toolNames).toContain('obter_contexto_comercial_lead');
    expect(toolNames).toContain('obter_contexto_recente');
    expect(toolNames).toContain('buscar_matches_lead');
    expect(toolNames).toContain('consultar_estado_lead');
  });

  it('4. tools/call: rejeita chamada com parâmetro obrigatório ausente', async () => {
    const res = await handleMcpRpc(
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'obter_contexto_comercial_lead',
          arguments: {}, // falta lead_id
        },
      },
      mockContext
    );

    expect(res.error).toBeDefined();
    expect(res.error?.code).toBe(-32602);
    expect(res.error?.message).toContain('lead_id');
  });

  it('5. método não suportado: retorna code -32601 METHOD_NOT_FOUND', async () => {
    const res = await handleMcpRpc(
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'metodo_inexistente',
      },
      mockContext
    );

    expect(res.error?.code).toBe(-32601);
    expect(res.error?.message).toContain('Método MCP não suportado');
  });
});

describe('WACRM MCP Authentication & Permissions', () => {
  beforeEach(() => {
    process.env.CRM_MCP_TOKEN = 'test-token-secret-12345';
    process.env.MATCH_CANONICAL_ACCOUNT_ID = 'f8d2ae51-e393-4a74-a432-ddab0610837e';
  });

  it('1. Rejeita requisição sem cabeçalho Authorization', async () => {
    const req = new Request('https://crmronaldomeira.com/api/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });

    const res = await POST(req);
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error.code).toBe(1001);
  });

  it('2. Rejeita token incorreto', async () => {
    const req = new Request('https://crmronaldomeira.com/api/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer token-invalido-errado',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });

    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it('3. Aceita token de ambiente configurado', async () => {
    const req = new Request('https://crmronaldomeira.com/api/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-token-secret-12345',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'tools/list' }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.result.tools).toHaveLength(5);
  });

  it('4. Suporta OPTIONS com CORS restritivo: reflete origem autorizada e rejeita não autorizada', async () => {
    // Origem autorizada
    const validReq = new Request('https://crmronaldomeira.com/api/mcp', {
      method: 'OPTIONS',
      headers: { Origin: 'https://crmronaldomeira.com' },
    });
    const validRes = await OPTIONS(validReq);
    expect(validRes.status).toBe(204);
    expect(validRes.headers.get('Access-Control-Allow-Origin')).toBe('https://crmronaldomeira.com');

    // Origem não autorizada
    const invalidReq = new Request('https://crmronaldomeira.com/api/mcp', {
      method: 'OPTIONS',
      headers: { Origin: 'https://site-malicioso.com' },
    });
    const invalidRes = await OPTIONS(invalidReq);
    expect(invalidRes.status).toBe(403);
  });

  it('5. Validação de permissões: hasMcpReadPermission rejeita escopo inválido', () => {
    expect(hasMcpReadPermission({
      accountId: 'acc-1',
      authMethod: 'api_key',
      scopes: ['broadcasts:send'],
    })).toBe(false);

    expect(hasMcpReadPermission({
      accountId: 'acc-1',
      authMethod: 'api_key',
      scopes: ['contacts:read'],
    })).toBe(true);

    expect(hasMcpReadPermission({
      accountId: 'acc-1',
      authMethod: 'api_key',
      scopes: ['mcp:read'],
    })).toBe(true);
  });

  it('6. Rejeita token via query param (?token=) exigindo cabeçalho Authorization: Bearer', async () => {
    const req = new Request('https://crmronaldomeira.com/api/mcp?token=test-token-secret-12345', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 20, method: 'tools/list' }),
    });

    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it('6.1. Desabilita token de ambiente em produção (NODE_ENV === production)', async () => {
    const originalEnv = process.env.NODE_ENV;
    try {
      (process.env as any).NODE_ENV = 'production';
      const req = new Request('https://crmronaldomeira.com/api/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer test-token-secret-12345',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 21, method: 'tools/list' }),
      });

      const res = await POST(req);
      expect(res.status).toBe(401);
    } finally {
      (process.env as any).NODE_ENV = originalEnv;
    }
  });

  it('7. Validação estrita de escopos por ferramenta (validateToolScope)', () => {
    // Chave com apenas contacts:read não pode ler mensagens e transcrições
    const contactOnlyContext: McpContext = {
      accountId: 'acc-1',
      authMethod: 'api_key',
      scopes: ['contacts:read'],
    };

    expect(validateToolScope(contactOnlyContext, 'obter_contexto_recente').allowed).toBe(false);
    expect(validateToolScope(contactOnlyContext, 'obter_candidatos_followup_matinal').allowed).toBe(true);
    expect(validateToolScope(contactOnlyContext, 'obter_contexto_comercial_lead').allowed).toBe(true);
    expect(validateToolScope(contactOnlyContext, 'buscar_matches_lead').allowed).toBe(true);
    expect(validateToolScope(contactOnlyContext, 'consultar_estado_lead').allowed).toBe(true);

    // Chave com messages:read pode ler contexto recente
    const messageContext: McpContext = {
      accountId: 'acc-1',
      authMethod: 'api_key',
      scopes: ['messages:read', 'contacts:read'],
    };
    expect(validateToolScope(messageContext, 'obter_contexto_recente').allowed).toBe(true);
  });

  it('8. POST rejeita requisição com Origin não autorizado (403)', async () => {
    const req = new Request('https://crmronaldomeira.com/api/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-token-secret-12345',
        Origin: 'https://site-invasor.com',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 30, method: 'tools/list' }),
    });

    const res = await POST(req);
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error.code).toBe(1002);
  });
});
