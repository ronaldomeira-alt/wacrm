/**
 * One-off: register the Google Calendar Events.watch push channel for
 * connections that predate the Google → CRM sync feature (migration
 * 084) and so never got one via the OAuth callback. Safe to re-run —
 * registerWatchChannel always replaces any existing channel.
 *
 * Usage: npx tsx scripts/register-calendar-watch.ts
 */
import { createClient } from '@supabase/supabase-js';
import { buildAuthorizedOAuth2Client, type StoredConnection } from '../src/lib/calendar/google-calendar-provider';
import { registerWatchChannel } from '../src/lib/calendar/google-watch';
import { processConnectionChanges } from '../src/lib/calendar/inbound-sync-service';

async function main() {
  const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
  const baseUrl = process.env.NEXT_PUBLIC_SITE_URL!;

  const { data: connections, error } = await db
    .from('calendar_connections')
    .select('user_id, account_id, google_email, access_token_encrypted, refresh_token_encrypted, token_expires_at, channel_id');
  if (error) throw error;

  for (const connection of connections ?? []) {
    console.log(`\n=== ${connection.google_email} (user ${connection.user_id}) ===`);
    try {
      const oauth2Client = buildAuthorizedOAuth2Client(db, connection.user_id, connection as StoredConnection);
      const registration = await registerWatchChannel(db, connection.user_id, oauth2Client, baseUrl);
      console.log('Watch registered:', registration);

      await processConnectionChanges(db, {
        account_id: connection.account_id,
        user_id: connection.user_id,
        access_token_encrypted: connection.access_token_encrypted,
        refresh_token_encrypted: connection.refresh_token_encrypted,
        token_expires_at: connection.token_expires_at,
        sync_token: null,
      });
      console.log('Initial sync completed.');
    } catch (err) {
      console.error('FAILED:', err);
    }
  }
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
