-- Cloudflare R2 media migration (Fase 1): dedup + bookkeeping table for
-- every object the app writes to R2. Purely additive — no existing
-- table is touched, `messages.media_url` / `message_templates
-- .header_media_url` keep their current shape (a legacy Supabase URL,
-- the Meta inbound proxy path, or now also a bare R2 key / a public-
-- bucket permanent URL, distinguished at read time by string shape,
-- not by a schema change — see src/lib/storage/r2-client.ts).
--
-- Two visibilities, two physical R2 buckets (see r2-client.ts's doc
-- comment): 'private' (chat-media-equivalent content — conversation
-- attachments, forwarded media, voice notes; every read goes through a
-- short-TTL signed URL) and 'public' (deliberately, permanently
-- shareable content — currently only WhatsApp template header images;
-- served off a Custom Domain as a plain https:// URL). The two are
-- distinct buckets under distinct credentials, so the same file
-- uploaded once for each purpose is legitimately two different
-- physical objects — the dedup key includes `visibility` for exactly
-- this reason.

create table public.media_objects (
  id uuid primary key default gen_random_uuid(),
  account_id uuid references public.accounts(id) on delete cascade not null,
  sha256 text not null,
  object_key text not null,
  -- Actual R2 bucket name the object lives in (e.g. 'wacrm-media' or
  -- 'wacrm-media-public') — kept alongside `visibility` so a future
  -- bucket rename/rotation doesn't require inferring it from visibility.
  bucket text not null,
  visibility text not null check (visibility in ('public', 'private')),
  -- Only set for visibility='public' — the permanent Custom Domain URL,
  -- e.g. "{R2_PUBLIC_BASE_URL}/{object_key}". Null for 'private' rows;
  -- private access is always minted on demand via /api/media/resolve,
  -- never persisted.
  public_url text,
  kind text not null check (kind in ('image', 'video', 'audio', 'document')),
  content_type text not null,
  size_bytes bigint not null,
  -- 'pending' from the moment a presigned PUT is issued; flipped to
  -- 'completed' only after /api/media/confirm-upload's HEAD-based
  -- re-validation succeeds. A 'pending' row older than the cleanup
  -- window is an abandoned/failed upload — see the partial index below
  -- and /api/media/cleanup-cron.
  status text not null default 'pending' check (status in ('pending', 'completed')),
  created_at timestamptz not null default now(),
  confirmed_at timestamptz,
  -- Bumped whenever a new upload dedup-hits this row, so a future
  -- historical-cleanup pass (Fase 6) can tell "never reused" apart from
  -- "actively reused" objects. Not touched by reads (resolve/signed-URL
  -- generation), only by a genuine new-upload dedup hit.
  last_referenced_at timestamptz not null default now(),
  -- Reference count, starting at 1 for the upload that created the
  -- row. A dedup hit (a second upload with the same account/sha256/
  -- visibility) increments this instead of writing a second physical
  -- object; /api/media/delete decrements it and only issues a real
  -- DeleteObjectCommand + row delete once it reaches 0. Without this,
  -- deleting a staged-but-discarded draft could silently destroy an
  -- object an *earlier, already-sent* message still references via the
  -- exact same key (dedup means many messages can share one physical
  -- object) — this is what makes that safe.
  reference_count integer not null default 1 check (reference_count >= 0)
);

-- The actual dedup key: same account, same content, same intended
-- visibility → same physical object. Also what a concurrent-upload
-- race (two requests presigning the same file at once) collides on —
-- the loser's INSERT fails with a unique violation and re-selects the
-- winner's row instead (see /api/media/presign-upload).
create unique index media_objects_account_sha256_visibility_key
  on public.media_objects (account_id, sha256, visibility);

-- Fast orphan sweep (cleanup-cron): find pending rows past the
-- abandonment window without scanning the whole table.
create index media_objects_pending_created_at_idx
  on public.media_objects (created_at)
  where status = 'pending';

alter table public.media_objects enable row level security;

-- Same is_account_member() helper every other tenant table uses
-- (migration 017_account_sharing.sql). Delete is 'agent'-gated like
-- insert/update — GC (discarding a staged draft) and the cleanup-cron
-- endpoint both go through the service-role client anyway and are
-- unaffected by RLS either way; this only gates a session-authed user
-- deleting their own account's row directly.
create policy media_objects_select on public.media_objects for select
  using (is_account_member(account_id));

create policy media_objects_insert on public.media_objects for insert
  with check (is_account_member(account_id, 'agent'));

create policy media_objects_update on public.media_objects for update
  using (is_account_member(account_id, 'agent'));

create policy media_objects_delete on public.media_objects for delete
  using (is_account_member(account_id, 'agent'));

-- Atomic reference-count bump/release. SECURITY INVOKER (the default —
-- stated explicitly for clarity) so these run under the caller's own
-- RLS-scoped session, same as every other write in this table; they
-- exist only because postgrest-js has no `column = column + 1` update
-- expression, not to bypass RLS.
create or replace function public.increment_media_object_reference(p_object_id uuid)
returns void
language sql
security invoker
as $$
  update public.media_objects
  set reference_count = reference_count + 1,
      last_referenced_at = now()
  where id = p_object_id;
$$;

create or replace function public.decrement_media_object_reference(p_object_id uuid)
returns integer
language sql
security invoker
as $$
  update public.media_objects
  set reference_count = greatest(reference_count - 1, 0)
  where id = p_object_id
  returning reference_count;
$$;
