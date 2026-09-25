import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/push/admin-client';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  try {
    const { token } = await params;
    if (!token) {
      return NextResponse.json({ error: 'Token não fornecido' }, { status: 400 });
    }

    const db = supabaseAdmin();

    const { data: share, error } = await db
      .from('property_shares')
      .select('id, property_id, revoked_at, account_id')
      .eq('tracking_token', token)
      .maybeSingle();

    if (error || !share) {
      return NextResponse.json({ valid: false, error: 'Token não encontrado' }, { status: 404 });
    }

    if (share.revoked_at) {
      return NextResponse.json({ valid: false, error: 'Token revogado' }, { status: 410 });
    }

    // Busca dados do corretor responsável pela conta (sem expor PII do lead!)
    const { data: accountMember } = await db
      .from('account_members')
      .select('user_id, profiles(full_name, email)')
      .eq('account_id', share.account_id)
      .eq('role', 'owner')
      .maybeSingle();

    const profile = (accountMember?.profiles || {}) as { full_name?: string };
    const corretorName = profile.full_name || 'Ronaldo Meira';

    return NextResponse.json({
      valid: true,
      property_id: share.property_id,
      corretor_name: corretorName,
    });
  } catch (err) {
    console.error('[GET /api/tunnel/v1/shares/resolve/:token] Erro:', err);
    return NextResponse.json({ error: 'Erro ao resolver token' }, { status: 500 });
  }
}
