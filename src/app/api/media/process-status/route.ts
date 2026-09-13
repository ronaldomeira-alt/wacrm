import { NextResponse } from 'next/server';
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { hasMinRole } from '@/lib/auth/roles';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { getMediaProcessingStatuses } from '@/lib/media/server-media-normalization';

export async function POST(request: Request) {
  try {
    const { accountId, userId, role } = await getCurrentAccount();

    if (!hasMinRole(role, 'agent')) {
      return NextResponse.json({ error: 'Insufficient role' }, { status: 403 });
    }

    const limit = checkRateLimit(`media-status:${userId}`, RATE_LIMITS.mediaResolve);
    if (!limit.success) return rateLimitResponse(limit);

    const body = await request.json();
    const { keys } = body as { keys?: string[] };

    if (!Array.isArray(keys) || keys.length === 0) {
      return NextResponse.json({ statuses: {} });
    }

    // Safety cap
    const safeKeys = keys.slice(0, 50);
    const statuses = await getMediaProcessingStatuses(safeKeys, accountId);

    return NextResponse.json({ statuses });
  } catch (error) {
    console.error('[media/process-status] error:', error);
    return toErrorResponse(error);
  }
}
