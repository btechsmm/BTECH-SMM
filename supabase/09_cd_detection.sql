-- ============================================================================
-- BTECH CYBER DEFENSE — 005 detection rules and incidents (PROPOSED, NOT APPLIED)
-- Run after 004 (file 06 in the release bundle).
--
-- What this adds
--   * security_rules: deterministic, tunable detection rules (threshold + time window over collected events).
--   * Automatic incidents: when a rule matches, ONE incident per rule+subject is opened and kept up to date
--     while it is open. Nothing is closed automatically. Humans review (recommendation mode).
--   * Incident review: status changes and notes, written only through audited server functions.
--   * Two "system" rules: broken audit-trail chain, and a data source in error.
--   * security_collect_all() now ends with the detection run.
--
-- Safety properties
--   * No change to payments, wallets, providers, RLS of existing tables, or any grants on existing tables.
--   * New tables: RLS on, select for security admins only, no API write privileges.
--   * All new functions: fixed search_path, EXECUTE revoked from everyone then granted explicitly.
--   * A resolved or false-positive incident is not re-opened by the same old events (only by newer ones).
-- ============================================================================

do $$
begin
  if to_regprocedure('public.security_collect_all()') is null then
    raise exception 'Apply the collectors file (004 / bundle file 06) first.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1) Incident columns
-- ---------------------------------------------------------------------------
alter table public.security_incidents
  add column if not exists rule_key       text,
  add column if not exists dedupe_key     text,
  add column if not exists event_count    integer not null default 0,
  add column if not exists first_event_at timestamptz,
  add column if not exists last_event_at  timestamptz,
  add column if not exists recommendation text,
  add column if not exists evidence_level text not null default 'verified'
    check (evidence_level in ('verified','potential','unverified'));

create unique index if not exists security_incidents_open_dedupe
  on public.security_incidents (dedupe_key)
  where dedupe_key is not null and status in ('open','investigating','contained');
create index if not exists security_incidents_dedupe_any on public.security_incidents (dedupe_key);

create table if not exists public.security_incident_notes (
  id          bigint generated always as identity primary key,
  incident_id uuid not null references public.security_incidents(id) on delete cascade,
  at          timestamptz not null default now(),
  actor_id    uuid,
  kind        text not null check (kind in ('opened','events','status','note')),
  body        text not null check (length(body) between 1 and 1000)
);
create index if not exists security_incident_notes_inc on public.security_incident_notes (incident_id, at);

-- ---------------------------------------------------------------------------
-- 2) Rules
-- ---------------------------------------------------------------------------
create table if not exists public.security_rules (
  key              text primary key check (key ~ '^[a-z0-9._-]{3,48}$'),
  kind             text not null default 'event' check (kind in ('event','system')),
  title            text not null check (length(title) between 3 and 160),
  description      text,
  source           text,                       -- event source filter (null = any)
  event_like       text,                       -- SQL LIKE pattern on event_type (event rules)
  min_severity     text not null default 'info' check (min_severity in ('info','low','medium','high','critical')),
  window_minutes   integer not null default 1440 check (window_minutes between 1 and 10080),
  threshold        integer not null default 1 check (threshold between 1 and 10000),
  group_by         text not null default 'none' check (group_by in ('none','actor','subject')),
  severity         text not null check (severity in ('low','medium','high','critical')),
  use_event_severity boolean not null default false,   -- incident severity = highest matched event severity (never below `severity`... see run)
  evidence_level   text not null default 'verified' check (evidence_level in ('verified','potential','unverified')),
  recommendation   text,
  enabled          boolean not null default true,
  last_run_at      timestamptz,
  last_matches     integer,
  updated_at       timestamptz not null default now(),
  constraint security_rules_event_needs_pattern check (kind = 'system' or event_like is not null)
);

do $$
declare t text;
begin
  foreach t in array array['security_rules','security_incident_notes'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('drop policy if exists %I on public.%I', t || '_sel', t);
    execute format('create policy %I on public.%I for select to authenticated using ((select public.is_security_admin()))', t || '_sel', t);
  end loop;
end $$;

insert into public.security_rules
  (key, kind, title, description, source, event_like, min_severity, window_minutes, threshold, group_by, severity, use_event_severity, evidence_level, recommendation)
values
  ('admin.unapproved_account', 'event', 'Admin account outside the approved list',
   'A profile has role=admin but is not in the owner-approved administrator list.',
   'supabase_auth', 'admin.unapproved', 'info', 1440, 1, 'actor', 'critical', false, 'verified',
   'Confirm with the owner whether this person should be an administrator. If not, remove the admin role at once, review that account''s recent admin actions, and check how the role was granted.'),
  ('pay.amount_mismatch', 'event', 'Paid amount differs from the amount requested',
   'A payment''s verified amount is not equal to its requested amount.',
   'payments', 'payment.amount_mismatch', 'info', 10080, 1, 'subject', 'high', false, 'verified',
   'Hold any credit or delivery for this payment, compare it with the provider statement, and correct or refund it manually.'),
  ('pay.paid_without_receipt', 'event', 'Wallet deposit marked paid without a receipt number',
   'A wallet deposit is paid but has no M-Pesa receipt number recorded.',
   'payments', 'payment.paid_without_receipt', 'info', 10080, 1, 'subject', 'medium', false, 'verified',
   'Look the payment up on the provider dashboard. If no matching receipt exists, reverse the credit.'),
  ('pay.needs_review', 'event', 'Payment flagged for review',
   'A payment was flagged needs_review by the payment functions.',
   'payments', 'payment.needs_review', 'info', 10080, 1, 'subject', 'medium', false, 'verified',
   'Review the payment against the provider record and clear the flag once checked.'),
  ('pay.legacy_flow_used', 'event', 'Legacy payment flow still in use',
   'A payment went through the retired mpesa-daraja path instead of TUMA.',
   'payments', 'payment.legacy_flow.%', 'info', 1440, 1, 'none', 'medium', false, 'verified',
   'Confirm it was owner/team testing. If so, shut the legacy function down so it cannot be used by anyone else.'),
  ('pay.stuck_open', 'event', 'Payments left open for more than 30 minutes',
   'The daily summary found payments still pending or processing after 30 minutes.',
   'payments', 'payment.stuck_summary', 'info', 1440, 1, 'none', 'low', false, 'verified',
   'Check each open payment on the provider side and close or reconcile it.'),
  ('provider.failure_spike', 'event', 'Burst of provider failures',
   'Many provider (Delix) calls failed within a short window.',
   'provider_delix', 'provider.failure', 'info', 15, 10, 'none', 'high', false, 'verified',
   'Check the provider dashboard and balance, then the Edge Function logs. Pause new orders if the provider is down.'),
  ('auth.admin_new_ip', 'event', 'Administrator signed in from a new network',
   'An admin account logged in from an IP not seen before for that account (IPs are stored hashed).',
   'supabase_auth', 'auth.admin_login_new_ip', 'info', 1440, 1, 'actor', 'medium', false, 'verified',
   'Ask the administrator to confirm. If it was not them, change their password, sign out all sessions and review their actions.'),
  ('admin.sensitive_action', 'event', 'Sensitive administrator action',
   'An admin action touching roles, permissions or privileges was logged.',
   'app_admin', 'admin.%', 'medium', 1440, 1, 'actor', 'medium', false, 'verified',
   'Confirm the action was intended and by the right person.'),
  ('admin.action_burst', 'event', 'Unusually many administrator actions',
   'One admin account performed many actions in a short time. Threshold is a starting guess: tune it.',
   'app_admin', 'admin.%', 'info', 10, 50, 'actor', 'medium', false, 'potential',
   'Confirm the admin was doing bulk work. If not, treat the account as possibly compromised.'),
  ('check.regressed', 'event', 'A security check got worse',
   'An automatic configuration check changed to a worse result.',
   'supabase_postgres', 'check.regressed', 'info', 1440, 1, 'subject', 'medium', true, 'verified',
   'Open the Checks tab for the evidence text and undo the change that caused it, or approve it knowingly.'),
  ('sys.audit_chain_broken', 'system', 'Audit trail hash chain is broken',
   'A row in the security audit trail does not match its hash chain. The trail is tamper-evident, so this needs a look.',
   null, null, 'info', 1, 1, 'none', 'critical', false, 'verified',
   'Press "Verify audit chain" on the Audit trail tab, note the broken row numbers, and investigate who had database owner access.'),
  ('sys.source_error', 'system', 'A data source is failing',
   'A collector reported an error, so that source is not being monitored.',
   null, null, 'info', 1, 1, 'subject', 'medium', false, 'verified',
   'Open the Sources tab, read the error, and fix the cause (missing table, permission, or platform change).')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 3) Detection engine (internal; runs at the end of every collection)
-- ---------------------------------------------------------------------------
create or replace function public.security_sev_rank(p text)
returns integer language sql immutable set search_path = public, pg_temp as $$
  select case p when 'critical' then 5 when 'high' then 4 when 'medium' then 3 when 'low' then 2 when 'info' then 1 else 0 end
$$;

-- Open or refresh one incident. Returns 1 if opened, 0 if an existing open one was refreshed/unchanged.
create or replace function public.security_raise_incident(
  p_rule public.security_rules, p_gk text, p_title text, p_summary text, p_severity text,
  p_count integer, p_first timestamptz, p_last timestamptz, p_event_ids bigint[])
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare v_key text := p_rule.key || ':' || p_gk; v_inc public.security_incidents; v_id uuid;
begin
  select * into v_inc from public.security_incidents
   where dedupe_key = v_key and status in ('open','investigating','contained');
  if found then
    if p_count is distinct from v_inc.event_count or public.security_sev_rank(p_severity) > public.security_sev_rank(v_inc.severity) then
      update public.security_incidents
         set event_count = greatest(p_count, v_inc.event_count),
             last_event_at = greatest(p_last, coalesce(last_event_at, p_last)),
             severity = case when public.security_sev_rank(p_severity) > public.security_sev_rank(severity) then p_severity else severity end,
             related_event_ids = (select coalesce(array_agg(x order by x desc), '{}') from (
                                   select distinct x from unnest(related_event_ids || coalesce(p_event_ids, '{}')) x order by x desc limit 50) q),
             updated_at = now()
       where id = v_inc.id;
      if p_count > v_inc.event_count then
        insert into public.security_incident_notes (incident_id, kind, body)
        values (v_inc.id, 'events', format('%s more matching event(s); total now %s.', p_count - v_inc.event_count, p_count));
      end if;
    end if;
    return 0;
  end if;

  insert into public.security_incidents (title, severity, status, summary, related_event_ids, rule_key, dedupe_key,
                                         event_count, first_event_at, last_event_at, recommendation, evidence_level, opened_at, updated_at)
  values (left(p_title, 200), p_severity, 'open', left(p_summary, 1000), coalesce(p_event_ids, '{}'), p_rule.key, v_key,
          coalesce(p_count, 0), p_first, p_last, p_rule.recommendation, p_rule.evidence_level, now(), now())
  returning id into v_id;
  insert into public.security_incident_notes (incident_id, kind, body)
  values (v_id, 'opened', 'Opened automatically by rule ' || p_rule.key || '.');
  perform public.security_audit('incident.opened', 'security_incidents', v_id::text,
    jsonb_build_object('rule', p_rule.key, 'severity', p_severity, 'events', p_count));
  return 1;
end;
$$;

create or replace function public.security_run_detection()
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r public.security_rules; g record; v_opened integer := 0; v_matches integer; v_errors jsonb := '{}'::jsonb;
  v_sev text; v_title text; v_gk_label text;
begin
  for r in select * from public.security_rules where enabled order by key loop
    v_matches := 0;
    begin
      if r.kind = 'event' then
        for g in
          with ev as (
            select e.id, e.occurred_at, e.severity,
                   case r.group_by when 'actor' then coalesce(e.actor_id::text, '-')
                                   when 'subject' then coalesce(e.subject_id, '-') else '-' end as gk
              from public.security_events e
             where e.occurred_at > now() - make_interval(mins => r.window_minutes)
               and (r.source is null or e.source = r.source)
               and e.event_type like r.event_like
               and public.security_sev_rank(e.severity) >= public.security_sev_rank(r.min_severity)),
          cut as (
            select d.gk, (select max(coalesce(i.resolved_at, i.updated_at)) from public.security_incidents i
                           where i.dedupe_key = r.key || ':' || d.gk and i.status in ('resolved','false_positive')) as cutoff
              from (select distinct gk from ev) d)
          select ev.gk, count(*)::integer as n, min(ev.occurred_at) as first_at, max(ev.occurred_at) as last_at,
                 (array_agg(ev.id order by ev.occurred_at desc))[1:25] as ids,
                 max(public.security_sev_rank(ev.severity)) as top_rank
            from ev join cut using (gk)
           where ev.occurred_at > coalesce(cut.cutoff, '-infinity'::timestamptz)
           group by ev.gk
          having count(*) >= r.threshold
        loop
          v_matches := v_matches + 1;
          v_sev := r.severity;
          if r.use_event_severity then
            v_sev := (array['info','low','medium','high','critical'])[g.top_rank];
            if public.security_sev_rank(v_sev) < public.security_sev_rank('low') then v_sev := 'low'; end if;
          end if;
          v_gk_label := case r.group_by when 'none' then '' when 'actor' then ' (account ' || left(g.gk, 8) || ')'
                                         else ' (' || left(g.gk, 40) || ')' end;
          v_title := r.title || v_gk_label;
          v_opened := v_opened + public.security_raise_incident(r, g.gk, v_title,
            format('%s matching event(s) in the last %s minute(s). %s', g.n, r.window_minutes, coalesce(r.description, '')),
            v_sev, g.n, g.first_at, g.last_at, g.ids);
        end loop;

      elsif r.key = 'sys.audit_chain_broken' then
        if not coalesce((public.security_audit_chain_check() ->> 'intact')::boolean, true) then
          v_matches := 1;
          v_opened := v_opened + public.security_raise_incident(r, '-', r.title, coalesce(r.description, ''), r.severity,
                        1, now(), now(), '{}');
        end if;

      elsif r.key = 'sys.source_error' then
        for g in select s.source, s.label, s.detail from public.security_source_status s where s.status = 'error' loop
          v_matches := v_matches + 1;
          v_opened := v_opened + public.security_raise_incident(r, g.source, r.title || ' (' || g.label || ')',
                        left(coalesce(g.detail, ''), 500), r.severity, 1, now(), now(), '{}');
        end loop;
      end if;
    exception when others then
      v_errors := v_errors || jsonb_build_object(r.key, sqlerrm);
    end;
    update public.security_rules set last_run_at = now(), last_matches = v_matches where key = r.key;
  end loop;
  return jsonb_build_object('incidents_opened', v_opened, 'rule_errors', v_errors);
end;
$$;

-- Collection now ends with detection.
create or replace function public.security_collect_all()
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v jsonb := '{}'::jsonb;
begin
  if not pg_try_advisory_xact_lock(hashtext('btech.security_collect')) then
    return jsonb_build_object('skipped', 'another collection run is in progress');
  end if;
  v := v || jsonb_build_object('admin_actions',  public.security_collect_admin_actions());
  v := v || jsonb_build_object('payments',       public.security_collect_payments());
  v := v || jsonb_build_object('provider_logs',  public.security_collect_provider_logs());
  v := v || jsonb_build_object('admin_accounts', public.security_collect_admin_accounts());
  v := v || jsonb_build_object('auth_audit',     public.security_collect_auth_audit());
  v := v || jsonb_build_object('db_checks',      public.security_run_db_checks());
  v := v || jsonb_build_object('detection',      public.security_run_detection());
  return v;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4) Review functions for security administrators
-- ---------------------------------------------------------------------------
create or replace function public.security_set_incident_status(p_id uuid, p_status text, p_note text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_old text;
begin
  perform public.security_assert_admin();
  if p_status not in ('open','investigating','contained','resolved','false_positive') then
    raise exception 'Invalid status.' using errcode = '22023';
  end if;
  if p_note is null or length(btrim(p_note)) < 5 then
    raise exception 'A note (at least 5 characters) is required.' using errcode = '22023';
  end if;
  select status into v_old from public.security_incidents where id = p_id for update;
  if not found then raise exception 'Unknown incident.' using errcode = '22023'; end if;
  if v_old = p_status then raise exception 'Incident is already %.', p_status using errcode = '22023'; end if;
  update public.security_incidents
     set status = p_status,
         resolved_at = case when p_status in ('resolved','false_positive') then now() else null end,
         assigned_to = coalesce(assigned_to, auth.uid()),
         updated_at = now()
   where id = p_id;
  insert into public.security_incident_notes (incident_id, actor_id, kind, body)
  values (p_id, auth.uid(), 'status', left(v_old || ' -> ' || p_status || ': ' || btrim(p_note), 1000));
  perform public.security_audit('incident.status', 'security_incidents', p_id::text,
    jsonb_build_object('from', v_old, 'to', p_status));
end;
$$;

create or replace function public.security_add_incident_note(p_id uuid, p_note text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public.security_assert_admin();
  if p_note is null or length(btrim(p_note)) < 3 then
    raise exception 'A note (at least 3 characters) is required.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.security_incidents where id = p_id) then
    raise exception 'Unknown incident.' using errcode = '22023';
  end if;
  insert into public.security_incident_notes (incident_id, actor_id, kind, body)
  values (p_id, auth.uid(), 'note', left(btrim(p_note), 1000));
  perform public.security_audit('incident.note', 'security_incidents', p_id::text, '{}'::jsonb);
end;
$$;

create or replace function public.security_set_rule(
  p_key text, p_enabled boolean, p_threshold integer, p_window_minutes integer, p_reason text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_old public.security_rules;
begin
  perform public.security_assert_admin();
  if p_reason is null or length(btrim(p_reason)) < 5 then
    raise exception 'A reason (at least 5 characters) is required.' using errcode = '22023';
  end if;
  select * into v_old from public.security_rules where key = p_key;
  if not found then raise exception 'Unknown rule.' using errcode = '22023'; end if;
  if p_threshold is not null and p_threshold not between 1 and 10000 then raise exception 'Threshold out of range.' using errcode = '22023'; end if;
  if p_window_minutes is not null and p_window_minutes not between 1 and 10080 then raise exception 'Window out of range.' using errcode = '22023'; end if;
  update public.security_rules
     set enabled = coalesce(p_enabled, enabled),
         threshold = coalesce(p_threshold, threshold),
         window_minutes = coalesce(p_window_minutes, window_minutes),
         updated_at = now()
   where key = p_key;
  perform public.security_audit('rule.changed', 'security_rules', p_key,
    jsonb_build_object('enabled', jsonb_build_array(v_old.enabled, coalesce(p_enabled, v_old.enabled)),
                       'threshold', jsonb_build_array(v_old.threshold, coalesce(p_threshold, v_old.threshold)),
                       'window_minutes', jsonb_build_array(v_old.window_minutes, coalesce(p_window_minutes, v_old.window_minutes)),
                       'reason', left(btrim(p_reason), 300)));
end;
$$;

-- ---------------------------------------------------------------------------
-- 5) EXECUTE grants
-- ---------------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array[
    'security_sev_rank(text)', 'security_raise_incident(public.security_rules,text,text,text,text,integer,timestamptz,timestamptz,bigint[])',
    'security_run_detection()', 'security_collect_all()',
    'security_set_incident_status(uuid,text,text)', 'security_add_incident_note(uuid,text)',
    'security_set_rule(text,boolean,integer,integer,text)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated, service_role', f);
  end loop;
end $$;
grant execute on function public.security_set_incident_status(uuid,text,text)           to authenticated;
grant execute on function public.security_add_incident_note(uuid,text)                  to authenticated;
grant execute on function public.security_set_rule(text,boolean,integer,integer,text)   to authenticated;
grant execute on function public.security_collect_all()                                 to service_role;

select public.security_audit('install.detection', 'security_*', '005', jsonb_build_object('rules', (select count(*) from public.security_rules)));
