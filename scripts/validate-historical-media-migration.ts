/**
 * Fase 4 of the Supabase Storage -> Cloudflare R2 media migration:
 * EXHAUSTIVE, INDEPENDENT validation of Fase 3's copy. Strictly
 * read-only — no writes to Supabase, no writes/deletes in R2, no
 * reference changes anywhere. Re-derives everything from scratch
 * (re-downloads and re-hashes both sides) rather than trusting Fase
 * 3's own recorded values, per the explicit "não confie no relatório
 * da migração" requirement.
 *
 * Checks, per completed `media_migration_log` row (604 expected):
 *   1. original object still exists in Supabase
 *   2. migrated object exists in R2
 *   3. size matches (Supabase live vs R2 live vs recorded)
 *   4. sha256 matches (Supabase live vs R2 live vs recorded)
 *   5. MIME type matches (Supabase live vs R2 live)
 *   6. the source row (messages/message_templates) still exists and its
 *      media_url/header_media_url still equals what was migrated
 * Then, across the 312 expected physical `media_objects` rows:
 *   7. every dedup group (>1 log row sharing an r2_key) shares one sha256
 *   8. reference_count >= the number of Fase-3 rows pointing at it
 *      (>= not == — live Fase 2 traffic can organically bump this
 *      further while this script runs; only *less than expected* is a
 *      real problem)
 *   9. every migration_log row's r2_key actually has a media_objects row
 *      that exists in R2 (no dangling reference)
 *  10. every physical object Fase 3 touched has at least one
 *      migration_log row pointing at it (no orphan)
 * Plus, independently:
 *  11. every `messages.document_thumbnail_url` is still a live Supabase
 *      chat-media URL (never touched by Fase 3)
 *  12. every `profiles.avatar_url` is still a live Supabase avatars URL
 *      (never touched by Fase 3)
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/validate-historical-media-migration.ts
 */
import { createHash } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getR2Bucket, getR2Client } from '../src/lib/storage/r2-client';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;

interface Divergence {
  category:
    | 'reference-inconsistent'
    | 'missing-file'
    | 'size-mismatch'
    | 'hash-mismatch'
    | 'mime-mismatch'
    | 'dedup-inconsistent'
    | 'reference-count-inconsistent'
    | 'orphan-reference'
    | 'thumbnail-altered'
    | 'thumbnail-missing'
    | 'avatar-altered'
    | 'avatar-missing';
  logId?: string;
  sourceTable?: string;
  rowId?: string;
  r2Key?: string;
  detail: string;
}

interface MigrationLogRow {
  id: string;
  source_table: string;
  source_column: string;
  source_row_id: string;
  source_url: string;
  r2_key: string;
  sha256: string | null;
  size_bytes: number | null;
  content_type: string | null;
}

async function streamToBuffer(body: unknown): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  // AWS SDK v3 Node responses implement the async iterable protocol.
  for await (const chunk of body as AsyncIterable<Uint8Array>) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function main() {
  const db: SupabaseClient = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const r2 = getR2Client();
  const bucket = getR2Bucket();

  const divergences: Divergence[] = [];
  let totalVerified = 0;
  let totalOk = 0;

  const { data: logRows, error: logErr } = await db
    .from('media_migration_log')
    .select('*')
    .eq('status', 'completed');
  if (logErr) throw logErr;
  const logs = (logRows ?? []) as MigrationLogRow[];

  console.log(`Loaded ${logs.length} completed migration_log rows (expect 604).\n`);

  for (const log of logs) {
    totalVerified++;
    let rowOk = true;

    // 6. reference still points at what was migrated
    const table = log.source_table as 'messages' | 'message_templates';
    const col = log.source_column as 'media_url' | 'header_media_url';
    const { data: sourceRow, error: srcErr } = await db
      .from(table)
      .select(`id, ${col}`)
      .eq('id', log.source_row_id)
      .maybeSingle();
    if (srcErr || !sourceRow) {
      divergences.push({
        category: 'reference-inconsistent',
        logId: log.id,
        sourceTable: table,
        rowId: log.source_row_id,
        detail: `Source row no longer exists in ${table}`,
      });
      rowOk = false;
    } else if ((sourceRow as Record<string, unknown>)[col] !== log.source_url) {
      divergences.push({
        category: 'reference-inconsistent',
        logId: log.id,
        sourceTable: table,
        rowId: log.source_row_id,
        detail: `${table}.${col} changed since migration: now "${(sourceRow as Record<string, unknown>)[col]}", expected "${log.source_url}"`,
      });
      rowOk = false;
    }

    // 1 + raw material for 3/4/5
    let supabaseBuffer: Buffer | null = null;
    let supabaseContentType: string | null = null;
    try {
      const res = await fetch(log.source_url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      supabaseContentType = res.headers.get('content-type');
      supabaseBuffer = Buffer.from(await res.arrayBuffer());
    } catch (err) {
      divergences.push({
        category: 'missing-file',
        logId: log.id,
        sourceTable: table,
        rowId: log.source_row_id,
        detail: `Original object missing/unreachable in Supabase: ${(err as Error).message}`,
      });
      rowOk = false;
    }

    // 2 + raw material for 3/4/5
    let r2Buffer: Buffer | null = null;
    let r2ContentType: string | null = null;
    try {
      const obj = await r2.send(new GetObjectCommand({ Bucket: bucket, Key: log.r2_key }));
      r2ContentType = obj.ContentType ?? null;
      r2Buffer = await streamToBuffer(obj.Body);
    } catch (err) {
      divergences.push({
        category: 'missing-file',
        logId: log.id,
        r2Key: log.r2_key,
        detail: `Migrated object missing/unreachable in R2: ${(err as Error).message}`,
      });
      rowOk = false;
    }

    if (supabaseBuffer && r2Buffer) {
      // 3. size
      if (supabaseBuffer.byteLength !== r2Buffer.byteLength) {
        divergences.push({
          category: 'size-mismatch',
          logId: log.id,
          r2Key: log.r2_key,
          detail: `Supabase ${supabaseBuffer.byteLength}B vs R2 ${r2Buffer.byteLength}B (live)`,
        });
        rowOk = false;
      }
      if (log.size_bytes != null && log.size_bytes !== supabaseBuffer.byteLength) {
        divergences.push({
          category: 'size-mismatch',
          logId: log.id,
          r2Key: log.r2_key,
          detail: `Recorded size ${log.size_bytes}B vs live Supabase ${supabaseBuffer.byteLength}B`,
        });
        rowOk = false;
      }

      // 4. sha256 — fresh on both sides, cross-checked against the recorded value
      const shaSupabase = createHash('sha256').update(supabaseBuffer).digest('hex');
      const shaR2 = createHash('sha256').update(r2Buffer).digest('hex');
      if (shaSupabase !== shaR2) {
        divergences.push({
          category: 'hash-mismatch',
          logId: log.id,
          r2Key: log.r2_key,
          detail: `Live Supabase sha256 ${shaSupabase} != live R2 sha256 ${shaR2}`,
        });
        rowOk = false;
      }
      if (log.sha256 && log.sha256 !== shaSupabase) {
        divergences.push({
          category: 'hash-mismatch',
          logId: log.id,
          r2Key: log.r2_key,
          detail: `Recorded sha256 ${log.sha256} != live Supabase sha256 ${shaSupabase}`,
        });
        rowOk = false;
      }

      // 5. MIME (compare base type, ignore charset/codec suffix noise)
      const baseType = (s: string | null) => s?.split(';')[0]?.trim().toLowerCase() ?? null;
      if (baseType(supabaseContentType) !== baseType(r2ContentType)) {
        divergences.push({
          category: 'mime-mismatch',
          logId: log.id,
          r2Key: log.r2_key,
          detail: `Supabase content-type "${supabaseContentType}" vs R2 "${r2ContentType}"`,
        });
        rowOk = false;
      }
    }

    if (rowOk) totalOk++;
    if (totalVerified % 50 === 0) console.log(`...${totalVerified}/${logs.length} checked`);
  }

  // --- Cross-checks against media_objects (7, 8, 9, 10) ---
  const { data: objectRows, error: objErr } = await db
    .from('media_objects')
    .select('id, object_key, sha256, reference_count')
    .eq('visibility', 'private');
  if (objErr) throw objErr;
  const objects = objectRows ?? [];

  const byKey = new Map<string, MigrationLogRow[]>();
  for (const log of logs) {
    const arr = byKey.get(log.r2_key) ?? [];
    arr.push(log);
    byKey.set(log.r2_key, arr);
  }

  let physicalObjectsChecked = 0;
  let dedupGroupsChecked = 0;

  for (const obj of objects) {
    const referencingLogs = byKey.get(obj.object_key) ?? [];
    if (referencingLogs.length === 0) continue; // untouched by Fase 3 (e.g. pure Fase-2 live upload) — out of this report's scope
    physicalObjectsChecked++;

    // 9. still resolvable in R2 (independent HEAD, not reusing the GetObject above)
    try {
      await r2.send(new HeadObjectCommand({ Bucket: bucket, Key: obj.object_key }));
    } catch (err) {
      divergences.push({
        category: 'orphan-reference',
        r2Key: obj.object_key,
        detail: `media_objects row references a key HeadObject can't find in R2: ${(err as Error).message}`,
      });
    }

    // 7. dedup-group coherence
    if (referencingLogs.length > 1) {
      dedupGroupsChecked++;
      const distinctHashes = new Set(referencingLogs.map((l) => l.sha256));
      if (distinctHashes.size > 1) {
        divergences.push({
          category: 'dedup-inconsistent',
          r2Key: obj.object_key,
          detail: `Dedup group has ${distinctHashes.size} distinct recorded sha256 values: ${[...distinctHashes].join(', ')}`,
        });
      }
    }

    // 8. reference_count coherence (>= expected; live traffic can only add more)
    if (obj.reference_count < referencingLogs.length) {
      divergences.push({
        category: 'reference-count-inconsistent',
        r2Key: obj.object_key,
        detail: `reference_count=${obj.reference_count} but ${referencingLogs.length} migration_log row(s) point at it`,
      });
    }
  }

  // 10. every referenced key has a media_objects row at all
  const objectKeySet = new Set(objects.map((o) => o.object_key));
  for (const [key, group] of byKey) {
    if (!objectKeySet.has(key)) {
      divergences.push({
        category: 'orphan-reference',
        r2Key: key,
        detail: `${group.length} migration_log row(s) point at a key with no media_objects row at all`,
      });
    }
  }

  // --- 11. Thumbnails intact (never touched by Fase 3) ---
  const { data: thumbRows } = await db
    .from('messages')
    .select('id, document_thumbnail_url')
    .not('document_thumbnail_url', 'is', null);
  let thumbsChecked = 0;
  let thumbsOk = 0;
  for (const t of thumbRows ?? []) {
    thumbsChecked++;
    const url = t.document_thumbnail_url as string;
    if (!url.includes('/storage/v1/object/public/chat-media/')) {
      divergences.push({ category: 'thumbnail-altered', rowId: t.id, detail: `document_thumbnail_url no longer a Supabase chat-media URL: ${url}` });
      continue;
    }
    try {
      const res = await fetch(url, { method: 'HEAD' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      thumbsOk++;
    } catch (err) {
      divergences.push({ category: 'thumbnail-missing', rowId: t.id, detail: `Thumbnail unreachable: ${(err as Error).message}` });
    }
  }

  // --- 12. Avatars intact (never touched by Fase 3) ---
  const { data: avatarRows } = await db
    .from('profiles')
    .select('id, avatar_url')
    .not('avatar_url', 'is', null);
  let avatarsChecked = 0;
  let avatarsOk = 0;
  for (const a of avatarRows ?? []) {
    avatarsChecked++;
    const url = a.avatar_url as string;
    if (!url.includes('/storage/v1/object/public/avatars/')) {
      divergences.push({ category: 'avatar-altered', rowId: a.id, detail: `avatar_url no longer a Supabase avatars URL: ${url}` });
      continue;
    }
    try {
      const res = await fetch(url, { method: 'HEAD' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      avatarsOk++;
    } catch (err) {
      divergences.push({ category: 'avatar-missing', rowId: a.id, detail: `Avatar unreachable: ${(err as Error).message}` });
    }
  }

  // --- Final report ---
  console.log('\n=== Fase 4 Validation Report ===');
  console.log(`Logical references verified: ${totalVerified} (expect 604)`);
  console.log(`OK: ${totalOk}`);
  console.log(`Physical objects cross-checked: ${physicalObjectsChecked} (expect 312)`);
  console.log(`Dedup groups checked: ${dedupGroupsChecked}`);
  console.log(`Thumbnails checked: ${thumbsChecked}, OK: ${thumbsOk}`);
  console.log(`Avatars checked: ${avatarsChecked}, OK: ${avatarsOk}`);
  console.log(`\nTotal divergences: ${divergences.length}`);
  const byCategory: Record<string, number> = {};
  for (const d of divergences) byCategory[d.category] = (byCategory[d.category] ?? 0) + 1;
  console.log('By category:', byCategory);
  if (divergences.length > 0) {
    console.log('\n--- Divergence details ---');
    for (const d of divergences) console.log(JSON.stringify(d));
  } else {
    console.log('\nNo divergences found.');
  }
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
