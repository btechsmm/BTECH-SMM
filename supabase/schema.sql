-- ============================================================================
-- BTECH SMM — Supabase Schema (Phase 4)
-- ----------------------------------------------------------------------------
-- Run this once in the Supabase SQL Editor (Project → SQL Editor → New query)
-- for project: https://nbiigfncyzfuzciubmru.supabase.co
--
-- This creates every table listed in the original brief, wires up Row Level
-- Security so each customer can only ever see their own data, and adds a
-- trigger so a profile + wallet are created automatically the moment someone
-- signs up (no separate "finish onboarding" step needed).
--
-- Safe to re-run: every statement uses IF NOT EXISTS / OR REPLACE / DROP...IF
-- EXISTS so re-running this script after a partial failure won't error out.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------------
create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- profiles  (one row per auth.users row)
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null default '',
  email text not null default '',
  phone text not null default '',
  role text not null default 'customer' check (role in ('customer', 'admin')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own" on public.profiles
  for select using (auth.uid() = id);

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own" on public.profiles
  for update using (auth.uid() = id);

-- Admins can view every profile (used by the admin dashboard's user list)
-- Admin status is checked via public.is_admin() (defined near the end of
-- this file, before it's first used here) rather than an inline subquery on
-- profiles — an inline `exists (select 1 from public.profiles ...)` inside a
-- policy defined ON profiles itself causes infinite recursion (Postgres
-- error 42P17), since answering the policy requires re-evaluating the same
-- policy. See migration_fix_rls_recursion.sql for the full explanation.
create or replace function public.is_admin()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.profiles where id = auth.uid() and role = 'admin'
  );
$$;

drop policy if exists "profiles_select_admin" on public.profiles;
create policy "profiles_select_admin" on public.profiles
  for select using (public.is_admin());

-- ---------------------------------------------------------------------------
-- services  (the catalogue — admin-managed, publicly readable)
-- ---------------------------------------------------------------------------
create table if not exists public.services (
  id text primary key,
  platform text not null,
  category text not null,
  name text not null,
  description text not null default '',
  price_per_1000 numeric not null,
  min_quantity integer not null default 1,
  max_quantity integer not null default 1,
  unit text,
  featured boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.services enable row level security;

drop policy if exists "services_select_all" on public.services;
create policy "services_select_all" on public.services
  for select using (true);

drop policy if exists "services_write_admin" on public.services;
create policy "services_write_admin" on public.services
  for all using (public.is_admin());

-- ---------------------------------------------------------------------------
-- wallets  (one row per user)
-- ---------------------------------------------------------------------------
create table if not exists public.wallets (
  user_id uuid primary key references auth.users(id) on delete cascade,
  balance numeric not null default 0,
  currency text not null default 'KES',
  updated_at timestamptz not null default now()
);

alter table public.wallets enable row level security;

drop policy if exists "wallets_select_own" on public.wallets;
create policy "wallets_select_own" on public.wallets
  for select using (auth.uid() = user_id);

-- Wallet balance is only ever changed server-side (via the functions below),
-- never by a direct client update — so no update/insert policy is granted
-- to regular users here.

-- ---------------------------------------------------------------------------
-- transactions  (wallet history — deposits, order payments, refunds)
-- ---------------------------------------------------------------------------
create table if not exists public.transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  type text not null check (type in ('deposit', 'order', 'refund')),
  amount numeric not null,
  status text not null default 'completed',
  note text not null default '',
  created_at timestamptz not null default now()
);

alter table public.transactions enable row level security;

drop policy if exists "transactions_select_own" on public.transactions;
create policy "transactions_select_own" on public.transactions
  for select using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- orders
-- ---------------------------------------------------------------------------
create table if not exists public.orders (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  service_id text not null references public.services(id),
  target text not null,
  quantity integer not null,
  amount numeric not null,
  status text not null default 'pending' check (status in ('pending', 'processing', 'completed', 'cancelled')),
  progress integer not null default 0,
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.orders enable row level security;

drop policy if exists "orders_select_own" on public.orders;
create policy "orders_select_own" on public.orders
  for select using (auth.uid() = user_id);

drop policy if exists "orders_select_admin" on public.orders;
create policy "orders_select_admin" on public.orders
  for select using (public.is_admin());

-- Orders are only ever inserted via the place_order() function below (so the
-- wallet debit and the order insert happen together, atomically).

-- ---------------------------------------------------------------------------
-- notifications
-- ---------------------------------------------------------------------------
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  type text not null default 'system',
  title text not null,
  text text not null default '',
  read boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.notifications enable row level security;

drop policy if exists "notifications_select_own" on public.notifications;
create policy "notifications_select_own" on public.notifications
  for select using (auth.uid() = user_id);

drop policy if exists "notifications_update_own" on public.notifications;
create policy "notifications_update_own" on public.notifications
  for update using (auth.uid() = user_id);

drop policy if exists "notifications_insert_own" on public.notifications;
create policy "notifications_insert_own" on public.notifications
  for insert with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- support_tickets
-- ---------------------------------------------------------------------------
create table if not exists public.support_tickets (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  subject text not null,
  status text not null default 'open' check (status in ('open', 'closed')),
  created_at timestamptz not null default now()
);

create table if not exists public.support_messages (
  id uuid primary key default gen_random_uuid(),
  ticket_id text not null references public.support_tickets(id) on delete cascade,
  sender text not null check (sender in ('user', 'support')),
  message text not null,
  created_at timestamptz not null default now()
);

alter table public.support_tickets enable row level security;
alter table public.support_messages enable row level security;

drop policy if exists "tickets_select_own" on public.support_tickets;
create policy "tickets_select_own" on public.support_tickets
  for select using (auth.uid() = user_id);

drop policy if exists "tickets_insert_own" on public.support_tickets;
create policy "tickets_insert_own" on public.support_tickets
  for insert with check (auth.uid() = user_id);

drop policy if exists "ticket_messages_select_own" on public.support_messages;
create policy "ticket_messages_select_own" on public.support_messages
  for select using (
    exists (select 1 from public.support_tickets t where t.id = ticket_id and t.user_id = auth.uid())
  );

drop policy if exists "ticket_messages_insert_own" on public.support_messages;
create policy "ticket_messages_insert_own" on public.support_messages
  for insert with check (
    exists (select 1 from public.support_tickets t where t.id = ticket_id and t.user_id = auth.uid())
  );

-- ---------------------------------------------------------------------------
-- providers / provider_services  (Phase 6 — external fulfilment providers)
-- ---------------------------------------------------------------------------
create table if not exists public.providers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  api_base_url text,
  active boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.provider_services (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid not null references public.providers(id) on delete cascade,
  service_id text not null references public.services(id) on delete cascade,
  provider_service_ref text not null,
  created_at timestamptz not null default now()
);

alter table public.providers enable row level security;
alter table public.provider_services enable row level security;

drop policy if exists "providers_admin_only" on public.providers;
create policy "providers_admin_only" on public.providers
  for all using (public.is_admin());

drop policy if exists "provider_services_admin_only" on public.provider_services;
create policy "provider_services_admin_only" on public.provider_services
  for all using (public.is_admin());

-- ---------------------------------------------------------------------------
-- payment_attempts  (Phase 5 — M-Pesa Daraja)
-- ---------------------------------------------------------------------------
create table if not exists public.payment_attempts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  amount numeric not null,
  method text not null default 'mpesa',
  status text not null default 'pending',
  provider_reference text,
  created_at timestamptz not null default now()
);

alter table public.payment_attempts enable row level security;

drop policy if exists "payment_attempts_select_own" on public.payment_attempts;
create policy "payment_attempts_select_own" on public.payment_attempts
  for select using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- site_settings  (admin-only key/value config)
-- ---------------------------------------------------------------------------
create table if not exists public.site_settings (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.site_settings enable row level security;

drop policy if exists "site_settings_admin_only" on public.site_settings;
create policy "site_settings_admin_only" on public.site_settings
  for all using (public.is_admin());

-- ============================================================================
-- Trigger: auto-create a profile + wallet + welcome notification the moment
-- someone signs up via Supabase Auth.
-- ============================================================================
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, name, email)
  values (new.id, coalesce(new.raw_user_meta_data->>'name', ''), new.email);

  insert into public.wallets (user_id, balance, currency)
  values (new.id, 0, 'KES');

  insert into public.notifications (user_id, type, title, text)
  values (new.id, 'system', 'Welcome to BTECH SMM', 'Your account has been created.');

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============================================================================
-- Function: place_order — atomically checks balance, debits wallet, inserts
-- the order and a transaction row. Called via supabase.rpc('place_order', …)
-- so a customer can never insert an order directly and bypass payment.
-- ============================================================================
create or replace function public.place_order(
  p_order_id text,
  p_service_id text,
  p_target text,
  p_quantity integer,
  p_amount numeric
)
returns public.orders
language plpgsql
security definer
set search_path = public
as $$
declare
  v_balance numeric;
  v_order public.orders;
begin
  select balance into v_balance from public.wallets where user_id = auth.uid() for update;

  if v_balance is null then
    raise exception 'Wallet not found for this user.';
  end if;

  if v_balance < p_amount then
    raise exception 'Insufficient wallet balance.';
  end if;

  update public.wallets set balance = balance - p_amount, updated_at = now() where user_id = auth.uid();

  insert into public.orders (id, user_id, service_id, target, quantity, amount, status, progress, notes)
  values (p_order_id, auth.uid(), p_service_id, p_target, p_quantity, p_amount, 'pending', 0, 'Order received, awaiting processing.')
  returning * into v_order;

  insert into public.transactions (user_id, type, amount, status, note)
  values (auth.uid(), 'order', -p_amount, 'completed', 'Order ' || p_order_id);

  insert into public.notifications (user_id, type, title, text)
  values (auth.uid(), 'order', 'Order created', 'Order ' || p_order_id || ' was created successfully.');

  return v_order;
end;
$$;

-- ============================================================================
-- Function: deposit_wallet — demo top-up (Phase 5 will call this only after
-- a real M-Pesa confirmation, from a trusted server context, instead of
-- directly from the client).
-- ============================================================================
create or replace function public.deposit_wallet(p_amount numeric)
returns public.wallets
language plpgsql
security definer
set search_path = public
as $$
declare
  v_wallet public.wallets;
begin
  if p_amount <= 0 then
    raise exception 'Deposit amount must be positive.';
  end if;

  update public.wallets set balance = balance + p_amount, updated_at = now()
    where user_id = auth.uid()
    returning * into v_wallet;

  insert into public.transactions (user_id, type, amount, status, note)
  values (auth.uid(), 'deposit', p_amount, 'completed', 'Demo wallet top-up');

  return v_wallet;
end;
$$;

-- ============================================================================
-- Seed the services catalogue (safe to re-run — upsert on id)
-- ============================================================================
insert into public.services (id, platform, category, name, description, price_per_1000, min_quantity, max_quantity, unit, featured)
values
  ('svc-tt-followers', 'tiktok', 'followers', 'TikTok Content Promotion', 'Promote a TikTok profile to a wider audience with steady, gradual delivery.', 220, 100, 50000, null, true),
  ('svc-tt-views', 'tiktok', 'views', 'TikTok Video Views', 'Increase view counts on a specific TikTok video over a controlled delivery window.', 15, 500, 500000, null, false),
  ('svc-tt-likes', 'tiktok', 'engagement', 'TikTok Engagement Boost', 'Add likes to a TikTok post to support existing engagement.', 90, 50, 20000, null, false),
  ('svc-ig-campaign', 'instagram', 'followers', 'Instagram Campaign Promotion', 'Grow an Instagram profile''s reach through a structured promotional campaign.', 260, 100, 30000, null, true),
  ('svc-ig-likes', 'instagram', 'engagement', 'Instagram Post Engagement', 'Add likes to an Instagram post or reel to support existing engagement.', 110, 50, 15000, null, false),
  ('svc-ig-views', 'instagram', 'views', 'Instagram Reel Views', 'Increase view counts on an Instagram reel over a controlled delivery window.', 20, 500, 250000, null, false),
  ('svc-yt-promotion', 'youtube', 'views', 'YouTube Promotion', 'Promote a YouTube video to a wider audience with steady, gradual delivery.', 180, 500, 200000, null, true),
  ('svc-yt-subs', 'youtube', 'followers', 'YouTube Channel Growth', 'Grow a YouTube channel''s subscriber base through a structured campaign.', 340, 100, 10000, null, false),
  ('svc-fb-campaign', 'facebook', 'followers', 'Facebook Campaign Promotion', 'Grow a Facebook page''s reach through a structured promotional campaign.', 200, 100, 40000, null, false),
  ('svc-fb-engagement', 'facebook', 'engagement', 'Facebook Post Engagement', 'Add reactions to a Facebook post to support existing engagement.', 95, 50, 15000, null, false),
  ('svc-x-followers', 'x', 'followers', 'X Profile Growth', 'Grow an X (formerly Twitter) profile''s reach through a structured campaign.', 300, 100, 20000, null, false),
  ('svc-x-engagement', 'x', 'engagement', 'X Post Engagement', 'Add engagement to a post on X to support existing activity.', 130, 50, 10000, null, false),
  ('svc-tg-members', 'telegram', 'followers', 'Telegram Channel Growth', 'Grow a Telegram channel or group''s member base gradually.', 160, 100, 50000, null, false),
  ('svc-tg-views', 'telegram', 'views', 'Telegram Post Views', 'Increase view counts on a Telegram channel post.', 12, 500, 300000, null, false),
  ('svc-analytics', 'instagram', 'analytics', 'Social Media Analytics', 'A monthly report covering growth trends, audience insights and content performance.', 2500, 1, 1, 'report', false),
  ('svc-management', 'facebook', 'management', 'Social Media Management', 'Ongoing content planning and posting support for one connected profile per month.', 8000, 1, 1, 'month', true)
on conflict (id) do update set
  platform = excluded.platform,
  category = excluded.category,
  name = excluded.name,
  description = excluded.description,
  price_per_1000 = excluded.price_per_1000,
  min_quantity = excluded.min_quantity,
  max_quantity = excluded.max_quantity,
  unit = excluded.unit,
  featured = excluded.featured;

-- ============================================================================
-- To promote your own account to admin after signing up, run:
--   update public.profiles set role = 'admin' where email = 'you@example.com';
-- ============================================================================
