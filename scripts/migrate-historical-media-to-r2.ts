/**
 * Fase 3 of the Supabase Storage -> Cloudflare R2 media migration:
 * COPIES eligible historical objects from the `chat-media` Supabase
 * bucket into R2. Does not touch `messages.media_url` or
 * `message_templates.header_media_url` — those keep pointing at the
 * old Supabase URLs (the app's existing compatibility rule already
 * serves them unchanged), and nothing is deleted from Supabase.
 * Reference-flipping (Fase 5) and cleanup (Fase 6) are separate,
 * explicitly-confirmed steps.
 *
 * Eligible = `messages.media_url` or `message_templates
 * .header_media_url` pointing at the public `chat-media` bucket.
 * Explicitly excluded (never matched by the query, not filtered after
 * the fact): `flow-media`-bucket URLs, `document_thumbnail_url` (PDF
 * thumbnails — a separate column, never read here), avatars (a
 * separate bucket, never referenced by these two columns).
 *
 * Idempotent/resumable: every row is claimed in `media_migration_log`
 * (unique on source_table+source_column+source_row_id) before any
 * network work, and only rows not already `completed` are retried on a
 * re-run — a `pending` row from an interrupted run is treated the same
 * as a `failed` one (retried), never as already-done.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/migrate-historical-media-to-r2.ts          (dry run — reports only, zero writes)
 *   APPLY=1 npx tsx --env-file=.env.local scripts/migrate-historical-media-to-r2.ts  (copies + logs)
 */
const APPLY = process.env.APPLY === '1';

import { createHash } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { buildR2MediaKey, getR2Bucket, getR2Client, type MediaKind } from '../src/lib/storage/r2-client';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const CHAT_MEDIA_PREFIX = `${SUPABASE_URL.replace(/\/+$/, '')}/storage/v1/object/public/chat-media/`;

interface EligibleRow {
  sourceTable: 'messages' | 'message_templates';
  sourceColumn: 'media_url' | 'header_media_url';
  rowId: string;
  url: string;
  accountId: string;
  kind: MediaKind;
  visibility: 'private' | 'public';
}

async function findEligibleMessages(db: SupabaseClient): Promise<EligibleRow[]> {
  const { data, error } = await db
    .from('messages')
    .select('id, media_url, content_type, conversation:conversations(account_id)')
    .like('media_url', `${CHAT_MEDIA_PREFIX}%`)
    // Defensive — document_thumbnail_url is a separate column and this
    // filter never matches it, but belt-and-braces per the explicit
    // "preserve thumbnails" requirement.
    .not('media_url', 'ilike', '%doc-thumbs%');
  if (error) throw error;

  const rows: EligibleRow[] = [];
  for (const m of (data ?? []) as unknown as Array<{
    id: string;
    media_url: string;
    content_type: string;
    conversation: { account_id: string } | { account_id: string }[] | null;
  }>) {
    const conv = Array.isArray(m.conversation) ? m.conversation[0] : m.conversation;
    if (!conv?.account_id) continue; // orphaned row — shouldn't happen, skip defensively
    if (!['image', 'video', 'document', 'audio'].includes(m.content_type)) continue;
    rows.push({
      sourceTable: 'messages',
      sourceColumn: 'media_url',
      rowId: m.id,
      url: m.media_url,
      accountId: conv.account_id,
      kind: m.content_type as MediaKind,
      visibility: 'private', // matches the chat-attachment classification (Fase 2)
    });
  }
  return rows;
}

async function findEligibleTemplates(db: SupabaseClient): Promise<EligibleRow[]> {
  const { data, error } = await db
    .from('message_templates')
    .select('id, header_media_url, header_type, account_id')
    .like('header_media_url', `${CHAT_MEDIA_PREFIX}%`);
  if (error) throw error;

  return ((data ?? []) as Array<{
    id: string;
    header_media_url: string;
    header_type: string | null;
    account_id: string;
  }>).map((t) => ({
    sourceTable: 'message_templates' as const,
    sourceColumn: 'header_media_url' as const,
    rowId: t.id,
    url: t.header_media_url,
    accountId: t.account_id,
    // Only image headers were ever uploadable through the app (Fase 2's
    // template-header purpose is image-only); default defensively.
    kind: (['image', 'video', 'document'].includes(t.header_type ?? '') ? t.header_type : 'image') as MediaKind,
    visibility: 'public' as const, // matches the template-header classification (Fase 2)
  }));
}

interface Report {
  totalEligible: number;
  byKind: Record<string, number>;
  alreadyMigrated: number;
  copiedNow: number;
  dedupedNow: number;
  failed: number;
  totalBytesCopied: number;
  failures: Array<{ sourceTable: string; rowId: string; url: string; error: string }>;
}

async function main() {
  const db = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY!);

  const [messageRows, templateRows] = await Promise.all([
    findEligibleMessages(db),
    findEligibleTemplates(db),
  ]);
  const eligible = [...messageRows, ...templateRows];

  const report: Report = {
    totalEligible: eligible.length,
    byKind: {},
    alreadyMigrated: 0,
    copiedNow: 0,
    dedupedNow: 0,
    failed: 0,
    totalBytesCopied: 0,
    failures: [],
  };
  for (const row of eligible) {
    report.byKind[row.kind] = (report.byKind[row.kind] ?? 0) + 1;
  }

  console.log(`Eligible objects: ${report.totalEligible}`);
  console.log('By kind:', report.byKind);
  if (!APPLY) {
    console.log('\nDRY RUN — no network transfer, no writes. Set APPLY=1 to actually copy.');
    return;
  }

  const bucket = getR2Bucket();
  const r2 = getR2Client();

  for (const row of eligible) {
    // Claim (or find) the log row first — this single upsert is what
    // makes a re-run skip already-completed work and retry
    // failed/interrupted work, without a separate "already claimed by
    // this run" check (a one-off script run by a human, not truly
    // concurrent).
    const { data: existingLog } = await db
      .from('media_migration_log')
      .select('id, status, r2_key')
      .eq('source_table', row.sourceTable)
      .eq('source_column', row.sourceColumn)
      .eq('source_row_id', row.rowId)
      .maybeSingle();

    if (existingLog?.status === 'completed') {
      report.alreadyMigrated++;
      continue;
    }

    const logId: string = existingLog?.id ?? crypto.randomUUID();
    if (!existingLog) {
      const { error: claimError } = await db.from('media_migration_log').insert({
        id: logId,
        source_table: row.sourceTable,
        source_column: row.sourceColumn,
        source_row_id: row.rowId,
        source_url: row.url,
        account_id: row.accountId,
        kind: row.kind,
        status: 'pending',
      });
      if (claimError) {
        // Unique-violation means another process/run claimed it a
        // moment ago — safe to skip, it's being handled elsewhere.
        if ((claimError as { code?: string }).code === '23505') continue;
        report.failed++;
        report.failures.push({ sourceTable: row.sourceTable, rowId: row.rowId, url: row.url, error: claimError.message });
        continue;
      }
    }

    try {
      const res = await fetch(row.url);
      if (!res.ok) throw new Error(`Fetch failed: HTTP ${res.status}`);
      const buffer = Buffer.from(await res.arrayBuffer());
      const contentType = res.headers.get('content-type') || 'application/octet-stream';
      const sha256 = createHash('sha256').update(buffer).digest('hex');

      const { data: existingObject } = await db
        .from('media_objects')
        .select('id, object_key, status')
        .eq('account_id', row.accountId)
        .eq('sha256', sha256)
        .eq('visibility', row.visibility)
        .maybeSingle();

      let r2Key: string;
      if (existingObject?.status === 'completed') {
        await db.rpc('increment_media_object_reference', { p_object_id: existingObject.id });
        r2Key = existingObject.object_key;
        report.dedupedNow++;
      } else {
        const filename = row.url.split('/').pop() || `migrated.${row.kind === 'document' ? 'bin' : row.kind}`;
        r2Key = buildR2MediaKey(row.accountId, row.kind, filename);
        await r2.send(new PutObjectCommand({ Bucket: bucket, Key: r2Key, Body: buffer, ContentType: contentType }));

        const publicUrl = row.visibility === 'public'
          ? `${process.env.NEXT_PUBLIC_SITE_URL!.replace(/\/+$/, '')}/api/media/public/${r2Key}`
          : null;

        const { error: insertErr } = await db.from('media_objects').insert({
          account_id: row.accountId,
          sha256,
          object_key: r2Key,
          bucket,
          visibility: row.visibility,
          public_url: publicUrl,
          kind: row.kind,
          content_type: contentType,
          size_bytes: buffer.byteLength,
          status: 'completed',
          confirmed_at: new Date().toISOString(),
        });
        if (insertErr) throw new Error(`media_objects insert failed: ${insertErr.message}`);
        report.totalBytesCopied += buffer.byteLength;
        report.copiedNow++;
      }

      await db
        .from('media_migration_log')
        .update({
          r2_key: r2Key,
          sha256,
          size_bytes: buffer.byteLength,
          content_type: contentType,
          status: 'completed',
          completed_at: new Date().toISOString(),
        })
        .eq('id', logId);

      console.log(`[ok] ${row.sourceTable}/${row.rowId} -> ${r2Key}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      report.failed++;
      report.failures.push({ sourceTable: row.sourceTable, rowId: row.rowId, url: row.url, error: message });
      await db
        .from('media_migration_log')
        .update({ status: 'failed', error: message })
        .eq('id', logId);
      console.error(`[fail] ${row.sourceTable}/${row.rowId}:`, message);
    }
  }

  console.log('\n--- Fase 3 report ---');
  console.log(`Total eligible:      ${report.totalEligible}`);
  console.log(`Already migrated:    ${report.alreadyMigrated}`);
  console.log(`Copied now:          ${report.copiedNow}`);
  console.log(`Deduped now:         ${report.dedupedNow}`);
  console.log(`Failed:              ${report.failed}`);
  console.log(`Bytes copied:        ${report.totalBytesCopied} (${(report.totalBytesCopied / 1024 / 1024).toFixed(2)} MB)`);
  console.log('By kind:', report.byKind);
  if (report.failures.length > 0) {
    console.log('\nFailures:');
    for (const f of report.failures) {
      console.log(`  - ${f.sourceTable}/${f.rowId} (${f.url}): ${f.error}`);
    }
  }
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
