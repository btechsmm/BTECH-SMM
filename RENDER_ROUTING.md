# BTECH SMM — Clean URLs on Render (deployment steps)

**Do these in the Render Dashboard BEFORE (or at the same time as) deploying the code.**
The site is plain static files, so the server must be told that `/login` means `login.html`.
Without the rules below, `/login`, `/dashboard`, etc. return **404**.

## How Render resolves a request (from Render's docs)
1. If a file exists at the requested path, Render serves it. Rules are **skipped**.
2. Otherwise Render applies the **first matching** redirect/rewrite rule (top to bottom).
3. Otherwise 404.

Consequences:
- `/login` has no file, so a **Rewrite** `/login -> /login.html` serves the page and the address bar stays `/login`.
- `/` is served from `index.html` natively. Rules cannot be applied to the domain root, and none are needed.
- `/login.html` **is a real file**, so Render will never apply a redirect to it. Old `.html` links keep working,
  and `js/shell.js` (`cleanAddressBar()`) switches the address bar to the clean URL in place.

## 1. Add these rules
Dashboard -> your static site -> **Redirects/Rewrites** -> add each as **Action = Rewrite**.
Order does not matter (no rule overlaps another). Do not add a `/*` catch-all, so unknown URLs still 404 correctly.

| Source | Destination |
|---|---|
| `/admin` | `/admin.html` |
| `/ambassador` | `/ambassador.html` |
| `/dashboard` | `/dashboard.html` |
| `/forgot-password` | `/forgot-password.html` |
| `/insights` | `/insights.html` |
| `/login` | `/login.html` |
| `/loyalty` | `/loyalty.html` |
| `/order-details` | `/order-details.html` |
| `/orders` | `/orders.html` |
| `/privacy` | `/privacy.html` |
| `/profile` | `/profile.html` |
| `/register` | `/register.html` |
| `/reset-password` | `/reset-password.html` |
| `/service-order` | `/service-order.html` |
| `/services` | `/services.html` |
| `/support` | `/support.html` |
| `/terms` | `/terms.html` |
| `/verify-ambassador` | `/verify-ambassador.html` |
| `/wallet` | `/wallet.html` |

`offline.html` is intentionally excluded: the service worker serves it by its real file name.

(Blueprint equivalent, only if you manage this service with a `render.yaml`: one
`- type: rewrite` / `source: /login` / `destination: /login.html` entry per row under `routes:`.
Do not add a `render.yaml` to an existing dashboard-created service just for this.)

## 2. Supabase (not changed by this task)
Password-reset emails still use `.../reset-password.html` as `redirectTo` (see `js/auth.js`), so nothing breaks today.
Optional follow-up: add `https://btechsmm.store/reset-password` to Supabase -> Authentication -> URL Configuration ->
Redirect URLs, then change that one string in `js/auth.js` to `"reset-password"`.

## 3. After deploy, test on the live site
- Open each of: `/`, `/login`, `/register`, `/dashboard`, `/services`, `/orders`, `/wallet`, `/profile`, `/admin`,
  `/loyalty`, `/ambassador`, `/support`, `/terms`, `/privacy`, `/insights` directly, then refresh, back and forward.
- Open `/login.html` and `/dashboard.html`: the address bar should become `/login` and `/dashboard`.
- Log in, log out, open `/dashboard` while logged out (should go to `/login`).
- Hard-refresh once (or close/reopen the installed PWA) so service worker `btechsmm-v17` replaces v16.
