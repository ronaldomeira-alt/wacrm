import crypto from 'crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { processAiReplyQueue } from '@/lib/ai/reply-queue'

export const dynamic = 'force-dynamic'

function verifyCronAuth(req: Request): boolean {
  const secret = process.env.AUTOMATION_CRON_SECRET || process.env.CRON_SECRET
  if (!secret) return false
  const auth = req.headers.get('authorization') || ''
  const xSecret = req.headers.get('x-cron-secret') || ''
  return auth === `Bearer ${secret}` || xSecret === secret
}

export async function GET(req: Request) {
  if (!verifyCronAuth(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const db = supabaseAdmin()
  const lockToken = crypto.randomUUID()

  // Single-flight protection against overlapping 1-minute cron ticks
  const { data: acquired, error: lockErr } = await db.rpc('acquire_ai_cron_lock', {
    p_cron_name: 'ai_reply_recovery',
    p_lock_token: lockToken,
    p_ttl_seconds: 55,
  })

  if (!lockErr && acquired === false) {
    return NextResponse.json({
      ok: true,
      skipped: true,
      reason: 'Another recovery cron execution is currently active.',
    })
  }

  try {
    const summary = await processAiReplyQueue(db)
    return NextResponse.json({ ok: true, ...summary })
  } catch (err) {
    console.error('[ai/recovery/cron] execution error:', err)
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  } finally {
    await db
      .rpc('release_ai_cron_lock', {
        p_cron_name: 'ai_reply_recovery',
        p_lock_token: lockToken,
      })
      .then(() => {}, () => {})
  }
}
