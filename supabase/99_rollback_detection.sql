-- 99 ROLLBACK of step 09 only (detection rules + incident review). Steps 03-06 and Phase 0 stay. Incidents already opened stay; extra columns are dropped.
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
  return v;
end;
$$;
revoke all on function public.security_collect_all() from public, anon, authenticated, service_role;
grant execute on function public.security_collect_all() to service_role;
drop function if exists public.security_set_rule(text,boolean,integer,integer,text);
drop function if exists public.security_add_incident_note(uuid,text);
drop function if exists public.security_set_incident_status(uuid,text,text);
drop function if exists public.security_run_detection();
drop function if exists public.security_raise_incident(public.security_rules,text,text,text,text,integer,timestamptz,timestamptz,bigint[]);
drop function if exists public.security_sev_rank(text);
drop table if exists public.security_incident_notes;
drop table if exists public.security_rules;
drop index if exists public.security_incidents_open_dedupe;
drop index if exists public.security_incidents_dedupe_any;
alter table public.security_incidents
  drop column if exists rule_key, drop column if exists dedupe_key, drop column if exists event_count,
  drop column if exists first_event_at, drop column if exists last_event_at, drop column if exists recommendation,
  drop column if exists evidence_level;
