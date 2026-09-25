import { headers } from 'next/headers';
import { supabaseAdmin } from '@/lib/push/admin-client';
import type { SupabaseClient } from '@supabase/supabase-js';

export interface TunnelAuthContext {
  db: SupabaseClient;
  accountId: string;
}

/**
 * Valida a autenticação entre WACRM e Meus Imóveis.
 * Aceita Bearer token configurado em TUNNEL_API_KEY ou service role key.
 */
export async function authenticateTunnelRequest(request: Request): Promise<TunnelAuthContext | null> {
  let authHeader = request?.headers?.get('authorization') || '';
  if (!authHeader) {
    try {
      const reqHeaders = await headers();
      authHeader = reqHeaders.get('authorization') || '';
    } catch {
      // Executando fora do escopo de requisição Next.js (ex: testes unitários)
    }
  }
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();

  const configuredKey = process.env.TUNNEL_API_KEY;

  // Validação estrita e exclusiva de TUNNEL_API_KEY (Fail-Closed)
  // SUPABASE_SERVICE_ROLE_KEY NÃO é aceita como credencial do túnel
  if (!configuredKey || !token || token !== configuredKey) {
    return null;
  }

  const db = supabaseAdmin();

  // Resolve a conta padrão do CRM (single-tenant por instância)
  const { data: account } = await db
    .from('accounts')
    .select('id')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!account) {
    return null;
  }

  return {
    db,
    accountId: account.id,
  };
}
