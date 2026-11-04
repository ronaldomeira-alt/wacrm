// ============================================================
// WACRM MCP Server — End-to-End Integration Test Suite
// Simulates an MCP Client (e.g. OpenBot) over Streamable HTTP
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST, GET, OPTIONS } from '@/app/api/mcp/route';
import { hashApiKey } from '@/lib/api-keys/keys';
import type { ApiKeyRow } from '@/lib/api-keys/store';

// Mock do supabaseAdmin para simular o banco com controle estrito
const mockDb = {
  from: vi.fn(),
};

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => mockDb,
}));

// Mock do api_keys store para simular banco de chaves ativas, expiradas e revogadas
let mockActiveKeys: Record<string, ApiKeyRow> = {};

vi.mock('@/lib/api-keys/store', () => ({
  findActiveKeyByHash: vi.fn(async (hash: string) => {
    const key = mockActiveKeys[hash];
    if (!key) return null;
    if (key.revoked_at) return null;
    if (key.expires_at && new Date(key.expires_at).getTime() <= Date.now()) return null;
    return key;
  }),
  touchLastUsed: vi.fn(async () => {}),
}));

describe('WACRM MCP Client Integration Suite (OpenBot Simulation)', () => {
  const ACCOUNT_A = 'account-alpha-111';
  const ACCOUNT_B = 'account-beta-222';
  const TEST_LEAD_A = 'lead-alice-001';
  const TEST_LEAD_B = 'lead-bob-002';

  const DEDICATED_KEY_FULL = 'wacrm_live_secretkeyfullpermission1234567890';
  const DEDICATED_KEY_CONTACTS_ONLY = 'wacrm_live_secretkeycontactsonly1234567890';
  const DEDICATED_KEY_EXPIRED = 'wacrm_live_secretkeyexpired1234567890123456';
  const DEDICATED_KEY_REVOKED = 'wacrm_live_secretkeyrevoked1234567890123456';

  let auditEntries: Array<{ account_id: string; tool_name: string; payload: any; result: any }> = [];

  beforeEach(() => {
    auditEntries = [];
    process.env.CRM_MCP_TOKEN = 'mcp_sec_7a9f82d4c01e68b31a54b9d0e12f';
    process.env.MATCH_CANONICAL_ACCOUNT_ID = ACCOUNT_A;
    delete process.env.TUNNEL_API_KEY; // Garante que tunnel key não concede acesso

    // Registra chaves no mock
    mockActiveKeys = {
      [hashApiKey(DEDICATED_KEY_FULL)]: {
        id: 'key-full-id',
        account_id: ACCOUNT_A,
        created_by: 'user-ronaldo',
        name: 'OpenBot Integration Key',
        scopes: ['contacts:read', 'messages:read', 'conversations:read', 'mcp:read'],
        expires_at: null,
        revoked_at: null,
      },
      [hashApiKey(DEDICATED_KEY_CONTACTS_ONLY)]: {
        id: 'key-limited-id',
        account_id: ACCOUNT_A,
        created_by: 'user-ronaldo',
        name: 'Contacts Only Key',
        scopes: ['contacts:read'],
        expires_at: null,
        revoked_at: null,
      },
      [hashApiKey(DEDICATED_KEY_EXPIRED)]: {
        id: 'key-expired-id',
        account_id: ACCOUNT_A,
        created_by: 'user-ronaldo',
        name: 'Expired Key',
        scopes: ['contacts:read', 'mcp:read'],
        expires_at: new Date(Date.now() - 10000).toISOString(),
        revoked_at: null,
      },
      [hashApiKey(DEDICATED_KEY_REVOKED)]: {
        id: 'key-revoked-id',
        account_id: ACCOUNT_A,
        created_by: 'user-ronaldo',
        name: 'Revoked Key',
        scopes: ['contacts:read', 'mcp:read'],
        expires_at: null,
        revoked_at: new Date(Date.now() - 5000).toISOString(),
      },
    };

    // Configura mock DB fluente e encadeável para auditoria e consultas comerciais
    mockDb.from.mockImplementation((table: string) => {
      if (table === 'mcp_audit_logs') {
        return {
          insert: vi.fn(async (row: any) => {
            auditEntries.push(row);
            return { error: null };
          }),
        };
      }

      const createBuilder = (resultData: any) => {
        const builder: any = {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn(function (this: any, field: string, val: any) {
            // Se consultar lead_id para outro lead (ex: TEST_LEAD_B tentando acessar na conta A)
            if (field === 'id' && val === TEST_LEAD_B) {
              return createBuilder(null);
            }
            if (field === 'contact_id' && val === TEST_LEAD_B) {
              return createBuilder(null);
            }
            if (field === 'lead_id' && val === TEST_LEAD_B) {
              return createBuilder([]);
            }
            return this;
          }),
          gte: vi.fn().mockReturnThis(),
          is: vi.fn().mockReturnThis(),
          in: vi.fn().mockReturnThis(),
          order: vi.fn().mockReturnThis(),
          limit: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn(async () => ({ data: resultData, error: null })),
          then: (resolve: any) => resolve({ data: resultData, error: null }),
        };
        return builder;
      };

      if (table === 'contacts') {
        return createBuilder({
          id: TEST_LEAD_A,
          name: 'Alice Santos',
          phone: '5583999991111',
          ai_score: 8,
          ai_score_reason: 'Interesse claro em apartamento 3 quartos no Cabo Branco',
          paused_at: null,
          archived_at: null,
          created_at: '2026-10-01T10:00:00Z',
          updated_at: '2026-11-04T12:00:00Z',
        });
      }

      if (table === 'conversations') {
        return createBuilder({
          id: 'conv-alice-01',
          contact_id: TEST_LEAD_A,
          account_id: ACCOUNT_A,
          status: 'open',
          assigned_agent_id: 'agent-thatianna',
          last_message_text: 'Gostei muito da opção do Cabo Branco',
          last_message_at: '2026-11-04T12:00:00Z',
          unread_count: 0,
          ai_autoreply_disabled: true, // Atendimento humano com Thatianna
          needs_review: false,
          last_reviewed_at: null,
          last_reviewed_by: null,
          ai_transfer_status: null,
          ai_transfer_reason: null,
          ai_transfer_boundary_type: null,
          ai_transfer_at: null,
        });
      }

      if (table === 'lead_intelligence') {
        return createBuilder({
          summary: {
            purpose: ['compra'],
            property_type: ['apartamento'],
            location: ['Cabo Branco'],
            price_max: 950000,
            bedrooms: [3],
            profile: ['moradia'],
            intent: 'decidindo este mês',
          },
          last_analyzed_at: '2026-11-04T12:30:00Z',
          last_message_id: 'msg-alice-99',
        });
      }

      if (table === 'lead_property_matches') {
        return createBuilder([
          {
            id: 'match-001',
            property_id: 'prop-cabo-branco-401',
            match_score: 92,
            score_breakdown: { tipologia: 30, localizacao: 30, orcamento: 32 },
            profile_maturity: 'maduro',
            commercial_priority: 'alta',
            match_status: 'sugerido',
            suppressed: false,
            origin: 'wacrm_clara',
            sent_at: null,
            created_at: '2026-11-04T10:00:00Z',
            updated_at: '2026-11-04T10:00:00Z',
            property_match_projections: {
              id: 'proj-001',
              code: 'CB-401',
              title: 'Edifício Cabo Branco Premier',
              operation: 'venda',
              property_type: 'Apartamento',
              neighborhood: 'Cabo Branco',
              city: 'João Pessoa',
              price_min: 890000,
              price_max: 920000,
              area_min: 95,
              area_max: 105,
              bedrooms_min: 3,
              bedrooms_max: 3,
              delivery_status: 'pronto',
              delivery_deadline: null,
              features: ['Piscina', 'Varanda Gourmet'],
              cover_url: 'https://cdn.exemplo.com/cb401.jpg',
              status: 'ativo',
            },
          },
        ]);
      }

      if (table === 'profiles') {
        return createBuilder([
          {
            id: 'agent-thatianna',
            full_name: 'Thatianna Oliveira',
            email: 'thatiannaoliveira@hotmail.com',
          },
        ]);
      }

      return createBuilder([]);
    });
  });

  // Helper para fazer requisições POST JSON-RPC ao endpoint
  async function callMcp(token: string | null, payload: any, origin?: string, customHeaders?: Record<string, string>) {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...customHeaders,
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (origin) headers['Origin'] = origin;

    const req = new Request('https://crmronaldomeira.com/api/mcp', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    const res = await POST(req);
    const text = await res.text();
    let json = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {}
    }
    return { status: res.status, headers: res.headers, json };
  }

  it('1. Autenticação: rejeita credencial ausente, inválida, revogada e expirada', async () => {
    // Sem token
    const noToken = await callMcp(null, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(noToken.status).toBe(401);

    // Token aleatório inválido
    const invalidToken = await callMcp('token-invalido', { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(invalidToken.status).toBe(401);

    // Chave expirada
    const expired = await callMcp(DEDICATED_KEY_EXPIRED, { jsonrpc: '2.0', id: 3, method: 'tools/list' });
    expect(expired.status).toBe(401);

    // Chave revogada
    const revoked = await callMcp(DEDICATED_KEY_REVOKED, { jsonrpc: '2.0', id: 4, method: 'tools/list' });
    expect(revoked.status).toBe(401);

    // Rejeição estrita de token passado via query string (?token=)
    const queryReq = new Request(`https://crmronaldomeira.com/api/mcp?token=${DEDICATED_KEY_FULL}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/list' }),
    });
    const queryRes = await POST(queryReq);
    expect(queryRes.status).toBe(401);
  });

  it('2. Inicialização e negociação de versão do protocolo MCP (2024-11-05 e 2025-03-26)', async () => {
    // Negociação com 2024-11-05
    const init1 = await callMcp(DEDICATED_KEY_FULL, {
      jsonrpc: '2.0',
      id: 'init-1',
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', clientInfo: { name: 'OpenBot', version: '2.0.0' } },
    });
    expect(init1.status).toBe(200);
    expect(init1.json.result.protocolVersion).toBe('2024-11-05');
    expect(init1.json.result.serverInfo.name).toBe('wacrm-mcp-server');
    expect(init1.json.result.capabilities.tools.listChanged).toBe(false);

    // Negociação com 2025-03-26 (Streamable HTTP)
    const init2 = await callMcp(DEDICATED_KEY_FULL, {
      jsonrpc: '2.0',
      id: 'init-2',
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', clientInfo: { name: 'OpenBot-Streamable' } },
    });
    expect(init2.status).toBe(200);
    expect(init2.json.result.protocolVersion).toBe('2025-03-26');

    // Confirmação de inicialização pelo cliente via notificação HTTP 202 sem corpo
    const notified = await callMcp(DEDICATED_KEY_FULL, {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
    expect(notified.status).toBe(202);
    expect(notified.json).toBeNull();
  });

  it('2.1. MCP 2026-07-28: execução direta sem handshake e rejeição de versão não suportada', async () => {
    // Execução direta de tools/list informando 2026-07-28 via cabeçalho sem prévia chamada de initialize
    const directCall = await callMcp(
      DEDICATED_KEY_FULL,
      { jsonrpc: '2.0', id: 'stateless-1', method: 'tools/list' },
      undefined,
      { 'MCP-Protocol-Version': '2026-07-28' }
    );
    expect(directCall.status).toBe(200);
    expect(directCall.headers.get('mcp-protocol-version')).toBe('2026-07-28');
    expect(directCall.json.result.tools).toHaveLength(5);

    // Rejeição de versão não suportada (-32022)
    const unsupported = await callMcp(
      DEDICATED_KEY_FULL,
      { jsonrpc: '2.0', id: 'unsupported-1', method: 'tools/list' },
      undefined,
      { 'MCP-Protocol-Version': '2030-01-01' }
    );
    expect(unsupported.status).toBe(400);
    expect(unsupported.json.error.code).toBe(-32022);
    expect(unsupported.json.error.message).toContain('não suportada');
  });

  it('3. Listagem das cinco ferramentas comerciais obrigatórias', async () => {
    const list = await callMcp(DEDICATED_KEY_FULL, {
      jsonrpc: '2.0',
      id: 'tools-list',
      method: 'tools/list',
    });

    expect(list.status).toBe(200);
    const tools = list.json.result.tools;
    expect(tools).toHaveLength(5);

    const toolNames = tools.map((t: any) => t.name);
    expect(toolNames).toContain('obter_candidatos_followup_matinal');
    expect(toolNames).toContain('obter_contexto_comercial_lead');
    expect(toolNames).toContain('obter_contexto_recente');
    expect(toolNames).toContain('buscar_matches_lead');
    expect(toolNames).toContain('consultar_estado_lead');
  });

  it('4. Consulta de um lead de teste (consultar_estado_lead)', async () => {
    const call = await callMcp(DEDICATED_KEY_FULL, {
      jsonrpc: '2.0',
      id: 'state-1',
      method: 'tools/call',
      params: {
        name: 'consultar_estado_lead',
        arguments: { lead_id: TEST_LEAD_A },
      },
    });

    expect(call.status).toBe(200);
    const structured = call.json.result.structuredContent;
    expect(structured.lead.id).toBe(TEST_LEAD_A);
    expect(structured.lead.nome).toBe('Alice Santos');
    expect(structured.atendimento.atendimento_humano_ativo).toBe(true);
  });

  it('5. Consulta do resumo comercial da Clara (obter_contexto_comercial_lead)', async () => {
    const call = await callMcp(DEDICATED_KEY_FULL, {
      jsonrpc: '2.0',
      id: 'intel-1',
      method: 'tools/call',
      params: {
        name: 'obter_contexto_comercial_lead',
        arguments: { lead_id: TEST_LEAD_A },
      },
    });

    expect(call.status).toBe(200);
    const structured = call.json.result.structuredContent;
    expect(structured.lead.nome).toBe('Alice Santos');
    expect(structured.resumo_inteligencia.status).toBe('atualizado');
    expect(structured.resumo_inteligencia.localizacao).toContain('Cabo Branco');
    expect(structured.resumo_inteligencia.orcamento.maximo).toBe(950000);
  });

  it('6. Consulta de correspondências (buscar_matches_lead)', async () => {
    const call = await callMcp(DEDICATED_KEY_FULL, {
      jsonrpc: '2.0',
      id: 'matches-1',
      method: 'tools/call',
      params: {
        name: 'buscar_matches_lead',
        arguments: { lead_id: TEST_LEAD_A, score_minimo: 80 },
      },
    });

    expect(call.status).toBe(200);
    const structured = call.json.result.structuredContent;
    expect(structured.total_matches).toBe(1);
    expect(structured.matches[0].score).toBe(92);
    expect(structured.matches[0].titulo).toBe('Edifício Cabo Branco Premier');
  });

  it('7. Rejeição de acesso sem escopo: chave sem messages:read não lê contexto recente', async () => {
    // Tenta chamar obter_contexto_recente com chave que só tem contacts:read
    const call = await callMcp(DEDICATED_KEY_CONTACTS_ONLY, {
      jsonrpc: '2.0',
      id: 'scope-fail',
      method: 'tools/call',
      params: {
        name: 'obter_contexto_recente',
        arguments: { lead_id: TEST_LEAD_A },
      },
    });

    expect(call.status).toBe(200); // Erro JSON-RPC retorna status 200 com envelope de erro
    expect(call.json.error).toBeDefined();
    expect(call.json.error.code).toBe(1002); // FORBIDDEN
    expect(call.json.error.message).toContain('messages:read');
  });

  it('8. Isolamento estrito entre contas: consulta a lead de outra conta retorna erro', async () => {
    // Autenticado na conta A (chave DEDICATED_KEY_FULL), tenta acessar lead da conta B
    const call = await callMcp(DEDICATED_KEY_FULL, {
      jsonrpc: '2.0',
      id: 'cross-account',
      method: 'tools/call',
      params: {
        name: 'consultar_estado_lead',
        arguments: { lead_id: TEST_LEAD_B },
      },
    });

    expect(call.json.error).toBeDefined();
    expect(call.json.error.message).toContain('Lead não encontrado');
  });

  it('9. Auditoria assíncrona sanitiza dados e omite segredos e conteúdo sensível', async () => {
    await callMcp(DEDICATED_KEY_FULL, {
      jsonrpc: '2.0',
      id: 'audit-test',
      method: 'tools/call',
      params: {
        name: 'consultar_estado_lead',
        arguments: {
          lead_id: TEST_LEAD_A,
          api_key: 'segredo-que-deve-ser-redigido',
        },
      },
    });

    expect(auditEntries.length).toBeGreaterThan(0);
    const lastAudit = auditEntries[auditEntries.length - 1];
    expect(lastAudit.account_id).toBe(ACCOUNT_A);
    expect(lastAudit.tool_name).toBe('consultar_estado_lead');
    expect(lastAudit.payload.api_key).toBe('[REDACTED]');
  });
});