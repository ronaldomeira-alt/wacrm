/**
 * Fase 6 of the Supabase Storage -> Cloudflare R2 media migration: FINAL
 * CLEANUP. Deletes ONLY the 604 original objects in the Supabase
 * `chat-media` bucket that were:
 *   - copied to R2 in Fase 3,
 *   - independently re-verified (hash/size/MIME, 0 divergences) in
 *     Fase 4,
 *   - and whose `messages.media_url` reference was flipped from the old
 *     Supabase URL to the R2 key in Fase 5.
 *
 * Never touches, by construction of the candidate query alone:
 *   - message_templates (0 eligible rows, confirmed by both the Fase 5
 *     and Fase 6 read-only audits)
 *   - PDF thumbnails (`doc-thumbs/` paths — a different column,
 *     document_thumbnail_url, never read or matched here; also
 *     defensively re-checked per-row below)
 *   - avatars (a different bucket entirely, never referenced)
 *   - flow-media (a different bucket entirely, never referenced)
 *   - the 110 other chat-media objects that are NOT in the 604-row
 *     migration log (whatever they are — out of scope by construction,
 *     since the only deletion target is an explicit list of exact
 *     object paths derived from media_migration_log, never a bucket-
 *     wide or prefix-wide delete)
 *
 * Defensive re-checks per row, immediately before deleting (the DB can
 * have changed since the Fase 6 read-only audit ran):
 *   1. messages.media_url must still equal the logged r2_key (Fase 5's
 *      flip must still be in effect — if it's been reverted for any
 *      reason, deleting the Supabase original would be destructive and
 *      unrecoverable, so this HALTS the whole run instead of skipping).
 *   2. media_objects must still have a completed row for that r2_key,
 *      in bucket wacrm-media — confirms the R2 copy this deletion
 *      depends on is still known-good.
 *   3. the derived storage.objects path must not contain "doc-thumbs"
 *      (belt-and-braces on top of Fase 3's own filter).
 *
 * Checkpointed and resumable via `storage_deleted_at` (added by
 * 20260907094500_media_migration_log_storage_cleanup.sql), the same
 * pattern as Fase 5's `reference_flipped_at`. Any anomaly halts the
 * entire run immediately — never a partial/silent batch.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/cleanup-historical-storage.ts          (dry run — reports only, zero deletes)
 *   APPLY=1 npx tsx --env-file=.env.local scripts/cleanup-historical-storage.ts  (deletes, batches of 50, checkpointed)
 */
const APPLY = process.env.APPLY === '1';
const BATCH_SIZE = 50;
const BUCKET = 'chat-media';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;

interface Candidate {
  logId: string;
  rowId: string;
  accountId: string;
  sourceUrl: string;
  r2Key: string;
  storagePath: string;
  sizeBytes: number | null;
}

function derivePath(sourceUrl: string): string {
  return sourceUrl.replace(/^.*\/chat-media\//, '');
}

async function loadCandidates(db: SupabaseClient): Promise<Candidate[]> {
  const { data, error } = await db
    .from('media_migration_log')
    .select('id, source_row_id, account_id, source_url, r2_key, size_bytes')
    .eq('source_table', 'messages')
    .eq('status', 'completed')
    .is('storage_deleted_at', null)
    .order('id');
  if (error) throw error;
  return ((data ?? []) as Array<{
    id: string;
    source_row_id: string;
    account_id: string;
    source_url: string;
    r2_key: string;
    size_bytes: number | null;
  }>).map((r) => ({
    logId: r.id,
    rowId: r.source_row_id,
    accountId: r.account_id,
    sourceUrl: r.source_url,
    r2Key: r.r2_key,
    storagePath: derivePath(r.source_url),
    sizeBytes: r.size_bytes,
  }));
}

interface Anomaly {
  logId: string;
  rowId: string;
  reason: string;
  detail: string;
}

async function checkRow(db: SupabaseClient, c: Candidate): Promise<Anomaly | null> {
  if (c.storagePath.includes('doc-thumbs')) {
    return { logId: c.logId, rowId: c.rowId, reason: 'thumbnail-path-in-candidate-set', detail: c.storagePath };
  }

  const { data: msg, error: msgErr } = await db
    .from('messages')
    .select('media_url')
    .eq('id', c.rowId)
    .maybeSingle();
  if (msgErr) throw msgErr;
  const currentMediaUrl = (msg?.media_url as string | null | undefined) ?? null;
  if (currentMediaUrl !== c.r2Key) {
    return {
      logId: c.logId,
      rowId: c.rowId,
      reason: 'reference-not-flipped-to-r2-key',
      detail: `expected r2_key=${c.r2Key}, found media_url=${currentMediaUrl}`,
    };
  }

  const { data: mo, error: moErr } = await db
    .from('media_objects')
    .select('id, status, bucket, object_key')
    .eq('account_id', c.accountId)
    .eq('object_key', c.r2Key)
    .maybeSingle();
  if (moErr) throw moErr;
  if (!mo || mo.status !== 'completed' || mo.bucket !== 'wacrm-media') {
    return {
      logId: c.logId,
      rowId: c.rowId,
      reason: 'media_objects-not-completed-or-wrong-bucket',
      detail: JSON.stringify(mo),
    };
  }

  return null;
}

async function main() {
  const db = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const candidates = await loadCandidates(db);
  console.log(`Candidates (status=completed, storage_deleted_at IS NULL): ${candidates.length} (expect 604 on first run)`);

  if (!APPLY) {
    let ok = 0;
    const anomalies: Anomaly[] = [];
    for (const c of candidates) {
      const anomaly = await checkRow(db, c);
      if (anomaly) anomalies.push(anomaly);
      else ok++;
    }
    const totalBytes = candidates.reduce((sum, c) => sum + (c.sizeBytes ?? 0), 0);
    console.log('\n--- Fase 6 DRY RUN report ---');
    console.log(`Total candidates:              ${candidates.length}`);
    console.log(`Safe to delete (all checks OK): ${ok}`);
    console.log(`Anomalies (would halt if APPLY): ${anomalies.length}`);
    console.log(`Total bytes eligible:          ${totalBytes} (${(totalBytes / 1024 / 1024).toFixed(2)} MB)`);
    if (anomalies.length > 0) {
      console.log('\nAnomaly detail:');
      for (const a of anomalies) {
        console.log(`  - log=${a.logId} message=${a.rowId} reason=${a.reason} detail=${a.detail}`);
      }
    }
    console.log('\nDRY RUN only — no deletes performed. Set APPLY=1 to execute in batches of 50.');
    return;
  }

  // ---- APPLY — batches of BATCH_SIZE, checkpointed, halts on any anomaly ----
  let deleted = 0;
  let deletedBytes = 0;
  let batchNum = 0;

  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    batchNum++;
    const batch = candidates.slice(i, i + BATCH_SIZE);

    // Re-check every row in the batch before deleting any of it.
    for (const c of batch) {
      const anomaly = await checkRow(db, c);
      if (anomaly) {
        console.error('\n=== ANOMALY DETECTED — HALTING, NOTHING FURTHER WILL BE DELETED ===');
        console.error(`log=${anomaly.logId} message=${anomaly.rowId} reason=${anomaly.reason}`);
        console.error(`  detail: ${anomaly.detail}`);
        console.error(`Objects successfully deleted before halt: ${deleted}`);
        console.error(`Bytes freed before halt: ${deletedBytes}`);
        process.exitCode = 1;
        return;
      }
    }

    const paths = batch.map((c) => c.storagePath);
    const { data: removed, error: removeErr } = await db.storage.from(BUCKET).remove(paths);
    if (removeErr) {
      console.error(`\n=== STORAGE REMOVE FAILED — HALTING === batch ${batchNum}: ${removeErr.message}`);
      console.error(`Objects successfully deleted before halt: ${deleted}`);
      console.error(`Bytes freed before halt: ${deletedBytes}`);
      process.exitCode = 1;
      return;
    }

    const removedNames = new Set((removed ?? []).map((r) => r.name));
    const notRemoved = batch.filter((c) => !removedNames.has(c.storagePath));
    if (notRemoved.length > 0) {
      console.error(`\n=== PARTIAL BATCH FAILURE — HALTING === batch ${batchNum}`);
      console.error(`Requested ${batch.length}, storage confirmed ${removedNames.size} removed.`);
      console.error('Not confirmed removed:');
      for (const c of notRemoved) {
        console.error(`  - log=${c.logId} message=${c.rowId} path=${c.storagePath}`);
      }
      console.error(`Objects successfully deleted before halt (this batch not counted): ${deleted}`);
      console.error(`Bytes freed before halt: ${deletedBytes}`);
      process.exitCode = 1;
      return;
    }

    // Verification: the Storage API's remove() response above already
    // confirmed every path in this batch by name (notRemoved check) —
    // storage.objects isn't reachable via PostgREST in this project
    // (only public/graphql_public are exposed), so there's no second,
    // independent DB-level check available; the confirmed-removed list
    // from remove() itself is the verification.

    for (const c of batch) {
      const { error: logErr } = await db
        .from('media_migration_log')
        .update({ storage_deleted_at: new Date().toISOString() })
        .eq('id', c.logId);
      if (logErr) {
        console.error(`\n=== CHECKPOINT WRITE FAILED — HALTING === log=${c.logId}: ${logErr.message}`);
        console.error(`Objects successfully deleted before halt: ${deleted} (this one's file IS deleted, only the checkpoint stamp failed)`);
        process.exitCode = 1;
        return;
      }
      deleted++;
      deletedBytes += c.sizeBytes ?? 0;
    }

    console.log(
      `[checkpoint] batch ${batchNum}: processed ${Math.min(i + BATCH_SIZE, candidates.length)}/${candidates.length} — cumulative deleted=${deleted}, bytes freed=${deletedBytes}`,
    );
  }

  console.log('\n--- Fase 6 APPLY report ---');
  console.log(`Total candidates: ${candidates.length}`);
  console.log(`Deleted:          ${deleted}`);
  console.log(`Bytes freed:      ${deletedBytes} (${(deletedBytes / 1024 / 1024).toFixed(2)} MB)`);
  console.log('Halted early: no — all candidates processed.');
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
