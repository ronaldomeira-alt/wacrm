-- =====================================================================
-- DEM-004 v3 — Estado persistente do ciclo de Match (N1)
-- Autor: Esteira Dev (Arquiteto de Software)
-- Status: PREPARADO — NÃO APLICADO. Requer aprovação expressa de Ronaldo.
--
-- Mudanças da v2 após Code Review:
--   * N2 (aplicação incremental) foi retirado deste DDL: sem o código do
--     WACRM não há mapeamento entre inventory_properties.property_id (texto)
--     e property_match_projections.property_id (UUID), nem política de órfãos.
--   * p_compact=true segue proibido.
--   * A decisão de pular o ciclo agora vem de uma "impressão digital" barata
--     (probe_match_sync), não do watermark das projeções — que muda a cada
--     ciclo e travaria o N1.
--   * Lock com TTL de 900 s (o ciclo pode durar mais que 120 s).
--   * Nenhuma tabela existente é alterada.
-- =====================================================================

begin;

create table if not exists public.match_sync_state (
  operational_account_id  uuid        not null primary key,
  last_fingerprint        text,
  inventory_watermark     timestamptz,
  tombstone_count         bigint      not null default 0,
  deleted_match_count     bigint      not null default 0,
  last_run_at             timestamptz,
  last_full_sync_at       timestamptz,
  last_mode               text        check (last_mode in ('skipped','full','incremental')),
  lock_token              uuid,
  lock_expires_at         timestamptz,
  updated_at              timestamptz not null default now()
);

comment on table public.match_sync_state is
  'DEM-004: impressão digital e lock do ciclo de Match do WACRM. Escrita só por service_role.';

alter table public.match_sync_state enable row level security;
revoke all on public.match_sync_state from anon, authenticated;
grant select, insert, update, delete on public.match_sync_state to service_role;

-- ---------------------------------------------------------------------
-- probe_match_sync: leitura barata e atômica usada para decidir o N1.
-- Retorna ~300 bytes. Substitui as três consultas de watermark que o
-- worker já faz hoje e inclui os dois drenos de exclusão.
-- ---------------------------------------------------------------------
create or replace function public.probe_match_sync(
  p_operational_account_id uuid,
  p_source_account_id      uuid default '52716edc-399e-4d4c-9788-0d6b04c0031f'::uuid
)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  with inv as (
    select coalesce(max(updated_at), '-infinity'::timestamptz) as watermark,
           count(*) as total
    from public.inventory_properties
    where account_id = p_source_account_id
  ),
  tomb as (
    select count(*) as total, coalesce(max(deleted_at), '-infinity'::timestamptz) as ultima
    from public.inventory_property_tombstones
    where account_id = p_source_account_id
  ),
  dmatch as (
    select count(*) as total, coalesce(max(deleted_at), '-infinity'::timestamptz) as ultima
    from public.deleted_match_properties
    where account_id = p_operational_account_id
  )
  select jsonb_build_object(
    'inventoryWatermark', inv.watermark,
    'inventoryCount',     inv.total,
    'tombstoneCount',     tomb.total,
    'tombstoneMaxAt',     tomb.ultima,
    'deletedMatchCount',  dmatch.total,
    'deletedMatchMaxAt',  dmatch.ultima,
    'fingerprint', md5(concat_ws('|',
        extract(epoch from inv.watermark), inv.total,
        tomb.total, extract(epoch from tomb.ultima),
        dmatch.total, extract(epoch from dmatch.ultima)))
  )
  from inv, tomb, dmatch;
$$;

-- ---------------------------------------------------------------------
-- claim_match_sync: adquire o ciclo. Sem linha => outro worker ativo.
-- ---------------------------------------------------------------------
drop function if exists public.claim_match_sync(uuid, integer);

create or replace function public.claim_match_sync(
  p_operational_account_id uuid,
  p_lock_seconds           integer default 900
)
returns table (
  acquired            boolean,
  last_fingerprint    text,
  last_run_at         timestamptz,
  last_full_sync_at   timestamptz,
  lock_token          uuid
)
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_token uuid := gen_random_uuid();
  v_row   public.match_sync_state%rowtype;
begin
  -- TTL precisa ser positivo, finito e maior que um ciclo (150 s).
  if p_lock_seconds is null or p_lock_seconds < 120 or p_lock_seconds > 3600 then
    raise exception 'claim_match_sync: p_lock_seconds=% fora da faixa 120..3600', p_lock_seconds
      using errcode = 'invalid_parameter_value';
  end if;

  insert into public.match_sync_state as s (
    operational_account_id, lock_token, lock_expires_at, updated_at
  )
  values (
    p_operational_account_id, v_token,
    clock_timestamp() + make_interval(secs => p_lock_seconds),
    clock_timestamp()
  )
  on conflict on constraint match_sync_state_pkey do update
     set lock_token      = excluded.lock_token,
         lock_expires_at = excluded.lock_expires_at,
         updated_at      = clock_timestamp()
   where s.lock_expires_at is null
      or s.lock_expires_at < clock_timestamp()
  returning * into v_row;

  if v_row.operational_account_id is null then
    -- Lock ativo de outro worker: devolve o estado sem tocar em nada.
    select s.* into v_row
      from public.match_sync_state s
     where s.operational_account_id = p_operational_account_id;
    return query select false, v_row.last_fingerprint, v_row.last_run_at,
                        v_row.last_full_sync_at, null::uuid;
    return;
  end if;

  return query select true, v_row.last_fingerprint, v_row.last_run_at,
                      v_row.last_full_sync_at, v_token;
end;
$$;

-- ---------------------------------------------------------------------
-- commit_match_sync: publica a impressão digital do ciclo e libera o lock.
-- Só aceita o token dono do ciclo.
-- ---------------------------------------------------------------------
create or replace function public.commit_match_sync(
  p_operational_account_id uuid,
  p_lock_token             uuid,
  p_fingerprint            text,
  p_mode                   text,
  p_inventory_watermark    timestamptz default null,
  p_tombstone_count        bigint default 0,
  p_deleted_match_count    bigint default 0
)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_updated integer;
begin
  if p_mode is null or p_mode not in ('skipped','full','incremental') then
    raise exception 'commit_match_sync: p_mode=% inválido (skipped|full|incremental)', p_mode
      using errcode = 'invalid_parameter_value';
  end if;
  if p_fingerprint is null then
    raise exception 'commit_match_sync: p_fingerprint nulo'
      using errcode = 'null_value_not_allowed';
  end if;

  update public.match_sync_state s
     set last_fingerprint    = p_fingerprint,
         inventory_watermark = greatest(coalesce(s.inventory_watermark, '-infinity'::timestamptz),
                                        coalesce(p_inventory_watermark, '-infinity'::timestamptz)),
         tombstone_count     = p_tombstone_count,
         deleted_match_count = p_deleted_match_count,
         last_mode           = p_mode,
         last_run_at         = clock_timestamp(),
         last_full_sync_at   = case when p_mode = 'full' then clock_timestamp()
                                    else s.last_full_sync_at end,
         lock_token          = null,
         lock_expires_at     = null,
         updated_at          = clock_timestamp()
   where s.operational_account_id = p_operational_account_id
     and s.lock_token = p_lock_token;
  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$$;

-- ---------------------------------------------------------------------
-- release_match_sync: libera sem publicar (falha no meio do ciclo).
-- ---------------------------------------------------------------------
create or replace function public.release_match_sync(
  p_operational_account_id uuid,
  p_lock_token             uuid
)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_updated integer;
begin
  update public.match_sync_state s
     set lock_token = null, lock_expires_at = null, updated_at = clock_timestamp()
   where s.operational_account_id = p_operational_account_id
     and s.lock_token = p_lock_token;
  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$$;

-- Sem acesso para anon/authenticated (o vazamento atual de
-- get_inventory_snapshot para PUBLIC está registrado como DEM-005).
revoke all on function public.probe_match_sync(uuid,uuid) from public, anon, authenticated;
revoke all on function public.claim_match_sync(uuid,integer) from public, anon, authenticated;
revoke all on function public.commit_match_sync(uuid,uuid,text,text,timestamptz,bigint,bigint) from public, anon, authenticated;
revoke all on function public.release_match_sync(uuid,uuid) from public, anon, authenticated;

grant execute on function public.probe_match_sync(uuid,uuid) to service_role;
grant execute on function public.claim_match_sync(uuid,integer) to service_role;
grant execute on function public.commit_match_sync(uuid,uuid,text,text,timestamptz,bigint,bigint) to service_role;
grant execute on function public.release_match_sync(uuid,uuid) to service_role;

commit;

-- =====================================================================
-- ROLLBACK (somente com aprovação de Ronaldo)
-- ---------------------------------------------------------------------
-- drop function if exists public.release_match_sync(uuid,uuid);
-- drop function if exists public.commit_match_sync(uuid,uuid,text,text,timestamptz,bigint,bigint);
-- drop function if exists public.claim_match_sync(uuid,integer);
-- drop function if exists public.probe_match_sync(uuid,uuid);
-- drop table  if exists public.match_sync_state;
-- =====================================================================
