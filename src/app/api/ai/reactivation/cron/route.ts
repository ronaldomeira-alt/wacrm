import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { runContextualReactivationForAccount } from '@/lib/ai/reactivation-engine'

/**
 * Scans every account with an active AI config for conversations that have been
 * interrupted by customer silence for ~3 hours. Re-evaluates context, respects
 * business hours (08:00–20:00), applies specific/global reactivation intelligence,
 * and sends natural contextual re-engagement messages via Clara.
 *
 * Meant to be called on a recurring schedule (external pinger, e.g. every 15-30m)
 * using the shared AUTOMATION_CRON_SECRET.
 */
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  const supplied = request.headers.get('x-cron-secret') ?? ''
  const suppliedBuf = Buffer.from(supplied)
  const expectedBuf = Buffer.from(expected)
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = supabaseAdmin()

  const { data: activeConfigs, error } = await admin
    .from('ai_configs')
    .select('account_id')
    .eq('is_active', true)
    .eq('auto_reply_enabled', true)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!activeConfigs || activeConfigs.length === 0) {
    return NextResponse.json({
      accounts_processed: 0,
      candidates: 0,
      evaluated: 0,
      sent: 0,
      scheduled: 0,
      cancelled: 0,
      skipped: 0,
      failed: 0,
    })
  }

  let candidates = 0
  let evaluated = 0
  let sent = 0
  let scheduled = 0
  let cancelled = 0
  let skipped = 0
  let failed = 0

  for (const row of activeConfigs) {
    try {
      const result = await runContextualReactivationForAccount(admin, row.account_id as string)
      candidates += result.candidates
      evaluated += result.evaluated
      sent += result.sent
      scheduled += result.scheduled
      cancelled += result.cancelled
      skipped += result.skipped
      failed += result.failed
    } catch (err) {
      console.error('[reactivation/cron] account', row.account_id, 'failed:', err)
      failed++
    }
  }

  return NextResponse.json({
    accounts_processed: activeConfigs.length,
    candidates,
    evaluated,
    sent,
    scheduled,
    cancelled,
    skipped,
    failed,
  })
}
