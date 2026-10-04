-- ============================================================================
-- BTECH SMM — Ambassador & Referral program
-- ----------------------------------------------------------------------------
-- Run after every previous migration. Additive / idempotent.
-- Independent of loyalty: it works whether or not migration_loyalty.sql ran.
--
-- THREE SEPARATE MONEY/POINT SYSTEMS (never merged):
--   wallets / transactions        real customer money            (untouched here)
--   loyalty_*                     points, levels, discounts      (untouched here)
--   ambassador_commissions        ambassador earnings ledger     (this file)
--
-- DESIGN
--  * Attribution:  claim_referral() validates a code server-side and writes ONE
--    immutable ambassador_referrals row per customer (unique on the customer).
--  * Commission:   a trigger on public.orders creates the earning when an order
--    qualifies and a negative reversal when it is refunded/cancelled. The rate
--    used is stored on every row, so later rate changes never rewrite history.
--  * Ledger rows are never deleted. Availability is derived from available_at
--    (hold period), "withdrawn" from ambassador_withdrawals — no cron needed.
--  * No client role can write any of these tables. Customers read their own
--    rows; admins read all and write only through audited RPCs.
--  * Payouts are recorded, NOT automated: an admin pays by M-Pesa and marks the
--    withdrawal paid. (Automatic B2C payout would be a separate Daraja project.)
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Program settings (single row)
-- ---------------------------------------------------------------------------
create table if not exists public.ambassador_settings (
  id boolean primary key default true check (id),
  program_enabled boolean not null default true,
  default_commission_rate numeric not null default 5 check (default_commission_rate between 0 and 100),
  qualify_on text not null default 'completed' check (qualify_on in ('paid', 'completed')),
  hold_days integer not null default 7 check (hold_days >= 0),
  min_withdrawal numeric not null default 500 check (min_withdrawal > 0),
  attribution_window_days integer not null default 7 check (attribution_window_days >= 0),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);
insert into public.ambassador_settings (id) values (true) on conflict (id) do nothing;

-- Services can opt out of commission (public boolean, reveals nothing sensitive).
alter table public.services add column if not exists commission_eligible boolean not null default true;

-- ---------------------------------------------------------------------------
-- Ambassadors
-- ---------------------------------------------------------------------------
create sequence if not exists public.ambassador_number_seq;   -- never reused

create table if not exists public.ambassadors (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete restrict,
  display_name text not null check (length(trim(display_name)) between 2 and 40),
  motivation text not null default '',
  status text not null default 'applicant'
    check (status in ('applicant', 'approved', 'suspended', 'rejected', 'deactivated')),
  ambassador_number bigint unique,
  ambassador_code text unique,                 -- BTECH-AMB-000001, assigned once on first approval
  referral_code text,
  commission_rate numeric not null default 5 check (commission_rate between 0 and 100),
  admin_notes text not null default '',
  applied_at timestamptz not null default now(),
  approved_at timestamptz,
  status_changed_at timestamptz not null default now(),
  last_activity_at timestamptz
);
create unique index if not exists ambassadors_referral_code_ci
  on public.ambassadors (upper(referral_code)) where referral_code is not null;

-- ---------------------------------------------------------------------------
-- Referrals (one referrer per customer, ever)
-- ---------------------------------------------------------------------------
create table if not exists public.ambassador_referrals (
  id uuid primary key default gen_random_uuid(),
  ambassador_id uuid not null references public.ambassadors(id) on delete restrict,
  referred_user_id uuid not null unique references auth.users(id) on delete cascade,
  referral_code_used text not null,
  created_at timestamptz not null default now()
);
create index if not exists ambassador_referrals_amb_idx on public.ambassador_referrals (ambassador_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Earnings ledger
--   earn        + commission on a qualifying order (rate frozen on the row)
--   reversal    - the matching negative row when that order is refunded/cancelled
--   adjustment  +/- admin correction (reason lives in the audit log)
-- status 'pending' = not yet reversed; it becomes spendable once available_at
-- has passed. 'reversed' marks an earn that has a reversal row.
-- ---------------------------------------------------------------------------
create table if not exists public.ambassador_commissions (
  id uuid primary key default gen_random_uuid(),
  ambassador_id uuid not null references public.ambassadors(id) on delete restrict,
  referred_user_id uuid references auth.users(id) on delete set null,
  order_id text references public.orders(id) on delete set null,
  type text not null check (type in ('earn', 'reversal', 'adjustment')),
  amount numeric not null,
  commissionable_amount numeric not null default 0,
  rate_percent numeric not null default 0,
  status text not null default 'pending' check (status in ('pending', 'reversed')),
  reverses_id uuid references public.ambassador_commissions(id),
  note text not null default '',
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  available_at timestamptz not null default now(),
  check ((type = 'earn' and amount > 0) or (type = 'reversal' and amount < 0) or (type = 'adjustment' and amount <> 0))
);
create unique index if not exists ambassador_commission_one_earn
  on public.ambassador_commissions (order_id) where type = 'earn';
create unique index if not exists ambassador_commission_one_reversal
  on public.ambassador_commissions (reverses_id) where type = 'reversal';
create index if not exists ambassador_commission_amb_idx on public.ambassador_commissions (ambassador_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Rate history, withdrawals, audit
-- ---------------------------------------------------------------------------
create table if not exists public.ambassador_rate_history (
  id uuid primary key default gen_random_uuid(),
  ambassador_id uuid not null references public.ambassadors(id) on delete restrict,
  old_rate numeric,
  new_rate numeric not null,
  changed_by uuid references auth.users(id),
  reason text,
  changed_at timestamptz not null default now()
);

create table if not exists public.ambassador_withdrawals (
  id uuid primary key default gen_random_uuid(),
  ambassador_id uuid not null references public.ambassadors(id) on delete restrict,
  amount numeric not null check (amount > 0),
  phone text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'paid')),
  admin_note text,
  payout_reference text,
  requested_at timestamptz not null default now(),
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  paid_at timestamptz
);
create unique index if not exists ambassador_one_open_withdrawal
  on public.ambassador_withdrawals (ambassador_id) where status in ('pending', 'approved');
create index if not exists ambassador_withdrawals_amb_idx on public.ambassador_withdrawals (ambassador_id, requested_at desc);

create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid not null references auth.users(id),
  action text not null,
  target_type text not null,
  target_id text,
  previous_value jsonb,
  new_value jsonb,
  reason text,
  created_at timestamptz not null default now()
);
create index if not exists audit_logs_created_idx on public.audit_logs (created_at desc);

-- ---------------------------------------------------------------------------
-- RLS: read-only for customers, admin read, no write policy for anyone.
-- (ambassador_referrals has no customer policy at all — the ambassador sees
-- referrals only through get_my_referrals(), which masks identities.)
-- ---------------------------------------------------------------------------
alter table public.ambassador_settings enable row level security;
alter table public.ambassadors enable row level security;
alter table public.ambassador_referrals enable row level security;
alter table public.ambassador_commissions enable row level security;
alter table public.ambassador_rate_history enable row level security;
alter table public.ambassador_withdrawals enable row level security;
alter table public.audit_logs enable row level security;

drop policy if exists "ambassadors_own" on public.ambassadors;
create policy "ambassadors_own" on public.ambassadors for select using (auth.uid() = user_id);
drop policy if exists "ambassadors_admin" on public.ambassadors;
create policy "ambassadors_admin" on public.ambassadors for select using (public.is_admin());

drop policy if exists "amb_commissions_own" on public.ambassador_commissions;
create policy "amb_commissions_own" on public.ambassador_commissions for select using (
  exists (select 1 from public.ambassadors a where a.id = ambassador_id and a.user_id = auth.uid()));
drop policy if exists "amb_commissions_admin" on public.ambassador_commissions;
create policy "amb_commissions_admin" on public.ambassador_commissions for select using (public.is_admin());

drop policy if exists "amb_withdrawals_own" on public.ambassador_withdrawals;
create policy "amb_withdrawals_own" on public.ambassador_withdrawals for select using (
  exists (select 1 from public.ambassadors a where a.id = ambassador_id and a.user_id = auth.uid()));
drop policy if exists "amb_withdrawals_admin" on public.ambassador_withdrawals;
create policy "amb_withdrawals_admin" on public.ambassador_withdrawals for select using (public.is_admin());

drop policy if exists "amb_referrals_admin" on public.ambassador_referrals;
create policy "amb_referrals_admin" on public.ambassador_referrals for select using (public.is_admin());
drop policy if exists "amb_rate_history_admin" on public.ambassador_rate_history;
create policy "amb_rate_history_admin" on public.ambassador_rate_history for select using (public.is_admin());
drop policy if exists "amb_settings_admin" on public.ambassador_settings;
create policy "amb_settings_admin" on public.ambassador_settings for select using (public.is_admin());
drop policy if exists "audit_logs_admin" on public.audit_logs;
create policy "audit_logs_admin" on public.audit_logs for select using (public.is_admin());

-- ---------------------------------------------------------------------------
-- Internal helpers
-- ---------------------------------------------------------------------------
create or replace function public.audit_log(p_action text, p_type text, p_target text, p_prev jsonb, p_new jsonb, p_reason text)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.audit_logs (admin_id, action, target_type, target_id, previous_value, new_value, reason)
  values (auth.uid(), p_action, p_type, p_target, p_prev, p_new, nullif(trim(coalesce(p_reason, '')), ''));
$$;

-- All money figures for one ambassador, in one place.
--   available = matured earns + (reversed earns and their reversals, which net to 0)
--               + adjustments - every withdrawal not rejected
create or replace function public.ambassador_balances(p_ambassador uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with c as (
    select
      coalesce(sum(amount) filter (where type = 'earn'), 0) as generated,
      coalesce(-sum(amount) filter (where type = 'reversal'), 0) as reversed,
      coalesce(sum(amount) filter (where type = 'adjustment'), 0) as adjustments,
      coalesce(sum(amount) filter (where type = 'earn' and status = 'pending' and available_at > now()), 0) as pending,
      coalesce(sum(amount) filter (
        where (type = 'earn' and ((status = 'pending' and available_at <= now()) or status = 'reversed'))
           or type in ('reversal', 'adjustment')), 0) as releasable
    from public.ambassador_commissions where ambassador_id = p_ambassador
  ), w as (
    select
      coalesce(sum(amount) filter (where status in ('pending', 'approved', 'paid')), 0) as committed,
      coalesce(sum(amount) filter (where status = 'paid'), 0) as withdrawn,
      coalesce(sum(amount) filter (where status in ('pending', 'approved')), 0) as in_review
    from public.ambassador_withdrawals where ambassador_id = p_ambassador
  )
  select jsonb_build_object(
    'generated', c.generated, 'reversed', c.reversed, 'adjustments', c.adjustments,
    'pending', c.pending, 'available', c.releasable - w.committed,
    'withdrawn', w.withdrawn, 'in_review', w.in_review)
  from c, w;
$$;

create or replace function public.generate_referral_code(p_name text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_base text := upper(substr(regexp_replace(coalesce(p_name, ''), '[^A-Za-z]', '', 'g'), 1, 4));
  v_code text;
  v_try integer := 0;
begin
  if length(v_base) < 2 then
    v_base := 'BTECH';
  end if;
  loop
    v_code := v_base || lpad((floor(random() * 900) + 100)::integer::text, 3, '0');
    exit when not exists (select 1 from public.ambassadors where upper(referral_code) = v_code);
    v_try := v_try + 1;
    if v_try > 40 then
      v_base := v_base || chr(65 + floor(random() * 26)::integer);
      v_try := 0;
    end if;
  end loop;
  return v_code;
end;
$$;

-- ---------------------------------------------------------------------------
-- Trigger: earn on qualifying orders, reverse on refund/cancel.
-- ---------------------------------------------------------------------------
create or replace function public.ambassador_on_order_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  s public.ambassador_settings;
  r public.ambassador_referrals;
  a public.ambassadors;
  v_earn public.ambassador_commissions;
  v_amt numeric;
  v_id uuid;
begin
  -- Reversals are always processed, even if the programme is switched off.
  if new.payment_status = 'refunded' or new.status = 'cancelled' then
    select * into v_earn from public.ambassador_commissions
     where order_id = new.id and type = 'earn' and status = 'pending';
    if found then
      insert into public.ambassador_commissions
        (ambassador_id, referred_user_id, order_id, type, amount, commissionable_amount, rate_percent, status, reverses_id, note, available_at)
      values
        (v_earn.ambassador_id, v_earn.referred_user_id, v_earn.order_id, 'reversal', -v_earn.amount,
         v_earn.commissionable_amount, v_earn.rate_percent, 'pending', v_earn.id,
         'Order ' || new.id || ' refunded or cancelled', now())
      on conflict (reverses_id) where type = 'reversal' do nothing
      returning id into v_id;
      if v_id is not null then
        update public.ambassador_commissions set status = 'reversed' where id = v_earn.id;
      end if;
    end if;
    return new;
  end if;

  select * into s from public.ambassador_settings where id;
  if not found or not s.program_enabled then
    return new;
  end if;

  if new.payment_status = 'paid' and new.status <> 'cancelled' and (s.qualify_on = 'paid' or new.status = 'completed') then
    select * into r from public.ambassador_referrals where referred_user_id = new.user_id;
    if not found then
      return new;
    end if;
    select * into a from public.ambassadors where id = r.ambassador_id;
    if not found or a.status <> 'approved' or a.user_id = new.user_id then
      return new;
    end if;
    if not coalesce((select commission_eligible from public.services where id = new.service_id), true) then
      return new;
    end if;

    -- Commissionable amount = what the customer actually paid for the order
    -- (after any loyalty discount). Wallet deposits are never commissionable.
    v_amt := round(new.amount * a.commission_rate / 100, 2);
    if v_amt > 0 then
      insert into public.ambassador_commissions
        (ambassador_id, referred_user_id, order_id, type, amount, commissionable_amount, rate_percent, status, note, available_at)
      values
        (a.id, new.user_id, new.id, 'earn', v_amt, new.amount, a.commission_rate, 'pending',
         'Order ' || new.id, now() + make_interval(days => s.hold_days))
      on conflict (order_id) where type = 'earn' do nothing
      returning id into v_id;
      if v_id is not null then
        update public.ambassadors set last_activity_at = now() where id = a.id;
      end if;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists ambassador_order_change on public.orders;
create trigger ambassador_order_change
  after update of status, payment_status on public.orders
  for each row
  when (old.status is distinct from new.status or old.payment_status is distinct from new.payment_status)
  execute function public.ambassador_on_order_change();

drop trigger if exists ambassador_order_insert on public.orders;
create trigger ambassador_order_insert
  after insert on public.orders
  for each row
  when (new.payment_status = 'paid')
  execute function public.ambassador_on_order_change();

-- ---------------------------------------------------------------------------
-- Public: safe, limited verification (anonymous callers allowed)
-- ---------------------------------------------------------------------------
create or replace function public.verify_ambassador(p_code text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  a public.ambassadors;
begin
  select * into a from public.ambassadors
   where ambassador_code = upper(trim(coalesce(p_code, ''))) and status in ('approved', 'suspended', 'deactivated');
  if not found then
    return jsonb_build_object('found', false);
  end if;
  return jsonb_build_object(
    'found', true,
    'ambassador_code', a.ambassador_code,
    'display_name', a.display_name,
    'referral_code', case when a.status = 'approved' then a.referral_code else null end,
    'status', a.status,
    'issued_at', a.approved_at);
end;
$$;

-- ---------------------------------------------------------------------------
-- Customer RPCs
-- ---------------------------------------------------------------------------
create or replace function public.claim_referral(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_code text := upper(trim(coalesce(p_code, '')));
  s public.ambassador_settings;
  a public.ambassadors;
  p public.profiles;
begin
  if v_uid is null then
    raise exception 'Not authenticated.';
  end if;
  if v_code !~ '^[A-Z0-9_-]{3,24}$' then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;
  if exists (select 1 from public.ambassador_referrals where referred_user_id = v_uid) then
    return jsonb_build_object('ok', false, 'reason', 'already_attributed');
  end if;

  select * into s from public.ambassador_settings where id;
  select * into a from public.ambassadors where upper(referral_code) = v_code and status = 'approved';
  if not found or not s.program_enabled then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;
  if a.user_id = v_uid then
    return jsonb_build_object('ok', false, 'reason', 'self');
  end if;

  -- Only genuinely new customers can be attributed.
  select * into p from public.profiles where id = v_uid;
  if not found or p.created_at < now() - make_interval(days => s.attribution_window_days) then
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;
  if exists (select 1 from public.orders where user_id = v_uid) then
    return jsonb_build_object('ok', false, 'reason', 'has_orders');
  end if;

  insert into public.ambassador_referrals (ambassador_id, referred_user_id, referral_code_used)
  values (a.id, v_uid, v_code)
  on conflict (referred_user_id) do nothing;
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.apply_for_ambassador(p_display_name text, p_motivation text)
returns public.ambassadors
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  s public.ambassador_settings;
  a public.ambassadors;
  v_name text := trim(coalesce(p_display_name, ''));
begin
  if v_uid is null then
    raise exception 'Not authenticated.';
  end if;
  select * into s from public.ambassador_settings where id;
  if not s.program_enabled then
    raise exception 'The Ambassador Program is not accepting applications right now.';
  end if;
  if length(v_name) < 2 or length(v_name) > 40 then
    raise exception 'Please enter a display name between 2 and 40 characters.';
  end if;

  select * into a from public.ambassadors where user_id = v_uid for update;
  if found then
    if a.status <> 'rejected' then
      raise exception 'You have already applied to the Ambassador Program.';
    end if;
    update public.ambassadors
       set display_name = v_name, motivation = left(coalesce(p_motivation, ''), 1000),
           status = 'applicant', applied_at = now(), status_changed_at = now()
     where id = a.id returning * into a;
  else
    insert into public.ambassadors (user_id, display_name, motivation, commission_rate)
    values (v_uid, v_name, left(coalesce(p_motivation, ''), 1000), s.default_commission_rate)
    returning * into a;
  end if;

  insert into public.notifications (user_id, type, title, text)
  values (v_uid, 'system', 'Application received', 'Your BTECH SMM Ambassador application is being reviewed.');
  return a;
end;
$$;

create or replace function public.get_my_ambassador()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  s public.ambassador_settings;
  a public.ambassadors;
  v_refs integer;
  v_active integer;
  v_orders integer;
  v_sales numeric;
begin
  if v_uid is null then
    raise exception 'Not authenticated.';
  end if;
  select * into s from public.ambassador_settings where id;
  select * into a from public.ambassadors where user_id = v_uid;
  if not found then
    return jsonb_build_object('exists', false, 'program_enabled', s.program_enabled);
  end if;

  select count(*) into v_refs from public.ambassador_referrals where ambassador_id = a.id;
  select count(distinct referred_user_id), count(*), coalesce(sum(commissionable_amount), 0)
    into v_active, v_orders, v_sales
    from public.ambassador_commissions where ambassador_id = a.id and type = 'earn' and status = 'pending';

  return jsonb_build_object(
    'exists', true,
    'program_enabled', s.program_enabled,
    'status', a.status,
    'display_name', a.display_name,
    'ambassador_code', a.ambassador_code,
    'referral_code', case when a.status = 'approved' then a.referral_code else null end,
    'commission_rate', a.commission_rate,
    'approved_at', a.approved_at,
    'applied_at', a.applied_at,
    'referrals', v_refs,
    'active_referrals', v_active,
    'qualifying_orders', v_orders,
    'referred_sales', v_sales,
    'conversion_rate', case when v_refs > 0 then round(v_active::numeric / v_refs * 100, 1) else 0 end,
    'balances', public.ambassador_balances(a.id),
    'min_withdrawal', s.min_withdrawal,
    'hold_days', s.hold_days
  );
end;
$$;

-- The ambassador's own referrals, identities masked to a first name.
create or replace function public.get_my_referrals(p_limit integer default 25, p_offset integer default 0)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  a public.ambassadors;
begin
  select * into a from public.ambassadors where user_id = auth.uid();
  if not found then
    return '[]'::jsonb;
  end if;
  return coalesce((
    select jsonb_agg(t) from (
      select coalesce(nullif(split_part(p.name, ' ', 1), ''), 'Customer') as first_name,
             r.created_at as joined_at,
             (select count(*) from public.ambassador_commissions c
               where c.ambassador_id = a.id and c.referred_user_id = r.referred_user_id and c.type = 'earn' and c.status = 'pending') as qualifying_orders,
             (select coalesce(sum(c.commissionable_amount), 0) from public.ambassador_commissions c
               where c.ambassador_id = a.id and c.referred_user_id = r.referred_user_id and c.type = 'earn' and c.status = 'pending') as order_value
      from public.ambassador_referrals r
      left join public.profiles p on p.id = r.referred_user_id
      where r.ambassador_id = a.id
      order by r.created_at desc
      limit least(greatest(coalesce(p_limit, 25), 1), 100) offset greatest(coalesce(p_offset, 0), 0)
    ) t), '[]'::jsonb);
end;
$$;

create or replace function public.request_ambassador_withdrawal(p_amount numeric, p_phone text)
returns public.ambassador_withdrawals
language plpgsql
security definer
set search_path = public
as $$
declare
  s public.ambassador_settings;
  a public.ambassadors;
  v_phone text := regexp_replace(coalesce(p_phone, ''), '[\s-]', '', 'g');
  v_avail numeric;
  w public.ambassador_withdrawals;
begin
  select * into a from public.ambassadors where user_id = auth.uid() for update;   -- serialises requests
  if not found or a.status <> 'approved' then
    raise exception 'Only active ambassadors can request withdrawals.';
  end if;
  select * into s from public.ambassador_settings where id;
  if p_amount is null or p_amount < s.min_withdrawal then
    raise exception 'The minimum withdrawal is KES %.', s.min_withdrawal;
  end if;
  if v_phone !~ '^(\+?254|0)[17][0-9]{8}$' then
    raise exception 'Please enter a valid Kenyan M-Pesa number.';
  end if;
  if exists (select 1 from public.ambassador_withdrawals where ambassador_id = a.id and status in ('pending', 'approved')) then
    raise exception 'You already have a withdrawal in progress.';
  end if;

  v_avail := (public.ambassador_balances(a.id)->>'available')::numeric;
  if p_amount > v_avail then
    raise exception 'You can withdraw up to KES % right now.', greatest(v_avail, 0);
  end if;

  insert into public.ambassador_withdrawals (ambassador_id, amount, phone)
  values (a.id, round(p_amount, 2), v_phone) returning * into w;

  insert into public.notifications (user_id, type, title, text)
  values (auth.uid(), 'payment', 'Withdrawal requested', 'Your withdrawal request of KES ' || w.amount || ' is awaiting review.');
  return w;
end;
$$;

-- ---------------------------------------------------------------------------
-- Admin RPCs (each re-checks is_admin() and writes to audit_logs)
-- ---------------------------------------------------------------------------
create or replace function public.admin_update_ambassador_settings(p_patch jsonb, p_reason text default null)
returns public.ambassador_settings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old public.ambassador_settings;
  v_new public.ambassador_settings;
begin
  if not public.is_admin() then raise exception 'Admin access required.'; end if;
  select * into v_old from public.ambassador_settings where id for update;
  update public.ambassador_settings set
    program_enabled = coalesce((p_patch->>'program_enabled')::boolean, program_enabled),
    default_commission_rate = coalesce((p_patch->>'default_commission_rate')::numeric, default_commission_rate),
    qualify_on = coalesce(p_patch->>'qualify_on', qualify_on),
    hold_days = coalesce((p_patch->>'hold_days')::integer, hold_days),
    min_withdrawal = coalesce((p_patch->>'min_withdrawal')::numeric, min_withdrawal),
    attribution_window_days = coalesce((p_patch->>'attribution_window_days')::integer, attribution_window_days),
    updated_at = now(), updated_by = auth.uid()
  where id returning * into v_new;
  perform public.audit_log('ambassador_settings_update', 'ambassador_settings', 'singleton', to_jsonb(v_old), to_jsonb(v_new), p_reason);
  return v_new;
end;
$$;

create or replace function public.admin_review_ambassador(p_id uuid, p_action text, p_reason text default null)
returns public.ambassadors
language plpgsql
security definer
set search_path = public
as $$
declare
  a public.ambassadors;
  v_prev text;
  v_new_status text;
  v_title text;
  v_num bigint;
begin
  if not public.is_admin() then raise exception 'Admin access required.'; end if;
  select * into a from public.ambassadors where id = p_id for update;
  if not found then raise exception 'Ambassador not found.'; end if;
  v_prev := a.status;

  if p_action = 'approve' then
    if a.status <> 'applicant' then raise exception 'Only pending applications can be approved.'; end if;
    v_new_status := 'approved'; v_title := 'Application approved';
  elsif p_action = 'reject' then
    if a.status <> 'applicant' then raise exception 'Only pending applications can be rejected.'; end if;
    v_new_status := 'rejected'; v_title := 'Application not approved';
  elsif p_action = 'suspend' then
    if a.status <> 'approved' then raise exception 'Only active ambassadors can be suspended.'; end if;
    v_new_status := 'suspended'; v_title := 'Ambassador account suspended';
  elsif p_action = 'reactivate' then
    if a.status not in ('suspended', 'deactivated') then raise exception 'This ambassador is not suspended or deactivated.'; end if;
    v_new_status := 'approved'; v_title := 'Ambassador account reactivated';
  elsif p_action = 'deactivate' then
    if a.status not in ('approved', 'suspended') then raise exception 'This ambassador cannot be deactivated.'; end if;
    v_new_status := 'deactivated'; v_title := 'Ambassador account deactivated';
  else
    raise exception 'Unknown action.';
  end if;

  if p_action = 'approve' then
    -- Permanent ID and referral code are assigned once and never change on their own.
    v_num := coalesce(a.ambassador_number, nextval('public.ambassador_number_seq'));
    update public.ambassadors set
      status = 'approved',
      ambassador_number = v_num,
      ambassador_code = coalesce(a.ambassador_code, 'BTECH-AMB-' || lpad(v_num::text, 6, '0')),
      referral_code = coalesce(a.referral_code, public.generate_referral_code(a.display_name)),
      approved_at = coalesce(approved_at, now()),
      status_changed_at = now()
    where id = p_id returning * into a;
  else
    update public.ambassadors set status = v_new_status, status_changed_at = now()
    where id = p_id returning * into a;
  end if;

  insert into public.notifications (user_id, type, title, text)
  values (a.user_id, 'system', v_title,
    case when p_action = 'approve' then 'Welcome to the BTECH SMM Ambassador Program. Your Ambassador ID is ' || a.ambassador_code || '.'
         else 'Your BTECH SMM Ambassador status is now: ' || v_new_status || '.' end);

  perform public.audit_log('ambassador_' || p_action, 'ambassador', p_id::text,
    jsonb_build_object('status', v_prev), jsonb_build_object('status', a.status, 'ambassador_code', a.ambassador_code), p_reason);
  return a;
end;
$$;

create or replace function public.admin_set_commission_rate(p_id uuid, p_rate numeric, p_reason text)
returns public.ambassadors
language plpgsql
security definer
set search_path = public
as $$
declare
  a public.ambassadors;
  v_old numeric;
begin
  if not public.is_admin() then raise exception 'Admin access required.'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'A reason is required.'; end if;
  if p_rate is null or p_rate < 0 or p_rate > 100 then raise exception 'The rate must be between 0 and 100.'; end if;
  select commission_rate into v_old from public.ambassadors where id = p_id for update;
  if not found then raise exception 'Ambassador not found.'; end if;

  -- Applies to FUTURE qualifying orders only; existing ledger rows keep their own rate.
  update public.ambassadors set commission_rate = p_rate where id = p_id returning * into a;
  insert into public.ambassador_rate_history (ambassador_id, old_rate, new_rate, changed_by, reason)
  values (p_id, v_old, p_rate, auth.uid(), trim(p_reason));
  perform public.audit_log('commission_rate_change', 'ambassador', p_id::text,
    jsonb_build_object('commission_rate', v_old), jsonb_build_object('commission_rate', p_rate), p_reason);
  return a;
end;
$$;

create or replace function public.admin_commission_adjustment(p_id uuid, p_amount numeric, p_reason text)
returns public.ambassador_commissions
language plpgsql
security definer
set search_path = public
as $$
declare
  c public.ambassador_commissions;
begin
  if not public.is_admin() then raise exception 'Admin access required.'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'A reason is required.'; end if;
  if p_amount is null or p_amount = 0 then raise exception 'The adjustment must be a non-zero amount.'; end if;
  if not exists (select 1 from public.ambassadors where id = p_id) then raise exception 'Ambassador not found.'; end if;

  insert into public.ambassador_commissions (ambassador_id, type, amount, status, note, created_by, available_at)
  values (p_id, 'adjustment', round(p_amount, 2), 'pending',
          case when p_amount > 0 then 'Admin credit' else 'Admin deduction' end, auth.uid(), now())
  returning * into c;
  perform public.audit_log('commission_adjustment', 'ambassador', p_id::text, null,
    jsonb_build_object('amount', c.amount, 'commission_id', c.id), p_reason);
  return c;
end;
$$;

-- The referral relationship is stored by ambassador id, so changing a code never
-- breaks attribution or commissions; only old links stop resolving.
create or replace function public.admin_set_referral_code(p_id uuid, p_code text, p_reason text)
returns public.ambassadors
language plpgsql
security definer
set search_path = public
as $$
declare
  a public.ambassadors;
  v_code text := upper(trim(coalesce(p_code, '')));
  v_old text;
begin
  if not public.is_admin() then raise exception 'Admin access required.'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'A reason is required.'; end if;
  if v_code !~ '^[A-Z0-9]{4,16}$' then raise exception 'Use 4-16 letters or digits.'; end if;
  if exists (select 1 from public.ambassadors where upper(referral_code) = v_code and id <> p_id) then
    raise exception 'That referral code is already in use.';
  end if;
  select referral_code into v_old from public.ambassadors where id = p_id for update;
  if not found then raise exception 'Ambassador not found.'; end if;
  update public.ambassadors set referral_code = v_code where id = p_id returning * into a;
  perform public.audit_log('referral_code_change', 'ambassador', p_id::text,
    jsonb_build_object('referral_code', v_old), jsonb_build_object('referral_code', v_code), p_reason);
  return a;
end;
$$;

create or replace function public.admin_save_ambassador_notes(p_id uuid, p_notes text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then raise exception 'Admin access required.'; end if;
  update public.ambassadors set admin_notes = left(coalesce(p_notes, ''), 2000) where id = p_id;
  perform public.audit_log('ambassador_notes', 'ambassador', p_id::text, null, null, 'Internal notes updated');
end;
$$;

create or replace function public.admin_review_withdrawal(p_id uuid, p_action text, p_note text default null, p_reference text default null)
returns public.ambassador_withdrawals
language plpgsql
security definer
set search_path = public
as $$
declare
  w public.ambassador_withdrawals;
  v_prev text;
  v_uid uuid;
begin
  if not public.is_admin() then raise exception 'Admin access required.'; end if;
  select * into w from public.ambassador_withdrawals where id = p_id for update;
  if not found then raise exception 'Withdrawal not found.'; end if;
  v_prev := w.status;

  if p_action = 'approve' then
    if w.status <> 'pending' then raise exception 'Only pending requests can be approved.'; end if;
    update public.ambassador_withdrawals set status = 'approved', admin_note = nullif(trim(coalesce(p_note, '')), ''),
      reviewed_by = auth.uid(), reviewed_at = now() where id = p_id returning * into w;
  elsif p_action = 'reject' then
    if w.status not in ('pending', 'approved') then raise exception 'This request can no longer be rejected.'; end if;
    if coalesce(trim(p_note), '') = '' then raise exception 'A reason is required to reject.'; end if;
    update public.ambassador_withdrawals set status = 'rejected', admin_note = trim(p_note),
      reviewed_by = auth.uid(), reviewed_at = now() where id = p_id returning * into w;
  elsif p_action = 'mark_paid' then
    if w.status <> 'approved' then raise exception 'Approve the request before marking it paid.'; end if;
    if coalesce(trim(p_reference), '') = '' then raise exception 'Enter the M-Pesa receipt/reference.'; end if;
    update public.ambassador_withdrawals set status = 'paid', payout_reference = trim(p_reference),
      paid_at = now(), reviewed_by = coalesce(reviewed_by, auth.uid()), reviewed_at = coalesce(reviewed_at, now())
    where id = p_id returning * into w;
  else
    raise exception 'Unknown action.';
  end if;

  select user_id into v_uid from public.ambassadors where id = w.ambassador_id;
  insert into public.notifications (user_id, type, title, text)
  values (v_uid, 'payment', 'Withdrawal ' || w.status,
    'Your withdrawal of KES ' || w.amount || ' is now ' || w.status || '.');

  perform public.audit_log('withdrawal_' || p_action, 'withdrawal', p_id::text,
    jsonb_build_object('status', v_prev), jsonb_build_object('status', w.status, 'amount', w.amount, 'reference', w.payout_reference),
    coalesce(p_note, p_reference));
  return w;
end;
$$;

create or replace function public.admin_list_ambassadors(p_status text default null, p_search text default null, p_limit integer default 25, p_offset integer default 0)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_q text := lower(trim(coalesce(p_search, '')));
begin
  if not public.is_admin() then raise exception 'Admin access required.'; end if;
  return coalesce((
    select jsonb_agg(t) from (
      select a.id, a.user_id, a.display_name, a.status, a.ambassador_code, a.referral_code, a.commission_rate,
             a.motivation, a.admin_notes, a.applied_at, a.approved_at, a.last_activity_at,
             p.name as account_name, p.email,
             (select count(*) from public.ambassador_referrals r where r.ambassador_id = a.id) as referrals,
             (select count(distinct c.referred_user_id) from public.ambassador_commissions c
               where c.ambassador_id = a.id and c.type = 'earn' and c.status = 'pending') as active_referrals,
             (select count(*) from public.ambassador_commissions c
               where c.ambassador_id = a.id and c.type = 'earn' and c.status = 'pending') as qualifying_orders,
             public.ambassador_balances(a.id) as balances
      from public.ambassadors a
      join public.profiles p on p.id = a.user_id
      where (p_status is null or p_status = '' or a.status = p_status)
        and (v_q = '' or position(v_q in lower(a.display_name)) > 0 or position(v_q in lower(p.email)) > 0
             or position(v_q in lower(coalesce(a.ambassador_code, ''))) > 0 or position(v_q in lower(coalesce(a.referral_code, ''))) > 0)
      order by case a.status when 'applicant' then 0 else 1 end, a.applied_at desc
      limit least(greatest(coalesce(p_limit, 25), 1), 100) offset greatest(coalesce(p_offset, 0), 0)
    ) t), '[]'::jsonb);
end;
$$;

create or replace function public.admin_list_withdrawals(p_status text default null, p_limit integer default 25)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then raise exception 'Admin access required.'; end if;
  return coalesce((
    select jsonb_agg(t) from (
      select w.id, w.amount, w.phone, w.status, w.admin_note, w.payout_reference, w.requested_at, w.reviewed_at, w.paid_at,
             a.display_name, a.ambassador_code, a.id as ambassador_id,
             (public.ambassador_balances(a.id)->>'available')::numeric as available_now
      from public.ambassador_withdrawals w join public.ambassadors a on a.id = w.ambassador_id
      where (p_status is null or p_status = '' or w.status = p_status)
      order by case w.status when 'pending' then 0 when 'approved' then 1 else 2 end, w.requested_at desc
      limit least(greatest(coalesce(p_limit, 25), 1), 100)
    ) t), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- Execute permissions
-- ---------------------------------------------------------------------------
revoke execute on function public.audit_log(text, text, text, jsonb, jsonb, text) from public, anon, authenticated;
revoke execute on function public.ambassador_balances(uuid) from public, anon, authenticated;
revoke execute on function public.generate_referral_code(text) from public, anon, authenticated;
revoke execute on function public.ambassador_on_order_change() from public, anon, authenticated;

grant execute on function public.verify_ambassador(text) to anon, authenticated;

revoke execute on function public.claim_referral(text) from public, anon;
grant execute on function public.claim_referral(text) to authenticated;
revoke execute on function public.apply_for_ambassador(text, text) from public, anon;
grant execute on function public.apply_for_ambassador(text, text) to authenticated;
revoke execute on function public.get_my_ambassador() from public, anon;
grant execute on function public.get_my_ambassador() to authenticated;
revoke execute on function public.get_my_referrals(integer, integer) from public, anon;
grant execute on function public.get_my_referrals(integer, integer) to authenticated;
revoke execute on function public.request_ambassador_withdrawal(numeric, text) from public, anon;
grant execute on function public.request_ambassador_withdrawal(numeric, text) to authenticated;

revoke execute on function public.admin_update_ambassador_settings(jsonb, text) from public, anon;
grant execute on function public.admin_update_ambassador_settings(jsonb, text) to authenticated;
revoke execute on function public.admin_review_ambassador(uuid, text, text) from public, anon;
grant execute on function public.admin_review_ambassador(uuid, text, text) to authenticated;
revoke execute on function public.admin_set_commission_rate(uuid, numeric, text) from public, anon;
grant execute on function public.admin_set_commission_rate(uuid, numeric, text) to authenticated;
revoke execute on function public.admin_commission_adjustment(uuid, numeric, text) from public, anon;
grant execute on function public.admin_commission_adjustment(uuid, numeric, text) to authenticated;
revoke execute on function public.admin_set_referral_code(uuid, text, text) from public, anon;
grant execute on function public.admin_set_referral_code(uuid, text, text) to authenticated;
revoke execute on function public.admin_save_ambassador_notes(uuid, text) from public, anon;
grant execute on function public.admin_save_ambassador_notes(uuid, text) to authenticated;
revoke execute on function public.admin_review_withdrawal(uuid, text, text, text) from public, anon;
grant execute on function public.admin_review_withdrawal(uuid, text, text, text) to authenticated;
revoke execute on function public.admin_list_ambassadors(text, text, integer, integer) from public, anon;
grant execute on function public.admin_list_ambassadors(text, text, integer, integer) to authenticated;
revoke execute on function public.admin_list_withdrawals(text, integer) from public, anon;
grant execute on function public.admin_list_withdrawals(text, integer) to authenticated;

-- ============================================================================
-- End of migration.
-- ============================================================================
