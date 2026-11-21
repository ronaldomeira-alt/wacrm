import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/push/admin-client';
import { runMatchInventorySyncIfChanged } from '@/lib/match/background-sync';

function getExpectedCronSecret(): string | null {
  return process.env.CRON_SECRET || process.env.AUTOMATION_CRON_SECRET || null;
}

function isAuthorizedCron(request: Request, expectedSecret: string): boolean {
  const authHeader = request.headers.get('authorization') ?? '';
  const cronHeader = request.headers.get('x-cron-secret') ?? '';
  const tokenFromBearer = authHeader.toLowerCase().startsWith('bearer ')
    ? authHeader.slice(7).trim()
    : authHeader.trim();
  const candidate = tokenFromBearer || cronHeader;
  if (!candidate) return false;

  const candidateBuf = Buffer.from(candidate);
  const expectedBuf = Buffer.from(expectedSecret);
  if (candidateBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(candidateBuf, expectedBuf);
}

async function handleMatchCron(request: Request): Promise<NextResponse> {
  const expectedSecret = getExpectedCronSecret();
  if (!expectedSecret) {
    return NextResponse.json(
      { error: 'CRON_SECRET is not configured on the server' },
      { status: 503 }
    );
  }
  if (!isAuthorizedCron(request, expectedSecret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const force = searchParams.get('force') === '1';
  const suppressNotifications = searchParams.get('suppress_notifications') === '1';
  const maxRecalcParam = Number(searchParams.get('max_recalc') || '40');
  const maxPropertiesToRecalculate = Number.isFinite(maxRecalcParam)
    ? Math.max(1, Math.min(maxRecalcParam, 250))
    : 40;

  const db = supabaseAdmin();
  const result = await runMatchInventorySyncIfChanged(db, null, {
    force,
    suppressNotifications,
    maxPropertiesToRecalculate,
  });

  return NextResponse.json({
    ok: true,
    checkedAt: new Date().toISOString(),
    ...result,
  });
}

export async function GET(request: Request): Promise<NextResponse> {
  return handleMatchCron(request);
}

export async function POST(request: Request): Promise<NextResponse> {
  return handleMatchCron(request);
}
