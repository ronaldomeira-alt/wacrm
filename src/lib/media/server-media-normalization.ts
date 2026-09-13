import { createHash } from 'node:crypto';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getR2Bucket, getR2Client, RESOLVE_TTL_SECONDS } from '@/lib/storage/r2-client';
import { supabaseAdmin } from '@/lib/storage/admin-client';
import { normalizePropertyImage } from '@/lib/media/normalize-property-image';

export type ProcessingStatus = 'none' | 'pending' | 'processing' | 'completed' | 'failed';

export interface ProcessMediaJob {
  objectKey: string;
  accountId: string;
}

export interface MediaProcessingStatusResult {
  key: string;
  status: ProcessingStatus;
  normalizedKey?: string;
  resolvedUrl?: string;
  error?: string;
}

/**
 * Server-side task queue with controlled concurrency (default = 1).
 * Ensures memory safety: prevents simultaneous decoding of multiple massive 24MP/48MP HEIC photos.
 */
class ServerTaskQueue {
  private queue: Array<() => Promise<void>> = [];
  private running = 0;
  private concurrency: number;

  constructor(concurrency = 1) {
    this.concurrency = concurrency;
  }

  add(task: () => Promise<void>): void {
    this.queue.push(task);
    this.next();
  }

  private next(): void {
    if (this.running >= this.concurrency || this.queue.length === 0) return;
    const task = this.queue.shift();
    if (!task) return;
    this.running++;
    task().finally(() => {
      this.running--;
      this.next();
    });
  }
}

const normalizationQueue = new ServerTaskQueue(2);

/**
 * Executes server-side normalization of an image object directly from R2 to R2.
 * The original image (e.g. HEIC from iPhone) is preserved, and a WhatsApp-compliant
 * JPEG (<= 5MB) is saved and linked in media_objects.
 */
export async function normalizeMediaObjectInR2(job: ProcessMediaJob): Promise<{ normalizedKey: string }> {
  const { objectKey, accountId } = job;
  const admin = supabaseAdmin();
  const client = getR2Client();
  const bucket = getR2Bucket();

  // Mark as actively processing
  await admin
    .from('media_objects')
    .update({
      processing_status: 'processing',
      processing_error: null,
    })
    .eq('account_id', accountId)
    .eq('object_key', objectKey);

  try {
    // 1. Download original bytes from R2
    const getCommand = new GetObjectCommand({ Bucket: bucket, Key: objectKey });
    const getRes = await client.send(getCommand);
    const byteArray = await getRes.Body?.transformToByteArray();

    if (!byteArray || byteArray.length === 0) {
      throw new Error(`Objeto não encontrado ou vazio no R2: ${objectKey}`);
    }

    const inputBuffer = Buffer.from(byteArray);

    // 2. Normalize image (HEIC decode, orientation, resize to max 2560px, JPEG compression <= 5MB)
    const normalized = await normalizePropertyImage(inputBuffer, {
      maxBytes: 5 * 1024 * 1024,
      maxWidth: 2560,
      maxHeight: 2560,
      quality: 85,
    });

    // 3. Build normalized key
    const normalizedKey = objectKey.replace(/\.[^.]+$/, '') + '-norm.jpg';
    const sha256 = createHash('sha256').update(normalized.buffer).digest('hex');

    // 4. Upload normalized JPEG to R2
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: normalizedKey,
        Body: normalized.buffer,
        ContentType: 'image/jpeg',
        CacheControl: 'private, max-age=31536000, immutable',
      }),
    );

    // 5. Register normalized JPEG in media_objects
    await admin.from('media_objects').upsert(
      {
        account_id: accountId,
        sha256,
        object_key: normalizedKey,
        original_key: objectKey,
        bucket,
        visibility: 'private',
        kind: 'image',
        content_type: 'image/jpeg',
        size_bytes: normalized.buffer.length,
        status: 'completed',
        confirmed_at: new Date().toISOString(),
        processing_status: 'completed',
      },
      { onConflict: 'account_id,sha256,visibility' },
    );

    // 6. Update original row with pointer to normalized key
    await admin
      .from('media_objects')
      .update({
        normalized_key: normalizedKey,
        processing_status: 'completed',
        processing_error: null,
      })
      .eq('account_id', accountId)
      .eq('object_key', objectKey);

    return { normalizedKey };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[media/normalize-r2] Error normalizing ${objectKey}:`, err);

    await admin
      .from('media_objects')
      .update({
        processing_status: 'failed',
        processing_error: errorMsg,
      })
      .eq('account_id', accountId)
      .eq('object_key', objectKey);

    throw err;
  }
}

/**
 * Enqueues normalization in background without waiting for completion.
 * Does not keep the client HTTP connection open.
 */
export function enqueueMediaNormalization(job: ProcessMediaJob): void {
  normalizationQueue.add(async () => {
    try {
      await normalizeMediaObjectInR2(job);
    } catch (err) {
      console.error('[media/queue] Background normalization failed:', err);
    }
  });
}

/**
 * Checks processing status for a list of object keys.
 * For completed items, generates signed GET URLs so the client can immediately preview the JPEG.
 */
export async function getMediaProcessingStatuses(
  keys: string[],
  accountId: string,
): Promise<Record<string, MediaProcessingStatusResult>> {
  if (!keys || keys.length === 0) return {};

  const admin = supabaseAdmin();
  const { data: rows, error } = await admin
    .from('media_objects')
    .select('object_key, processing_status, normalized_key, processing_error, content_type')
    .eq('account_id', accountId)
    .in('object_key', keys);

  if (error || !rows) {
    console.error('[media/status] Failed to fetch statuses:', error);
    return {};
  }

  const client = getR2Client();
  const bucket = getR2Bucket();
  const results: Record<string, MediaProcessingStatusResult> = {};

  for (const row of rows) {
    const status = (row.processing_status as ProcessingStatus) || 'none';
    let resolvedUrl: string | undefined;

    if (status === 'completed' && row.normalized_key) {
      try {
        resolvedUrl = await getSignedUrl(
          client,
          new GetObjectCommand({
            Bucket: bucket,
            Key: row.normalized_key,
            ResponseCacheControl: 'private, max-age=86400, immutable',
          }),
          { expiresIn: RESOLVE_TTL_SECONDS },
        );
      } catch (e) {
        console.warn('[media/status] Failed to sign resolved URL:', e);
      }
    }

    results[row.object_key] = {
      key: row.object_key,
      status,
      normalizedKey: row.normalized_key ?? undefined,
      resolvedUrl,
      error: row.processing_error ?? undefined,
    };
  }

  return results;
}
