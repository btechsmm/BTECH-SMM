-- ============================================================================
-- BTECH SMM — Formal Ambassador Application system
-- ----------------------------------------------------------------------------
-- Run AFTER migration_ambassador.sql and migration_ambassador_photos.sql.
-- Additive and idempotent. Touches NO existing table, balance, commission,
-- referral or withdrawal logic.
--
-- DESIGN
--  * An application is a record in its own table. SUBMITTING ONE CREATES NO
--    ambassadors ROW and grants nothing: no Ambassador ID, no referral code, no
--    link, no commission, no withdrawals.
--  * Approval goes through the EXISTING activation path, public.admin_review_ambassador(..., 'approve').
--    That function assigns the permanent Ambassador ID and referral code once. This migration only
--    makes sure the applicant has an ambassadors row for it to act on (ambassadors.user_id is
--    unique, so a second record can never be created) and calls it in the same transaction.
--    If activation fails for any reason, the whole decision rolls back.
--  * No client role can write either new table. Applicants submit and answer through
--    SECURITY DEFINER functions; only admins can read the tables or decide.
--  * Applicants never read the tables directly (private reviewer notes live there).
--    They get a limited view through get_my_ambassador_application().
--
-- PROGRAMME REQUIREMENTS THIS MIGRATION DELIBERATELY DOES NOT DECIDE (management to confirm):
--   * minimum age / parental consent
--   * eligibility criteria and any applicant cap
--   * commission rate for new ambassadors (the existing default is used, as today)
--   * how long declined/old applications are retained
--   * how soon a declined applicant may re-apply (today: any time, max 3 submissions per 24 h)
-- ============================================================================

create sequence if not exists public.ambassador_application_seq;

-- ---------------------------------------------------------------------------
-- Applications
-- ---------------------------------------------------------------------------
create table if not exists public.ambassador_applications (
  id uuid primary key default gen_random_uuid(),
  reference text not null unique,                       -- BTECH-APP-000001
  user_id uuid not null references auth.users(id) on delete restrict,
  status text not null default 'submitted'
    check (status in ('submitted', 'clarification_requested', 'approved', 'declined')),

  full_name text not null check (length(btrim(full_name)) between 2 and 100),
  display_name text check (display_name is null or length(btrim(display_name)) between 2 and 40),
  phone text not null check (phone ~ '^\+?[0-9]{9,15}$'),
  email text not null check (length(email) <= 254 and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  btech_username text check (btech_username is null or length(btech_username) <= 60),
  motivation text not null check (length(btrim(motivation)) between 30 and 1500),
  experience text check (experience is null or length(experience) <= 1500),
  promotion_channels text not null check (length(btrim(promotion_channels)) between 10 and 1000),

  conflict_declared boolean not null,
  conflict_details text check (conflict_details is null or length(conflict_details) <= 1000),
  check (not conflict_declared or length(btrim(coalesce(conflict_details, ''))) >= 10),

  ack_accuracy boolean not null check (ack_accuracy),
  ack_honest_promotion boolean not null check (ack_honest_promotion),
  ack_privacy boolean not null check (ack_privacy),
  ack_no_guarantee boolean not null check (ack_no_guarantee),
  ack_badge_display boolean not null check (ack_badge_display),   -- existing badge/verification-page consent
  confirmation_name text not null check (length(btrim(confirmation_name)) between 2 and 100),

  photo_path text,                                       -- existing 'ambassador-photos' bucket, validated on submit
  submitted_at timestamptz not null default now(),       -- server-generated
  confirmed_at timestamptz not null default now(),       -- server-generated time of the digital confirmation
  updated_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid references auth.users(id),
  ambassador_id uuid references public.ambassadors(id)   -- set on approval
);

-- One application "in play" per person (an approved one blocks a second as well).
create unique index if not exists ambassador_application_one_open
  on public.ambassador_applications (user_id)
  where status in ('submitted', 'clarification_requested', 'approved');
create index if not exists ambassador_applications_status_idx
  on public.ambassador_applications (status, submitted_at desc);
create index if not exists ambassador_applications_user_idx
  on public.ambassador_applications (user_id, submitted_at desc);

-- ---------------------------------------------------------------------------
-- Decision history / timeline. Rows are only ever inserted, never edited.
--   visible_to_applicant = false  -> private reviewer note (admins only)
-- ---------------------------------------------------------------------------
create table if not exists public.ambassador_application_events (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.ambassador_applications(id) on delete cascade,
  actor_id uuid references auth.users(id),
  actor_role text not null check (actor_role in ('applicant', 'admin')),
  event text not null check (event in ('submitted', 'clarification_requested', 'applicant_replied', 'approved', 'declined', 'note')),
  from_status text,
  to_status text,
  message text check (message is null or length(message) <= 2000),
  visible_to_applicant boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists ambassador_application_events_app_idx
  on public.ambassador_application_events (application_id, created_at);

-- ---------------------------------------------------------------------------
-- Row Level Security: admin read only. There is NO insert/update/delete policy
-- for anyone, and table privileges are removed as a second lock.
-- ---------------------------------------------------------------------------
alter table public.ambassador_applications enable row level security;
alter table public.ambassador_application_events enable row level security;

drop policy if exists "amb_applications_admin_select" on public.ambassador_applications;
create policy "amb_applications_admin_select" on public.ambassador_applications
  for select using (public.is_admin());
drop policy if exists "amb_application_events_admin_select" on public.ambassador_application_events;
create policy "amb_application_events_admin_select" on public.ambassador_application_events
  for select using (public.is_admin());

revoke all on public.ambassador_applications from public, anon, authenticated;
revoke all on public.ambassador_application_events from public, anon, authenticated;
grant select on public.ambassador_applications to authenticated;          -- still filtered by the admin-only policy
grant select on public.ambassador_application_events to authenticated;    -- still filtered by the admin-only policy
revoke all on sequence public.ambassador_application_seq from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Applicant: submit
--   Spam / abuse controls (server side): signed-in only, honeypot field must be empty,
--   a minimum fill time, one open application per person (unique index above), and at most
--   3 submissions per rolling 24 hours.
-- ---------------------------------------------------------------------------
create or replace function public.submit_ambassador_application(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  s public.ambassador_settings;
  amb public.ambassadors;
  app public.ambassador_applications;
  v_name text;
  v_display text;
  v_phone text;
  v_email text;
  v_username text;
  v_why text;
  v_exp text;
  v_channels text;
  v_conflict boolean;
  v_conflict_text text;
  v_confirm text;
  v_photo text;
  v_elapsed numeric;
  v_has_amb boolean;
begin
  if v_uid is null then
    raise exception 'Please log in to apply.';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'We couldn''t read your application. Please try again.';
  end if;

  -- Bot traps: a hidden field real users never fill, and an implausibly fast submission.
  if btrim(coalesce(p_payload->>'website', '')) <> '' then
    raise exception 'We couldn''t submit your application. Please try again.';
  end if;
  v_elapsed := case when coalesce(p_payload->>'elapsed_ms', '') ~ '^[0-9]{1,9}$' then (p_payload->>'elapsed_ms')::numeric else 0 end;
  if v_elapsed < 5000 then
    raise exception 'Please take a moment to review your answers, then submit again.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('ambassador_application:' || v_uid::text, 0));

  select * into s from public.ambassador_settings where id;
  if not found or not s.program_enabled then
    raise exception 'The Ambassador Program is not accepting applications right now.';
  end if;

  v_name := btrim(coalesce(p_payload->>'full_name', ''));
  v_display := nullif(btrim(coalesce(p_payload->>'display_name', '')), '');
  v_phone := regexp_replace(coalesce(p_payload->>'phone', ''), '[\s().-]', '', 'g');
  v_email := lower(btrim(coalesce(p_payload->>'email', '')));
  v_username := nullif(btrim(coalesce(p_payload->>'btech_username', '')), '');
  v_why := btrim(coalesce(p_payload->>'motivation', ''));
  v_exp := nullif(btrim(coalesce(p_payload->>'experience', '')), '');
  v_channels := btrim(coalesce(p_payload->>'promotion_channels', ''));
  v_conflict_text := nullif(btrim(coalesce(p_payload->>'conflict_details', '')), '');
  v_confirm := btrim(coalesce(p_payload->>'confirmation_name', ''));

  if length(v_name) < 2 or length(v_name) > 100 then
    raise exception 'Please enter your full name.';
  end if;
  if v_display is not null and (length(v_display) < 2 or length(v_display) > 40) then
    raise exception 'The name on your badge must be 2 to 40 characters.';
  end if;
  if v_phone !~ '^\+?[0-9]{9,15}$' then
    raise exception 'Please enter a valid phone / WhatsApp number.';
  end if;
  if length(v_email) > 254 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'Please enter a valid email address.';
  end if;
  if v_username is not null and length(v_username) > 60 then
    raise exception 'Your BTECH SMM username or ID is too long.';
  end if;
  if length(v_why) < 30 or length(v_why) > 1500 then
    raise exception 'Please tell us why you want to join (30 to 1,500 characters).';
  end if;
  if v_exp is not null and length(v_exp) > 1500 then
    raise exception 'Your experience is too long (maximum 1,500 characters).';
  end if;
  if length(v_channels) < 10 or length(v_channels) > 1000 then
    raise exception 'Please describe where you will promote BTECH SMM (10 to 1,000 characters).';
  end if;

  if p_payload->>'conflict_declared' is null or (p_payload->>'conflict_declared') not in ('true', 'false') then
    raise exception 'Please declare whether you have a conflict of interest.';
  end if;
  v_conflict := (p_payload->>'conflict_declared') = 'true';
  if v_conflict and (v_conflict_text is null or length(v_conflict_text) < 10) then
    raise exception 'Please explain your conflict of interest.';
  end if;
  if not v_conflict then
    v_conflict_text := null;
  end if;
  if v_conflict_text is not null and length(v_conflict_text) > 1000 then
    raise exception 'Your conflict-of-interest explanation is too long (maximum 1,000 characters).';
  end if;

  if coalesce(p_payload->>'ack_accuracy', '') <> 'true'
     or coalesce(p_payload->>'ack_honest_promotion', '') <> 'true'
     or coalesce(p_payload->>'ack_privacy', '') <> 'true'
     or coalesce(p_payload->>'ack_no_guarantee', '') <> 'true'
     or coalesce(p_payload->>'ack_badge_display', '') <> 'true' then
    raise exception 'Please tick every acknowledgement to continue.';
  end if;
  if length(v_confirm) < 2 then
    raise exception 'Please type your full name to confirm your application.';
  end if;

  -- Existing ambassador record? A rejected one may re-apply; anything else may not.
  select * into amb from public.ambassadors where user_id = v_uid;
  v_has_amb := found;
  if v_has_amb and amb.status <> 'rejected' then
    if amb.status = 'applicant' then
      raise exception 'You already have an ambassador application under review.';
    end if;
    raise exception 'You already have an ambassador account.';
  end if;

  -- Photo: the existing storage bucket and validator. Reuse the account's current photo if there is one.
  v_photo := nullif(btrim(coalesce(p_payload->>'photo_path', '')), '');
  if v_photo is not null then
    if not public.ambassador_photo_valid(v_uid, v_photo) then
      raise exception 'Please upload a valid profile photo.';
    end if;
  elsif v_has_amb and amb.photo_path is not null then
    v_photo := amb.photo_path;
  else
    raise exception 'Please add a profile photo.';
  end if;

  select * into app from public.ambassador_applications
   where user_id = v_uid and status in ('submitted', 'clarification_requested', 'approved');
  if found then
    raise exception 'You already have an application on file (%).', app.reference;
  end if;
  if (select count(*) from public.ambassador_applications where user_id = v_uid and submitted_at > now() - interval '24 hours') >= 3 then
    raise exception 'You have submitted several applications recently. Please try again later.';
  end if;

  begin
    insert into public.ambassador_applications (
      reference, user_id, full_name, display_name, phone, email, btech_username, motivation, experience,
      promotion_channels, conflict_declared, conflict_details,
      ack_accuracy, ack_honest_promotion, ack_privacy, ack_no_guarantee, ack_badge_display,
      confirmation_name, photo_path)
    values (
      'BTECH-APP-' || lpad(nextval('public.ambassador_application_seq')::text, 6, '0'),
      v_uid, v_name, v_display, v_phone, v_email, v_username, v_why, v_exp,
      v_channels, v_conflict, v_conflict_text,
      true, true, true, true, true,
      v_confirm, v_photo)
    returning * into app;
  exception when unique_violation then
    raise exception 'You already have an application on file.';
  end;

  insert into public.ambassador_application_events (application_id, actor_id, actor_role, event, to_status, visible_to_applicant)
  values (app.id, v_uid, 'applicant', 'submitted', 'submitted', true);

  insert into public.notifications (user_id, type, title, text)
  values (v_uid, 'system', 'Ambassador application received',
          'Your application ' || app.reference || ' has been received and will be reviewed. Applying does not guarantee approval or earnings.');

  return jsonb_build_object('reference', app.reference, 'submitted_at', app.submitted_at, 'status', app.status);
end;
$$;

-- ---------------------------------------------------------------------------
-- Applicant: read own latest application (limited view, no private notes)
-- ---------------------------------------------------------------------------
create or replace function public.get_my_ambassador_application()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  app public.ambassador_applications;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated.';
  end if;
  select * into app from public.ambassador_applications
   where user_id = auth.uid() order by submitted_at desc limit 1;
  if not found then
    return jsonb_build_object('exists', false);
  end if;
  return jsonb_build_object(
    'exists', true,
    'reference', app.reference,
    'status', app.status,
    'full_name', app.full_name,
    'submitted_at', app.submitted_at,
    'decided_at', app.decided_at,
    'message', (select e.message from public.ambassador_application_events e
                 where e.application_id = app.id and e.visible_to_applicant and e.actor_role = 'admin' and e.message is not null
                 order by e.created_at desc limit 1),
    'history', coalesce((select jsonb_agg(jsonb_build_object('event', e.event, 'at', e.created_at, 'message', e.message) order by e.created_at)
                           from public.ambassador_application_events e
                          where e.application_id = app.id and e.visible_to_applicant), '[]'::jsonb));
end;
$$;

-- ---------------------------------------------------------------------------
-- Applicant: answer a clarification request (puts the application back in the review queue)
-- ---------------------------------------------------------------------------
create or replace function public.respond_to_ambassador_application(p_message text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  app public.ambassador_applications;
  v_msg text := btrim(coalesce(p_message, ''));
begin
  if v_uid is null then
    raise exception 'Please log in.';
  end if;
  if length(v_msg) < 2 or length(v_msg) > 1500 then
    raise exception 'Please write a reply (up to 1,500 characters).';
  end if;

  select * into app from public.ambassador_applications
   where user_id = v_uid and status = 'clarification_requested' for update;
  if not found then
    raise exception 'There is no clarification request waiting for your reply.';
  end if;

  update public.ambassador_applications set status = 'submitted', updated_at = now() where id = app.id;
  insert into public.ambassador_application_events (application_id, actor_id, actor_role, event, from_status, to_status, message, visible_to_applicant)
  values (app.id, v_uid, 'applicant', 'applicant_replied', 'clarification_requested', 'submitted', v_msg, true);

  return jsonb_build_object('reference', app.reference, 'status', 'submitted');
end;
$$;

-- ---------------------------------------------------------------------------
-- Admin: list / detail / counts
-- ---------------------------------------------------------------------------
create or replace function public.admin_list_ambassador_applications(
  p_status text default null, p_search text default null, p_limit integer default 25, p_offset integer default 0)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_q text := lower(btrim(coalesce(p_search, '')));
begin
  if not public.is_admin() then raise exception 'Admin access required.'; end if;
  return coalesce((
    select jsonb_agg(t) from (
      select a.id, a.reference, a.status, a.full_name, a.email, a.phone, a.btech_username, a.submitted_at, a.decided_at,
             a.photo_path, a.conflict_declared,
             p.name as account_name, p.email as account_email
        from public.ambassador_applications a
        left join public.profiles p on p.id = a.user_id
       where (p_status is null or p_status = '' or a.status = p_status)
         and (v_q = ''
              or position(v_q in lower(a.reference)) > 0
              or position(v_q in lower(a.full_name)) > 0
              or position(v_q in lower(a.email)) > 0
              or position(v_q in lower(a.phone)) > 0
              or position(v_q in lower(coalesce(a.btech_username, ''))) > 0)
       order by case a.status when 'submitted' then 0 when 'clarification_requested' then 1 else 2 end, a.submitted_at desc
       limit least(greatest(coalesce(p_limit, 25), 1), 100) offset greatest(coalesce(p_offset, 0), 0)
    ) t), '[]'::jsonb);
end;
$$;

create or replace function public.admin_get_ambassador_application(p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  app public.ambassador_applications;
begin
  if not public.is_admin() then raise exception 'Admin access required.'; end if;
  select * into app from public.ambassador_applications where id = p_id;
  if not found then raise exception 'Application not found.'; end if;
  return jsonb_build_object(
    'application', to_jsonb(app),
    'account', (select jsonb_build_object('name', p.name, 'email', p.email, 'phone', p.phone, 'created_at', p.created_at)
                  from public.profiles p where p.id = app.user_id),
    'ambassador_status', (select a.status from public.ambassadors a where a.user_id = app.user_id),
    'events', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', e.id, 'event', e.event, 'from_status', e.from_status, 'to_status', e.to_status, 'message', e.message,
               'visible_to_applicant', e.visible_to_applicant, 'actor_role', e.actor_role,
               'actor', coalesce(nullif(p.name, ''), p.email), 'at', e.created_at) order by e.created_at)
        from public.ambassador_application_events e
        left join public.profiles p on p.id = e.actor_id
       where e.application_id = app.id), '[]'::jsonb));
end;
$$;

create or replace function public.admin_ambassador_application_counts()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then raise exception 'Admin access required.'; end if;
  return coalesce((select jsonb_object_agg(status, n) from (
    select status, count(*) as n from public.ambassador_applications group by status) c), '{}'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- Admin: request clarification
-- ---------------------------------------------------------------------------
create or replace function public.admin_request_application_clarification(p_id uuid, p_message text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  app public.ambassador_applications;
  v_msg text := btrim(coalesce(p_message, ''));
  v_prev text;
begin
  if not public.is_admin() then raise exception 'Admin access required.'; end if;
  if length(v_msg) < 5 or length(v_msg) > 1500 then
    raise exception 'Write what you need clarified (5 to 1,500 characters). The applicant will see this.';
  end if;
  select * into app from public.ambassador_applications where id = p_id for update;
  if not found then raise exception 'Application not found.'; end if;
  if app.status not in ('submitted', 'clarification_requested') then
    raise exception 'Only applications awaiting a decision can be queried.';
  end if;
  v_prev := app.status;

  update public.ambassador_applications set status = 'clarification_requested', updated_at = now() where id = p_id;
  insert into public.ambassador_application_events (application_id, actor_id, actor_role, event, from_status, to_status, message, visible_to_applicant)
  values (p_id, auth.uid(), 'admin', 'clarification_requested', v_prev, 'clarification_requested', v_msg, true);

  insert into public.notifications (user_id, type, title, text)
  values (app.user_id, 'system', 'More information needed',
          'We need a little more information about your Ambassador application ' || app.reference || '. Open the Ambassador page to reply.');
  perform public.audit_log('ambassador_application_clarification', 'ambassador_application', p_id::text,
    jsonb_build_object('status', v_prev), jsonb_build_object('status', 'clarification_requested', 'reference', app.reference), v_msg);
  return jsonb_build_object('status', 'clarification_requested');
end;
$$;

-- ---------------------------------------------------------------------------
-- Admin: private reviewer note (never shown to the applicant)
-- ---------------------------------------------------------------------------
create or replace function public.admin_add_application_note(p_id uuid, p_note text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_note text := btrim(coalesce(p_note, ''));
begin
  if not public.is_admin() then raise exception 'Admin access required.'; end if;
  if length(v_note) < 1 or length(v_note) > 2000 then raise exception 'Enter a note (up to 2,000 characters).'; end if;
  if not exists (select 1 from public.ambassador_applications where id = p_id) then raise exception 'Application not found.'; end if;
  insert into public.ambassador_application_events (application_id, actor_id, actor_role, event, message, visible_to_applicant)
  values (p_id, auth.uid(), 'admin', 'note', v_note, false);
  perform public.audit_log('ambassador_application_note', 'ambassador_application', p_id::text, null, null, 'Private reviewer note added');
end;
$$;

-- ---------------------------------------------------------------------------
-- Admin: approve or decline
--   APPROVE reuses admin_review_ambassador(..., 'approve'): it assigns the permanent Ambassador ID
--   and referral code exactly as it does today. All of it happens in one transaction.
--   DECLINE never creates an ambassador record.
-- ---------------------------------------------------------------------------
create or replace function public.admin_decide_ambassador_application(
  p_id uuid, p_decision text, p_message text default null, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  app public.ambassador_applications;
  amb public.ambassadors;
  s public.ambassador_settings;
  v_prev text;
  v_msg text := nullif(btrim(coalesce(p_message, '')), '');
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_status text;
begin
  if not public.is_admin() then raise exception 'Admin access required.'; end if;
  if p_decision not in ('approve', 'decline') then raise exception 'Unknown decision.'; end if;
  if v_msg is not null and length(v_msg) > 1500 then raise exception 'The message to the applicant is too long.'; end if;
  if v_note is not null and length(v_note) > 2000 then raise exception 'The private note is too long.'; end if;
  if p_decision = 'decline' and v_note is null then
    raise exception 'A reason is required to decline (it is recorded privately in the audit log).';
  end if;

  select * into app from public.ambassador_applications where id = p_id for update;
  if not found then raise exception 'Application not found.'; end if;
  if app.status not in ('submitted', 'clarification_requested') then
    raise exception 'This application has already been decided.';
  end if;
  v_prev := app.status;

  select * into amb from public.ambassadors where user_id = app.user_id for update;

  if p_decision = 'approve' then
    select * into s from public.ambassador_settings where id;
    if not found then raise exception 'Ambassador settings are missing.'; end if;

    if amb.id is null then
      insert into public.ambassadors (user_id, display_name, motivation, commission_rate, photo_path, photo_updated_at)
      values (app.user_id, btrim(left(coalesce(app.display_name, app.full_name), 40)), left(app.motivation, 1000),
              s.default_commission_rate, app.photo_path, case when app.photo_path is null then null else now() end)
      returning * into amb;
    elsif amb.status = 'rejected' then
      update public.ambassadors
         set status = 'applicant', display_name = btrim(left(coalesce(app.display_name, app.full_name), 40)),
             motivation = left(app.motivation, 1000), applied_at = now(), status_changed_at = now(),
             photo_path = coalesce(app.photo_path, photo_path),
             photo_updated_at = case when app.photo_path is not null and app.photo_path is distinct from photo_path then now() else photo_updated_at end
       where id = amb.id returning * into amb;
    elsif amb.status = 'applicant' then
      if amb.photo_path is null and app.photo_path is not null then
        update public.ambassadors set photo_path = app.photo_path, photo_updated_at = now() where id = amb.id returning * into amb;
      end if;
    else
      raise exception 'This person already has an ambassador record (status: %). Manage it from the Ambassadors list.', amb.status;
    end if;

    -- The existing activation process: assigns the permanent ID and referral code once, writes its own audit row.
    perform public.admin_review_ambassador(amb.id, 'approve', v_note);
    select * into amb from public.ambassadors where id = amb.id;
    v_status := 'approved';
  else
    if amb.id is not null and amb.status = 'applicant' then
      perform public.admin_review_ambassador(amb.id, 'reject', v_note);   -- also notifies the applicant
    else
      insert into public.notifications (user_id, type, title, text)
      values (app.user_id, 'system', 'Application not approved',
              'Your Ambassador application ' || app.reference || ' was not approved this time.');
    end if;
    v_status := 'declined';
  end if;

  update public.ambassador_applications
     set status = v_status, decided_at = now(), decided_by = auth.uid(), updated_at = now(),
         ambassador_id = case when p_decision = 'approve' then amb.id else ambassador_id end
   where id = p_id;

  insert into public.ambassador_application_events (application_id, actor_id, actor_role, event, from_status, to_status, message, visible_to_applicant)
  values (p_id, auth.uid(), 'admin', v_status::text, v_prev, v_status, v_msg, true);
  if v_note is not null then
    insert into public.ambassador_application_events (application_id, actor_id, actor_role, event, message, visible_to_applicant)
    values (p_id, auth.uid(), 'admin', 'note', v_note, false);
  end if;

  perform public.audit_log('ambassador_application_' || p_decision, 'ambassador_application', p_id::text,
    jsonb_build_object('status', v_prev),
    jsonb_build_object('status', v_status, 'reference', app.reference, 'ambassador_code', case when p_decision = 'approve' then amb.ambassador_code else null end),
    coalesce(v_note, v_msg));

  return jsonb_build_object('status', v_status, 'ambassador_code', case when p_decision = 'approve' then amb.ambassador_code else null end);
end;
$$;

-- ---------------------------------------------------------------------------
-- Execute permissions
-- ---------------------------------------------------------------------------
revoke execute on function public.submit_ambassador_application(jsonb) from public, anon;
grant execute on function public.submit_ambassador_application(jsonb) to authenticated;
revoke execute on function public.get_my_ambassador_application() from public, anon;
grant execute on function public.get_my_ambassador_application() to authenticated;
revoke execute on function public.respond_to_ambassador_application(text) from public, anon;
grant execute on function public.respond_to_ambassador_application(text) to authenticated;

revoke execute on function public.admin_list_ambassador_applications(text, text, integer, integer) from public, anon;
grant execute on function public.admin_list_ambassador_applications(text, text, integer, integer) to authenticated;
revoke execute on function public.admin_get_ambassador_application(uuid) from public, anon;
grant execute on function public.admin_get_ambassador_application(uuid) to authenticated;
revoke execute on function public.admin_ambassador_application_counts() from public, anon;
grant execute on function public.admin_ambassador_application_counts() to authenticated;
revoke execute on function public.admin_request_application_clarification(uuid, text) from public, anon;
grant execute on function public.admin_request_application_clarification(uuid, text) to authenticated;
revoke execute on function public.admin_add_application_note(uuid, text) from public, anon;
grant execute on function public.admin_add_application_note(uuid, text) to authenticated;
revoke execute on function public.admin_decide_ambassador_application(uuid, text, text, text) from public, anon;
grant execute on function public.admin_decide_ambassador_application(uuid, text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- OPTIONAL HARDENING (management / developer decision; left OFF so nothing existing changes).
-- The website no longer calls the older one-step apply_for_ambassador(text, text, text), but it is still
-- executable by signed-in users, so someone calling it directly would create an 'applicant' record that
-- skips the formal form. It cannot grant any privileges (an admin must still approve it). To close the
-- bypass once you are happy with the new flow, run:
--
--   revoke execute on function public.apply_for_ambassador(text, text, text) from authenticated;
-- ---------------------------------------------------------------------------

-- ============================================================================
-- End of migration.
-- ============================================================================
