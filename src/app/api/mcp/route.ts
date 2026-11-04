// ============================================================
// Route Handler: /api/mcp
// WACRM Model Context Protocol (MCP) Server Endpoint
// Streamable HTTP JSON-RPC 2.0 Transport
// ============================================================

import { NextResponse } from 'next/server';
import { authenticateMcpRequest, hasMcpReadPermission } from '@/lib/mcp/auth';
import { handleMcpRpc } from '@/lib/mcp/server';
import {
  JsonRpcRequest,
  MCP_ERROR_CODES,
  DEFAULT_PROTOCOL_VERSION,
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
} from '@/lib/mcp/types';
import { WACRM_MCP_TOOLS } from '@/lib/mcp/tools';
import { validateOrigin, getMcpHeaders } from '@/lib/mcp/cors';

export async function OPTIONS(request: Request) {
  const origin = request.headers.get('origin');
  if (origin && !validateOrigin(origin)) {
    return new Response(null, { status: 403 });
  }

  return new Response(null, {
    status: 204,
    headers: getMcpHeaders(request),
  });
}

export async function GET(request: Request) {
  const origin = request.headers.get('origin');
  if (origin && !validateOrigin(origin)) {
    return NextResponse.json(
      {
        jsonrpc: '2.0',
        error: {
          code: MCP_ERROR_CODES.FORBIDDEN,
          message: 'Origem não autorizada pela política de segurança CORS.',
        },
      },
      { status: 403 }
    );
  }

  const mcpHeaders = getMcpHeaders(request);
  const isSse = (request.headers.get('accept') || '').includes('text/event-stream');

  // Autenticação para handshake e listagem
  const auth = await authenticateMcpRequest(request);
  if (!auth.authorized || !auth.context) {
    return NextResponse.json(
      {
        jsonrpc: '2.0',
        error: {
          code: MCP_ERROR_CODES.UNAUTHORIZED,
          message: auth.error || 'Autenticação necessária.',
        },
      },
      {
        status: auth.statusCode || 401,
        headers: mcpHeaders,
      }
    );
  }

  // Handshake SSE para clientes legados compatíveis com transporte de eventos
  if (isSse) {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`event: endpoint\ndata: /api/mcp\n\n`));
        controller.close();
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        ...mcpHeaders,
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      },
    });
  }

  // Resposta padrão GET com status, versões de protocolo suportadas e catálogo de ferramentas
  return NextResponse.json(
    {
      name: MCP_SERVER_NAME,
      version: MCP_SERVER_VERSION,
      protocolVersion: DEFAULT_PROTOCOL_VERSION,
      supportedProtocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
      status: 'online',
      account_id: auth.context.accountId,
      tools_available: WACRM_MCP_TOOLS.length,
      tools: WACRM_MCP_TOOLS,
    },
    {
      status: 200,
      headers: mcpHeaders,
    }
  );
}

export async function POST(request: Request) {
  const origin = request.headers.get('origin');
  if (origin && !validateOrigin(origin)) {
    return NextResponse.json(
      {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: MCP_ERROR_CODES.FORBIDDEN,
          message: 'Origem não autorizada pela política de segurança CORS.',
        },
      },
      { status: 403 }
    );
  }

  const mcpHeaders = getMcpHeaders(request);

  // 1. Autenticação Bearer Token / API Key
  const auth = await authenticateMcpRequest(request);
  if (!auth.authorized || !auth.context) {
    return NextResponse.json(
      {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: MCP_ERROR_CODES.UNAUTHORIZED,
          message: auth.error || 'Credencial inválida ou ausente.',
        },
      },
      {
        status: auth.statusCode || 401,
        headers: mcpHeaders,
      }
    );
  }

  // 2. Validação geral de permissões de leitura MCP
  if (!hasMcpReadPermission(auth.context)) {
    return NextResponse.json(
      {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: MCP_ERROR_CODES.FORBIDDEN,
          message: 'A chave fornecida não possui escopo suficiente para consultas MCP.',
        },
      },
      {
        status: 403,
        headers: mcpHeaders,
      }
    );
  }

  // 3. Leitura e validação do payload JSON-RPC
  let body: JsonRpcRequest;
  try {
    body = await request.json();
  } catch (err: any) {
    return NextResponse.json(
      {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: MCP_ERROR_CODES.PARSE_ERROR,
          message: `JSON inválido: ${err?.message || 'Parse error'}`,
        },
      },
      {
        status: 400,
        headers: mcpHeaders,
      }
    );
  }

  if (!body || body.jsonrpc !== '2.0' || !body.method) {
    return NextResponse.json(
      {
        jsonrpc: '2.0',
        id: body?.id || null,
        error: {
          code: MCP_ERROR_CODES.INVALID_REQUEST,
          message: 'Requisição inválida. Deve seguir o padrão JSON-RPC 2.0 (jsonrpc: "2.0", method: string).',
        },
      },
      {
        status: 400,
        headers: mcpHeaders,
      }
    );
  }

  // 4. Resolução e validação da versão do protocolo MCP
  const declaredVersion =
    request.headers.get('mcp-protocol-version') ||
    (body.params?.protocolVersion as string) ||
    ((body as any)?._meta?.['io.modelcontextprotocol/protocolVersion'] as string) ||
    ((body.params as any)?._meta?.['io.modelcontextprotocol/protocolVersion'] as string) ||
    null;

  if (declaredVersion && !(SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(declaredVersion)) {
    return NextResponse.json(
      {
        jsonrpc: '2.0',
        id: body?.id || null,
        error: {
          code: -32022,
          message: `Versão do protocolo MCP não suportada: "${declaredVersion}". Versões suportadas: ${SUPPORTED_PROTOCOL_VERSIONS.join(', ')}.`,
          data: {
            supportedProtocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
          },
        },
      },
      {
        status: 400,
        headers: mcpHeaders,
      }
    );
  }

  const negotiatedVersion = declaredVersion || DEFAULT_PROTOCOL_VERSION;
  const responseHeaders = {
    ...mcpHeaders,
    'MCP-Protocol-Version': negotiatedVersion,
  };

  // 5. Tratamento de Notificações JSON-RPC (HTTP 202 sem corpo)
  const isNotification =
    body.method?.startsWith('notifications/') ||
    body.method === 'initialized';

  if (isNotification) {
    await handleMcpRpc(body, auth.context);
    return new Response(null, {
      status: 202,
      headers: responseHeaders,
    });
  }

  // 6. Executa roteador MCP com contexto autenticado
  const response = await handleMcpRpc(body, auth.context);

  return NextResponse.json(response, {
    status: 200,
    headers: responseHeaders,
  });
}
