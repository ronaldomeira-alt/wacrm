-- Fase 3 (migração histórica Supabase Storage -> R2): tabela de
-- rastreamento pura, aditiva. NÃO toca messages nem message_templates —
-- existe só para o script scripts/migrate-historical-media-to-r2.ts
-- saber o que já copiou (idempotência/retomada) e para gerar o relatório
-- final. Sem RLS liberado para nenhum papel: só o service-role (usado
-- pelo script) acessa, por design — não é uma tabela do app.

create table public.media_migration_log (
  id uuid primary key default gen_random_uuid(),
  source_table text not null check (source_table in ('messages', 'message_templates')),
  source_column text not null check (source_column in ('media_url', 'header_media_url')),
  source_row_id uuid not null,
  source_url text not null,
  account_id uuid not null,
  kind text,
  r2_key text,
  sha256 text,
  size_bytes bigint,
  content_type text,
  status text not null default 'pending' check (status in ('pending', 'completed', 'failed')),
  error text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (source_table, source_column, source_row_id)
);

create index media_migration_log_status_idx on public.media_migration_log (status);

alter table public.media_migration_log enable row level security;
-- Deliberately zero policies — RLS with no policies denies every
-- session-scoped (anon/authenticated) client by default; the
-- service-role client the migration script uses bypasses RLS entirely,
-- same as every other admin-only table in this schema.
