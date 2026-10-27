-- 10 VERIFY DETECTION (READ-ONLY). Run after 09. FIRST open the Cyber Defense screen -> Sources -> "Collect now"
-- (that runs the rules once); otherwise row 6 will say CHECK. Send me the table.
select * from (
  select 1 as n, 'security tables with row-level security (13 earlier + rules + notes)' as check_item, '15' as expected,
         (select count(*) from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and c.relname like 'security\_%' and c.relrowsecurity)::text as actual
  union all select 2, 'security tables WITHOUT row-level security', '0',
         (select count(*) from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and c.relname like 'security\_%' and not c.relrowsecurity)::text
  union all select 3, 'security tables the anonymous role can touch', '0',
         (select count(*) from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and c.relname like 'security\_%' and has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'))::text
  union all select 4, 'security tables logged-in users can WRITE', '0',
         (select count(*) from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and c.relname like 'security\_%' and has_table_privilege('authenticated', c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE'))::text
  union all select 5, 'security functions callable by the anonymous role', '0',
         (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'security\_%' and has_function_privilege('anon', p.oid, 'EXECUTE'))::text
  union all select 6, 'detection rules that have run at least once', '13',
         (select count(*) from public.security_rules where last_run_at is not null)::text
  union all select 7, 'detection rules defined', '13', (select count(*) from public.security_rules)::text
  union all select 8, 'security functions callable by logged-in users (screen functions)', '12',
         (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'security\_%' and has_function_privilege('authenticated', p.oid, 'EXECUTE'))::text
  union all select 9, 'detection functions without a fixed search_path', '0',
         (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace
            and p.proname in ('security_run_detection','security_raise_incident','security_set_incident_status','security_add_incident_note','security_set_rule','security_sev_rank')
            and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%'))::text
  union all select 10, 'duplicate open incidents for the same rule+subject', '0',
         (select count(*) from (select dedupe_key from public.security_incidents where dedupe_key is not null and status in ('open','investigating','contained') group by 1 having count(*) > 1) d)::text
  union all select 11, 'audit trail hash chain intact', 'true', (public.security_audit_chain_check() ->> 'intact')
  union all select 12, 'recommendation mode set', '"recommendation"', (select value::text from public.security_settings where key = 'mode')
) v
cross join lateral (select case when v.actual = v.expected then 'OK' else 'CHECK' end as status) s
order by v.n;
