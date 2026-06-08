-- Sales Manager cloud tables and roles
-- Run this in Supabase SQL Editor.

create table if not exists public.sales_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique not null,
  login_email text not null,
  role text not null check (role in ('admin', 'agent', 'staff')),
  full_name text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.sales_state (
  id text primary key default 'main',
  data jsonb not null default '{"parties":[],"misc":[],"orders":[],"agents":[]}'::jsonb,
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now()
);

insert into public.sales_state (id, data)
values ('main', '{"parties":[],"misc":[],"orders":[],"agents":[]}'::jsonb)
on conflict (id) do nothing;

alter table public.sales_profiles enable row level security;
alter table public.sales_state enable row level security;

drop policy if exists "sales profiles username lookup" on public.sales_profiles;
drop policy if exists "sales profiles own read" on public.sales_profiles;
drop policy if exists "sales state read active users" on public.sales_state;
drop policy if exists "sales state insert admins" on public.sales_state;
drop policy if exists "sales state update admins_staff" on public.sales_state;

-- Allows username login mapping before Supabase Auth sign-in.
create policy "sales profiles username lookup"
on public.sales_profiles
for select
to anon
using (active = true);

create policy "sales profiles own read"
on public.sales_profiles
for select
to authenticated
using (id = auth.uid() or active = true);

create policy "sales state read active users"
on public.sales_state
for select
to authenticated
using (
  exists (
    select 1 from public.sales_profiles sp
    where sp.id = auth.uid()
      and sp.active = true
      and sp.role in ('admin', 'agent', 'staff')
  )
);

create policy "sales state insert admins"
on public.sales_state
for insert
to authenticated
with check (
  exists (
    select 1 from public.sales_profiles sp
    where sp.id = auth.uid()
      and sp.active = true
      and sp.role = 'admin'
  )
);

create policy "sales state update admins_staff"
on public.sales_state
for update
to authenticated
using (
  exists (
    select 1 from public.sales_profiles sp
    where sp.id = auth.uid()
      and sp.active = true
      and sp.role in ('admin', 'staff')
  )
)
with check (
  exists (
    select 1 from public.sales_profiles sp
    where sp.id = auth.uid()
      and sp.active = true
      and sp.role in ('admin', 'staff')
  )
);

-- Example: add Sales Admin after creating the user in Authentication > Users.
-- Replace USER_UID_HERE and login_email.
/*
insert into public.sales_profiles (id, username, login_email, role, full_name)
values ('USER_UID_HERE', 'GARVIT', 'garvit@mtm.local', 'admin', 'Garvit')
on conflict (id)
do update set
  username = excluded.username,
  login_email = excluded.login_email,
  role = excluded.role,
  full_name = excluded.full_name,
  active = true,
  updated_at = now();
*/
