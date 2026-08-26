-- Follow-up Inteligente: the two tables from the prior two migrations
-- (followup_plans, scheduled_sends) were created without RLS policies
-- and without a valid 'failed' status, unlike every other account-
-- scoped table in this schema (see e.g. 066_action_items.sql). Fixes:
--
--   1. RLS policies using the same is_account_member() helper (017)
--      every other tenant table uses — account members can read/write
--      their own account's rows; the cron dispatcher uses the
--      service-role client and is unaffected by RLS either way.
--   2. Adds 'failed' to scheduled_sends.status — the send cron needs
--      to record a failed send without violating the check constraint.

alter table public.followup_plans enable row level security;
alter table public.scheduled_sends enable row level security;

drop policy if exists followup_plans_select on public.followup_plans;
create policy followup_plans_select on public.followup_plans for select
  using (is_account_member(account_id));

drop policy if exists followup_plans_insert on public.followup_plans;
create policy followup_plans_insert on public.followup_plans for insert
  with check (is_account_member(account_id, 'agent'));

drop policy if exists followup_plans_update on public.followup_plans;
create policy followup_plans_update on public.followup_plans for update
  using (is_account_member(account_id, 'agent'));

drop policy if exists scheduled_sends_select on public.scheduled_sends;
create policy scheduled_sends_select on public.scheduled_sends for select
  using (is_account_member(account_id));

drop policy if exists scheduled_sends_insert on public.scheduled_sends;
create policy scheduled_sends_insert on public.scheduled_sends for insert
  with check (is_account_member(account_id, 'agent'));

drop policy if exists scheduled_sends_update on public.scheduled_sends;
create policy scheduled_sends_update on public.scheduled_sends for update
  using (is_account_member(account_id, 'agent'));

alter table public.scheduled_sends drop constraint if exists scheduled_sends_status_check;
alter table public.scheduled_sends add constraint scheduled_sends_status_check
  check (status in ('pending', 'sent', 'cancelled', 'failed'));
