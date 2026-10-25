-- ============================================================================
-- BTECH SMM — PHASE 0 (PROPOSED, NOT APPLIED): profile role protection + security_admins
-- Review only. Tested on a disposable LOCAL database built from the repo SQL; NOT run on production.
-- Idempotent: safe to re-run. Rollback: phase0_rollback.sql.
-- ============================================================================

-- 1) Users may update only their own row (adds the missing WITH CHECK).
drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own" on public.profiles
  for update to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- 2) Column-level privileges: the app only ever updates name, phone, updated_at (js/profile.js:59).
revoke update on public.profiles from anon, authenticated;
grant  update (name, phone, updated_at) on public.profiles to authenticated;

-- 3) Defence in depth: nobody except trusted database roles may change `role`, whatever grants exist later.
create or replace function public.profiles_protect_role()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if new.role is distinct from old.role
     and current_user not in ('postgres', 'supabase_admin', 'service_role') then
    raise exception 'Changing a profile role is not permitted.' using errcode = '42501';
  end if;
  if new.id is distinct from old.id then
    raise exception 'Profile id cannot be changed.' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function public.profiles_protect_role() from public, anon, authenticated;

drop trigger if exists profiles_protect_role on public.profiles;
create trigger profiles_protect_role
  before update on public.profiles
  for each row execute function public.profiles_protect_role();

-- 4) Separate, server-managed list of security administrators. Customers and ordinary admins cannot write it.
create table if not exists public.security_admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  note       text,
  granted_at timestamptz not null default now()
);
alter table public.security_admins enable row level security;      -- no policies: unreachable through the API
revoke all on public.security_admins from public, anon, authenticated;

-- 5) The ONLY authorization check the Cyber Defense module will use: admin role AND explicit membership.
create or replace function public.is_security_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select auth.uid() is not null
     and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
     and exists (select 1 from public.security_admins s where s.user_id = auth.uid());
$$;
revoke all on function public.is_security_admin() from public, anon;
grant execute on function public.is_security_admin() to authenticated;

-- 6) SEED — run SEPARATELY, only after you have verified the owner's auth user id (queries in the report).
--    Do not use an email lookup here: paste the verified UUID.
-- insert into public.security_admins (user_id, note) values ('<VERIFIED-OWNER-UUID>', 'Owner') on conflict do nothing;
