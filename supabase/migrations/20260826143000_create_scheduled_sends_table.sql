create table public.scheduled_sends (
  id uuid default gen_random_uuid() primary key,
  account_id uuid references public.accounts(id) on delete cascade not null,
  contact_id uuid references public.contacts(id) on delete cascade not null,
  followup_plan_id uuid references public.followup_plans(id) on delete set null,
  send_at timestamp with time zone not null,
  status text check (status in ('pending', 'sent', 'cancelled')) default 'pending' not null,
  template_name text not null,
  template_language text not null,
  template_params jsonb,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  processed_at timestamp with time zone,
  error_message text
);

create index idx_scheduled_sends_status_send_at on public.scheduled_sends(status, send_at);
