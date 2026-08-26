create table public.followup_plans (
  id uuid default gen_random_uuid() primary key,
  account_id uuid references public.accounts(id) on delete cascade not null,
  contact_id uuid references public.contacts(id) on delete cascade not null,
  conversation_id uuid references public.conversations(id) on delete cascade not null,
  status text check (status in ('active', 'completed', 'cancelled')) default 'active',
  plan_data jsonb not null,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null
);

create index idx_followup_plans_account_id on public.followup_plans(account_id);
create index idx_followup_plans_contact_id on public.followup_plans(contact_id);
create index idx_followup_plans_status on public.followup_plans(status);