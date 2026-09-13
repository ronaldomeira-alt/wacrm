import { NextResponse } from 'next/server';
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { hasMinRole } from '@/lib/auth/roles';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { getR2Bucket, getR2Client } from '@/lib/storage/r2-client';
import { buildMediaPath } from '@/lib/storage/upload-media';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import {
  normalizePropertyImage,
  isHeicBuffer,
  MAX_UPLOAD_INPUT_BYTES,
} from '@/lib/media/normalize-property-image';
import { sha256Hex } from '@/lib/media/hash-file';

export const maxDuration = 60; // 60s for high-res photo processing

export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId, role } = await getCurrentAccount();

    if (!hasMinRole(role, 'agent')) {
      return NextResponse.json(
        { error: 'Permissão insuficiente para normalizar mídia' },
        { status: 403 },
      );
    }

    const limit = checkRateLimit('media-upload:' + userId, RATE_LIMITS.mediaUpload);
    if (!limit.success) return rateLimitResponse(limit);

    const formData = await request.formData();
    const file = formData.get('file');
    const preserveOriginalParam = formData.get('preserveOriginal');
    const shouldPreserveOriginal = preserveOriginalParam === 'true';

    if (!file || !(file instanceof Blob)) {
      return NextResponse.json(
        { error: 'Arquivo ausente ou inválido' },
        { status: 400 },
      );
    }

    if (file.size > MAX_UPLOAD_INPUT_BYTES * 2) {
      // 32 MB absolute ceiling
      return NextResponse.json(
        { error: 'Arquivo excede o limite máximo permitido' },
        { status: 400 },
      );
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    if (buffer.length === 0) {
      return NextResponse.json(
        { error: 'Arquivo de imagem vazio' },
        { status: 400 },
      );
    }

    let originalKey: string | undefined;

    // Preserve original in R2 if requested and file is HEIC/HEIF
    if (shouldPreserveOriginal && isHeicBuffer(buffer)) {
      try {
        const client = getR2Client();
        const bucket = getR2Bucket();
        const filename = (file as File).name || 'image.heic';
        const key = buildMediaPath(accountId, 'orig-' + Date.now() + '-' + filename);
        const sha = await sha256Hex(file as File);

        await client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: buffer,
            ContentType: file.type || 'image/heic',
          }),
        );

        // Record in media_objects
        await supabase.from('media_objects').insert({
          account_id: accountId,
          sha256: sha,
          object_key: key,
          bucket,
          visibility: 'private',
          kind: 'image',
          content_type: file.type || 'image/heic',
          size_bytes: buffer.length,
          status: 'completed',
          confirmed_at: new Date().toISOString(),
        });

        originalKey = key;
      } catch (err) {
        console.warn('[media/normalize] Failed to preserve original HEIC to R2:', err);
      }
    }

    // Perform normalization (EXIF rotate, HEIC/WebP decode, downscale <= 3840px, JPEG compress <= 5MB)
    const normalized = await normalizePropertyImage(buffer);

    const headers = new Headers();
    headers.set('Content-Type', normalized.contentType);
    headers.set('Content-Length', String(normalized.fileSize));
    headers.set('X-Original-Format', normalized.originalFormat || 'unknown');
    headers.set('X-Image-Width', String(normalized.width));
    headers.set('X-Image-Height', String(normalized.height));
    if (originalKey) {
      headers.set('X-Original-Key', originalKey);
    }

    return new NextResponse(new Uint8Array(normalized.buffer), {
      status: 200,
      headers,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
