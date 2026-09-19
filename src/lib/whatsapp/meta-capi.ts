/**
 * Meta Conversions API — Click-to-WhatsApp qualified-lead signal.
 *
 * Sends a `QualifiedLead` event back to Meta keyed by `ctwa_clid`, so ad
 * delivery can optimize toward the audience that actually produces leads
 * a human would call qualified — not just people who open a chat. This is
 * the server-side counterpart to the `ctwa_clid` already captured on
 * `conversations.ctwa_referral` when the lead first landed.
 *
 * Spec: https://developers.facebook.com/documentation/ads-commerce/conversions-api/business-messaging
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from './encryption'

const META_API_VERSION = 'v21.0'

export type SendQualifiedLeadResult =
  | { sent: true }
  | { sent: false; reason: 'no_ctwa_clid' | 'capi_not_configured' | 'graph_api_error'; detail?: string }

export interface SendQualifiedLeadOptions {
  /**
   * Meta's Test Events code (Events Manager → dataset → Test Events tab).
   * ONLY ever supplied by the manual test harness
   * (`scripts/test-qualified-lead-capi.ts`) — no production call site
   * passes this, so real lead traffic can never carry it by accident, no
   * matter what's set in the environment. When present, Meta shows the
   * event live in Test Events instead of (or alongside) counting it as a
   * normal production event.
   */
  testEventCode?: string
}

/**
 * Deterministic event id: the logical event is "this conversation's lead
 * became qualified", which by construction (see the early-return in
 * applyStageSuggestion once a deal is already in the target stage) can
 * only be produced once per conversation — but a retry of the same
 * analysis run (network retry, at-least-once webhook redelivery racing
 * the cooldown) must still resolve to the same id so Meta's own
 * deduplication collapses it, instead of a fresh random id creating a
 * second count each time. Never randomize this.
 */
function qualifiedLeadEventId(conversationId: string): string {
  return `qualified-lead:${conversationId}`
}

/**
 * Fires the `QualifiedLead` CAPI event for the ad click that originated
 * this conversation. No-op (not an error) when the conversation didn't
 * come from a Click-to-WhatsApp ad, or when the account hasn't set up a
 * Conversions API dataset yet — callers should treat every non-`sent`
 * result as "nothing to do", never surface it to the end user.
 */
export async function sendQualifiedLeadEvent(
  db: SupabaseClient,
  accountId: string,
  conversationId: string,
  options?: SendQualifiedLeadOptions,
): Promise<SendQualifiedLeadResult> {
  const { data: conversation } = await db
    .from('conversations')
    .select('ctwa_referral')
    .eq('id', conversationId)
    .eq('account_id', accountId)
    .maybeSingle()

  const ctwaClid = (conversation?.ctwa_referral as { ctwa_clid?: string } | null)?.ctwa_clid
  if (!ctwaClid) return { sent: false, reason: 'no_ctwa_clid' }

  const { data: wcfg } = await db
    .from('whatsapp_config')
    .select('access_token, waba_id, meta_capi_dataset_id')
    .eq('account_id', accountId)
    .maybeSingle()

  if (!wcfg?.access_token || !wcfg.meta_capi_dataset_id) {
    return { sent: false, reason: 'capi_not_configured' }
  }

  const token = decrypt(wcfg.access_token)

  const res = await fetch(
    `https://graph.facebook.com/${META_API_VERSION}/${wcfg.meta_capi_dataset_id}/events?access_token=${encodeURIComponent(token)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data: [
          {
            event_name: 'QualifiedLead',
            event_id: qualifiedLeadEventId(conversationId),
            event_time: Math.floor(Date.now() / 1000),
            action_source: 'business_messaging',
            messaging_channel: 'whatsapp',
            user_data: {
              whatsapp_business_account_id: wcfg.waba_id,
              ctwa_clid: ctwaClid,
            },
          },
        ],
        ...(options?.testEventCode ? { test_event_code: options.testEventCode } : {}),
      }),
    },
  )

  const json = await res.json().catch(() => null)
  if (!res.ok || json?.error) {
    return { sent: false, reason: 'graph_api_error', detail: json?.error?.message ?? `HTTP ${res.status}` }
  }

  return { sent: true }
}
