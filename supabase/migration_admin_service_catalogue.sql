-- ============================================================================
-- BTECH SMM — Admin service catalogue management (schema additions)
-- ----------------------------------------------------------------------------
-- Run after all previous migrations. Additive/idempotent.
--
-- WHY: `services.active` already existed and already correctly gates
-- purchasing (place_order() checks it, customer services.js filters by it).
-- But the brief distinguishes "activate/deactivate" (can it be bought) from
-- "hide/show" (does it appear in the listing at all) as two separate admin
-- actions with two separate tests — that genuinely needs a second column,
-- not a rename of the first.
--
-- `refill_enabled`/`cancel_enabled` are BTECH's own customer-facing promise,
-- independent of whether the mapped provider happens to support it — BTECH
-- may choose not to offer refill/cancel even when Delix does.
-- ============================================================================

alter table public.services
  add column if not exists visible boolean not null default true,
  add column if not exists display_order integer not null default 0,
  add column if not exists refill_enabled boolean not null default false,
  add column if not exists cancel_enabled boolean not null default false;

-- Server-side validation, not just "only an admin can write" — RLS already
-- restricts WHO can write (is_admin()), this restricts WHAT values are
-- ever allowed to land in the table regardless of who's writing.
alter table public.services drop constraint if exists services_price_positive;
alter table public.services add constraint services_price_positive check (price_per_1000 > 0);

alter table public.services drop constraint if exists services_min_positive;
alter table public.services add constraint services_min_positive check (min_quantity > 0);

alter table public.services drop constraint if exists services_max_gte_min;
alter table public.services add constraint services_max_gte_min check (max_quantity >= min_quantity);

-- ---------------------------------------------------------------------------
-- place_order(): purchase eligibility now also requires visible = true —
-- "hide" and "deactivate" both block new purchases per the brief's own
-- Test 3/4; a hidden-but-still-technically-active service must not be
-- buyable via a direct/guessed URL either.
-- ---------------------------------------------------------------------------
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
  select * into v_service from public.services where id = p_service_id and active = true and visible = true;

  if v_service is null then
    raise exception 'This service is not available.';
  end if;

  if p_quantity is null or p_quantity < v_service.min_quantity or p_quantity > v_service.max_quantity then
    raise exception 'Quantity must be between % and %.', v_service.min_quantity, v_service.max_quantity;
  end if;

  if p_target is null or length(trim(p_target)) = 0 then
    raise exception 'A target URL is required.';
  end if;

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

-- ============================================================================
-- End of migration.
-- ============================================================================
