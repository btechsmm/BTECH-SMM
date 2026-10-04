# BTECH SMM

Social Media Marketing & Digital Growth — a platform for creators, brands and businesses to plan, order and track social-media growth campaigns.

Built by **BTECH Studios**.

## Project status

- **Phase 1 — Foundation**: complete. Responsive, installable HTML/CSS/vanilla-JS frontend.
- **Phase 2A — Real Supabase app + price/quantity security + admin data**: complete (see `PHASE_2A_REPORT.md` for the full audit and what changed).
- **Phase 5 — M-Pesa Daraja**: implemented. Wallet deposits and order payments go through the `mpesa-daraja` Edge Function (STK Push, Safaricom callback, polling). `js/payment.js` (the old `DemoPaymentProvider` interface) is no longer used — wallet.js/orders.js call the Edge Function directly, the same pattern as `delix-provider`.
- **Phase 6 — External provider APIs**: not started. Orders are stored but not auto-submitted to any fulfilment provider yet.

**Important:** the Supabase wiring in this codebase has not been tested against a live database (this environment cannot reach supabase.co — network access is disabled). You must run `supabase/schema.sql` **and then** `supabase/migration_phase2a.sql`, and test the signup → dashboard → order → wallet flow yourself, before relying on it. See `PHASE_2A_REPORT.md`.

## Technology

- HTML5, CSS3, vanilla JavaScript (ES6 modules) — no framework, no build step
- **Supabase** (Postgres + Auth) via `@supabase/supabase-js`, loaded from a CDN as an ESM URL import — no npm install needed
- PWA: Web App Manifest + Service Worker (installable, offline app-shell fallback)
- Google Fonts (Inter) loaded via `<link>`

No React, Vue, Angular, TypeScript, Tailwind, or any other framework is used, per the project brief.

## One-time setup: run the database schema

Before the app will work, run **`supabase/schema.sql`** once, in full, in your Supabase project's SQL Editor (Project → SQL Editor → New query → paste → Run):

- Project: `https://nbiigfncyzfuzciubmru.supabase.co`

This creates every table (`profiles`, `services`, `wallets`, `transactions`, `orders`, `notifications`, `support_tickets`, `support_messages`, `providers`, `provider_services`, `payment_attempts`, `site_settings`), the Row Level Security policies that scope each user to their own data, a trigger that auto-creates a profile + wallet + welcome notification the moment someone signs up, two RPC functions (`place_order`, `deposit_wallet`) that keep order placement and wallet top-ups atomic, and seeds the 16-service demo catalogue.

It's safe to re-run — every statement uses `if not exists` / `or replace` / `drop … if exists`.

**Check your Auth settings.** By default Supabase requires email confirmation before a session is issued. The app handles both cases (it shows "check your email" if confirmation is required), but if you want instant login during testing, you can turn confirmation off under Authentication → Providers → Email in the Supabase dashboard.

**To make your own account an admin** (required to see `admin.html`), sign up in the app once, then run in the SQL Editor:

```sql
update public.profiles set role = 'admin' where email = 'you@example.com';
```

## Folder structure

```
btech-smm/
├── index.html, login.html, register.html, forgot-password.html, reset-password.html
├── services.html, service-order.html
├── dashboard.html, orders.html, order-details.html, wallet.html, profile.html
├── support.html, admin.html
├── terms.html, privacy.html, offline.html
├── manifest.json, sw.js, robots.txt, sitemap.xml
├── supabase/
│   ├── schema.sql              # full DB schema, RLS policies, triggers, RPCs, seed data — run first
│   └── migration_phase2a.sql   # Phase 2A: server-side price/quantity checks, unpaid orders, disables deposit_wallet() — run second
├── assets/brand/          # logo, favicon, PWA icons
├── css/                   # style.css, components.css, dashboard.css, responsive.css
├── js/
│   ├── app.js              # bootstraps every page — awaits auth + services before rendering
│   ├── navigation.js        # header/footer/mobile nav/bottom nav/notification bell
│   ├── auth.js              # Supabase Auth wrapper + in-memory session/profile cache
│   ├── auth-forms.js         # wires login/register/forgot/reset forms to auth.js
│   ├── supabase.js          # Supabase client config (project URL + public anon key)
│   ├── utils.js             # formatting, validation, toast, loading-state helpers
│   ├── services.js          # live services catalogue (Supabase, with offline fallback)
│   ├── orders.js            # order form + place_order() RPC, list, detail view
│   ├── wallet.js            # wallet balance, transactions, deposit_wallet() RPC
│   ├── dashboard.js         # dashboard stats + recent orders
│   ├── profile.js           # profile read/update
│   ├── admin.js             # admin overview — requires profiles.role = 'admin'
│   ├── support.js           # FAQ (static) + support tickets (Supabase)
│   ├── notifications.js     # notification bell, backed by `notifications` table
│   └── payment.js           # PaymentService interface + DemoPaymentProvider (Phase 5 will add MpesaDarajaProvider here)
└── data/
    └── demo-data.js    # FAQ copy + offline-fallback service catalogue only
```

## How to run locally

Pages use ES6 modules and a service worker, so they must be served over HTTP:

```bash
python3 -m http.server 8080
# then open http://localhost:8080
```

## What's real now vs. still demo

- **Accounts**: real Supabase Auth (email/password). Session persists via Supabase's own storage; `js/auth.js` caches the session + profile in memory after `AuthService.init()` so pages can check "is someone logged in" synchronously.
- **Orders, wallet, notifications, support tickets**: real rows in Supabase, scoped per-user by RLS — not just this browser anymore.
- **Wallet balance**: real, and currently always KSh 0 for new accounts, with no way to add funds — `deposit_wallet()` rejects every call until Phase 5 wires up a real, server-verified M-Pesa path. Orders no longer debit the wallet either; every new order is created with `payment_status = 'unpaid'` and is not charged for anything.
- **Admin dashboard**: reads real cross-user data, gated by `profiles.role = 'admin'`.

Nothing in this phase stores passwords in application code, secret keys, or real payment credentials. The key in `js/supabase.js` is the public "publishable" anon key — safe to ship in frontend code, with RLS (not secrecy) as the actual access-control boundary.

## Installing as a PWA

Once served over HTTP(S), most browsers offer an "Install app" prompt. The offline page (`offline.html`) appears if a navigation fails without a connection — note that account/order/wallet actions still require connectivity now that they hit Supabase.

## Future integration phases

- **Phase 5 — M-Pesa Daraja**: `js/payment.js` defines the `PaymentService` interface (`initiatePayment`, `verifyPayment`, `getPaymentStatus`). A future `MpesaDarajaProvider` will implement it via STK Push → Daraja → a trusted server/edge function → `payment_attempts` table → wallet credit, replacing the current `DemoPaymentProvider`. No M-Pesa credentials exist anywhere in this codebase yet.
- **Phase 6 — External provider APIs**: `providers` and `provider_services` tables already exist in the schema. A future edge function or scheduled job will read newly-paid orders and submit them to the mapped provider, updating `orders.status`/`progress` as it goes.

## Brand assets

The BTECH SMM logo and favicon were flattened JPEGs with a checkerboard pattern baked into the pixels (not real alpha transparency). They were reprocessed into true transparent PNGs and a full icon set (16–512px, plus a maskable icon with navy safe-zone padding) without altering the artwork — see `assets/brand/`.