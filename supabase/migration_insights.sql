-- ============================================================================
-- BTECH SMM — BTECH INSIGHTS (server-side analytics)
-- ----------------------------------------------------------------------------
-- Run AFTER migration_ambassador.sql (the ambassador figures read its tables).
-- The loyalty figures are optional: they appear only once migration_loyalty.sql
-- has been run.
--
-- Everything here is READ-ONLY aggregation done inside Postgres, so the browser
-- never downloads raw order/customer tables to calculate analytics. Every
-- function is admin-only (is_admin()) and takes a date window [p_from, p_to).
-- The previous period is the equal-length window immediately before p_from.
--
-- ESTIMATES: provider rates are stored in USD, so a KES cost/profit can only be
-- estimated, and only after an admin sets business_settings 'usd_kes_rate'.
-- Without it, no profit figure is produced.
-- ============================================================================

create table if not exists public.business_settings (
  key text primary key,
  value text,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);
alter table public.business_settings enable row level security;
drop policy if exists "business_settings_admin" on public.business_settings;
create policy "business_settings_admin" on public.business_settings for select using (public.is_admin());

create or replace function public.admin_set_business_setting(p_key text, p_value text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old text;
begin
  if not public.is_admin() then raise exception 'Admin access required.'; end if;
  if p_key not in ('usd_kes_rate', 'pending_order_threshold_hours', 'provider_submit_threshold_minutes') then
    raise exception 'Unknown setting.';
  end if;
  if p_value is not null and trim(p_value) <> '' and (p_value !~ '^[0-9]+(\.[0-9]+)?$' or p_value::numeric <= 0) then
    raise exception 'Enter a positive number.';
  end if;
  select value into v_old from public.business_settings where key = p_key;
  insert into public.business_settings (key, value, updated_by)
  values (p_key, nullif(trim(coalesce(p_value, '')), ''), auth.uid())
  on conflict (key) do update set value = excluded.value, updated_at = now(), updated_by = auth.uid();
  perform public.audit_log('business_setting_change', 'business_settings', p_key,
    jsonb_build_object('value', v_old), jsonb_build_object('value', nullif(trim(coalesce(p_value, '')), '')), null);
end;
$$;

create or replace function public.insights_setting(p_key text, p_default numeric)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select nullif(value, '')::numeric from public.business_settings where key = p_key), p_default);
$$;

-- ---------------------------------------------------------------------------
-- Orders: status mix, revenue, daily/monthly series (current vs previous)
-- ---------------------------------------------------------------------------
create or replace function public.insights_orders(p_from timestamptz, p_to timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pf timestamptz := p_from - (p_to - p_from);
  v_bucket text := case when (p_to - p_from) > interval '92 days' then 'month' else 'day' end;
begin
  if not public.is_admin() then raise exception 'Admin access required.'; end if;
  return jsonb_build_object(
    'bucket', v_bucket,
    'totals', (
      select jsonb_build_object(
        'cur', jsonb_build_object(
          'total', count(*) filter (where x.c),
          'pending', count(*) filter (where x.c and x.status = 'pending'),
          'processing', count(*) filter (where x.c and x.status = 'processing'),
          'completed', count(*) filter (where x.c and x.status = 'completed'),
          'cancelled', count(*) filter (where x.c and x.status = 'cancelled'),
          'refunded', count(*) filter (where x.c and x.payment_status = 'refunded'),
          'paid', count(*) filter (where x.c and x.payment_status = 'paid'),
          'revenue', coalesce(sum(x.amount) filter (where x.c and x.payment_status = 'paid'), 0)),
        'prev', jsonb_build_object(
          'total', count(*) filter (where x.p),
          'completed', count(*) filter (where x.p and x.status = 'completed'),
          'cancelled', count(*) filter (where x.p and x.status = 'cancelled'),
          'paid', count(*) filter (where x.p and x.payment_status = 'paid'),
          'revenue', coalesce(sum(x.amount) filter (where x.p and x.payment_status = 'paid'), 0)))
      from (
        select o.status, o.payment_status, o.amount,
               (o.created_at >= p_from and o.created_at < p_to) as c,
               (o.created_at >= v_pf and o.created_at < p_from) as p
        from public.orders o
        where o.created_at >= v_pf and o.created_at < p_to
      ) x),
    'series', (
      select coalesce(jsonb_agg(t order by t.d), '[]'::jsonb) from (
        select to_char(date_trunc(v_bucket, o.created_at at time zone 'Africa/Nairobi'), 'YYYY-MM-DD') as d,
               count(*) as orders,
               count(*) filter (where o.status = 'completed') as completed,
               count(*) filter (where o.status = 'cancelled') as cancelled,
               coalesce(sum(o.amount) filter (where o.payment_status = 'paid'), 0) as revenue
        from public.orders o
        where o.created_at >= p_from and o.created_at < p_to
        group by 1
      ) t)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Services: measurable metrics per service (no overall "best" ranking)
-- ---------------------------------------------------------------------------
create or replace function public.insights_services(p_from timestamptz, p_to timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pf timestamptz := p_from - (p_to - p_from);
  v_fx numeric := public.insights_setting('usd_kes_rate', null);
begin
  if not public.is_admin() then raise exception 'Admin access required.'; end if;
  return jsonb_build_object(
    'fx_set', v_fx is not null,
    'rows', (
      with o as (
        select x.service_id,
               count(*) filter (where x.c) as orders,
               count(*) filter (where x.p) as prev_orders,
               coalesce(sum(x.amount) filter (where x.c and x.payment_status = 'paid'), 0) as revenue,
               count(*) filter (where x.c and x.payment_status = 'refunded') as refunded,
               count(*) filter (where x.c and x.status = 'cancelled') as cancelled,
               count(*) filter (where x.c and x.status = 'completed') as completed,
               count(*) filter (where x.c and x.provider_status ~* '^(cancel|fail|error|reject)') as provider_failed,
               coalesce(sum(x.quantity) filter (where x.c and x.payment_status = 'paid'), 0) as paid_qty
        from (
          select o2.service_id, o2.status, o2.payment_status, o2.amount, o2.quantity, o2.provider_status,
                 (o2.created_at >= p_from and o2.created_at < p_to) as c,
                 (o2.created_at >= v_pf and o2.created_at < p_from) as p
          from public.orders o2
          where o2.created_at >= v_pf and o2.created_at < p_to
        ) x
        group by x.service_id
      )
      select coalesce(jsonb_agg(r order by r.orders desc), '[]'::jsonb) from (
        select s.id, s.name, s.category, s.platform, s.price_per_1000, s.active, s.visible,
               o.orders, o.prev_orders, o.revenue, o.refunded, o.cancelled, o.completed, o.provider_failed,
               pc.provider_name, pc.provider_rate, pc.provider_currency,
               case when v_fx is not null and s.unit is null and pc.provider_currency = 'USD' and pc.provider_rate is not null
                    then round(pc.provider_rate * o.paid_qty / 1000.0 * v_fx, 2) end as est_cost_kes
        from o
        join public.services s on s.id = o.service_id
        left join lateral (
          select p.name as provider_name, ps.provider_rate, ps.provider_currency
          from public.provider_services ps join public.providers p on p.id = ps.provider_id
          where ps.service_id = s.id
          order by ps.last_provider_sync desc nulls last
          limit 1
        ) pc on true
        where o.orders > 0 or o.prev_orders > 0
        order by o.orders desc
        limit 100
      ) r)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Customers
-- ---------------------------------------------------------------------------
create or replace function public.insights_customers(p_from timestamptz, p_to timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pf timestamptz := p_from - (p_to - p_from);
begin
  if not public.is_admin() then raise exception 'Admin access required.'; end if;
  return jsonb_build_object(
    'total', (select count(*) from public.profiles where role = 'customer'),
    'new_cur', (select count(*) from public.profiles where role = 'customer' and created_at >= p_from and created_at < p_to),
    'new_prev', (select count(*) from public.profiles where role = 'customer' and created_at >= v_pf and created_at < p_from),
    'active_cur', (select count(distinct user_id) from public.orders where created_at >= p_from and created_at < p_to),
    'active_prev', (select count(distinct user_id) from public.orders where created_at >= v_pf and created_at < p_from),
    'returning_cur', (
      select count(distinct o.user_id) from public.orders o
      where o.created_at >= p_from and o.created_at < p_to
        and exists (select 1 from public.orders o2 where o2.user_id = o.user_id and o2.created_at < p_from)),
    'referred_total', (select count(*) from public.ambassador_referrals),
    'referred_new', (select count(*) from public.ambassador_referrals where created_at >= p_from and created_at < p_to),
    'top', (
      select coalesce(jsonb_agg(t), '[]'::jsonb) from (
        select pr.id, pr.name, pr.email, count(*) as orders,
               coalesce(sum(o.amount) filter (where o.payment_status = 'paid'), 0) as spend,
               max(o.created_at) as last_order_at,
               exists (select 1 from public.ambassador_referrals r where r.referred_user_id = pr.id) as referred
        from public.orders o join public.profiles pr on pr.id = o.user_id
        where o.created_at >= p_from and o.created_at < p_to
        group by pr.id, pr.name, pr.email
        order by spend desc, orders desc
        limit 10
      ) t)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Finance: actual money kept apart from ESTIMATED figures
-- ---------------------------------------------------------------------------
create or replace function public.insights_finance(p_from timestamptz, p_to timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pf timestamptz := p_from - (p_to - p_from);
  v_fx numeric := public.insights_setting('usd_kes_rate', null);
  v_cov numeric := 0;
  v_cost numeric := 0;
  v_rev numeric := 0;
  v_loyalty numeric := 0;
begin
  if not public.is_admin() then raise exception 'Admin access required.'; end if;

  select coalesce(sum(o.amount) filter (where o.payment_status = 'paid'), 0) into v_rev
  from public.orders o where o.created_at >= p_from and o.created_at < p_to;

  if v_fx is not null then
    -- Only paid orders for per-quantity services whose provider rate is known in USD.
    select coalesce(sum(o.amount), 0), coalesce(sum(m.provider_rate * o.quantity / 1000.0 * v_fx), 0)
      into v_cov, v_cost
    from public.orders o
    join public.services s on s.id = o.service_id and s.unit is null
    join lateral (
      select ps.provider_rate from public.provider_services ps
      where ps.service_id = o.service_id and ps.provider_currency = 'USD' and ps.provider_rate is not null
      order by ps.last_provider_sync desc nulls last limit 1
    ) m on true
    where o.payment_status = 'paid' and o.created_at >= p_from and o.created_at < p_to;
  end if;

  if to_regclass('public.loyalty_accounts') is not null then
    select coalesce(sum(o.loyalty_discount_amount), 0) into v_loyalty
    from public.orders o where o.created_at >= p_from and o.created_at < p_to and o.payment_status = 'paid';
  end if;

  return jsonb_build_object(
    'deposits_cur', (select coalesce(sum(amount), 0) from public.payments where payment_type = 'wallet_deposit' and status = 'paid' and created_at >= p_from and created_at < p_to),
    'deposits_prev', (select coalesce(sum(amount), 0) from public.payments where payment_type = 'wallet_deposit' and status = 'paid' and created_at >= v_pf and created_at < p_from),
    'deposit_count', (select count(*) from public.payments where payment_type = 'wallet_deposit' and status = 'paid' and created_at >= p_from and created_at < p_to),
    'payments_failed', (select count(*) from public.payments where status in ('failed', 'expired') and created_at >= p_from and created_at < p_to),
    'payments_cancelled', (select count(*) from public.payments where status = 'cancelled' and created_at >= p_from and created_at < p_to),
    'wallet_spend', (select coalesce(sum(abs(amount)), 0) from public.transactions where type = 'order' and created_at >= p_from and created_at < p_to),
    'wallet_outstanding', (select coalesce(sum(balance), 0) from public.wallets),
    'wallets_funded', (select count(*) from public.wallets where balance > 0),
    'revenue', v_rev,
    'refunded_value', (select coalesce(sum(amount), 0) from public.orders where payment_status = 'refunded' and created_at >= p_from and created_at < p_to),
    'refunded_count', (select count(*) from public.orders where payment_status = 'refunded' and created_at >= p_from and created_at < p_to),
    'loyalty_discounts', v_loyalty,
    'commissions_generated', (select coalesce(sum(amount), 0) from public.ambassador_commissions where type = 'earn' and created_at >= p_from and created_at < p_to),
    'commissions_reversed', (select coalesce(-sum(amount), 0) from public.ambassador_commissions where type = 'reversal' and created_at >= p_from and created_at < p_to),
    'commission_adjustments', (select coalesce(sum(amount), 0) from public.ambassador_commissions where type = 'adjustment' and created_at >= p_from and created_at < p_to),
    'withdrawals_paid', (select coalesce(sum(amount), 0) from public.ambassador_withdrawals where status = 'paid' and paid_at >= p_from and paid_at < p_to),
    'withdrawals_pending', (select coalesce(sum(amount), 0) from public.ambassador_withdrawals where status in ('pending', 'approved')),
    'estimate', jsonb_build_object('fx', v_fx, 'covered_revenue', v_cov, 'est_cost', v_cost)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Ambassadors (optionally one ambassador)
-- ---------------------------------------------------------------------------
create or replace function public.insights_ambassadors(p_from timestamptz, p_to timestamptz, p_ambassador uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pf timestamptz := p_from - (p_to - p_from);
begin
  if not public.is_admin() then raise exception 'Admin access required.'; end if;
  return jsonb_build_object(
    'by_status', (select coalesce(jsonb_object_agg(status, n), '{}'::jsonb) from (select status, count(*) as n from public.ambassadors group by status) s),
    'new_approved', (select count(*) from public.ambassadors where approved_at >= p_from and approved_at < p_to),
    'cur', (
      select jsonb_build_object(
        'referrals', (select count(*) from public.ambassador_referrals r where r.created_at >= p_from and r.created_at < p_to and (p_ambassador is null or r.ambassador_id = p_ambassador)),
        'qualifying_orders', count(*) filter (where c.type = 'earn' and c.status = 'pending'),
        'referred_value', coalesce(sum(c.commissionable_amount) filter (where c.type = 'earn' and c.status = 'pending'), 0),
        'generated', coalesce(sum(c.amount) filter (where c.type = 'earn'), 0),
        'reversed', coalesce(-sum(c.amount) filter (where c.type = 'reversal'), 0),
        'adjustments', coalesce(sum(c.amount) filter (where c.type = 'adjustment'), 0))
      from public.ambassador_commissions c
      where c.created_at >= p_from and c.created_at < p_to and (p_ambassador is null or c.ambassador_id = p_ambassador)),
    'prev', (
      select jsonb_build_object(
        'referrals', (select count(*) from public.ambassador_referrals r where r.created_at >= v_pf and r.created_at < p_from and (p_ambassador is null or r.ambassador_id = p_ambassador)),
        'qualifying_orders', count(*) filter (where c.type = 'earn' and c.status = 'pending'),
        'generated', coalesce(sum(c.amount) filter (where c.type = 'earn'), 0))
      from public.ambassador_commissions c
      where c.created_at >= v_pf and c.created_at < p_from and (p_ambassador is null or c.ambassador_id = p_ambassador)),
    'withdrawals', (
      select jsonb_build_object(
        'pending_count', count(*) filter (where status in ('pending', 'approved')),
        'pending_amount', coalesce(sum(amount) filter (where status in ('pending', 'approved')), 0),
        'paid_amount', coalesce(sum(amount) filter (where status = 'paid' and paid_at >= p_from and paid_at < p_to), 0))
      from public.ambassador_withdrawals where (p_ambassador is null or ambassador_id = p_ambassador)),
    'top', (
      select coalesce(jsonb_agg(t), '[]'::jsonb) from (
        select a.id, a.display_name, a.ambassador_code, a.status, a.commission_rate,
               (select count(*) from public.ambassador_referrals r where r.ambassador_id = a.id and r.created_at >= p_from and r.created_at < p_to) as referrals,
               coalesce(c.qualifying_orders, 0) as qualifying_orders,
               coalesce(c.referred_value, 0) as referred_value,
               coalesce(c.generated, 0) as generated
        from public.ambassadors a
        left join (
          select ambassador_id,
                 count(*) filter (where type = 'earn' and status = 'pending') as qualifying_orders,
                 sum(commissionable_amount) filter (where type = 'earn' and status = 'pending') as referred_value,
                 sum(amount) filter (where type = 'earn') as generated
          from public.ambassador_commissions where created_at >= p_from and created_at < p_to group by ambassador_id
        ) c on c.ambassador_id = a.id
        where a.status in ('approved', 'suspended', 'deactivated') and (p_ambassador is null or a.id = p_ambassador)
        order by coalesce(c.generated, 0) desc, a.approved_at
        limit 25
      ) t)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Provider: submission and delivery signals from existing order columns
-- ---------------------------------------------------------------------------
create or replace function public.insights_provider(p_from timestamptz, p_to timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pf timestamptz := p_from - (p_to - p_from);
  v_submit_min numeric := public.insights_setting('provider_submit_threshold_minutes', 30);
  v_pending_h numeric := public.insights_setting('pending_order_threshold_hours', 24);
begin
  if not public.is_admin() then raise exception 'Admin access required.'; end if;
  return jsonb_build_object(
    'submitted_cur', (select count(*) from public.orders where provider_order_id is not null and created_at >= p_from and created_at < p_to),
    'failed_cur', (select count(*) from public.orders where provider_status ~* '^(cancel|fail|error|reject)' and created_at >= p_from and created_at < p_to),
    'submitted_prev', (select count(*) from public.orders where provider_order_id is not null and created_at >= v_pf and created_at < p_from),
    'failed_prev', (select count(*) from public.orders where provider_status ~* '^(cancel|fail|error|reject)' and created_at >= v_pf and created_at < p_from),
    'awaiting_submission', (select count(*) from public.orders
      where payment_status = 'paid' and status <> 'cancelled' and provider_order_id is null
        and created_at < now() - make_interval(mins => v_submit_min::integer)),
    'slow_processing', (select count(*) from public.orders
      where status = 'processing' and created_at < now() - make_interval(hours => v_pending_h::integer)),
    'by_provider', (
      select coalesce(jsonb_agg(t), '[]'::jsonb) from (
        select coalesce(provider, 'Unassigned') as provider,
               count(*) as orders,
               count(*) filter (where provider_status ~* '^(cancel|fail|error|reject)') as failed,
               count(*) filter (where status = 'completed') as completed
        from public.orders where provider_order_id is not null and created_at >= p_from and created_at < p_to
        group by 1 order by 2 desc
      ) t),
    'thresholds', jsonb_build_object('submit_minutes', v_submit_min, 'pending_hours', v_pending_h)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Loyalty (only once the loyalty tables exist)
-- ---------------------------------------------------------------------------
create or replace function public.insights_loyalty(p_from timestamptz, p_to timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_enabled boolean;
  v_levels jsonb;
  v_near integer := 0;
  v_pf timestamptz := p_from - (p_to - p_from);
begin
  if not public.is_admin() then raise exception 'Admin access required.'; end if;
  if to_regclass('public.loyalty_accounts') is null then
    return jsonb_build_object('available', false);
  end if;
  select enabled into v_enabled from public.loyalty_settings where id;

  select coalesce(jsonb_agg(t), '[]'::jsonb) into v_levels from (
    select coalesce(l.name, 'Unassigned') as level, count(*) as members
    from public.loyalty_accounts a
    left join public.loyalty_levels l on l.id = coalesce(a.level_override_id, a.level_id)
    group by 1 order by 2 desc
  ) t;

  -- Members who have reached at least 80% of the next level's spend requirement.
  select count(*) into v_near
  from public.loyalty_accounts a
  left join public.loyalty_levels cur on cur.id = coalesce(a.level_override_id, a.level_id)
  join lateral (
    select nl.min_spend from public.loyalty_levels nl
    where nl.active and nl.display_order > coalesce(cur.display_order, -1)
    order by nl.display_order limit 1
  ) nx on true
  where nx.min_spend > 0 and a.qualifying_spend >= nx.min_spend * 0.8 and a.qualifying_spend < nx.min_spend;

  return jsonb_build_object(
    'available', true,
    'enabled', coalesce(v_enabled, false),
    'members', (select count(*) from public.loyalty_accounts),
    'outstanding_points', (select coalesce(sum(points_balance), 0) from public.loyalty_accounts),
    'issued_cur', (select coalesce(sum(points), 0) from public.loyalty_transactions where points > 0 and type in ('earn', 'bonus') and created_at >= p_from and created_at < p_to),
    'issued_prev', (select coalesce(sum(points), 0) from public.loyalty_transactions where points > 0 and type in ('earn', 'bonus') and created_at >= v_pf and created_at < p_from),
    'reversed_cur', (select coalesce(-sum(points), 0) from public.loyalty_transactions where type = 'reversal' and created_at >= p_from and created_at < p_to),
    'redeemed_cur', (select coalesce(-sum(points), 0) from public.loyalty_transactions where type = 'redemption' and created_at >= p_from and created_at < p_to),
    'discounts_cur', (select coalesce(sum(loyalty_discount_amount), 0) from public.orders where payment_status = 'paid' and created_at >= p_from and created_at < p_to),
    'discounted_orders_cur', (select count(*) from public.orders where loyalty_discount_amount > 0 and created_at >= p_from and created_at < p_to),
    'active_members', (select count(distinct t.user_id) from public.loyalty_transactions t where t.created_at >= p_from and t.created_at < p_to),
    'near_next_level', v_near,
    'levels', v_levels
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Attention required: a snapshot of what needs action right now
-- ---------------------------------------------------------------------------
create or replace function public.insights_attention()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pending_h numeric := public.insights_setting('pending_order_threshold_hours', 24);
  v_submit_min numeric := public.insights_setting('provider_submit_threshold_minutes', 30);
begin
  if not public.is_admin() then raise exception 'Admin access required.'; end if;
  return jsonb_build_object(
    'pending_old', (select count(*) from public.orders where status = 'pending' and created_at < now() - make_interval(hours => v_pending_h::integer)),
    'pending_hours', v_pending_h,
    'awaiting_submission', (select count(*) from public.orders
      where payment_status = 'paid' and status <> 'cancelled' and provider_order_id is null
        and created_at < now() - make_interval(mins => v_submit_min::integer)),
    'refund_requests', (select count(*) from public.refund_requests where status = 'pending'),
    'cancellation_requests', (select count(*) from public.order_cancellations where status = 'pending'),
    'withdrawals_pending', (select count(*) from public.ambassador_withdrawals where status = 'pending'),
    'withdrawals_to_pay', (select count(*) from public.ambassador_withdrawals where status = 'approved'),
    'applications_pending', (select count(*) from public.ambassadors where status = 'applicant'),
    'ambassadors_suspended', (select count(*) from public.ambassadors where status = 'suspended'),
    'payments_failed_24h', (select count(*) from public.payments where status in ('failed', 'expired') and created_at >= now() - interval '24 hours'),
    'services_hidden', (select count(*) from public.services where visible = false),
    'services_inactive', (select count(*) from public.services where active = false),
    'open_tickets', (select count(*) from public.support_tickets where status = 'open')
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Indexes that keep the date-window scans fast as the tables grow
-- ---------------------------------------------------------------------------
create index if not exists orders_created_at_idx on public.orders (created_at desc);
create index if not exists orders_service_created_idx on public.orders (service_id, created_at desc);
create index if not exists payments_created_idx on public.payments (created_at desc);
create index if not exists profiles_created_idx on public.profiles (created_at desc);

-- ---------------------------------------------------------------------------
-- Execute permissions: signed-in callers only; each function re-checks is_admin().
-- ---------------------------------------------------------------------------
revoke execute on function public.insights_setting(text, numeric) from public, anon, authenticated;
revoke execute on function public.admin_set_business_setting(text, text) from public, anon;
grant execute on function public.admin_set_business_setting(text, text) to authenticated;
revoke execute on function public.insights_orders(timestamptz, timestamptz) from public, anon;
grant execute on function public.insights_orders(timestamptz, timestamptz) to authenticated;
revoke execute on function public.insights_services(timestamptz, timestamptz) from public, anon;
grant execute on function public.insights_services(timestamptz, timestamptz) to authenticated;
revoke execute on function public.insights_customers(timestamptz, timestamptz) from public, anon;
grant execute on function public.insights_customers(timestamptz, timestamptz) to authenticated;
revoke execute on function public.insights_finance(timestamptz, timestamptz) from public, anon;
grant execute on function public.insights_finance(timestamptz, timestamptz) to authenticated;
revoke execute on function public.insights_ambassadors(timestamptz, timestamptz, uuid) from public, anon;
grant execute on function public.insights_ambassadors(timestamptz, timestamptz, uuid) to authenticated;
revoke execute on function public.insights_provider(timestamptz, timestamptz) from public, anon;
grant execute on function public.insights_provider(timestamptz, timestamptz) to authenticated;
revoke execute on function public.insights_loyalty(timestamptz, timestamptz) from public, anon;
grant execute on function public.insights_loyalty(timestamptz, timestamptz) to authenticated;
revoke execute on function public.insights_attention() from public, anon;
grant execute on function public.insights_attention() to authenticated;

-- ============================================================================
-- End of migration.
-- ============================================================================
