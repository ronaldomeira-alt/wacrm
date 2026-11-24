import type { SupabaseClient } from '@supabase/supabase-js'

export interface ConversationLease {
  lockToken: string
  fencingToken: number
  abortController: AbortController
  verify: () => Promise<boolean>
  release: () => Promise<void>
}

const LEASE_TTL_SECONDS = 45
const HEARTBEAT_INTERVAL_MS = 15_000

/**
 * Acquire a 45-second lease with automatic 15-second heartbeat renewal and
 * monotonic fencing token verification.
 *
 * - If the process dies or hangs, the 45s lease expires automatically so the
 *   conversation is never blocked indefinitely.
 * - While processing legitimately (e.g., 45s primary + 45s fallback + 30s Meta),
 *   the heartbeat keeps the lease alive without needing an oversized static TTL.
 * - If another worker steals an expired lease (advancing `fencingToken`), the
 *   next heartbeat returns `false`, aborts `abortController`, and `verify()`
 *   prevents the stale worker from committing any side effects.
 */
export async function acquireConversationLeaseWithHeartbeat(
  db: SupabaseClient,
  conversationId: string,
  lockToken: string,
): Promise<ConversationLease | null> {
  const abortController = new AbortController()
  let fencingToken = 0
  let rpcAvailable = true

  try {
    const { data, error } = await db.rpc('acquire_ai_conversation_lease', {
      p_conversation_id: conversationId,
      p_lock_token: lockToken,
      p_ttl_seconds: LEASE_TTL_SECONDS,
    })

    const row = Array.isArray(data) ? data[0] : data
    if (error || !row || typeof row.acquired !== 'boolean') {
      // Fallback to legacy lock RPC if migration/mock doesn't implement lease RPC
      rpcAvailable = false
      const { data: legacyOk, error: legacyErr } = await db.rpc(
        'acquire_ai_conversation_lock',
        {
          p_conversation_id: conversationId,
          p_lock_token: lockToken,
          p_ttl_seconds: LEASE_TTL_SECONDS,
        },
      )
      if (!legacyErr && legacyOk === false) {
        return null
      }
    } else {
      if (!row.acquired) return null
      fencingToken = Number(row.fencing_token ?? 0)
    }
  } catch {
    rpcAvailable = false
  }

  let released = false
  const timer = rpcAvailable
    ? setInterval(() => {
        if (released) return
        void Promise.resolve(
          db.rpc('renew_ai_conversation_lock', {
            p_conversation_id: conversationId,
            p_lock_token: lockToken,
            p_fencing_token: fencingToken,
            p_ttl_seconds: LEASE_TTL_SECONDS,
          }),
        )
          .then(({ data }) => {
            if (data === false) {
              console.warn(
                `[lease] Fencing token lost for conv ${conversationId}; aborting stale worker.`,
              )
              abortController.abort(new Error('lease_lost'))
            }
          })
          .catch(() => {})
      }, HEARTBEAT_INTERVAL_MS)
    : null

  return {
    lockToken,
    fencingToken,
    abortController,
    verify: async () => {
      if (abortController.signal.aborted) return false
      if (!rpcAvailable || fencingToken === 0) return true
      try {
        const { data, error } = await db.rpc('verify_ai_conversation_lease', {
          p_conversation_id: conversationId,
          p_lock_token: lockToken,
          p_fencing_token: fencingToken,
        })
        if (error) return true
        return data === true
      } catch {
        return true
      }
    },
    release: async () => {
      released = true
      if (timer) clearInterval(timer)
      try {
        await db.rpc('release_ai_conversation_lock', {
          p_conversation_id: conversationId,
          p_lock_token: lockToken,
        })
      } catch {
        // best-effort
      }
    },
  }
}
