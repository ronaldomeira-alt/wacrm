-- Retenção automática de mídia: apaga fotos/vídeos/áudios/PDFs/
-- documentos/thumbnails de leads arquivados há 60+ dias ou inativos
-- (sem mensagem real) há 180+ dias. NUNCA apaga contato/conversa/
-- mensagens (texto) nem dados estruturais — só a coluna media_url /
-- document_thumbnail_url e o objeto físico correspondente (R2 ou
-- Supabase Storage, conforme o caso).

-- View somente-leitura: uma linha por mensagem elegível, já resolvendo
-- o media_objects correspondente quando media_url é uma key R2 crua
-- (nunca casa com URL/proxy da Meta, então thumbnails-only e mensagens
-- inbound-proxy naturalmente não trazem media_object_id).
create or replace view public.media_retention_eligible_messages as
select
  m.id as message_id,
  c.id as conversation_id,
  c.account_id,
  ct.id as contact_id,
  m.media_url,
  m.document_thumbnail_url,
  mo.id as media_object_id,
  mo.bucket as media_object_bucket,
  mo.visibility as media_object_visibility,
  case
    when ct.archived_at is not null and ct.archived_at <= now() - interval '60 days' then 'archived_60d'
    else 'inactive_180d'
  end as reason
from public.messages m
join public.conversations c on c.id = m.conversation_id
join public.contacts ct on ct.id = c.contact_id
left join public.media_objects mo
  on mo.account_id = c.account_id and mo.object_key = m.media_url
where (
    (m.media_url is not null and m.media_url not like 'http%' and m.media_url not like '/api/whatsapp/media/%')
    or m.document_thumbnail_url is not null
  )
  and (
    (ct.archived_at is not null and ct.archived_at <= now() - interval '60 days')
    or (ct.archived_at is null and c.last_message_at is not null and c.last_message_at <= now() - interval '180 days')
  );

revoke all on public.media_retention_eligible_messages from anon, authenticated;

-- Log de auditoria — uma linha por objeto/thumbnail efetivamente
-- removido (ou por referência liberada sem remoção física, quando o
-- objeto físico ainda tem reference_count > 0 por dedup com outro
-- lead). Só o service-role escreve/lê (sem policies = RLS nega tudo
-- pra anon/authenticated), mesmo padrão de media_migration_log.
create table public.media_retention_deletions (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null,
  contact_id uuid not null,
  kind text not null check (kind in ('media_reference', 'media_object', 'thumbnail')),
  reason text not null check (reason in ('archived_60d', 'inactive_180d')),
  object_key text,
  bucket text,
  size_bytes bigint,
  created_at timestamptz not null default now()
);

create index media_retention_deletions_message_idx on public.media_retention_deletions (message_id);

alter table public.media_retention_deletions enable row level security;
