-- ============================================================================
-- BTECH SMM — Loyalty discount pricing (STAGED — read before running)
-- ----------------------------------------------------------------------------
-- Run only after migration_loyalty.sql.
--
-- HOW IT WORKS
--  A BEFORE INSERT trigger on public.orders takes whatever price the creating
--  function computed (place_order, wallet_place_order, anything else) as the
--  LIST price, then applies the customer's loyalty discount and stores:
--     orders.list_amount, orders.loyalty_discount_percent,
--     orders.loyalty_discount_amount, and the discounted orders.amount.
--  Everything downstream that already reads orders.amount (M-Pesa order
--  payments, wallet_pay_order, refunds, admin revenue) then uses the
--  discounted price with no further change.
--
-- !! DO NOT RUN THIS UNTIL wallet_place_order() HAS BEEN CHECKED !!
--  If wallet_place_order() computes its own amount and debits THAT number
--  (instead of the amount stored on the order row), the wallet would be
--  debited the undiscounted price while the order shows the discounted one.
--  wallet_place_order's source was not part of the files reviewed. Run this in
--  the SQL editor first and check the debit uses the inserted order's amount:
--
--    select pg_get_functiondef(
--      'public.wallet_place_order(uuid,text,text,text,integer)'::regprocedure);
--
--  If it debits its own variable, that function must be changed to debit
--  v_order.amount (after the insert) before this migration is applied.
--
-- PROFIT PROTECTION (all enforced here, on the server)
--  * Effective % = least(level %, settings.max_discount_percent,
--                        service rule max_discount_percent)
--  * Services with no rule use settings.discount_default_eligible (default
--    FALSE, so nothing is discounted until an admin opts services in).
--  * service_loyalty_rules.min_price_per_1000 is a hard floor: the discount is
--    reduced so the final price never falls below list * floor / base price.
--  * The floor lives in an admin-only table. Provider cost (USD in
--    provider_services.provider_rate) is never read or exposed here.
-- ============================================================================

create or replace function public.loyalty_discount_for(p_user uuid, p_service_id text, p_list numeric)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  s public.loyalty_settings;
  svc public.services;
  a public.loyalty_accounts;
  lvl public.loyalty_levels;
  r public.service_loyalty_rules;
  v_member numeric := 0;
  v_pct numeric := 0;
  v_disc numeric := 0;
  v_min_final numeric;
  v_eligible boolean := false;
begin
  select * into s from public.loyalty_settings where id;
  select * into svc from public.services where id = p_service_id;

  if not found or s.enabled is not true or p_list is null or p_list <= 0 then
    return jsonb_build_object('list_amount', p_list, 'discount_percent', 0, 'discount_amount', 0,
                              'final_amount', p_list, 'eligible', false, 'member_discount_percent', 0);
  end if;

  select * into a from public.loyalty_accounts where user_id = p_user;
  select * into lvl from public.loyalty_levels where id = coalesce(a.level_override_id, a.level_id);
  v_member := coalesce(lvl.discount_percent, 0);

  select * into r from public.service_loyalty_rules where service_id = p_service_id;
  v_eligible := case when r.service_id is null then s.discount_default_eligible else r.discount_eligible end;

  if v_eligible and v_member > 0 then
    v_pct := least(v_member, s.max_discount_percent, coalesce(r.max_discount_percent, 100));
    -- Round the discount DOWN so rounding can never breach the floor.
    if svc.unit is not null then
      v_disc := floor(p_list * v_pct / 100 * 100) / 100;
    else
      v_disc := floor(p_list * v_pct / 100);
    end if;

    if r.min_price_per_1000 is not null and svc.price_per_1000 > 0 then
      v_min_final := p_list * r.min_price_per_1000 / svc.price_per_1000;
      if p_list - v_disc < v_min_final then
        v_disc := greatest(0, p_list - v_min_final);
        if svc.unit is not null then
          v_disc := floor(v_disc * 100) / 100;
        else
          v_disc := floor(v_disc);
        end if;
      end if;
    end if;
  end if;

  return jsonb_build_object(
    'list_amount', p_list,
    'discount_percent', v_pct,
    'discount_amount', v_disc,
    'final_amount', p_list - v_disc,
    'eligible', v_eligible,
    'member_discount_percent', v_member
  );
end;
$$;

-- Applies the discount to every new order, whichever function creates it.
create or replace function public.loyalty_apply_order_discount()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  q jsonb;
begin
  new.list_amount := new.amount;
  q := public.loyalty_discount_for(new.user_id, new.service_id, new.amount);
  if coalesce((q->>'discount_amount')::numeric, 0) > 0 then
    new.loyalty_discount_percent := (q->>'discount_percent')::numeric;
    new.loyalty_discount_amount := (q->>'discount_amount')::numeric;
    new.amount := new.amount - (q->>'discount_amount')::numeric;
  end if;
  return new;
end;
$$;

drop trigger if exists loyalty_order_discount on public.orders;
create trigger loyalty_order_discount
  before insert on public.orders
  for each row execute function public.loyalty_apply_order_discount();

-- Display-only preview for the order form. The server never trusts this: the
-- charged price is decided by the trigger above at order creation.
create or replace function public.quote_my_order(p_service_id text, p_quantity integer)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_service public.services;
  v_list numeric;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated.';
  end if;

  select * into v_service from public.services where id = p_service_id and active = true and visible = true;
  if not found then
    raise exception 'This service is not available.';
  end if;
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Quantity must be positive.';
  end if;

  -- Same formula as place_order().
  if v_service.unit is not null then
    v_list := v_service.price_per_1000 * p_quantity;
  else
    v_list := round((p_quantity::numeric / 1000) * v_service.price_per_1000);
  end if;

  return public.loyalty_discount_for(auth.uid(), p_service_id, v_list);
end;
$$;

revoke execute on function public.loyalty_discount_for(uuid, text, numeric) from public, anon, authenticated;
revoke execute on function public.loyalty_apply_order_discount() from public, anon, authenticated;
revoke execute on function public.quote_my_order(text, integer) from public, anon;
grant execute on function public.quote_my_order(text, integer) to authenticated;

-- ============================================================================
-- After applying, verify with a test customer (loyalty enabled, a level with a
-- discount, the service opted in):
--   1. place a wallet order and compare:
--        wallet balance before - after   ==   orders.amount   (NOT list_amount)
--   2. select id, list_amount, loyalty_discount_amount, amount from public.orders
--        order by created_at desc limit 3;
-- If the wallet delta equals list_amount, stop and fix wallet_place_order().
-- ============================================================================
