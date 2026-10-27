# BTECH CYBER DEFENSE — SQL run order (Supabase SQL Editor)

Nothing here has been run on your production project. Run ONE file at a time, in order. Paste the whole file, press Run, check the result, then go on.
Supabase may warn "destructive query" on 01 (it drops/replaces one policy and one trigger). That is expected; confirm only after reading the file.

| # | File | What it does | Expected result |
|---|------|--------------|-----------------|
| 00 | 00_precheck_readonly.sql | Read-only. Checks tables, the owner account, current profile policies/triggers. | 9+ rows. Row 2 must say "found; email confirmed: true; profile role: admin". **Send me this table before 01.** |
| 01 | 01_phase0_role_protection.sql | Stops customers editing their own `role`. Creates `security_admins` and `is_security_admin()`. | "Success. No rows returned" |
| 02 | 02_phase0_seed_owner.sql | Makes Becamwilunda15@gmail.com (id 362b2bc0-…) a security administrator, only if id, confirmed email and admin role all match. | Exactly 1 row. 0 rows = STOP. |
| 03 | 03_cd_foundation.sql | Tables, scoring, audit trail, screen functions. | Success |
| 04 | 04_cd_catalogue.sql | 12 categories, 45 checks, 8 monitored sources. | Success |
| 05 | 05_cd_initial_state.sql | Starting facts from your evidence (as of 2026-10-25). Edit anything no longer true before running. | Success |
| 06 | 06_cd_collectors.sql | Read-only collectors (admin actions, payments, provider failures, admin accounts, auth log) + automatic DB checks. No triggers on payment/wallet tables. | Success |
| 07 | 07_OPTIONAL_cd_schedule.sql | Runs collectors every 5 min via pg_cron. Skip if pg_cron is not enabled; the "Collect now" button works without it. | Success |
| 08 | 08_verify_readonly.sql | Read-only. Run BEFORE 09 (it counts the tables/functions that exist up to step 06). | 17 rows, all status OK. **Send me this table.** |
| 09 | 09_cd_detection.sql | NEW (phase 3). 13 detection rules and automatic incidents, incident review (status, notes), rule tuning. Adds 2 tables, 6 functions. Does not touch payments, wallets, providers or any existing grants/RLS. | Success |
| 10 | 10_verify_detection_readonly.sql | Read-only. First open the screen, go to Sources and press "Collect now" once (runs the rules), then run it. | 12 rows, all OK. **Send me this table.** |

## Stop conditions
- Any error: stop, copy the red message to me, do not run the next file.
- 00 row 2 says NOT FOUND, or 02 returns 0 rows: stop.
- 08 shows any CHECK row: send it to me.

## Rollback
- 99_rollback_cyber_defense.sql removes all Cyber Defense tables/functions/data (steps 03-06). Phase 0 stays. If you ran 07, unschedule first (command in the file).
- 99_rollback_detection.sql removes only step 09 (rules, notes, detection functions) and restores the earlier collection function.
- 99_EMERGENCY_rollback_phase0.sql restores the ORIGINAL vulnerable role policy. Use only if Phase 0 breaks the site.

## Not SQL
The screen itself (admin.html, js/cyber-defense.js, css/cyber-defense.css, js/admin.js, sw.js; use the NEW zip for phase 3, it adds the Incidents review and Rules tab) is deployed separately through your repo. The panel stays hidden unless the server confirms you are a security administrator.

## What to expect after 09
The first "Collect now" re-reads the last 7 days, so a few incidents may open straight away from real history (for example the legacy mpesa-daraja test payments, or payments flagged for review). That is the rules working; review each, then close it with a note. Sign-in FAILURES are not covered: Supabase does not record them in the table we read, so a failed-login rule would be dishonest.

## Honest limits
Scores start "poor / provisional": many checks are unverified or need your evidence. Tamper-evident audit trail, not tamper-proof. Free-plan limits (SMTP, leaked-password protection, short log retention) are reported, not fixed, by this.
