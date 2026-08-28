import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// Lazy, shared service-role client for the Google Calendar inbound
// webhook and watch-channel renewal cron — neither has a user session
// (Google calls the webhook directly; the cron is hit by an external
// pinger). Mirrors the pattern used by src/lib/baileys/admin-client.ts
// and the other per-module admin clients.
let _adminClient: SupabaseClient | null = null

export function supabaseAdmin(): SupabaseClient {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )
  }
  return _adminClient
}
