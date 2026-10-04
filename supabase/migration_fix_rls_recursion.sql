-- ============================================================================
-- BTECH SMM — Fix: infinite recursion in admin RLS policies (error 42P17)
-- ----------------------------------------------------------------------------
-- Run this in the Supabase SQL Editor, after schema.sql and
-- migration_phase2a.sql. Safe to re-run.
--
-- THE BUG: every "admin can see everything" policy checked admin status with
--   exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
-- Because that check itself queries `profiles`, and the policy being
-- evaluated is ALSO on `profiles`, Postgres re-enters the same policy to
-- answer its own question — forever. It correctly detects this and refuses
-- the query with "infinite recursion detected in policy for relation
-- profiles" (42P17). This affected the admin dashboard's user list/count
-- immediately, and likely made ordinary profile loads on the admin account
-- flaky/uncertain too, since the query planner isn't required to evaluate
-- OR'd policies in a particular order.
--
-- THE FIX: move the admin check into a `security definer` function. Such a
-- function runs with the privileges of its owner (not the calling user), and
-- since none of our tables use FORCE ROW LEVEL SECURITY, that means its own
-- internal query against `profiles` is NOT subject to RLS at all — so it can
-- safely answer "is this user an admin?" without re-triggering any policy.
-- This is the standard, documented pattern for this exact situation.
-- ============================================================================

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

-- profiles: admins can see every profile
drop policy if exists "profiles_select_admin" on public.profiles;
create policy "profiles_select_admin" on public.profiles
  for select using (public.is_admin());

-- orders: admins can see every order
drop policy if exists "orders_select_admin" on public.orders;
create policy "orders_select_admin" on public.orders
  for select using (public.is_admin());

-- services: admins can create/edit/deactivate services
drop policy if exists "services_write_admin" on public.services;
create policy "services_write_admin" on public.services
  for all using (public.is_admin());

-- providers / provider_services (Phase 6 groundwork): admin-only
drop policy if exists "providers_admin_only" on public.providers;
create policy "providers_admin_only" on public.providers
  for all using (public.is_admin());

drop policy if exists "provider_services_admin_only" on public.provider_services;
create policy "provider_services_admin_only" on public.provider_services
  for all using (public.is_admin());

-- site_settings: admin-only
drop policy if exists "site_settings_admin_only" on public.site_settings;
create policy "site_settings_admin_only" on public.site_settings
  for all using (public.is_admin());

-- ============================================================================
-- End of fix. Nothing else changes — profiles_select_own,
-- profiles_update_own, and every non-admin policy were already fine and are
-- untouched.
-- ============================================================================
