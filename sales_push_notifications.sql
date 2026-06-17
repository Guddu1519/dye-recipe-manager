create table if not exists public.sales_push_tokens (
  id uuid primary key default gen_random_uuid(),
  user_email text not null,
  role text not null check (role in ('admin','agent','team')),
  app_name text not null,
  expo_push_token text not null unique,
  device_label text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists sales_push_tokens_role_idx on public.sales_push_tokens(role);
create index if not exists sales_push_tokens_user_email_idx on public.sales_push_tokens(lower(user_email));

alter table public.sales_push_tokens enable row level security;

drop policy if exists "sales push tokens read authenticated" on public.sales_push_tokens;
create policy "sales push tokens read authenticated"
on public.sales_push_tokens for select
to authenticated
using (true);

drop policy if exists "sales push tokens insert authenticated" on public.sales_push_tokens;
create policy "sales push tokens insert authenticated"
on public.sales_push_tokens for insert
to authenticated
with check (true);

drop policy if exists "sales push tokens update own token" on public.sales_push_tokens;
create policy "sales push tokens update own token"
on public.sales_push_tokens for update
to authenticated
using (true)
with check (true);
