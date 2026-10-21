-- ============================================================================
-- BTECH SMM — Finance & Accounts: KES provider-cost model, cost snapshots,
-- reconciliation and the financial activity feed.
-- ----------------------------------------------------------------------------
-- Run after migration_insights.sql (and migration_loyalty*.sql if you use loyalty).
-- Additive and idempotent: safe to run twice. Nothing here edits a posted
-- financial record (payments, transactions, commissions, withdrawals).
--
-- BUSINESS RULE (owner-confirmed 2026-10-17)
--   Delix Gains displays its rates and wallet balance with the label "USD", but
--   the numbers are Kenyan shillings. For BTECH accounting they are KES and are
--   NEVER multiplied by business_settings.usd_kes_rate. The external label and the
--   Delix API format are untouched (provider_services.provider_currency still says
--   what Delix sent). The accounting interpretation lives in NEW explicit columns:
--      providers.rate_currency          'KES' for Delix Gains
--      provider_services.rate_currency  copied from the provider on insert
--      provider_services.rate_per_quantity  units a rate is quoted for (1000)
--   Any provider whose rate_currency is 'USD' is still converted with usd_kes_rate;
--   a provider with no rate_currency is "currency not defined" and yields no cost.
--
-- WHAT THIS ADDS
--   1. Currency metadata + provider_rate_kes() (the only place a rate becomes KES).
--   2. A provider-cost SNAPSHOT on each order (orders.provider_cost_*), taken
--      server-side when the order is submitted to the provider, and backfilled once
--      for already-submitted orders (labelled as such). It is immutable except
--      through admin_correct_order_cost(), which writes finance_corrections.
--   3. insights_services / insights_finance rewritten to use snapshots (no FX).
--   4. admin_finance_overview()  - the metric set with definitions.
--      admin_finance_activity()  - searchable/paginated activity feed (+ CSV source).
--      admin_finance_reconciliation() / finance_recon_flags - discrepancy detectors.
--      admin_finance_estimate_comparison() - old (USD-converted) vs corrected estimate.
--      admin_delix_wallet()      - stored provider-wallet reading (no secrets).
-- Everything is admin-only (is_admin()) and read-only except the two audited
-- correction functions.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Currency metadata
-- ---------------------------------------------------------------------------
alter table public.providers
  add column if not exists rate_currency text check (rate_currency is null or rate_currency in ('KES', 'USD')),
  add column if not exists rate_currency_note text;

update public.providers
   set rate_currency = 'KES',
       rate_currency_note = 'Delix displays "USD" but the amounts are Kenyan shillings (owner-confirmed). Interpreted as KES; never converted with usd_kes_rate.'
 where name = 'Delix Gains' and rate_currency is null;

alter table public.provider_services
  add column if not exists rate_currency text check (rate_currency is null or rate_currency in ('KES', 'USD')),
  add column if not exists rate_per_quantity integer not null default 1000 check (rate_per_quantity > 0);

-- New / re-synced mappings pick the provider's interpretation up automatically, so the
-- Edge Function (which still writes provider_currency = 'USD', the label Delix uses) needs no change.
create or replace function public.provider_services_set_rate_currency()
returns trigger
language plpgsql
as $$
begin
  if new.rate_currency is null then
    select p.rate_currency into new.rate_currency from public.providers p where p.id = new.provider_id;
  end if;
  return new;
end;
$$;
drop trigger if exists provider_services_rate_currency on public.provider_services;
create trigger provider_services_rate_currency
  before insert on public.provider_services
  for each row execute function public.provider_services_set_rate_currency();

update public.provider_services ps
   set rate_currency = p.rate_currency
  from public.providers p
 where p.id = ps.provider_id and ps.rate_currency is null and p.rate_currency is not null;

-- The ONLY place a provider rate becomes KES.
--   KES -> as is.  USD -> x usd_kes_rate (NULL if the admin has not set one).  Anything else -> NULL.
create or replace function public.provider_rate_kes(p_rate numeric, p_currency text)
returns numeric
language sql
stable
as $$
  select case
    when p_rate is null then null
    when upper(coalesce(p_currency, '')) = 'KES' then p_rate
    when upper(coalesce(p_currency, '')) = 'USD' then p_rate * public.insights_setting('usd_kes_rate', null)
    else null
  end;
$$;
revoke execute on function public.provider_rate_kes(numeric, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Per-order provider cost snapshot
-- ---------------------------------------------------------------------------
alter table public.orders
  add column if not exists provider_cost_kes numeric,
  add column if not exists provider_cost_status text
    check (provider_cost_status is null or provider_cost_status in ('snapshot', 'backfill_current_rate', 'unavailable', 'corrected')),
  add column if not exists provider_cost_basis jsonb,
  add column if not exists provider_cost_at timestamptz;

-- cost = rate (KES) x quantity / rate_per_quantity. Rounded to 4 dp (numeric, never float).
create or replace function public.provider_cost_basis(o public.orders)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
  m record;
  v_rate_kes numeric;
  v_cost numeric;
begin
  select ps.id as mapping_id, ps.provider_rate, ps.provider_currency as label_currency,
         coalesce(ps.rate_currency, p.rate_currency) as rate_currency, ps.rate_per_quantity, p.name as provider_name
    into m
    from public.provider_services ps join public.providers p on p.id = ps.provider_id
   where ps.service_id = o.service_id
   order by (p.name = o.provider) desc, ps.last_provider_sync desc nulls last
   limit 1;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'No provider mapping for this service.');
  end if;
  if m.provider_rate is null then
    return jsonb_build_object('ok', false, 'reason', 'Mapped provider rate is not known.', 'mapping_id', m.mapping_id);
  end if;
  if m.rate_currency is null then
    return jsonb_build_object('ok', false, 'reason', 'Rate currency is not defined for this provider.', 'mapping_id', m.mapping_id);
  end if;
  v_rate_kes := public.provider_rate_kes(m.provider_rate, m.rate_currency);
  if v_rate_kes is null then
    return jsonb_build_object('ok', false, 'reason', 'USD-denominated rate but no USD to KES rate is set.', 'mapping_id', m.mapping_id);
  end if;
  v_cost := round(v_rate_kes * o.quantity / m.rate_per_quantity, 4);
  return jsonb_build_object(
    'ok', true, 'cost_kes', v_cost, 'mapping_id', m.mapping_id, 'provider', m.provider_name,
    'rate_as_sent', m.provider_rate, 'label_currency', m.label_currency,
    'rate_currency', m.rate_currency, 'rate_kes', v_rate_kes,
    'rate_per_quantity', m.rate_per_quantity, 'quantity', o.quantity,
    'fx_applied', case when upper(m.rate_currency) = 'USD' then public.insights_setting('usd_kes_rate', null) else null end);
end;
$$;
revoke execute on function public.provider_cost_basis(public.orders) from public, anon, authenticated;

-- Snapshot when an order is first submitted to the provider. Never blocks the order update.
create or replace function public.orders_snapshot_provider_cost()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  b jsonb;
begin
  if new.provider_order_id is not null and new.provider_cost_status is null
     and (tg_op = 'INSERT' or old.provider_order_id is null) then
    begin
      b := public.provider_cost_basis(new);
    exception when others then
      b := jsonb_build_object('ok', false, 'reason', 'Cost calculation error.');
    end;
    new.provider_cost_basis := b;
    new.provider_cost_at := now();
    if (b->>'ok')::boolean then
      new.provider_cost_kes := (b->>'cost_kes')::numeric;
      new.provider_cost_status := 'snapshot';
    else
      new.provider_cost_status := 'unavailable';
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists orders_snapshot_provider_cost on public.orders;
create trigger orders_snapshot_provider_cost
  before insert or update of provider_order_id on public.orders
  for each row execute function public.orders_snapshot_provider_cost();

-- A recorded cost can only change through admin_correct_order_cost().
create or replace function public.orders_guard_provider_cost()
returns trigger
language plpgsql
as $$
begin
  if old.provider_cost_status is not null
     and (new.provider_cost_kes is distinct from old.provider_cost_kes
          or new.provider_cost_status is distinct from old.provider_cost_status
          or new.provider_cost_basis is distinct from old.provider_cost_basis)
     and coalesce(current_setting('btech.finance_correction', true), '') <> 'on' then
    raise exception 'A recorded provider cost cannot be edited directly; use admin_correct_order_cost().';
  end if;
  return new;
end;
$$;
drop trigger if exists orders_guard_provider_cost on public.orders;
create trigger orders_guard_provider_cost
  before update on public.orders
  for each row execute function public.orders_guard_provider_cost();

-- Append-only audit of financial corrections.
create table if not exists public.finance_corrections (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  admin_id uuid references auth.users(id),
  entity_type text not null,
  entity_id text not null,
  field text not null,
  old_value jsonb,
  new_value jsonb,
  reason text not null check (length(trim(reason)) >= 5)
);
alter table public.finance_corrections enable row level security;
drop policy if exists finance_corrections_admin_read on public.finance_corrections;
create policy finance_corrections_admin_read on public.finance_corrections for select using (public.is_admin());
revoke insert, update, delete on public.finance_corrections from anon, authenticated;

create or replace function public.finance_corrections_append_only()
returns trigger language plpgsql as $$
begin
  raise exception 'finance_corrections is append-only.';
end;
$$;
drop trigger if exists finance_corrections_no_change on public.finance_corrections;
create trigger finance_corrections_no_change
  before update or delete on public.finance_corrections
  for each row execute function public.finance_corrections_append_only();

-- One-time (and re-runnable) backfill: only orders already sent to the provider that have no
-- snapshot yet. Uses the CURRENT synced rate, so it is labelled 'backfill_current_rate' - an
-- estimate, not the rate in force at submission (rate history was never stored).
create or replace function public.finance_backfill_provider_costs()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n integer;
begin
  with t as (
    select o.id, public.provider_cost_basis(o) as b
      from public.orders o
     where o.provider_order_id is not null and o.provider_cost_status is null
  ), u as (
    update public.orders o
       set provider_cost_kes = case when (t.b->>'ok')::boolean then (t.b->>'cost_kes')::numeric end,
           provider_cost_status = case when (t.b->>'ok')::boolean then 'backfill_current_rate' else 'unavailable' end,
           provider_cost_basis = t.b,
           provider_cost_at = now()
      from t where o.id = t.id
     returning 1)
  select count(*) into v_n from u;
  return v_n;
end;
$$;
revoke execute on function public.finance_backfill_provider_costs() from public, anon, authenticated;
select public.finance_backfill_provider_costs();

-- Admin re-run for orders still 'unavailable' or missing (e.g. after a mapping/currency is fixed).
create or replace function public.admin_backfill_provider_costs(p_reason text default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n integer;
begin
  if not public.is_admin() then raise exception 'Admin access required.'; end if;
  set local btech.finance_correction = 'on';
  with t as (
    select o.id, public.provider_cost_basis(o) as b
      from public.orders o
     where o.provider_order_id is not null and (o.provider_cost_status is null or o.provider_cost_status = 'unavailable')
  ), u as (
    update public.orders o
       set provider_cost_kes = case when (t.b->>'ok')::boolean then (t.b->>'cost_kes')::numeric end,
           provider_cost_status = case when (t.b->>'ok')::boolean then 'backfill_current_rate' else 'unavailable' end,
           provider_cost_basis = t.b, provider_cost_at = now()
      from t where o.id = t.id and (t.b->>'ok')::boolean
     returning 1)
  select count(*) into v_n from u;
  perform public.audit_log('finance_backfill_costs', 'orders', 'bulk', null, jsonb_build_object('orders_updated', v_n), p_reason);
  return v_n;
end;
$$;

create or replace function public.admin_correct_order_cost(p_order text, p_cost numeric, p_reason text)
returns public.orders
language plpgsql
security definer
set search_path = public
as $$
declare
  o public.orders;
  v_old jsonb;
begin
  if not public.is_admin() then raise exception 'Admin access required.'; end if;
  if p_cost is null or p_cost < 0 then raise exception 'Enter a cost of zero or more (KES).'; end if;
  if coalesce(length(trim(p_reason)), 0) < 5 then raise exception 'A reason of at least 5 characters is required.'; end if;
  select * into o from public.orders where id = p_order for update;
  if not found then raise exception 'Order not found.'; end if;
  if o.provider_order_id is null then raise exception 'This order was never sent to a provider.'; end if;
  v_old := jsonb_build_object('cost_kes', o.provider_cost_kes, 'status', o.provider_cost_status);
  set local btech.finance_correction = 'on';
  update public.orders
     set provider_cost_kes = round(p_cost, 4), provider_cost_status = 'corrected',
         provider_cost_basis = coalesce(provider_cost_basis, '{}'::jsonb) || jsonb_build_object('corrected', true, 'corrected_cost_kes', round(p_cost, 4)),
         provider_cost_at = now()
   where id = p_order returning * into o;
  insert into public.finance_corrections (admin_id, entity_type, entity_id, field, old_value, new_value, reason)
  values (auth.uid(), 'order', p_order, 'provider_cost_kes', v_old, jsonb_build_object('cost_kes', o.provider_cost_kes), trim(p_reason));
  perform public.audit_log('finance_correct_cost', 'orders', p_order, v_old, jsonb_build_object('cost_kes', o.provider_cost_kes), p_reason);
  return o;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Services table + finance KPIs: snapshot based, no exchange rate
-- ---------------------------------------------------------------------------
create or replace function public.insights_services(p_from timestamptz, p_to timestamptz)
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
    'fx_set', true,  -- kept for older clients: no exchange rate is needed any more
    'rows', (
      with o as (
        select x.service_id,
               count(*) filter (where x.c) as orders,
               count(*) filter (where x.p) as prev_orders,
               coalesce(sum(x.amount) filter (where x.c and x.payment_status = 'paid' and x.status <> 'cancelled'), 0) as revenue,
               count(*) filter (where x.c and x.payment_status = 'refunded') as refunded,
               count(*) filter (where x.c and x.status = 'cancelled') as cancelled,
               count(*) filter (where x.c and x.status = 'completed') as completed,
               count(*) filter (where x.c and x.provider_status ~* '^(cancel|fail|error|reject)') as provider_failed,
               -- paid orders whose provider cost is known (snapshot / backfill / corrected)
               coalesce(sum(x.amount) filter (where x.c and x.payment_status = 'paid' and x.status <> 'cancelled' and x.cost is not null), 0) as covered_revenue,
               coalesce(sum(x.cost) filter (where x.c and x.payment_status = 'paid' and x.status <> 'cancelled'), 0) as cost_kes,
               count(*) filter (where x.c and x.payment_status = 'paid' and x.status <> 'cancelled' and x.cost is null) as uncosted_paid,
               count(*) filter (where x.c and x.payment_status = 'paid' and x.status <> 'cancelled' and x.cost_status = 'backfill_current_rate') as backfilled
        from (
          select o2.service_id, o2.status, o2.payment_status, o2.amount, o2.quantity, o2.provider_status,
                 o2.provider_cost_kes as cost, o2.provider_cost_status as cost_status,
                 (o2.created_at >= p_from and o2.created_at < p_to) as c,
                 (o2.created_at >= v_pf and o2.created_at < p_from) as p
          from public.orders o2
          where o2.created_at >= v_pf and o2.created_at < p_to
        ) x
        group by x.service_id
      )
      select coalesce(jsonb_agg(r order by r.orders desc), '[]'::jsonb) from (
        select s.id, s.name, s.category, s.platform, s.price_per_1000, s.unit, s.active, s.visible,
               o.orders, o.prev_orders, o.revenue, o.refunded, o.cancelled, o.completed, o.provider_failed,
               pc.provider_name, pc.provider_rate, pc.provider_currency, pc.rate_currency,
               public.provider_rate_kes(pc.provider_rate, pc.rate_currency) as rate_kes,
               pc.rate_per_quantity,
               o.covered_revenue, round(o.cost_kes, 2) as est_cost_kes, o.uncosted_paid, o.backfilled,
               case when o.covered_revenue > 0 or o.cost_kes > 0 then round(o.covered_revenue - o.cost_kes, 2) end as est_profit_kes,
               -- sanity flag: the provider rate per 1000 is above BTECH's own list price per 1000
               (s.unit is null and public.provider_rate_kes(pc.provider_rate, pc.rate_currency) is not null
                  and public.provider_rate_kes(pc.provider_rate, pc.rate_currency) / pc.rate_per_quantity * 1000 > s.price_per_1000) as rate_above_price
        from o
        join public.services s on s.id = o.service_id
        left join lateral (
          select p.name as provider_name, ps.provider_rate, ps.provider_currency,
                 coalesce(ps.rate_currency, p.rate_currency) as rate_currency, ps.rate_per_quantity
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

-- insights_finance keeps every key the previous UI read, but the estimate now comes from snapshots.
create or replace function public.insights_finance(p_from timestamptz, p_to timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pf timestamptz := p_from - (p_to - p_from);
  v_cov numeric := 0;
  v_cost numeric := 0;
  v_rev numeric := 0;
  v_loyalty numeric := 0;
begin
  if not public.is_admin() then raise exception 'Admin access required.'; end if;

  select coalesce(sum(o.amount) filter (where o.payment_status = 'paid'), 0) into v_rev
  from public.orders o where o.created_at >= p_from and o.created_at < p_to;

  select coalesce(sum(o.amount) filter (where o.payment_status = 'paid'), 0), coalesce(sum(o.provider_cost_kes), 0)
    into v_cov, v_cost
  from public.orders o
  where o.provider_cost_kes is not null and o.payment_status in ('paid', 'refunded')
    and o.created_at >= p_from and o.created_at < p_to;

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
    'estimate', jsonb_build_object('fx', null, 'covered_revenue', v_cov, 'est_cost', v_cost, 'basis', 'order cost snapshots, KES, no exchange rate')
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Reconciliation detectors (single source of truth for flags)
--    A view so the activity feed and the reconciliation report agree. Not exposed
--    to API roles; only the SECURITY DEFINER admin functions below read it.
-- ---------------------------------------------------------------------------
create or replace view public.finance_recon_flags as
-- R01 paid orders never sent to a provider (cost cannot exist yet)
select 'R01'::text as check_id, 'order'::text as entity_type, o.id::text as entity_id, o.amount as amount, o.user_id,
       'Paid but not sent to the provider after 30 minutes'::text as detail
  from public.orders o
 where o.payment_status = 'paid' and o.status <> 'cancelled' and o.provider_order_id is null
   and o.created_at < now() - interval '30 minutes'
union all
-- R02 sent to the provider but cost could not be determined
select 'R02', 'order', o.id, o.amount, o.user_id,
       'Sent to provider but no cost: ' || coalesce(o.provider_cost_basis->>'reason', 'no snapshot')
  from public.orders o
 where o.provider_order_id is not null and (o.provider_cost_kes is null)
   and o.payment_status in ('paid', 'refunded')
union all
-- R03 provider cost above what the customer paid (loss-making; wrong rate, wrong unit or pricing issue)
select 'R03', 'order', o.id, o.provider_cost_kes - o.amount, o.user_id,
       'Provider cost KES ' || o.provider_cost_kes || ' exceeds the order price KES ' || o.amount
  from public.orders o
 where o.provider_cost_kes is not null and o.payment_status = 'paid' and o.provider_cost_kes > o.amount
union all
-- R04 paid but cancelled: customer money held, no refund recorded
select 'R04', 'order', o.id, o.amount, o.user_id, 'Order is cancelled but still marked paid (no refund recorded)'
  from public.orders o where o.status = 'cancelled' and o.payment_status = 'paid'
union all
-- R05 refunded with no approved/completed refund request
select 'R05', 'order', o.id, o.amount, o.user_id, 'Marked refunded without an approved or completed refund request'
  from public.orders o
 where o.payment_status = 'refunded'
   and not exists (select 1 from public.refund_requests r where r.order_id = o.id and r.status in ('approved', 'processing', 'completed'))
union all
-- R06 refund request approved/completed but the order is not marked refunded
select 'R06', 'refund_request', r.id::text, r.amount, r.user_id, 'Refund ' || r.status || ' but the order is not marked refunded'
  from public.refund_requests r join public.orders o on o.id = r.order_id
 where r.status in ('approved', 'completed') and o.payment_status <> 'refunded'
union all
-- R07 refunded order with no matching wallet refund transaction (settlement not evidenced in the system)
select 'R07', 'order', o.id, o.amount, o.user_id,
       'Refund recorded but no wallet refund transaction of this amount exists (settled manually, or not settled)'
  from public.orders o
 where o.payment_status = 'refunded'
   and not exists (select 1 from public.transactions t where t.user_id = o.user_id and t.type = 'refund' and abs(t.amount) = o.amount)
union all
-- R08 duplicate M-Pesa receipts
select 'R08', 'payment', p.id::text, p.amount, p.user_id, 'M-Pesa receipt ' || p.mpesa_receipt_number || ' appears on more than one payment'
  from public.payments p
 where p.mpesa_receipt_number is not null
   and (select count(*) from public.payments q where q.mpesa_receipt_number = p.mpesa_receipt_number) > 1
union all
-- R09 paid order with no payment evidence (no paid M-Pesa payment and no wallet debit of that amount)
select 'R09', 'order', o.id, o.amount, o.user_id, 'Marked paid but no paid M-Pesa payment or matching wallet debit was found'
  from public.orders o
 where o.payment_status in ('paid', 'refunded')
   and not exists (select 1 from public.payments p where p.order_id = o.id and p.status = 'paid')
   and not exists (select 1 from public.transactions t where t.user_id = o.user_id and t.type = 'order' and abs(t.amount) = o.amount)
union all
-- R10 wallet balance does not equal its transaction history
select 'R10', 'wallet', w.user_id::text, w.balance - h.expected, w.user_id,
       'Wallet balance KES ' || w.balance || ' but transaction history gives KES ' || h.expected
  from public.wallets w
  join lateral (
    select coalesce(sum(case when t.type = 'order' then -abs(t.amount) else abs(t.amount) end)
                    filter (where t.status = 'completed'), 0) as expected
      from public.transactions t where t.user_id = w.user_id) h on true
 where w.balance <> h.expected
union all
-- R11 paid wallet deposits not equal to wallet deposit transactions (per customer)
select 'R11', 'wallet', d.user_id::text, d.paid - coalesce(t.credited, 0), d.user_id,
       'Paid deposits KES ' || d.paid || ' vs deposit transactions KES ' || coalesce(t.credited, 0)
  from (select user_id, sum(amount) as paid from public.payments where payment_type = 'wallet_deposit' and status = 'paid' group by user_id) d
  left join (select user_id, sum(abs(amount)) as credited from public.transactions where type = 'deposit' and status = 'completed' group by user_id) t
    on t.user_id = d.user_id
 where d.paid <> coalesce(t.credited, 0)
union all
-- R12 more than one commission earn for the same order
select 'R12', 'order', c.order_id, sum(c.amount), null::uuid, 'More than one commission earn row for this order'
  from public.ambassador_commissions c
 where c.type = 'earn' and c.order_id is not null
 group by c.order_id having count(*) > 1
union all
-- R13 commission still pending/active on an order that is cancelled or refunded
select 'R13', 'commission', c.id::text, c.amount, null::uuid, 'Commission not reversed although the order is ' || case when o.payment_status = 'refunded' then 'refunded' else 'cancelled' end
  from public.ambassador_commissions c join public.orders o on o.id = c.order_id
 where c.type = 'earn' and c.status = 'pending' and (o.payment_status = 'refunded' or o.status = 'cancelled')
union all
-- R14 commission amount does not equal commissionable amount x frozen rate
select 'R14', 'commission', c.id::text, c.amount - round(c.commissionable_amount * c.rate_percent / 100, 2), null::uuid,
       'Commission KES ' || c.amount || ' differs from ' || c.rate_percent || '% of KES ' || c.commissionable_amount
  from public.ambassador_commissions c
 where c.type = 'earn' and abs(c.amount - round(c.commissionable_amount * c.rate_percent / 100, 2)) > 0.01
union all
-- R15 withdrawal marked paid without payout evidence
select 'R15', 'withdrawal', w.id::text, w.amount, null::uuid, 'Marked paid without an M-Pesa reference or paid date'
  from public.ambassador_withdrawals w
 where w.status = 'paid' and (coalesce(trim(w.payout_reference), '') = '' or w.paid_at is null)
union all
-- R16 ambassador with a negative available balance
select 'R16', 'ambassador', a.id::text, (public.ambassador_balances(a.id)->>'available')::numeric, a.user_id,
       'Available balance is negative (withdrawals exceed released commission)'
  from public.ambassadors a
 where (public.ambassador_balances(a.id)->>'available')::numeric < 0
union all
-- R17 rate currency not defined / still USD on a mapped provider service
select 'R17', 'provider_service', ps.id::text, ps.provider_rate, null::uuid,
       case when coalesce(ps.rate_currency, p.rate_currency) is null then 'Rate currency not defined'
            else 'Rate treated as USD and converted with the exchange rate' end
  from public.provider_services ps join public.providers p on p.id = ps.provider_id
 where ps.provider_rate is not null and (coalesce(ps.rate_currency, p.rate_currency) is null or coalesce(ps.rate_currency, p.rate_currency) = 'USD')
union all
-- R18 provider rate (KES per 1000) above BTECH's own list price - sanity check of the KES interpretation and pricing
select 'R18', 'service', s.id, (ps.provider_rate / ps.rate_per_quantity * 1000) - s.price_per_1000, null::uuid,
       'Provider rate KES ' || round(ps.provider_rate / ps.rate_per_quantity * 1000, 2) || ' per 1000 is above the BTECH price KES ' || s.price_per_1000 || ' per 1000'
  from public.provider_services ps
  join public.providers p on p.id = ps.provider_id
  join public.services s on s.id = ps.service_id
 where s.unit is null and ps.provider_rate is not null and coalesce(ps.rate_currency, p.rate_currency) = 'KES'
   and ps.provider_rate / ps.rate_per_quantity * 1000 > s.price_per_1000
union all
-- R19 provider cancelled/failed order still carrying a cost that is counted
select 'R19', 'order', o.id, o.provider_cost_kes, o.user_id, 'Provider reports ' || o.provider_status || ': check whether the provider charged or refunded this cost'
  from public.orders o
 where o.provider_cost_kes is not null and o.provider_status ~* '^(cancel|fail|error|reject)'
union all
-- R20 loyalty discount recorded does not equal list price minus charged amount
select 'R20', 'order', o.id, o.loyalty_discount_amount - (o.list_amount - o.amount), o.user_id, 'Loyalty discount differs from list price minus charged amount'
  from public.orders o
 where o.list_amount is not null and o.loyalty_discount_amount > 0
   and abs(o.loyalty_discount_amount - (o.list_amount - o.amount)) > 0.01;
revoke all on public.finance_recon_flags from public, anon, authenticated;

create or replace function public.finance_check_meta()
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'R01', jsonb_build_array('warning', 'Paid orders not sent to the provider', 'Order was paid, but no provider order id exists after 30 minutes.', 'Open the order and submit it to the provider, or refund it.'),
    'R02', jsonb_build_array('warning', 'Provider orders without a cost', 'The provider mapping, rate or currency is missing, so no cost was recorded.', 'Fix the mapping / rate currency, then use "Fill missing costs".'),
    'R03', jsonb_build_array('critical', 'Provider cost above the order price', 'Wrong rate or unit, a pricing error, or a service sold below cost.', 'Check the Delix rate and the BTECH price for the service; correct a wrong cost with a documented correction.'),
    'R04', jsonb_build_array('warning', 'Cancelled orders still marked paid', 'Cancellation was approved but the money was not marked refunded.', 'Process the refund or mark the order correctly.'),
    'R05', jsonb_build_array('warning', 'Refunds without an approved request', 'Order status was changed without the refund workflow.', 'Confirm who authorised the refund and record it.'),
    'R06', jsonb_build_array('warning', 'Approved refunds not applied to the order', 'Refund request approved but the order is not marked refunded.', 'Re-run the refund approval or correct the order.'),
    'R07', jsonb_build_array('info', 'Refunds with no wallet refund transaction', 'Refund payout is not automated, so it is normally settled outside the app.', 'Confirm the M-Pesa or wallet refund was actually paid.'),
    'R08', jsonb_build_array('critical', 'Duplicate M-Pesa receipts', 'A callback was processed twice or two payments share a receipt.', 'Investigate before any further crediting.'),
    'R09', jsonb_build_array('critical', 'Paid orders without payment evidence', 'No paid payment row and no wallet debit of the same amount.', 'Verify the payment in M-Pesa; revert or document it.'),
    'R10', jsonb_build_array('critical', 'Wallet balance does not match history', 'A balance was changed without a matching transaction, or the reverse.', 'Investigate the customer wallet; correct with a documented adjustment.'),
    'R11', jsonb_build_array('critical', 'Paid deposits not matching wallet credits', 'A paid deposit was not credited, or credited twice.', 'Compare with M-Pesa statements; credit via the existing function only.'),
    'R12', jsonb_build_array('critical', 'Duplicate commission for one order', 'Commission should be earned at most once per order.', 'Reverse the extra commission with an adjustment.'),
    'R13', jsonb_build_array('warning', 'Commission on refunded/cancelled orders', 'The commission reversal did not run.', 'Reverse the commission (admin adjustment).'),
    'R14', jsonb_build_array('warning', 'Commission amount differs from its rate', 'The frozen rate x commissionable amount does not equal the amount.', 'Review the row; adjust if it is wrong.'),
    'R15', jsonb_build_array('critical', 'Withdrawals paid without evidence', 'No M-Pesa reference or paid date recorded.', 'Add the payout evidence or reverse the status.'),
    'R16', jsonb_build_array('critical', 'Negative ambassador balance', 'Withdrawals exceed released commission.', 'Review the ambassador ledger.'),
    'R17', jsonb_build_array('warning', 'Rate currency undefined or USD', 'Costs cannot be computed, or are converted with the exchange rate.', 'Set the provider rate currency (KES for Delix).'),
    'R18', jsonb_build_array('warning', 'Provider rate above BTECH price', 'The service is priced below its provider cost, or the rate or unit is misread.', 'Review the price or the rate.'),
    'R19', jsonb_build_array('info', 'Provider-cancelled orders carrying a cost', 'Cost recovery from the provider is not tracked automatically.', 'Check the Delix panel for a refund and record a correction if one was given.'),
    'R20', jsonb_build_array('warning', 'Loyalty discount mismatch', 'Recorded discount differs from list price minus charged amount.', 'Review the order pricing.')
  );
$$;
revoke execute on function public.finance_check_meta() from public, anon, authenticated;

create or replace function public.admin_finance_reconciliation()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_meta jsonb := public.finance_check_meta();
begin
  if not public.is_admin() then raise exception 'Admin access required.'; end if;
  return jsonb_build_object(
    'generated_at', now(),
    'checks', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'check_id', m.key,
        'severity', m.value->>0, 'title', m.value->>1, 'probable_cause', m.value->>2, 'recommended_action', m.value->>3,
        'count', coalesce(f.n, 0), 'amount', coalesce(f.amt, 0), 'currency', 'KES',
        'sample', coalesce(f.sample, '[]'::jsonb)
      ) order by m.key), '[]'::jsonb)
      from jsonb_each(v_meta) m
      left join lateral (
        select count(*) as n, sum(abs(coalesce(x.amount, 0))) as amt,
               (select jsonb_agg(jsonb_build_object('entity_type', s.entity_type, 'entity_id', s.entity_id, 'amount', s.amount, 'detail', s.detail))
                  from (select * from public.finance_recon_flags z where z.check_id = m.key order by z.entity_id limit 20) s) as sample
          from public.finance_recon_flags x where x.check_id = m.key) f on true),
    'corrections', (select coalesce(jsonb_agg(c order by c.created_at desc), '[]'::jsonb)
                      from (select created_at, entity_type, entity_id, field, old_value, new_value, reason from public.finance_corrections order by created_at desc limit 25) c)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Overview metrics (definitions travel with the numbers)
--    Period is by orders.created_at / payments.created_at, as elsewhere in Insights.
-- ---------------------------------------------------------------------------
create or replace function public.finance_window_metrics(p_from timestamptz, p_to timestamptz)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v jsonb;
  v_has_loyalty boolean := to_regclass('public.loyalty_accounts') is not null;
  v_list numeric := 0; v_disc numeric := 0;
begin
  if v_has_loyalty then
    execute 'select coalesce(sum(coalesce(list_amount, amount)), 0), coalesce(sum(loyalty_discount_amount), 0)
               from public.orders where payment_status in (''paid'', ''refunded'') and status <> ''cancelled''
                and created_at >= $1 and created_at < $2' into v_list, v_disc using p_from, p_to;
  else
    select coalesce(sum(amount), 0) into v_list from public.orders
     where payment_status in ('paid', 'refunded') and status <> 'cancelled' and created_at >= p_from and created_at < p_to;
  end if;

  select jsonb_build_object(
    -- B. gross order sales: paid orders at the price charged (after loyalty discount, before refunds)
    'gross_sales', coalesce(sum(o.amount) filter (where o.payment_status in ('paid', 'refunded') and o.status <> 'cancelled'), 0),
    'orders_paid', count(*) filter (where o.payment_status = 'paid' and o.status <> 'cancelled'),
    -- refunds
    'refunds', coalesce(sum(o.amount) filter (where o.payment_status = 'refunded'), 0),
    'refund_count', count(*) filter (where o.payment_status = 'refunded'),
    -- C. net order revenue: gross sales minus refunds
    'net_revenue', coalesce(sum(o.amount) filter (where o.payment_status = 'paid' and o.status <> 'cancelled'), 0),
    -- D. provider costs: cost snapshot of every order sent to a provider (a refund does not recover it)
    'provider_cost', coalesce(sum(o.provider_cost_kes) filter (where o.payment_status in ('paid', 'refunded') and o.status <> 'cancelled'), 0),
    'cost_orders', count(*) filter (where o.provider_cost_kes is not null and o.payment_status in ('paid', 'refunded') and o.status <> 'cancelled'),
    'cost_backfilled', count(*) filter (where o.provider_cost_status = 'backfill_current_rate' and o.payment_status in ('paid', 'refunded') and o.status <> 'cancelled'),
    -- revenue that has a known cost (the basis of profit)
    'covered_revenue', coalesce(sum(o.amount) filter (where o.payment_status = 'paid' and o.status <> 'cancelled' and o.provider_cost_kes is not null), 0),
    'uncovered_revenue', coalesce(sum(o.amount) filter (where o.payment_status = 'paid' and o.status <> 'cancelled' and o.provider_cost_kes is null), 0),
    'uncovered_orders', count(*) filter (where o.payment_status = 'paid' and o.status <> 'cancelled' and o.provider_cost_kes is null),
    'unpaid_orders', count(*) filter (where o.payment_status = 'unpaid')
  ) into v
  from public.orders o where o.created_at >= p_from and o.created_at < p_to;

  v := v || jsonb_build_object(
    'list_sales', v_list, 'discounts', v_disc,
    -- A. customer payments received (cash in): paid M-Pesa payments, split by purpose
    'deposits', (select coalesce(sum(amount), 0) from public.payments where payment_type = 'wallet_deposit' and status = 'paid' and created_at >= p_from and created_at < p_to),
    'direct_order_payments', (select coalesce(sum(amount), 0) from public.payments where payment_type = 'order' and status = 'paid' and created_at >= p_from and created_at < p_to),
    'payments_pending', (select coalesce(sum(amount), 0) from public.payments where status in ('pending', 'processing') and created_at >= p_from and created_at < p_to),
    'payments_failed', (select coalesce(sum(amount), 0) from public.payments where status in ('failed', 'cancelled', 'expired') and created_at >= p_from and created_at < p_to),
    'wallet_spend', (select coalesce(sum(abs(amount)), 0) from public.transactions where type = 'order' and created_at >= p_from and created_at < p_to),
    -- ambassador commission expense (accrual): earned + adjustments - reversals recorded in the period
    'commission_expense', (select coalesce(sum(amount), 0) from public.ambassador_commissions where created_at >= p_from and created_at < p_to),
    'commission_earned', (select coalesce(sum(amount), 0) from public.ambassador_commissions where type = 'earn' and created_at >= p_from and created_at < p_to),
    'commission_reversed', (select coalesce(-sum(amount), 0) from public.ambassador_commissions where type = 'reversal' and created_at >= p_from and created_at < p_to),
    'commission_adjustments', (select coalesce(sum(amount), 0) from public.ambassador_commissions where type = 'adjustment' and created_at >= p_from and created_at < p_to),
    -- payouts: only withdrawals an admin marked paid WITH a reference (cash out)
    'payouts_paid', (select coalesce(sum(amount), 0) from public.ambassador_withdrawals where status = 'paid' and paid_at >= p_from and paid_at < p_to),
    'withdrawals_requested', (select coalesce(sum(amount), 0) from public.ambassador_withdrawals where requested_at >= p_from and requested_at < p_to)
  );
  return v;
end;
$$;
revoke execute on function public.finance_window_metrics(timestamptz, timestamptz) from public, anon, authenticated;

create or replace function public.admin_finance_overview(p_from timestamptz, p_to timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pf timestamptz := p_from - (p_to - p_from);
  cur jsonb; prev jsonb;
  v_gp numeric; v_net_op numeric;
  v_balances jsonb;
begin
  if not public.is_admin() then raise exception 'Admin access required.'; end if;
  cur := public.finance_window_metrics(p_from, p_to);
  prev := public.finance_window_metrics(v_pf, p_from);

  select jsonb_build_object(
    'commission_pending_release', coalesce(sum((b->>'pending')::numeric), 0),
    'commission_available', coalesce(sum(greatest((b->>'available')::numeric, 0)), 0),
    'withdrawals_in_review', coalesce(sum((b->>'in_review')::numeric), 0),
    'withdrawn_total', coalesce(sum((b->>'withdrawn')::numeric), 0),
    'reversed_total', coalesce(sum((b->>'reversed')::numeric), 0),
    'adjustments_total', coalesce(sum((b->>'adjustments')::numeric), 0))
    into v_balances
  from (select public.ambassador_balances(a.id) as b from public.ambassadors a where a.status in ('approved', 'suspended', 'deactivated')) x;

  return jsonb_build_object(
    'currency', 'KES',
    'cur', cur, 'prev', prev,
    -- E. gross profit on orders whose provider cost is known; shown with how much revenue that covers
    'gross_profit', (cur->>'covered_revenue')::numeric - (cur->>'provider_cost')::numeric,
    'gross_profit_prev', (prev->>'covered_revenue')::numeric - (prev->>'provider_cost')::numeric,
    'net_operating_profit', (cur->>'covered_revenue')::numeric - (cur->>'provider_cost')::numeric - (cur->>'commission_expense')::numeric,
    'net_operating_profit_prev', (prev->>'covered_revenue')::numeric - (prev->>'provider_cost')::numeric - (prev->>'commission_expense')::numeric,
    'ambassadors', coalesce(v_balances, '{}'::jsonb) || jsonb_build_object(
      'awaiting_approval', (select coalesce(sum(amount), 0) from public.ambassador_withdrawals where status = 'pending'),
      'approved_unpaid', (select coalesce(sum(amount), 0) from public.ambassador_withdrawals where status = 'approved'),
      'rejected', (select coalesce(sum(amount), 0) from public.ambassador_withdrawals where status = 'rejected'),
      'paid_total', (select coalesce(sum(amount), 0) from public.ambassador_withdrawals where status = 'paid')),
    'wallet_liabilities', (select coalesce(sum(balance), 0) from public.wallets),
    'wallets_funded', (select count(*) from public.wallets where balance > 0),
    'unreconciled', (select count(*) from public.finance_recon_flags where check_id in
                       (select key from jsonb_each(public.finance_check_meta()) where value->>0 in ('critical', 'warning'))),
    'critical_flags', (select count(*) from public.finance_recon_flags where check_id in
                       (select key from jsonb_each(public.finance_check_meta()) where value->>0 = 'critical')),
    'delix_wallet', public.admin_delix_wallet_internal(),
    'trend', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'day', d.day, 'net_revenue', d.net_revenue, 'provider_cost', d.cost, 'covered_revenue', d.covered) order by d.day), '[]'::jsonb)
      from (
        select (date_trunc('day', o.created_at at time zone 'Africa/Nairobi'))::date as day,
               sum(o.amount) filter (where o.payment_status = 'paid' and o.status <> 'cancelled') as net_revenue,
               sum(o.provider_cost_kes) filter (where o.payment_status in ('paid', 'refunded') and o.status <> 'cancelled') as cost,
               sum(o.amount) filter (where o.payment_status = 'paid' and o.status <> 'cancelled' and o.provider_cost_kes is not null) as covered
          from public.orders o where o.created_at >= p_from and o.created_at < p_to group by 1) d),
    'definitions', jsonb_build_object(
      'gross_sales', 'Orders paid for (M-Pesa or wallet), at the price charged: after loyalty discounts, before refunds. Unpaid, failed and cancelled orders are excluded.',
      'net_revenue', 'Gross order sales minus refunded orders. Wallet deposits are not revenue; a wallet debit pays for an order but is not extra income.',
      'provider_cost', 'Sum of each order''s provider-cost snapshot (Delix rate in KES x quantity / 1000). It is the rate when the order was sent, not a provider invoice. A refund to the customer does not recover it.',
      'gross_profit', 'Net revenue minus provider costs, only over orders whose provider cost is known. Revenue without a known cost is reported separately and is not included.',
      'net_operating_profit', 'Gross profit minus ambassador commission expense (earned + adjustments - reversals recorded in the period). No other expense types are recorded in the system yet.',
      'payments_received', 'Paid M-Pesa payments: wallet deposits plus direct order payments. Pending, failed and cancelled payments are not money received.',
      'discounts', 'Loyalty discounts already deducted from the order price (face value of points issued is not a cost).',
      'payouts', 'Ambassador withdrawals an admin marked paid with an M-Pesa reference. Requested or approved withdrawals are not payouts.',
      'wallet_liabilities', 'Customer wallet balances: money held for customers, owed back, not income.')
  );
end;
$$;

-- Old vs corrected estimate: shows what the previous USD-converted method produced against the KES method.
create or replace function public.admin_finance_estimate_comparison(p_from timestamptz, p_to timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fx numeric := public.insights_setting('usd_kes_rate', null);
begin
  if not public.is_admin() then raise exception 'Admin access required.'; end if;
  return jsonb_build_object(
    'fx_in_settings', v_fx,
    'rows', (
      select coalesce(jsonb_agg(r order by r.service), '[]'::jsonb) from (
        select s.name as service,
               count(*) as orders,
               sum(o.amount) as revenue,
               round(sum(o.provider_cost_kes), 2) as cost_corrected_kes,
               round(sum(o.provider_cost_kes) * v_fx, 2) as cost_previous_method_kes,
               round(sum(o.amount) - sum(o.provider_cost_kes), 2) as profit_corrected_kes,
               round(sum(o.amount) - sum(o.provider_cost_kes) * v_fx, 2) as profit_previous_method_kes,
               bool_or(o.provider_cost_status = 'backfill_current_rate') as uses_backfilled_cost
          from public.orders o join public.services s on s.id = o.service_id
         where o.payment_status = 'paid' and o.provider_cost_kes is not null and (o.provider_cost_basis->>'rate_currency') = 'KES'
           and o.created_at >= p_from and o.created_at < p_to
         group by s.name) r),
    'note', 'The previous method multiplied the KES rate by the USD to KES setting. Only orders whose rate is interpreted as KES are compared. No stored record was changed.');
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Delix provider wallet (stored reading written by the check-balance Edge Function)
-- ---------------------------------------------------------------------------
create or replace function public.admin_delix_wallet_internal()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select case when v.value is null then jsonb_build_object('available', false, 'reason', 'Balance has not been fetched yet. Use Refresh Balance.')
    else jsonb_build_object(
      'available', (v.value->>'balance') is not null,
      'balance', (v.value->>'balance')::numeric,
      'currency', coalesce(v.value->>'currency', 'KES'),
      'currency_reported', v.value->>'currency_reported',
      'currency_basis', coalesce(v.value->>'currency_basis', 'owner_confirmed_kes'),
      'last_success_at', v.value->>'checked_at',
      'last_attempt_at', v.value->>'last_attempt_at',
      'ok', coalesce((v.value->>'ok')::boolean, true),
      'last_error', v.value->>'last_error')
    end
  from (select (select value from public.site_settings where key = 'delix_balance') as value) v;
$$;
revoke execute on function public.admin_delix_wallet_internal() from public, anon, authenticated;

create or replace function public.admin_delix_wallet()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then raise exception 'Admin access required.'; end if;
  return public.admin_delix_wallet_internal() || jsonb_build_object(
    'connection', (select value from public.site_settings where key = 'delix_connection_status'));
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Financial activity feed
--    Derived, read-only, straight from the authoritative tables (no second copy of money).
--    direction: credit = money/value recognised for BTECH, debit = cost/outflow, memo = not posted.
-- ---------------------------------------------------------------------------
create or replace function public.admin_finance_activity(
  p_from timestamptz, p_to timestamptz,
  p_type text default null, p_search text default null, p_status text default null,
  p_limit integer default 25, p_offset integer default 0, p_for_export boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_q text := lower(trim(coalesce(p_search, '')));
  v_limit integer := least(greatest(coalesce(p_limit, 25), 1), case when p_for_export then 5000 else 100 end);
  v_rows jsonb;
  v_total integer;
begin
  if not public.is_admin() then raise exception 'Admin access required.'; end if;

  with u as (
    select p.created_at as at,
           case when p.payment_type = 'wallet_deposit' then 'wallet_deposit' else 'order_payment' end as type,
           coalesce(p.mpesa_receipt_number, p.checkout_request_id, p.id::text) as ref,
           p.order_id as order_id, p.user_id as customer_id, null::text as counterparty,
           case when p.status = 'paid' then 'credit' else 'memo' end as direction,
           p.amount as amount, p.status as status, 'payments' as source, p.id::text as entity_id, 'payment' as entity_type
      from public.payments p where p.created_at >= p_from and p.created_at < p_to
    union all
    select t.created_at, 'wallet_tx_' || t.type, t.id::text, null, t.user_id, null,
           'memo', abs(t.amount), t.status, 'transactions', t.id::text, 'wallet_transaction'
      from public.transactions t where t.created_at >= p_from and t.created_at < p_to
    union all
    select o.created_at, 'order_sale', o.id, o.id, o.user_id, null,
           'credit', o.amount, 'paid', 'orders', o.id, 'order'
      from public.orders o where o.payment_status = 'paid' and o.status <> 'cancelled' and o.created_at >= p_from and o.created_at < p_to
    union all
    select o.updated_at, 'refund', o.id, o.id, o.user_id, null,
           'debit', o.amount, 'refunded', 'orders', o.id, 'order'
      from public.orders o where o.payment_status = 'refunded' and o.updated_at >= p_from and o.updated_at < p_to
    union all
    select coalesce(o.provider_cost_at, o.created_at), 'provider_cost', coalesce(o.provider_order_id, o.id), o.id, o.user_id, o.provider,
           'debit', o.provider_cost_kes, o.provider_cost_status, 'orders', o.id, 'order'
      from public.orders o
     where o.provider_cost_kes is not null and coalesce(o.provider_cost_at, o.created_at) >= p_from and coalesce(o.provider_cost_at, o.created_at) < p_to
    union all
    select c.created_at, 'commission_' || c.type, c.id::text, c.order_id, c.referred_user_id, a.display_name,
           case when c.amount >= 0 then 'debit' else 'credit' end, abs(c.amount), c.status, 'ambassador_commissions', c.id::text, 'commission'
      from public.ambassador_commissions c join public.ambassadors a on a.id = c.ambassador_id
     where c.created_at >= p_from and c.created_at < p_to
    union all
    select coalesce(w.paid_at, w.requested_at), 'ambassador_payout', coalesce(w.payout_reference, w.id::text), null, null, a.display_name,
           case when w.status = 'paid' then 'debit' else 'memo' end, w.amount, w.status, 'ambassador_withdrawals', w.id::text, 'withdrawal'
      from public.ambassador_withdrawals w join public.ambassadors a on a.id = w.ambassador_id
     where coalesce(w.paid_at, w.requested_at) >= p_from and coalesce(w.paid_at, w.requested_at) < p_to
  ), f as (
    select u.*, pr.name as customer_name, pr.email as customer_email,
           case when exists (select 1 from public.finance_recon_flags x where x.entity_type = u.entity_type and x.entity_id = u.entity_id)
                then 'review' else 'matched' end as recon_state
      from u left join public.profiles pr on pr.id = u.customer_id
     where (p_type is null or p_type = '' or u.type = p_type or u.type like p_type || '%')
       and (p_status is null or p_status = '' or u.status = p_status)
       and (v_q = '' or lower(coalesce(u.ref, '')) like '%' || v_q || '%' or lower(coalesce(u.order_id, '')) like '%' || v_q || '%'
            or lower(coalesce(pr.email, '')) like '%' || v_q || '%' or lower(coalesce(pr.name, '')) like '%' || v_q || '%'
            or lower(coalesce(u.counterparty, '')) like '%' || v_q || '%')
  )
  select (select count(*) from f),
         coalesce((select jsonb_agg(r) from (
           select at as date, type, ref as reference, order_id, entity_type, entity_id,
                  case when p_for_export then null else customer_name end as customer,
                  case when p_for_export then null else customer_email end as customer_email,
                  counterparty, direction, amount, 'KES' as currency, status, recon_state, source
             from f order by at desc, ref limit v_limit offset greatest(coalesce(p_offset, 0), 0)) r), '[]'::jsonb)
    into v_total, v_rows;
  return jsonb_build_object('total', v_total, 'rows', v_rows, 'limit', v_limit, 'offset', greatest(coalesce(p_offset, 0), 0));
end;
$$;

-- One entity in full (the "inspect" panel).
create or replace function public.admin_finance_entity(p_type text, p_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v jsonb;
begin
  if not public.is_admin() then raise exception 'Admin access required.'; end if;
  if p_type = 'order' then
    select jsonb_build_object('order', to_jsonb(o) - 'target', 'customer', (select jsonb_build_object('name', pr.name, 'email', pr.email) from public.profiles pr where pr.id = o.user_id),
             'payments', (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'status', p.status, 'amount', p.amount, 'receipt', p.mpesa_receipt_number, 'at', p.created_at)), '[]'::jsonb) from public.payments p where p.order_id = o.id),
             'commissions', (select coalesce(jsonb_agg(jsonb_build_object('type', c.type, 'amount', c.amount, 'status', c.status)), '[]'::jsonb) from public.ambassador_commissions c where c.order_id = o.id),
             'refunds', (select coalesce(jsonb_agg(jsonb_build_object('status', r.status, 'amount', r.amount, 'at', r.requested_at)), '[]'::jsonb) from public.refund_requests r where r.order_id = o.id),
             'cost_corrections', (select coalesce(jsonb_agg(to_jsonb(fc) - 'admin_id'), '[]'::jsonb) from public.finance_corrections fc where fc.entity_type = 'order' and fc.entity_id = o.id),
             'flags', (select coalesce(jsonb_agg(jsonb_build_object('check', f.check_id, 'detail', f.detail)), '[]'::jsonb) from public.finance_recon_flags f where f.entity_type = 'order' and f.entity_id = o.id))
      into v from public.orders o where o.id = p_id;
  elsif p_type = 'payment' then
    select jsonb_build_object('payment', to_jsonb(p) - 'phone_number', 'flags', (select coalesce(jsonb_agg(jsonb_build_object('check', f.check_id, 'detail', f.detail)), '[]'::jsonb) from public.finance_recon_flags f where f.entity_type = 'payment' and f.entity_id = p.id::text))
      into v from public.payments p where p.id::text = p_id;
  elsif p_type = 'commission' then
    select jsonb_build_object('commission', to_jsonb(c), 'ambassador', (select a.display_name from public.ambassadors a where a.id = c.ambassador_id),
             'flags', (select coalesce(jsonb_agg(jsonb_build_object('check', f.check_id, 'detail', f.detail)), '[]'::jsonb) from public.finance_recon_flags f where f.entity_type = 'commission' and f.entity_id = c.id::text))
      into v from public.ambassador_commissions c where c.id::text = p_id;
  elsif p_type = 'withdrawal' then
    select jsonb_build_object('withdrawal', to_jsonb(w) - 'phone', 'ambassador', (select a.display_name from public.ambassadors a where a.id = w.ambassador_id),
             'flags', (select coalesce(jsonb_agg(jsonb_build_object('check', f.check_id, 'detail', f.detail)), '[]'::jsonb) from public.finance_recon_flags f where f.entity_type = 'withdrawal' and f.entity_id = w.id::text))
      into v from public.ambassador_withdrawals w where w.id::text = p_id;
  elsif p_type = 'wallet_transaction' then
    select jsonb_build_object('transaction', to_jsonb(t), 'customer', (select pr.email from public.profiles pr where pr.id = t.user_id))
      into v from public.transactions t where t.id::text = p_id;
  end if;
  return coalesce(v, jsonb_build_object('error', 'Record not found.'));
end;
$$;

-- ---------------------------------------------------------------------------
-- Execute permissions: signed-in callers only; every function re-checks is_admin().
-- ---------------------------------------------------------------------------
revoke execute on function public.insights_services(timestamptz, timestamptz) from public, anon;
grant execute on function public.insights_services(timestamptz, timestamptz) to authenticated;
revoke execute on function public.insights_finance(timestamptz, timestamptz) from public, anon;
grant execute on function public.insights_finance(timestamptz, timestamptz) to authenticated;
do $$
declare f text;
begin
  foreach f in array array[
    'admin_finance_reconciliation()', 'admin_finance_overview(timestamptz,timestamptz)',
    'admin_finance_estimate_comparison(timestamptz,timestamptz)', 'admin_delix_wallet()',
    'admin_finance_activity(timestamptz,timestamptz,text,text,text,integer,integer,boolean)',
    'admin_finance_entity(text,text)', 'admin_backfill_provider_costs(text)', 'admin_correct_order_cost(text,numeric,text)']
  loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

-- ============================================================================
-- End of migration.
-- ============================================================================
