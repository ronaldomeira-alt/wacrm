/**
 * Backfills `transcript_text` for agent (Ronaldo/Thatianna) voice notes
 * sent before agent-audio transcription existed (2026-09-18) — the
 * customer-only restriction removed in transcribe-audio.ts /
 * /api/ai/transcribe/route.ts / send-message.ts this same day left every
 * pre-existing corretor recording untranscribed, which means none of it
 * has ever been eligible for the AI learning scan (effectiveMessageText
 * only returns text for audio once transcript_text exists).
 *
 * Downloads each message's `media_url` directly (already a plain public
 * Supabase Storage URL for agent-sent audio — see
 * transcribeAgentAudioMessage's doc comment) and calls the same
 * transcription path a live send now uses, so a backfilled row is
 * indistinguishable from one transcribed live.
 *
 * Idempotent: only ever selects rows where `transcript_text IS NULL`, so
 * re-running (e.g. to work through the backlog in batches, or after a
 * transient failure) never re-transcribes (and re-bills) an already-done
 * message. Processes oldest-first with a small delay between calls to
 * stay well under Whisper's rate limits.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/backfill-agent-audio-transcripts.ts             (dry run — reports only)
 *   APPLY=1 npx tsx --env-file=.env.local scripts/backfill-agent-audio-transcripts.ts      (transcribes, all pending)
 *   APPLY=1 LIMIT=50 npx tsx --env-file=.env.local scripts/backfill-agent-audio-transcripts.ts   (transcribes at most 50 this run)
 */
const APPLY = process.env.APPLY === '1';
const LIMIT = process.env.LIMIT ? parseInt(process.env.LIMIT, 10) : undefined;

import { createClient } from '@supabase/supabase-js';
import { transcribeAgentAudioMessage } from '../src/lib/ai/transcribe-audio';

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  let query = db
    .from('messages')
    .select('id, conversation_id, media_url, created_at, conversations!inner(account_id)')
    .eq('content_type', 'audio')
    .eq('sender_type', 'agent')
    .is('transcript_text', null)
    .not('media_url', 'is', null)
    .order('created_at', { ascending: true });
  if (LIMIT) query = query.limit(LIMIT);

  const { data: rows, error } = await query;
  if (error) throw error;

  const pending = (rows ?? []) as unknown as {
    id: string;
    conversation_id: string;
    media_url: string;
    created_at: string;
    conversations: { account_id: string };
  }[];

  console.log(`Found ${pending.length} untranscribed agent voice note(s)${LIMIT ? ` (capped at ${LIMIT})` : ''}.`);
  if (!APPLY) {
    console.log('Dry run — set APPLY=1 to actually transcribe. Sample:');
    for (const m of pending.slice(0, 10)) {
      console.log(`  [would transcribe] ${m.id} (${m.created_at}) conv=${m.conversation_id}`);
    }
    return;
  }

  let done = 0;
  let failed = 0;
  for (const m of pending) {
    try {
      const text = await transcribeAgentAudioMessage(db, m.conversations.account_id, m.id, m.media_url);
      if (text) {
        done++;
        console.log(`[ok] ${m.id}: "${text.slice(0, 80)}${text.length > 80 ? '…' : ''}"`);
      } else {
        console.warn(`[skip] ${m.id}: no embeddings key configured for account ${m.conversations.account_id}`);
      }
    } catch (err) {
      failed++;
      console.error(`[error] ${m.id}:`, (err as Error).message);
    }
    // Stay well clear of Whisper's rate limits across a batch of hundreds.
    await sleep(300);
  }

  console.log(`\nDone: transcribed ${done}, failed ${failed}, total checked ${pending.length}.`);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
