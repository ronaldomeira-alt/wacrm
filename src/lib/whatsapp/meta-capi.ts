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
            event_time: Math.floor(Date.now() / 1000),
            action_source: 'business_messaging',
            messaging_channel: 'whatsapp',
            user_data: {
              whatsapp_business_account_id: wcfg.waba_id,
              ctwa_clid: ctwaClid,
            },
          },
        ],
      }),
    },
  )

  const json = await res.json().catch(() => null)
  if (!res.ok || json?.error) {
    return { sent: false, reason: 'graph_api_error', detail: json?.error?.message ?? `HTTP ${res.status}` }
  }

  return { sent: true }
}
