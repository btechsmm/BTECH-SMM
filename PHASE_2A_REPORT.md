# BTECH SMM — Phase 2A Report

Scope: audit the existing HTML/CSS/vanilla-JS/Supabase codebase, remove any remaining demo/fake business data, find and fix the actual root cause of the reported service→order problem, and harden price/quantity handling and the admin/wallet flows — without rebuilding, without adding a framework, and without touching M-Pesa or provider integration.

**Environment disclosure (read this first):** this environment has no network access, so I could not connect to `nbiigfncyzfuzciubmru.supabase.co`, run SQL against a live database, or exercise the app in a browser. Everything below is a static-code audit and a source-level fix. The "Tests performed" section is explicit about what was and wasn't actually run.

---

## 1. What was already real (no change needed)

- **Auth** (`js/auth.js`, `js/auth-forms.js`): genuinely uses `supabase.auth` (sign up / sign in / sign out / password reset), not a local mock. Session + profile are cached in memory after `AuthService.init()`.
- **Page guards** (`js/app.js`): `data-requires-auth="true"` pages call `AuthService.requireAuth()`, which checks the real session, not `localStorage`.
- **Profiles, orders, notifications, support tickets, dashboard stats**: already queried live from Supabase (`profiles`, `orders`, `notifications`, `support_tickets`/`support_messages`), correctly scoped to `auth.uid()` by RLS. No hardcoded "Demo User" style data found in these paths.
- **Admin gating**: `js/admin.js` checks `profiles.role === 'admin'` client-side for UX, and the schema's `orders_select_admin` / `profiles_select_admin` RLS policies independently enforce it at the database level — so the frontend check is a UI nicety, not the security boundary. This matches Part 15's requirement.
- **`localStorage`**: the only use found is the dark/light theme toggle (`js/app.js`, `js/navigation.js`). That's an explicitly allowed UI preference, not a source of truth for business data.

## 2. Demo/mock data found, and what I did with it

| Location | What it was | Action |
|---|---|---|
| `js/services.js` | Silently fell back to the bundled `data/demo-data.js` catalogue whenever the Supabase query errored **or returned zero rows** — even while online | **Fixed** — see §3, this is the actual root cause |
| `js/wallet.js` + `wallet.html` | "Deposit Funds" button called `deposit_wallet()` RPC and showed a real (if labeled "demo") balance top-up | **Fixed** — deposits disabled, see §4 |
| `data/demo-data.js` | Still imported by `services.js` (offline fallback) and `support.js`/`index.html` (static FAQ copy) | **Kept**, narrowed — FAQ text isn't "business data," and the service catalogue fallback is now offline-only (see §3) |
| `sw.js` precache list | Precaches `data/demo-data.js` | **Kept** — needed for the legitimate offline-PWA fallback |

No fake users, fake order IDs, fake statistics, or hardcoded prices were found in the live-data code paths (dashboard, orders, admin stats). The demo data that existed was already correctly isolated to `data/demo-data.js`; the problem was that `services.js` reached for it under the wrong conditions, and `wallet.js` had a working (not just cosmetic) simulated top-up.

## 3. The service → order problem — root cause and fix

I traced the full flow end to end instead of guessing:

`services.js` → link `service-order.html?service=${svc.id}` → `orders.js` reads `params.get("service")` → `findService()` → `supabase.rpc("place_order", …)`.

The URL parameter name and the order of operations were **already consistent** — that part was not broken. I found two real defects instead:

**Defect A — the actual "not working" symptom.** `ServicesService.preload()` treated *any* Supabase error, **and also a legitimately empty result set**, as a reason to silently swap in the bundled demo catalogue (`data/demo-data.js`), with no error surfaced anywhere except a `console.warn`. If the live `services` table was empty, unseeded, or briefly unreachable, the customer would see a full, convincing services grid — built entirely from IDs that may not exist in the real database — click "Order Now," fill in the order form (which also renders fine, since it reads from the same in-memory fallback list), and only discover something was wrong when `place_order()` failed at the very last step, because the service ID it received doesn't exist in the actual table. This is the most likely explanation for "service/order functionality is not working correctly": the failure surfaces at checkout, several steps downstream of its real cause.

　*Fix:* `services.js` now only uses the bundled catalogue when `navigator.onLine === false` (a real offline PWA scenario). Any other failure — or a genuinely empty table — now produces `ServicesService.hasError() === true` / an empty list, and `services.html`, `index.html`'s featured section, and `service-order.html` all now render an explicit "Unable to load services" / "No services are currently available" message instead of fabricated data.

**Defect B — a real security hole, not a functional bug, but directly relevant to Part 6/7.** The old `place_order(p_order_id, p_service_id, p_target, p_quantity, p_amount)` Postgres function accepted `p_amount` and never checked `p_quantity` against the service's own `min_quantity`/`max_quantity` in the database — both values came straight from the browser and were trusted. Anyone with devtools open could call `supabase.rpc('place_order', { p_amount: 1, p_quantity: 999999999, ... })` directly and bypass the price and quantity shown in the UI entirely.

　*Fix* (`supabase/migration_phase2a.sql`): `place_order()` no longer accepts `p_amount` at all. It looks up the service row itself, validates `p_quantity` against `min_quantity`/`max_quantity` server-side, and computes the charged amount from the service's own `price_per_1000`/`unit`. The browser's total is now purely a UI preview.

## 4. Wallet / payment status changes (Parts 8 & 11)

The brief is explicit: until M-Pesa exists, orders must not be marked paid or deduct real (or simulated) money, and the deposit button must not simulate a top-up. The previous implementation did both — `place_order()` debited the wallet, and the wallet page's deposit modal actually credited it via `deposit_wallet()`.

Changes made:

- **`orders` table**: added `payment_status text default 'unpaid' check (in ('unpaid','paid'))`. `status` (pending/processing/completed/cancelled) is unchanged and continues to track fulfilment, not payment.
- **`place_order()`**: no longer touches `wallets` or inserts a debit `transactions` row. Every new order is inserted as `status = 'pending', payment_status = 'unpaid'`.
- **`deposit_wallet()`**: now unconditionally raises an exception. This is enforced at the database layer, not just by hiding the button, per Part 15's "don't rely only on frontend JavaScript" principle applied consistently.
- **`wallet.html` / `js/wallet.js`**: the deposit modal is now an informational message ("Real deposits aren't available yet…"); no form, no RPC call.
- **Customer-facing UI**: Orders list, Order Details, and Admin Orders all now show a "Payment" column/badge (Awaiting payment / Paid) alongside the existing status badge, and the order-details page shows an explanatory note while unpaid.
- **Admin revenue stat**: now sums only `payment_status = 'paid'` orders, so it correctly reads **KSh 0** until Phase 5 exists, instead of summing all non-cancelled order amounts (which would have shown revenue for orders nobody had actually paid for — the exact thing Part 20 prohibits).

**You must run `supabase/migration_phase2a.sql` once, after `schema.sql`, for any of this to take effect against your live project.** It's additive/idempotent (`add column if not exists`, `drop function if exists` + `create or replace`) and doesn't touch existing rows other than defaulting the new column.

## 5. Files changed

```
supabase/migration_phase2a.sql   NEW — payment_status column, rewritten place_order(), disabled deposit_wallet()
js/services.js                   fallback logic fixed; hasError()/isOfflineFallback() added; error/empty states
js/orders.js                     place_order RPC call no longer sends p_amount; payment badge + notes added
js/wallet.js                     deposit form/RPC removed, replaced with an inert info panel
js/admin.js                      revenue now sums only paid orders; Payment column added to orders table
wallet.html                      deposit modal rewritten to an informational message; button relabeled
orders.html                      "Payment" column header added
admin.html                       "Payment" column header added
README.md                        status + folder-structure + "what's real vs demo" sections updated
PHASE_2A_REPORT.md               this file
```

Also reorganized the flat upload into the folder structure the codebase's own imports/manifest/service-worker expect (`js/`, `css/`, `data/`, `assets/brand/`, `supabase/`) — the HTML/manifest/`sw.js` all already referenced these paths, so this is a no-op for behavior, just matching layout to what was already assumed.

## 6. Existing schema/tables used (no duplicates created)

`profiles`, `services`, `wallets`, `transactions`, `orders` (+ new `payment_status` column), `notifications`, `support_tickets`, `support_messages`, `providers`, `provider_services`, `payment_attempts`, `site_settings` — all from the existing `schema.sql`. No new tables were introduced; `role` on `profiles` was already the admin mechanism and is reused as-is.

## 7. Security / RLS status

- RLS was already enabled on every table in `schema.sql`, and I did not disable or weaken any policy.
- Confirmed customers can only `select` their own `orders`/`wallets`/`transactions`/`notifications`/`support_tickets` rows; admins get an additional `select`-only policy on `profiles`/`orders` gated by `profiles.role = 'admin'`.
- No service-role key, M-Pesa secret, or provider credential exists anywhere in the frontend source — `js/supabase.js` only holds the public anon/publishable key, which is safe to ship per Supabase's own design (RLS is the boundary, not key secrecy).
- Fixed the price/quantity trust gap described in §3 (Defect B).

## 8. Tests performed vs. not performed

**Actually verified (static code reading):** URL parameter naming through the services → order-form flow; RPC parameter names against the SQL function signatures; RLS policy definitions against every `.from(...)` call in the JS; grep audit for demo/mock/fake/localStorage/sessionStorage across every file; the price/quantity trust gap in `place_order()`.

**NOT run — no network access in this environment:** signup/login/logout against live Supabase Auth, actually placing an order end-to-end, viewing the app in an actual browser at any breakpoint, installing the PWA, or confirming the migration SQL executes cleanly against your project. Please run `schema.sql` then `migration_phase2a.sql` in the Supabase SQL editor, then walk through: register → services → place a small order → confirm it shows "Awaiting payment" in Orders and Order Details → log in as an admin (`update profiles set role='admin' where email=...`) → confirm admin revenue reads KSh 0 → confirm a second test account cannot see the first account's orders.

## 9. Remaining known gaps (unchanged from before this pass, intentionally out of scope)

- Admin "Users" and "Settings" sections are still placeholders (already documented as such in `admin.html`/`README.md`) — Part 17/21 ask for these, but building full user-management and settings CRUD is a larger addition than "fix demo mode + the order bug," so I left the existing honest placeholder text rather than half-building it. Flagging this explicitly rather than silently skipping it.
- Admin "Add Service" / edit-service UI (Part 18) doesn't exist yet — the `services` table and its admin-only RLS policy already support it, but no UI was built for it in this pass, for the same reason.

## 10. Next recommended step

Run both SQL files against the live project, do the manual walkthrough in §8, then confirm before I (or a future session) start Part 17/18 (admin user management + service CRUD UI) — per the brief, M-Pesa/Daraja and provider integration remain explicitly out of scope until you approve this phase.
