/**
 * Fase 5 of the Supabase Storage -> Cloudflare R2 media migration:
 * flips `messages.media_url` from the old Supabase `chat-media` URL to
 * the already-migrated (Fase 3) and already-validated (Fase 4) R2 key.
 *
 * Never touches, by construction of the candidate query alone (not by
 * post-hoc filtering):
 *   - message_templates.header_media_url (0 eligible rows — confirmed
 *     by the Fase 5 read-only analysis; no template header currently
 *     points at chat-media)
 *   - messages.document_thumbnail_url (a different column, never
 *     selected or written here)
 *   - avatars (different table entirely)
 *   - the Meta inbound proxy paths (/api/whatsapp/media/...) — never
 *     logged in media_migration_log in the first place
 *   - media_objects rows (read-only here; reference_count was already
 *     set correctly by Fase 3 and does not change — this script only
 *     moves which column contains the pointer, never creates/destroys
 *     a physical object or a dedup relationship)
 *
 * Rollback: media_migration_log.source_url is the original value,
 * written by Fase 3 and never modified since. reference_flipped_at
 * marks exactly which rows THIS script converted, so a rollback only
 * ever reverts rows it actually touched:
 *
 *   update messages m set media_url = l.source_url
 *   from media_migration_log l
 *   where m.id = l.source_row_id and l.reference_flipped_at is not null
 *     and m.media_url = l.r2_key;
 *
 * Resumable: a row whose current media_url already equals its logged
 * r2_key (an interrupted previous APPLY run got the data write done
 * but crashed before stamping the checkpoint) is recognized as
 * "already-flipped" and only gets reference_flipped_at stamped — never
 * re-written, never treated as an error. Any OTHER unexpected value at
 * media_url (neither source_url nor r2_key) is genuine drift and halts
 * the entire run immediately, per the "never auto-fix, stop and
 * report" rule — no partial/silent conversion of a batch.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/flip-media-references-to-r2.ts          (dry run — reports only, zero writes)
 *   APPLY=1 npx tsx --env-file=.env.local scripts/flip-media-references-to-r2.ts  (writes, batches of 50, checkpointed)
 */
const APPLY = process.env.APPLY === '1';
const BATCH_SIZE = 50;

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { getR2Bucket, getR2Client } from '../src/lib/storage/r2-client';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;

interface Candidate {
  logId: string;
  rowId: string;
  sourceUrl: string;
  r2Key: string;
  accountId: string;
}

async function loadCandidates(db: SupabaseClient): Promise<Candidate[]> {
  const { data, error } = await db
    .from('media_migration_log')
    .select('id, source_row_id, source_url, r2_key, account_id')
    .eq('source_table', 'messages')
    .eq('status', 'completed')
    .is('reference_flipped_at', null)
    .order('id');
  if (error) throw error;
  return ((data ?? []) as Array<{
    id: string;
    source_row_id: string;
    source_url: string;
    r2_key: string;
    account_id: string;
  }>).map((r) => ({
    logId: r.id,
    rowId: r.source_row_id,
    sourceUrl: r.source_url,
    r2Key: r.r2_key,
    accountId: r.account_id,
  }));
}

type Classification = 'update' | 'already-flipped' | 'drift';

async function classify(
  db: SupabaseClient,
  c: Candidate,
): Promise<{ status: Classification; currentMediaUrl: string | null }> {
  const { data: msg, error } = await db
    .from('messages')
    .select('media_url')
    .eq('id', c.rowId)
    .maybeSingle();
  if (error) throw error;
  const current = (msg?.media_url as string | null | undefined) ?? null;

  if (current === c.sourceUrl) return { status: 'update', currentMediaUrl: current };
  if (current === c.r2Key) return { status: 'already-flipped', currentMediaUrl: current };
  return { status: 'drift', currentMediaUrl: current };
}

interface DriftDetail {
  logId: string;
  rowId: string;
  accountId: string;
  sourceUrl: string;
  r2Key: string;
  currentMediaUrl: string | null;
  reason: string;
}

async function objectExistsInR2(r2Key: string): Promise<boolean> {
  try {
    await getR2Client().send(new HeadObjectCommand({ Bucket: getR2Bucket(), Key: r2Key }));
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const db = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const candidates = await loadCandidates(db);
  console.log(`Candidates (status=completed, reference_flipped_at IS NULL): ${candidates.length} (expect 604 on first run)`);

  if (!APPLY) {
    // ---- DRY RUN — read-only, zero writes ----
    let willUpdate = 0;
    let alreadyFlippedNeedsCheckpoint = 0;
    let missingR2Object = 0;
    const drifts: DriftDetail[] = [];

    for (const c of candidates) {
      const result = await classify(db, c);
      if (result.status === 'update') {
        const exists = await objectExistsInR2(c.r2Key);
        if (exists) {
          willUpdate++;
        } else {
          missingR2Object++;
          drifts.push({ ...c, currentMediaUrl: result.currentMediaUrl, reason: 'R2 object missing at HeadObject time' });
        }
      } else if (result.status === 'already-flipped') {
        alreadyFlippedNeedsCheckpoint++;
      } else {
        drifts.push({ ...c, currentMediaUrl: result.currentMediaUrl, reason: 'media_url matches neither source_url nor r2_key' });
      }
    }

    console.log('\n--- Fase 5 DRY RUN report ---');
    console.log(`Total candidates:                                          ${candidates.length}`);
    console.log(`Would update (media_url = source_url, R2 object confirmed): ${willUpdate}`);
    console.log(`Already flipped, needs only a checkpoint stamp:             ${alreadyFlippedNeedsCheckpoint}`);
    console.log(`Drift (unexpected current value):                          ${drifts.length - missingR2Object}`);
    console.log(`Missing R2 object specifically:                            ${missingR2Object}`);
    console.log(`Total drift/divergence:                                     ${drifts.length}`);
    console.log(
      `Unambiguous correspondence for every "would update" row: ${drifts.length === 0 ? 'YES' : 'NO — see detail below, do not APPLY'}`,
    );
    if (drifts.length > 0) {
      console.log('\nDivergence detail:');
      for (const d of drifts) {
        console.log(
          `  - log=${d.logId} message=${d.rowId} account=${d.accountId} reason="${d.reason}" source_url=${d.sourceUrl} r2_key=${d.r2Key} current_media_url=${d.currentMediaUrl}`,
        );
      }
    }
    console.log('\nDRY RUN only — no writes performed. Set APPLY=1 to execute in batches of 50.');
    return;
  }

  // ---- APPLY — batches of BATCH_SIZE, checkpointed, halts on any divergence ----
  let flipped = 0;
  let checkpointedOnly = 0;
  let batchNum = 0;

  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    batchNum++;
    const batch = candidates.slice(i, i + BATCH_SIZE);

    for (const c of batch) {
      const result = await classify(db, c);

      if (result.status === 'drift') {
        console.error('\n=== DRIFT DETECTED — HALTING, NOTHING FURTHER WILL BE WRITTEN ===');
        console.error(`log=${c.logId} message=${c.rowId} account=${c.accountId}`);
        console.error(`  source_url (expected old value): ${c.sourceUrl}`);
        console.error(`  r2_key (intended new value):     ${c.r2Key}`);
        console.error(`  current media_url in DB:         ${result.currentMediaUrl}`);
        console.error(`Rows successfully flipped before halt:    ${flipped}`);
        console.error(`Rows checkpoint-only stamped before halt: ${checkpointedOnly}`);
        process.exitCode = 1;
        return;
      }

      if (result.status === 'update') {
        const exists = await objectExistsInR2(c.r2Key);
        if (!exists) {
          console.error('\n=== R2 OBJECT MISSING — HALTING, NOTHING FURTHER WILL BE WRITTEN ===');
          console.error(`log=${c.logId} message=${c.rowId} account=${c.accountId} r2_key=${c.r2Key}`);
          console.error(`Rows successfully flipped before halt:    ${flipped}`);
          console.error(`Rows checkpoint-only stamped before halt: ${checkpointedOnly}`);
          process.exitCode = 1;
          return;
        }

        // Guarded, atomic, single-row UPDATE — if the row changed since
        // classify() ran a moment ago (a genuine race), this matches 0
        // rows instead of overwriting blindly, and we halt rather than
        // silently treating 0-matched as success.
        const { data: updated, error: updErr } = await db
          .from('messages')
          .update({ media_url: c.r2Key })
          .eq('id', c.rowId)
          .eq('media_url', c.sourceUrl)
          .select('id');
        if (updErr) {
          console.error(`\n=== UPDATE FAILED — HALTING === log=${c.logId} message=${c.rowId}: ${updErr.message}`);
          console.error(`Rows successfully flipped before halt: ${flipped}`);
          process.exitCode = 1;
          return;
        }
        if (!updated || updated.length === 0) {
          console.error(`\n=== RACE DETECTED (0 rows matched guarded UPDATE) — HALTING === log=${c.logId} message=${c.rowId}`);
          console.error(`Rows successfully flipped before halt: ${flipped}`);
          process.exitCode = 1;
          return;
        }
        flipped++;
      } else {
        // already-flipped: media_url already = r2_key from an interrupted prior run — checkpoint only.
        checkpointedOnly++;
      }

      const { error: logErr } = await db
        .from('media_migration_log')
        .update({ reference_flipped_at: new Date().toISOString() })
        .eq('id', c.logId);
      if (logErr) {
        console.error(`\n=== CHECKPOINT WRITE FAILED — HALTING === log=${c.logId}: ${logErr.message}`);
        console.error(`Rows successfully flipped before halt: ${flipped}`);
        process.exitCode = 1;
        return;
      }
    }

    console.log(
      `[checkpoint] batch ${batchNum}: processed ${Math.min(i + BATCH_SIZE, candidates.length)}/${candidates.length} — cumulative flipped=${flipped}, checkpoint-only=${checkpointedOnly}`,
    );
  }

  console.log('\n--- Fase 5 APPLY report ---');
  console.log(`Total candidates:                        ${candidates.length}`);
  console.log(`Flipped (media_url updated to r2_key):   ${flipped}`);
  console.log(`Checkpoint-only (already flipped prior):  ${checkpointedOnly}`);
  console.log('Halted early: no — all candidates processed.');
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
