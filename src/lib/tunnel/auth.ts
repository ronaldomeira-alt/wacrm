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
  const reqHeaders = await headers();
  const authHeader = reqHeaders.get('authorization') || request.headers.get('authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();

  const configuredKey = process.env.TUNNEL_API_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  // Validação estrita do token de túnel sem fallback hardcoded
  if (!token || (!configuredKey && !serviceKey)) {
    return null;
  }

  if (token !== configuredKey && token !== serviceKey) {
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
