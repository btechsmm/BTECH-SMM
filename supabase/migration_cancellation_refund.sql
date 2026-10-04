-- ============================================================================
-- BTECH SMM — Order Cancellation + Refund Request workflow
-- ----------------------------------------------------------------------------
-- Run after schema.sql, migration_phase2a.sql and
-- migration_fix_rls_recursion.sql. Safe to re-run.
--
-- Design notes:
-- - Does NOT add new values to orders.status. That column stays exactly
--   pending/processing/completed/cancelled (fulfilment only). Cancellation
--   and refund each get their OWN small request table instead, so "is there
--   a pending cancellation request for this order" is just a row lookup,
--   not an overloaded status enum.
-- - orders.payment_status gains one more legal value, 'refunded', purely as
--   a record that a refund was approved — it does not move any money.
-- - All writes to the two new tables go through security-definer RPCs
--   (matching place_order's existing pattern), so eligibility rules and the
--   "customers can never approve their own refund" rule are enforced in the
--   database, not just hidden in the UI.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- orders.payment_status: allow 'refunded' as an outcome
-- ---------------------------------------------------------------------------
alter table public.orders drop constraint if exists orders_payment_status_check;
alter table public.orders add constraint orders_payment_status_check
  check (payment_status in ('unpaid', 'paid', 'refunded'));

-- ---------------------------------------------------------------------------
-- order_cancellations
-- ---------------------------------------------------------------------------
create table if not exists public.order_cancellations (
  id uuid primary key default gen_random_uuid(),
  order_id text not null references public.orders(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  reason text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  admin_note text,
  requested_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references auth.users(id)
);

create unique index if not exists order_cancellations_one_pending
  on public.order_cancellations (order_id) where status = 'pending';

alter table public.order_cancellations enable row level security;

drop policy if exists "cancellations_select_own" on public.order_cancellations;
create policy "cancellations_select_own" on public.order_cancellations
  for select using (auth.uid() = user_id);

drop policy if exists "cancellations_select_admin" on public.order_cancellations;
create policy "cancellations_select_admin" on public.order_cancellations
  for select using (public.is_admin());

-- Intentionally no insert/update policies: all writes happen through the
-- RPCs below, which run as security definer and enforce eligibility,
-- ownership and admin-only review themselves.

-- ---------------------------------------------------------------------------
-- refund_requests
-- ---------------------------------------------------------------------------
create table if not exists public.refund_requests (
  id uuid primary key default gen_random_uuid(),
  order_id text not null references public.orders(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  amount numeric not null,
  reason text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'processing', 'completed', 'failed')),
  admin_note text,
  requested_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references auth.users(id),
  processed_at timestamptz
);

create unique index if not exists refund_requests_one_pending
  on public.refund_requests (order_id) where status = 'pending';

alter table public.refund_requests enable row level security;

drop policy if exists "refunds_select_own" on public.refund_requests;
create policy "refunds_select_own" on public.refund_requests
  for select using (auth.uid() = user_id);

drop policy if exists "refunds_select_admin" on public.refund_requests;
create policy "refunds_select_admin" on public.refund_requests
  for select using (public.is_admin());

-- ---------------------------------------------------------------------------
-- request_order_cancellation() — customer-facing
-- ---------------------------------------------------------------------------
create or replace function public.request_order_cancellation(p_order_id text, p_reason text)
returns public.order_cancellations
language plpgsql security definer set search_path = public as $$
declare
  v_order public.orders;
  v_row public.order_cancellations;
begin
  select * into v_order from public.orders where id = p_order_id and user_id = auth.uid();
  if v_order is null then
    raise exception 'Order not found.';
  end if;
  if v_order.status not in ('pending', 'processing') then
    raise exception 'This order can no longer be cancelled.';
  end if;
  if exists (select 1 from public.order_cancellations where order_id = p_order_id and status = 'pending') then
    raise exception 'A cancellation request is already pending for this order.';
  end if;

  insert into public.order_cancellations (order_id, user_id, reason)
  values (p_order_id, auth.uid(), nullif(trim(coalesce(p_reason, '')), ''))
  returning * into v_row;

  insert into public.notifications (user_id, type, title, text)
  values (auth.uid(), 'order', 'Cancellation requested', 'Your cancellation request for order ' || p_order_id || ' has been submitted.');

  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- review_cancellation_request() — admin-only
-- ---------------------------------------------------------------------------
create or replace function public.review_cancellation_request(p_request_id uuid, p_approve boolean, p_admin_note text)
returns public.order_cancellations
language plpgsql security definer set search_path = public as $$
declare
  v_row public.order_cancellations;
begin
  if not public.is_admin() then
    raise exception 'Admin access required.';
  end if;

  select * into v_row from public.order_cancellations where id = p_request_id;
  if v_row is null then
    raise exception 'Request not found.';
  end if;
  if v_row.status <> 'pending' then
    raise exception 'This request has already been reviewed.';
  end if;

  update public.order_cancellations
    set status = case when p_approve then 'approved' else 'rejected' end,
        admin_note = nullif(trim(coalesce(p_admin_note, '')), ''),
        reviewed_at = now(),
        reviewed_by = auth.uid()
    where id = p_request_id
    returning * into v_row;

  if p_approve then
    update public.orders set status = 'cancelled', updated_at = now() where id = v_row.order_id;
  end if;

  insert into public.notifications (user_id, type, title, text)
  values (
    v_row.user_id, 'order',
    case when p_approve then 'Cancellation approved' else 'Cancellation rejected' end,
    case when p_approve then 'Your order ' || v_row.order_id || ' has been cancelled.'
         else 'Your cancellation request for order ' || v_row.order_id || ' was rejected.' end
  );

  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- request_order_refund() — customer-facing
-- ---------------------------------------------------------------------------
create or replace function public.request_order_refund(p_order_id text, p_reason text)
returns public.refund_requests
language plpgsql security definer set search_path = public as $$
declare
  v_order public.orders;
  v_row public.refund_requests;
begin
  select * into v_order from public.orders where id = p_order_id and user_id = auth.uid();
  if v_order is null then
    raise exception 'Order not found.';
  end if;
  if v_order.status = 'cancelled' then
    raise exception 'Cancelled orders cannot be refunded.';
  end if;
  if exists (select 1 from public.refund_requests where order_id = p_order_id and status = 'pending') then
    raise exception 'A refund request is already pending for this order.';
  end if;

  insert into public.refund_requests (order_id, user_id, amount, reason)
  values (p_order_id, auth.uid(), v_order.amount, nullif(trim(coalesce(p_reason, '')), ''))
  returning * into v_row;

  insert into public.notifications (user_id, type, title, text)
  values (auth.uid(), 'payment', 'Refund requested', 'Your refund request for order ' || p_order_id || ' has been submitted.');

  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- review_refund_request() — admin-only
-- ---------------------------------------------------------------------------
create or replace function public.review_refund_request(p_request_id uuid, p_approve boolean, p_admin_note text)
returns public.refund_requests
language plpgsql security definer set search_path = public as $$
declare
  v_row public.refund_requests;
begin
  if not public.is_admin() then
    raise exception 'Admin access required.';
  end if;

  select * into v_row from public.refund_requests where id = p_request_id;
  if v_row is null then
    raise exception 'Request not found.';
  end if;
  if v_row.status <> 'pending' then
    raise exception 'This request has already been reviewed.';
  end if;

  update public.refund_requests
    set status = case when p_approve then 'approved' else 'rejected' end,
        admin_note = nullif(trim(coalesce(p_admin_note, '')), ''),
        reviewed_at = now(),
        reviewed_by = auth.uid()
    where id = p_request_id
    returning * into v_row;

  -- Recorded as an outcome only — no money moves. Real M-Pesa refund
  -- transfer is a future phase; this just marks the order's payment_status
  -- so staff and the customer can see the request was honoured.
  if p_approve then
    update public.orders set payment_status = 'refunded', updated_at = now() where id = v_row.order_id;
  end if;

  insert into public.notifications (user_id, type, title, text)
  values (
    v_row.user_id, 'payment',
    case when p_approve then 'Refund approved' else 'Refund rejected' end,
    case when p_approve then 'Your refund for order ' || v_row.order_id || ' has been approved. Online refund payments are not connected yet, so our team will contact you about next steps.'
         else 'Your refund request for order ' || v_row.order_id || ' was rejected.' end
  );

  return v_row;
end;
$$;

-- ============================================================================
-- End of migration.
-- ============================================================================
