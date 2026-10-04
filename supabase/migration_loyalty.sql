-- ============================================================================
-- BTECH SMM — Loyalty & Rewards (core: settings, levels, ledger, points, admin)
-- ----------------------------------------------------------------------------
-- Run after every previous migration. Additive / idempotent.
-- Ships DISABLED (loyalty_settings.enabled = false) with only a "Regular"
-- level seeded. Nothing changes for customers until an admin turns it on.
--
-- This file does NOT change order pricing. The discount side lives in
-- migration_loyalty_pricing.sql, which must only be applied after
-- wallet_place_order() has been checked (see the notes at the top of that file).
--
-- Design:
--  * loyalty_transactions is the source of truth (a ledger). loyalty_accounts
--    is a cache that loyalty_recompute() rebuilds entirely from the ledger.
--  * Points are awarded / reversed by ONE trigger on public.orders, so it does
--    not matter which Edge Function or admin action changed the order.
--  * No client role can write to any loyalty table. Customers read their own
--    rows; admins read everything and write only through audited RPCs.
--  * Points are NOT wallet money. Nothing here touches wallets/transactions.
--  * Ambassador/referral commissions are a separate system and are not touched.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Settings (single row)
-- ---------------------------------------------------------------------------
create table if not exists public.loyalty_settings (
  id boolean primary key default true check (id),
  enabled boolean not null default false,
  qualify_on text not null default 'completed' check (qualify_on in ('paid', 'completed')),
  spend_unit numeric not null default 100 check (spend_unit > 0),
  points_per_unit numeric not null default 10 check (points_per_unit >= 0),
  min_qualifying_order numeric not null default 0 check (min_qualifying_order >= 0),
  max_points_per_order integer check (max_points_per_order > 0),
  bonus_enabled boolean not null default false,
  max_discount_percent numeric not null default 10 check (max_discount_percent between 0 and 100),
  discount_default_eligible boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);
insert into public.loyalty_settings (id) values (true) on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Levels
-- ---------------------------------------------------------------------------
create table if not exists public.loyalty_levels (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  description text not null default '',
  min_points integer not null default 0 check (min_points >= 0),
  min_spend numeric not null default 0 check (min_spend >= 0),
  min_orders integer not null default 0 check (min_orders >= 0),
  discount_percent numeric not null default 0 check (discount_percent between 0 and 100),
  active boolean not null default true,
  display_order integer not null default 0,
  created_at timestamptz not null default now()
);
insert into public.loyalty_levels (name, description, display_order)
select 'Regular', 'Default level for all customers.', 0
where not exists (select 1 from public.loyalty_levels);

-- ---------------------------------------------------------------------------
-- Accounts (cache, rebuilt from the ledger)
-- ---------------------------------------------------------------------------
create table if not exists public.loyalty_accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  points_balance integer not null default 0,
  lifetime_points integer not null default 0,
  qualifying_spend numeric not null default 0,
  qualifying_orders integer not null default 0,
  level_id uuid references public.loyalty_levels(id) on delete set null,
  level_override_id uuid references public.loyalty_levels(id) on delete set null,
  last_qualifying_order_at timestamptz,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Ledger
-- ---------------------------------------------------------------------------
create table if not exists public.loyalty_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  order_id text references public.orders(id) on delete set null,
  type text not null check (type in ('earn', 'reversal', 'bonus', 'adjustment', 'redemption')),
  points integer not null,
  spend_delta numeric not null default 0,
  orders_delta integer not null default 0,
  note text not null default '',
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

-- An order can earn once and be reversed once, enforced by the database.
create unique index if not exists loyalty_tx_one_per_order
  on public.loyalty_transactions (order_id, type) where type in ('earn', 'reversal');
create index if not exists loyalty_tx_user_idx on public.loyalty_transactions (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Per-service rules (admin-only: holds price floors, so NOT on public.services)
-- ---------------------------------------------------------------------------
create table if not exists public.service_loyalty_rules (
  service_id text primary key references public.services(id) on delete cascade,
  discount_eligible boolean not null default true,
  earns_points boolean not null default true,
  max_discount_percent numeric check (max_discount_percent between 0 and 100),
  min_price_per_1000 numeric check (min_price_per_1000 >= 0),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Audit log
-- ---------------------------------------------------------------------------
create table if not exists public.loyalty_audit_log (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid not null references auth.users(id),
  user_id uuid references auth.users(id) on delete set null,
  action text not null,
  previous_value jsonb,
  new_value jsonb,
  reason text,
  created_at timestamptz not null default now()
);
create index if not exists loyalty_audit_created_idx on public.loyalty_audit_log (created_at desc);

-- ---------------------------------------------------------------------------
-- orders: record the pre-discount price and the discount actually granted.
-- (Populated by migration_loyalty_pricing.sql; harmless until then.)
-- ---------------------------------------------------------------------------
alter table public.orders
  add column if not exists list_amount numeric,
  add column if not exists loyalty_discount_percent numeric not null default 0,
  add column if not exists loyalty_discount_amount numeric not null default 0;

-- ---------------------------------------------------------------------------
-- RLS: read-only for customers, admin read, NO write policies for anyone.
-- ---------------------------------------------------------------------------
alter table public.loyalty_settings enable row level security;
alter table public.loyalty_levels enable row level security;
alter table public.loyalty_accounts enable row level security;
alter table public.loyalty_transactions enable row level security;
alter table public.service_loyalty_rules enable row level security;
alter table public.loyalty_audit_log enable row level security;

drop policy if exists "loyalty_accounts_own" on public.loyalty_accounts;
create policy "loyalty_accounts_own" on public.loyalty_accounts for select using (auth.uid() = user_id);
drop policy if exists "loyalty_accounts_admin" on public.loyalty_accounts;
create policy "loyalty_accounts_admin" on public.loyalty_accounts for select using (public.is_admin());

drop policy if exists "loyalty_tx_own" on public.loyalty_transactions;
create policy "loyalty_tx_own" on public.loyalty_transactions for select using (auth.uid() = user_id);
drop policy if exists "loyalty_tx_admin" on public.loyalty_transactions;
create policy "loyalty_tx_admin" on public.loyalty_transactions for select using (public.is_admin());

drop policy if exists "loyalty_levels_read" on public.loyalty_levels;
create policy "loyalty_levels_read" on public.loyalty_levels for select to authenticated using (active or public.is_admin());

drop policy if exists "loyalty_settings_admin" on public.loyalty_settings;
create policy "loyalty_settings_admin" on public.loyalty_settings for select using (public.is_admin());

drop policy if exists "service_loyalty_rules_admin" on public.service_loyalty_rules;
create policy "service_loyalty_rules_admin" on public.service_loyalty_rules for select using (public.is_admin());

drop policy if exists "loyalty_audit_admin" on public.loyalty_audit_log;
create policy "loyalty_audit_admin" on public.loyalty_audit_log for select using (public.is_admin());

-- ---------------------------------------------------------------------------
-- loyalty_recompute(): rebuild one customer's cached account from the ledger
-- and pick their level (highest active level whose minimums are ALL met;
-- a minimum of 0 means "not required"). Thresholds use LIFETIME points so a
-- future redemption can never demote someone.
-- ---------------------------------------------------------------------------
create or replace function public.loyalty_recompute(p_user uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pts integer;
  v_life integer;
  v_spend numeric;
  v_orders integer;
  v_last timestamptz;
  v_level uuid;
begin
  select coalesce(sum(points), 0),
         coalesce(sum(points) filter (where type <> 'redemption'), 0),
         coalesce(sum(spend_delta), 0),
         coalesce(sum(orders_delta), 0),
         max(created_at) filter (where type = 'earn')
    into v_pts, v_life, v_spend, v_orders, v_last
    from public.loyalty_transactions where user_id = p_user;

  select id into v_level from public.loyalty_levels
   where active and min_points <= v_life and min_spend <= v_spend and min_orders <= v_orders
   order by display_order desc, discount_percent desc
   limit 1;

  insert into public.loyalty_accounts
    (user_id, points_balance, lifetime_points, qualifying_spend, qualifying_orders, level_id, last_qualifying_order_at)
  values (p_user, v_pts, v_life, v_spend, v_orders, v_level, v_last)
  on conflict (user_id) do update set
    points_balance = excluded.points_balance,
    lifetime_points = excluded.lifetime_points,
    qualifying_spend = excluded.qualifying_spend,
    qualifying_orders = excluded.qualifying_orders,
    level_id = excluded.level_id,
    last_qualifying_order_at = excluded.last_qualifying_order_at,
    updated_at = now();
end;
$$;

create or replace function public.loyalty_recompute_all()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.loyalty_recompute(user_id) from public.loyalty_accounts;
end;
$$;

-- ---------------------------------------------------------------------------
-- Trigger: award points when an order qualifies, reverse them when it is
-- refunded or cancelled. Idempotent through loyalty_tx_one_per_order.
-- ---------------------------------------------------------------------------
create or replace function public.loyalty_on_order_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  s public.loyalty_settings;
  v_pts integer;
  v_id uuid;
  v_earn public.loyalty_transactions;
begin
  select * into s from public.loyalty_settings where id;
  if not found or not s.enabled then
    return new;
  end if;

  if new.payment_status = 'paid'
     and new.status <> 'cancelled'
     and (s.qualify_on = 'paid' or new.status = 'completed')
     and new.amount >= s.min_qualifying_order
     and coalesce((select earns_points from public.service_loyalty_rules where service_id = new.service_id), true)
  then
    v_pts := floor(new.amount / s.spend_unit * s.points_per_unit);
    if s.max_points_per_order is not null then
      v_pts := least(v_pts, s.max_points_per_order);
    end if;

    insert into public.loyalty_transactions (user_id, order_id, type, points, spend_delta, orders_delta, note)
    values (new.user_id, new.id, 'earn', v_pts, new.amount, 1, 'Order ' || new.id)
    on conflict (order_id, type) where type in ('earn', 'reversal') do nothing
    returning id into v_id;

    if v_id is not null then
      perform public.loyalty_recompute(new.user_id);
    end if;
  end if;

  if new.payment_status = 'refunded' or new.status = 'cancelled' then
    select * into v_earn from public.loyalty_transactions where order_id = new.id and type = 'earn';
    if found then
      v_id := null;
      insert into public.loyalty_transactions (user_id, order_id, type, points, spend_delta, orders_delta, note)
      values (new.user_id, new.id, 'reversal', -v_earn.points, -v_earn.spend_delta, -v_earn.orders_delta,
              'Order ' || new.id || ' refunded or cancelled')
      on conflict (order_id, type) where type in ('earn', 'reversal') do nothing
      returning id into v_id;

      if v_id is not null then
        perform public.loyalty_recompute(new.user_id);
      end if;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists loyalty_order_change on public.orders;
create trigger loyalty_order_change
  after update of status, payment_status on public.orders
  for each row
  when (old.status is distinct from new.status or old.payment_status is distinct from new.payment_status)
  execute function public.loyalty_on_order_change();

-- Covers an order that is inserted already paid (a single-step wallet purchase).
drop trigger if exists loyalty_order_insert on public.orders;
create trigger loyalty_order_insert
  after insert on public.orders
  for each row
  when (new.payment_status = 'paid')
  execute function public.loyalty_on_order_change();

-- ---------------------------------------------------------------------------
-- Customer RPC: my loyalty summary (real data, computed server-side)
-- ---------------------------------------------------------------------------
create or replace function public.get_my_loyalty()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  s public.loyalty_settings;
  a public.loyalty_accounts;
  lvl public.loyalty_levels;
  nxt public.loyalty_levels;
begin
  if v_uid is null then
    raise exception 'Not authenticated.';
  end if;

  select * into s from public.loyalty_settings where id;
  if not found or not s.enabled then
    return jsonb_build_object('enabled', false);
  end if;

  select * into a from public.loyalty_accounts where user_id = v_uid;
  if not found then
    perform public.loyalty_recompute(v_uid);
    select * into a from public.loyalty_accounts where user_id = v_uid;
  end if;

  select * into lvl from public.loyalty_levels where id = coalesce(a.level_override_id, a.level_id);
  select * into nxt from public.loyalty_levels
   where active and display_order > coalesce(lvl.display_order, -1)
   order by display_order
   limit 1;

  return jsonb_build_object(
    'enabled', true,
    'points', a.points_balance,
    'lifetime_points', a.lifetime_points,
    'qualifying_spend', a.qualifying_spend,
    'qualifying_orders', a.qualifying_orders,
    'last_qualifying_order_at', a.last_qualifying_order_at,
    'level', case when lvl.id is null then null else jsonb_build_object(
      'id', lvl.id, 'name', lvl.name, 'description', lvl.description, 'discount_percent', lvl.discount_percent) end,
    'next_level', case when nxt.id is null then null else jsonb_build_object(
      'id', nxt.id, 'name', nxt.name, 'description', nxt.description, 'discount_percent', nxt.discount_percent,
      'min_points', nxt.min_points, 'min_spend', nxt.min_spend, 'min_orders', nxt.min_orders) end,
    'config', jsonb_build_object(
      'qualify_on', s.qualify_on, 'spend_unit', s.spend_unit, 'points_per_unit', s.points_per_unit,
      'min_qualifying_order', s.min_qualifying_order),
    'levels', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', l.id, 'name', l.name, 'description', l.description, 'discount_percent', l.discount_percent,
        'min_points', l.min_points, 'min_spend', l.min_spend, 'min_orders', l.min_orders) order by l.display_order)
      from public.loyalty_levels l where l.active), '[]'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Admin RPCs. Every one re-checks is_admin() and writes to loyalty_audit_log.
-- ---------------------------------------------------------------------------
create or replace function public.loyalty_audit(p_user uuid, p_action text, p_prev jsonb, p_new jsonb, p_reason text)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.loyalty_audit_log (admin_id, user_id, action, previous_value, new_value, reason)
  values (auth.uid(), p_user, p_action, p_prev, p_new, nullif(trim(coalesce(p_reason, '')), ''));
$$;

create or replace function public.admin_loyalty_update_settings(p_patch jsonb, p_reason text default null)
returns public.loyalty_settings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old public.loyalty_settings;
  v_new public.loyalty_settings;
begin
  if not public.is_admin() then
    raise exception 'Admin access required.';
  end if;

  select * into v_old from public.loyalty_settings where id for update;

  update public.loyalty_settings set
    enabled = coalesce((p_patch->>'enabled')::boolean, enabled),
    qualify_on = coalesce(p_patch->>'qualify_on', qualify_on),
    spend_unit = coalesce((p_patch->>'spend_unit')::numeric, spend_unit),
    points_per_unit = coalesce((p_patch->>'points_per_unit')::numeric, points_per_unit),
    min_qualifying_order = coalesce((p_patch->>'min_qualifying_order')::numeric, min_qualifying_order),
    max_points_per_order = case when p_patch ? 'max_points_per_order'
                                then nullif(p_patch->>'max_points_per_order', '')::integer
                                else max_points_per_order end,
    bonus_enabled = coalesce((p_patch->>'bonus_enabled')::boolean, bonus_enabled),
    max_discount_percent = coalesce((p_patch->>'max_discount_percent')::numeric, max_discount_percent),
    discount_default_eligible = coalesce((p_patch->>'discount_default_eligible')::boolean, discount_default_eligible),
    updated_at = now(),
    updated_by = auth.uid()
  where id
  returning * into v_new;

  perform public.loyalty_audit(null, 'settings_update', to_jsonb(v_old), to_jsonb(v_new), p_reason);
  return v_new;
end;
$$;

create or replace function public.admin_loyalty_save_level(p_level jsonb, p_reason text default null)
returns public.loyalty_levels
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid := nullif(p_level->>'id', '')::uuid;
  v_old public.loyalty_levels;
  v_new public.loyalty_levels;
begin
  if not public.is_admin() then
    raise exception 'Admin access required.';
  end if;

  if v_id is null then
    insert into public.loyalty_levels (name, description, min_points, min_spend, min_orders, discount_percent, active, display_order)
    values (
      trim(p_level->>'name'),
      coalesce(p_level->>'description', ''),
      coalesce((p_level->>'min_points')::integer, 0),
      coalesce((p_level->>'min_spend')::numeric, 0),
      coalesce((p_level->>'min_orders')::integer, 0),
      coalesce((p_level->>'discount_percent')::numeric, 0),
      coalesce((p_level->>'active')::boolean, true),
      coalesce((select max(display_order) + 1 from public.loyalty_levels), 0)
    )
    returning * into v_new;
    perform public.loyalty_audit(null, 'level_create', null, to_jsonb(v_new), p_reason);
  else
    select * into v_old from public.loyalty_levels where id = v_id for update;
    if not found then
      raise exception 'Level not found.';
    end if;
    update public.loyalty_levels set
      name = coalesce(nullif(trim(p_level->>'name'), ''), name),
      description = coalesce(p_level->>'description', description),
      min_points = coalesce((p_level->>'min_points')::integer, min_points),
      min_spend = coalesce((p_level->>'min_spend')::numeric, min_spend),
      min_orders = coalesce((p_level->>'min_orders')::integer, min_orders),
      discount_percent = coalesce((p_level->>'discount_percent')::numeric, discount_percent),
      active = coalesce((p_level->>'active')::boolean, active)
    where id = v_id
    returning * into v_new;
    perform public.loyalty_audit(null, 'level_update', to_jsonb(v_old), to_jsonb(v_new), p_reason);
  end if;

  perform public.loyalty_recompute_all();
  return v_new;
end;
$$;

create or replace function public.admin_loyalty_reorder_levels(p_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Admin access required.';
  end if;

  update public.loyalty_levels l set display_order = t.ord - 1
  from unnest(p_ids) with ordinality as t(id, ord)
  where l.id = t.id;

  perform public.loyalty_audit(null, 'level_reorder', null, to_jsonb(p_ids), null);
  perform public.loyalty_recompute_all();
end;
$$;

-- Deletes only when nobody currently holds the level; otherwise deactivate it.
create or replace function public.admin_loyalty_delete_level(p_id uuid, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old public.loyalty_levels;
begin
  if not public.is_admin() then
    raise exception 'Admin access required.';
  end if;

  select * into v_old from public.loyalty_levels where id = p_id for update;
  if not found then
    raise exception 'Level not found.';
  end if;
  if exists (select 1 from public.loyalty_accounts where level_id = p_id or level_override_id = p_id) then
    raise exception 'Customers currently hold this level. Deactivate it instead of deleting it.';
  end if;

  delete from public.loyalty_levels where id = p_id;
  perform public.loyalty_audit(null, 'level_delete', to_jsonb(v_old), null, p_reason);
  perform public.loyalty_recompute_all();
end;
$$;

create or replace function public.admin_loyalty_adjust_points(p_user uuid, p_points integer, p_kind text, p_reason text)
returns public.loyalty_accounts
language plpgsql
security definer
set search_path = public
as $$
declare
  s public.loyalty_settings;
  v_prev integer;
  v_acc public.loyalty_accounts;
begin
  if not public.is_admin() then
    raise exception 'Admin access required.';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'A reason is required.';
  end if;
  if p_points is null or p_points = 0 then
    raise exception 'Points must be a non-zero number.';
  end if;
  if p_kind not in ('adjustment', 'bonus') then
    raise exception 'Invalid adjustment type.';
  end if;

  select * into s from public.loyalty_settings where id;
  if p_kind = 'bonus' and not s.bonus_enabled then
    raise exception 'Bonus points are disabled in loyalty settings.';
  end if;
  if p_kind = 'bonus' and p_points < 0 then
    raise exception 'A bonus must be positive. Use an adjustment to remove points.';
  end if;
  if not exists (select 1 from auth.users where id = p_user) then
    raise exception 'Customer not found.';
  end if;

  perform public.loyalty_recompute(p_user);
  select points_balance into v_prev from public.loyalty_accounts where user_id = p_user;
  if v_prev + p_points < 0 then
    raise exception 'This adjustment would make the balance negative.';
  end if;

  insert into public.loyalty_transactions (user_id, type, points, note, created_by)
  values (p_user, p_kind, p_points, case when p_kind = 'bonus' then 'Loyalty bonus' else 'Admin adjustment' end, auth.uid());

  perform public.loyalty_recompute(p_user);
  select * into v_acc from public.loyalty_accounts where user_id = p_user;

  perform public.loyalty_audit(p_user, 'points_' || p_kind,
    jsonb_build_object('points_balance', v_prev),
    jsonb_build_object('points_balance', v_acc.points_balance, 'change', p_points),
    p_reason);
  return v_acc;
end;
$$;

create or replace function public.admin_loyalty_set_level_override(p_user uuid, p_level uuid, p_reason text)
returns public.loyalty_accounts
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prev uuid;
  v_acc public.loyalty_accounts;
begin
  if not public.is_admin() then
    raise exception 'Admin access required.';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'A reason is required.';
  end if;
  if p_level is not null and not exists (select 1 from public.loyalty_levels where id = p_level) then
    raise exception 'Level not found.';
  end if;
  if not exists (select 1 from auth.users where id = p_user) then
    raise exception 'Customer not found.';
  end if;

  perform public.loyalty_recompute(p_user);
  select level_override_id into v_prev from public.loyalty_accounts where user_id = p_user;

  update public.loyalty_accounts set level_override_id = p_level, updated_at = now()
  where user_id = p_user returning * into v_acc;

  perform public.loyalty_audit(p_user, 'level_override',
    jsonb_build_object('level_override_id', v_prev), jsonb_build_object('level_override_id', p_level), p_reason);
  return v_acc;
end;
$$;

create or replace function public.admin_loyalty_upsert_service_rule(
  p_service_id text,
  p_discount_eligible boolean,
  p_earns_points boolean,
  p_max_discount numeric,
  p_min_price numeric,
  p_reason text default null
)
returns public.service_loyalty_rules
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old public.service_loyalty_rules;
  v_new public.service_loyalty_rules;
begin
  if not public.is_admin() then
    raise exception 'Admin access required.';
  end if;
  select * into v_old from public.service_loyalty_rules where service_id = p_service_id;

  insert into public.service_loyalty_rules (service_id, discount_eligible, earns_points, max_discount_percent, min_price_per_1000)
  values (p_service_id, p_discount_eligible, p_earns_points, p_max_discount, p_min_price)
  on conflict (service_id) do update set
    discount_eligible = excluded.discount_eligible,
    earns_points = excluded.earns_points,
    max_discount_percent = excluded.max_discount_percent,
    min_price_per_1000 = excluded.min_price_per_1000,
    updated_at = now()
  returning * into v_new;

  perform public.loyalty_audit(null, 'service_rule', to_jsonb(v_old), to_jsonb(v_new), p_reason);
  return v_new;
end;
$$;

create or replace function public.admin_loyalty_customers(p_search text default null, p_limit integer default 25, p_offset integer default 0)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_q text := lower(trim(coalesce(p_search, '')));
begin
  if not public.is_admin() then
    raise exception 'Admin access required.';
  end if;

  return coalesce((
    select jsonb_agg(r) from (
      select p.id as user_id, p.name, p.email,
             coalesce(a.points_balance, 0) as points,
             coalesce(a.qualifying_spend, 0) as qualifying_spend,
             coalesce(a.qualifying_orders, 0) as qualifying_orders,
             l.name as level_name,
             coalesce(l.discount_percent, 0) as discount_percent,
             (a.level_override_id is not null) as overridden,
             a.last_qualifying_order_at
      from public.profiles p
      left join public.loyalty_accounts a on a.user_id = p.id
      left join public.loyalty_levels l on l.id = coalesce(a.level_override_id, a.level_id)
      where p.role = 'customer'
        and (v_q = '' or position(v_q in lower(p.name)) > 0 or position(v_q in lower(p.email)) > 0)
      order by coalesce(a.points_balance, 0) desc, p.created_at desc
      limit least(greatest(coalesce(p_limit, 25), 1), 100)
      offset greatest(coalesce(p_offset, 0), 0)
    ) r
  ), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- Execute permissions. Internal helpers: nobody but the database itself.
-- Customer/admin RPCs: signed-in users only (each admin RPC re-checks is_admin()).
-- ---------------------------------------------------------------------------
revoke execute on function public.loyalty_recompute(uuid) from public, anon, authenticated;
revoke execute on function public.loyalty_recompute_all() from public, anon, authenticated;
revoke execute on function public.loyalty_on_order_change() from public, anon, authenticated;
revoke execute on function public.loyalty_audit(uuid, text, jsonb, jsonb, text) from public, anon, authenticated;

revoke execute on function public.get_my_loyalty() from public, anon;
grant execute on function public.get_my_loyalty() to authenticated;

revoke execute on function public.admin_loyalty_update_settings(jsonb, text) from public, anon;
grant execute on function public.admin_loyalty_update_settings(jsonb, text) to authenticated;
revoke execute on function public.admin_loyalty_save_level(jsonb, text) from public, anon;
grant execute on function public.admin_loyalty_save_level(jsonb, text) to authenticated;
revoke execute on function public.admin_loyalty_reorder_levels(uuid[]) from public, anon;
grant execute on function public.admin_loyalty_reorder_levels(uuid[]) to authenticated;
revoke execute on function public.admin_loyalty_delete_level(uuid, text) from public, anon;
grant execute on function public.admin_loyalty_delete_level(uuid, text) to authenticated;
revoke execute on function public.admin_loyalty_adjust_points(uuid, integer, text, text) from public, anon;
grant execute on function public.admin_loyalty_adjust_points(uuid, integer, text, text) to authenticated;
revoke execute on function public.admin_loyalty_set_level_override(uuid, uuid, text) from public, anon;
grant execute on function public.admin_loyalty_set_level_override(uuid, uuid, text) to authenticated;
revoke execute on function public.admin_loyalty_upsert_service_rule(text, boolean, boolean, numeric, numeric, text) from public, anon;
grant execute on function public.admin_loyalty_upsert_service_rule(text, boolean, boolean, numeric, numeric, text) to authenticated;
revoke execute on function public.admin_loyalty_customers(text, integer, integer) from public, anon;
grant execute on function public.admin_loyalty_customers(text, integer, integer) to authenticated;

-- ============================================================================
-- End of migration.
-- ============================================================================
