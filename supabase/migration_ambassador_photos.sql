-- ============================================================================
-- BTECH SMM — Ambassador profile photos
-- ----------------------------------------------------------------------------
-- Run AFTER migration_ambassador.sql. Idempotent.
--
-- Applicants upload a photo with their application; it appears on their badge
-- (and, once approved, on the public verification page).
--
-- STORAGE MODEL
--  * Public bucket "ambassador-photos": JPEG only, max 2 MB. Public so the
--    anonymous verification page can show the photo; files live at
--    <user-id>/<random-uuid>.jpg, so a URL cannot be guessed.
--  * Only the owner can upload/delete inside their own folder (storage RLS);
--    admins can read/delete any.
--  * The DATABASE records which file is the ambassador's photo. The RPCs check
--    that the path is in the caller's own folder AND that the object really
--    exists, so nobody can point their profile at someone else's file.
--  * The verification RPC reveals the photo only while the ambassador is active.
-- The browser crops and re-encodes every photo to a 600x600 JPEG before upload
-- (which also strips camera metadata such as GPS location).
-- ============================================================================

alter table public.ambassadors
  add column if not exists photo_path text,
  add column if not exists photo_updated_at timestamptz;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('ambassador-photos', 'ambassador-photos', true, 2097152, array['image/jpeg'])
on conflict (id) do update
  set public = true, file_size_limit = 2097152, allowed_mime_types = array['image/jpeg'];

drop policy if exists "amb_photos_insert_own" on storage.objects;
create policy "amb_photos_insert_own" on storage.objects for insert to authenticated
  with check (bucket_id = 'ambassador-photos' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "amb_photos_select_own" on storage.objects;
create policy "amb_photos_select_own" on storage.objects for select to authenticated
  using (bucket_id = 'ambassador-photos' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "amb_photos_delete_own" on storage.objects;
create policy "amb_photos_delete_own" on storage.objects for delete to authenticated
  using (bucket_id = 'ambassador-photos' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "amb_photos_admin" on storage.objects;
create policy "amb_photos_admin" on storage.objects for all to authenticated
  using (bucket_id = 'ambassador-photos' and public.is_admin())
  with check (bucket_id = 'ambassador-photos' and public.is_admin());

-- Is this path one of the caller's own, well-formed photo files that really exists?
create or replace function public.ambassador_photo_valid(p_uid uuid, p_path text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_path is not null
     and p_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$'
     and split_part(p_path, '/', 1) = p_uid::text
     and exists (select 1 from storage.objects where bucket_id = 'ambassador-photos' and name = p_path);
$$;

-- The application now requires a photo (replaces the 2-argument version).
drop function if exists public.apply_for_ambassador(text, text);
create or replace function public.apply_for_ambassador(p_display_name text, p_motivation text, p_photo_path text)
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
  if not public.ambassador_photo_valid(v_uid, p_photo_path) then
    raise exception 'Please upload a profile photo.';
  end if;

  select * into a from public.ambassadors where user_id = v_uid for update;
  if found then
    if a.status <> 'rejected' then
      raise exception 'You have already applied to the Ambassador Program.';
    end if;
    update public.ambassadors
       set display_name = v_name, motivation = left(coalesce(p_motivation, ''), 1000),
           photo_path = p_photo_path, photo_updated_at = now(),
           status = 'applicant', applied_at = now(), status_changed_at = now()
     where id = a.id returning * into a;
  else
    insert into public.ambassadors (user_id, display_name, motivation, commission_rate, photo_path, photo_updated_at)
    values (v_uid, v_name, left(coalesce(p_motivation, ''), 1000), s.default_commission_rate, p_photo_path, now())
    returning * into a;
  end if;

  insert into public.notifications (user_id, type, title, text)
  values (v_uid, 'system', 'Application received', 'Your BTECH SMM Ambassador application is being reviewed.');
  return a;
end;
$$;

-- Change the photo later. Returns the previous path so the browser can delete
-- the old file once this succeeds.
create or replace function public.update_ambassador_photo(p_photo_path text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  a public.ambassadors;
  v_old text;
begin
  select * into a from public.ambassadors where user_id = auth.uid() for update;
  if not found or a.status not in ('applicant', 'approved', 'suspended') then
    raise exception 'You cannot change the photo for this account.';
  end if;
  if not public.ambassador_photo_valid(auth.uid(), p_photo_path) then
    raise exception 'Please upload a profile photo.';
  end if;
  v_old := a.photo_path;
  update public.ambassadors set photo_path = p_photo_path, photo_updated_at = now() where id = a.id;
  return jsonb_build_object('old_path', v_old);
end;
$$;

-- Functions below are redefined from migration_ambassador.sql with photo support.

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
    'photo_path', a.photo_path,
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
    'photo_path', case when a.status = 'approved' then a.photo_path else null end,
    'referral_code', case when a.status = 'approved' then a.referral_code else null end,
    'status', a.status,
    'issued_at', a.approved_at);
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
      select a.id, a.user_id, a.display_name, a.photo_path, a.status, a.ambassador_code, a.referral_code, a.commission_rate,
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
    if a.photo_path is null then raise exception 'The applicant must upload a profile photo before approval.'; end if;
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

revoke execute on function public.ambassador_photo_valid(uuid, text) from public, anon, authenticated;
revoke execute on function public.apply_for_ambassador(text, text, text) from public, anon;
grant execute on function public.apply_for_ambassador(text, text, text) to authenticated;
revoke execute on function public.update_ambassador_photo(text) from public, anon;
grant execute on function public.update_ambassador_photo(text) to authenticated;
-- Re-grant the redefined functions (create or replace keeps grants, restated for clarity).
grant execute on function public.verify_ambassador(text) to anon, authenticated;

-- ============================================================================
-- End of migration.
-- ============================================================================
