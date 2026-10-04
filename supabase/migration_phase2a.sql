-- ============================================================================
-- BTECH SMM — Phase 2A Migration
-- ----------------------------------------------------------------------------
-- Run this ONCE in the Supabase SQL Editor, AFTER schema.sql has already been
-- run at least once. It is additive and safe to re-run (every statement uses
-- IF NOT EXISTS / OR REPLACE / DROP...IF EXISTS).
--
-- What this changes and why:
--
-- 1. orders.payment_status — new column. Until M-Pesa (Phase 5) exists, no
--    order can ever actually be paid for, so every order is created as
--    'unpaid'. `status` continues to track fulfilment workflow (pending /
--    processing / completed / cancelled) and is unaffected.
--
-- 2. place_order() — REWRITTEN. The previous version accepted `p_amount`
--    directly from the browser and trusted it verbatim, and never checked
--    the submitted quantity against the service's min/max in the database.
--    Both are exploitable: a customer could open the browser console and
--    call `supabase.rpc('place_order', { p_amount: 1 })` to buy anything for
--    KSh 1, or submit a quantity far outside the advertised range. The new
--    version looks up the service row itself, recomputes the price and
--    validates quantity server-side, and ignores/ no longer accepts a
--    client-supplied amount. It also no longer touches the wallet at all —
--    orders are recorded as unpaid, not paid for from wallet balance.
--
-- 3. deposit_wallet() — DISABLED server-side (raises an exception). The
--    brief for this phase is explicit that simulated deposits must not be
--    possible before real M-Pesa integration exists, and that this must not
--    be enforced by frontend JavaScript alone. The function is kept (not
--    dropped) so Phase 5 can replace its body with the real, server-verified
--    M-Pesa deposit path without having to re-create it.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. orders.payment_status
-- ---------------------------------------------------------------------------
alter table public.orders
  add column if not exists payment_status text not null default 'unpaid'
  check (payment_status in ('unpaid', 'paid'));

-- ---------------------------------------------------------------------------
-- 2. place_order() — server-side price + quantity validation, no wallet debit
-- ---------------------------------------------------------------------------
drop function if exists public.place_order(text, text, text, integer, numeric);

create or replace function public.place_order(
  p_order_id text,
  p_service_id text,
  p_target text,
  p_quantity integer
)
returns public.orders
language plpgsql
security definer
set search_path = public
as $$
declare
  v_service public.services;
  v_amount numeric;
  v_order public.orders;
begin
  select * into v_service from public.services where id = p_service_id and active = true;

  if v_service is null then
    raise exception 'This service is not available.';
  end if;

  if p_quantity is null or p_quantity < v_service.min_quantity or p_quantity > v_service.max_quantity then
    raise exception 'Quantity must be between % and %.', v_service.min_quantity, v_service.max_quantity;
  end if;

  if p_target is null or length(trim(p_target)) = 0 then
    raise exception 'A target URL is required.';
  end if;

  -- Server-computed amount — the browser's displayed total is for UX only
  -- and is never trusted as the source of truth.
  if v_service.unit is not null then
    v_amount := v_service.price_per_1000 * p_quantity;
  else
    v_amount := round((p_quantity::numeric / 1000) * v_service.price_per_1000);
  end if;

  insert into public.orders (id, user_id, service_id, target, quantity, amount, status, payment_status, progress, notes)
  values (p_order_id, auth.uid(), p_service_id, p_target, p_quantity, v_amount, 'pending', 'unpaid', 0,
          'Order received. Payment is not yet connected (M-Pesa integration is planned) — this order is awaiting payment.')
  returning * into v_order;

  insert into public.notifications (user_id, type, title, text)
  values (auth.uid(), 'order', 'Order created', 'Order ' || p_order_id || ' was created and is awaiting payment.');

  return v_order;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. deposit_wallet() — disabled until real M-Pesa integration (Phase 5)
-- ---------------------------------------------------------------------------
create or replace function public.deposit_wallet(p_amount numeric)
returns public.wallets
language plpgsql
security definer
set search_path = public
as $$
begin
  raise exception 'Wallet deposits are not available yet. M-Pesa integration is planned for a future update.';
end;
$$;

-- ============================================================================
-- End of migration. No existing rows are modified; only new orders use the
-- new function. Existing order rows keep payment_status = 'unpaid' (default).
-- ============================================================================
