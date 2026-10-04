/**
 * BTECH SMM — Service Worker
 * ----------------------------------------------------------------
 * Provides basic offline support: precaches the app shell (core
 * pages, styles, scripts, brand assets) and falls back to
 * offline.html for navigations that fail while offline.
 *
 * IMPORTANT: this does NOT make orders, payments or wallet actions
 * work offline — those still require a network connection once
 * they are backed by a real server. This worker only keeps the
 * interface itself viewable/installable when connectivity drops.
 *
 * CRITICAL FIX (Phase 2A): the fetch handler below now only applies
 * its cache-first strategy to SAME-ORIGIN requests (the app's own
 * HTML/CSS/JS/images). Earlier versions of this file cached every
 * GET request indiscriminately, including cross-origin calls to
 * Supabase's REST API. That meant the very first time the app
 * fetched a profile, wallet balance, order list, or services
 * catalogue, the service worker froze that response in its cache —
 * every later reload replayed the stale cached answer instead of
 * asking Supabase again, so changes made directly in the database
 * (e.g. promoting an account to admin) would appear to "not work"
 * even though they took effect immediately server-side. Supabase
 * requests must always hit the network live.
 *
 * Bump CACHE_VERSION whenever cached files change so old caches
 * are cleaned up on the next visit — this itself also forces every
 * visitor's browser to drop any previously-cached Supabase
 * responses accidentally captured by the old, unscoped fetch
 * handler.
 */

const CACHE_VERSION = "btechsmm-v14";
const PRECACHE_URLS = [
  "index.html",
  "services.html",
  "login.html",
  "register.html",
  "dashboard.html",
  "orders.html",
  "wallet.html",
  "profile.html",
  "support.html",
  "loyalty.html",
  "ambassador.html",
  "verify-ambassador.html",
  "insights.html",
  "offline.html",
  "manifest.json",
  "css/style.css",
  "css/components.css",
  "css/dashboard.css",
  "css/responsive.css",
  "js/app.js",
  "js/navigation.js",
  "js/auth.js",
  "js/auth-forms.js",
  "js/utils.js",
  "js/services.js",
  "js/orders.js",
  "js/wallet.js",
  "js/dashboard.js",
  "js/profile.js",
  "js/admin.js",
  "js/support.js",
  "js/notifications.js",
  "js/payment.js",
  "js/wallet-pay.js",
  "js/loyalty.js",
  "js/loyalty-admin.js",
  "js/admin-dashboard.js",
  "js/ambassador.js",
  "js/ambassador-admin.js",
  "js/badge.js",
  "js/qr.js",
  "js/referral.js",
  "js/photo.js",
  "js/insights.js",
  "js/mpesa-card.js",
  "js/order-progress.js",
  "js/supabase.js",
  "js/config.js",
  "data/demo-data.js",
  "assets/brand/btech-smm-logo.png",
  "assets/brand/icon-192.png",
  "assets/brand/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(async (cache) => {
      // Deliberately NOT cache.addAll(PRECACHE_URLS): addAll is all-or-nothing
      // — a single missing/renamed file (this project shipped with
      // assets/brand/icon-192.png listed here but never actually present)
      // makes the ENTIRE install() reject, which means the new service
      // worker never activates and self.skipWaiting() never runs. Every
      // subsequent CACHE_VERSION bump is then silently pointless — the old
      // worker just keeps controlling the page forever. Caching each file
      // independently means one bad entry can't take down the rest.
      const results = await Promise.allSettled(PRECACHE_URLS.map((url) => cache.add(url)));
      const failed = results
        .map((r, i) => (r.status === "rejected" ? PRECACHE_URLS[i] : null))
        .filter(Boolean);
      if (failed.length) console.warn("[sw] Failed to precache (continuing anyway):", failed);
      return self.skipWaiting();
    })
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  const isSameOrigin = url.origin === self.location.origin;

  // Cross-origin requests (Supabase Auth/REST/Realtime, Google Fonts, the
  // CDN-hosted supabase-js module, etc.) are never cached and never served
  // from cache — they always go straight to the network. This is what was
  // missing before: without this check, a Supabase API response could get
  // frozen in the cache and replayed forever instead of reflecting the
  // current database state.
  if (!isSameOrigin) {
    event.respondWith(fetch(request));
    return;
  }

  // Same-origin navigations: try network first, fall back to cache, then
  // the offline page.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() => caches.match(request).then((cached) => cached || caches.match("offline.html")))
    );
    return;
  }

  // Same-origin static assets (CSS/JS/images): cache first, then network,
  // updating the cache as we go.
  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ||
        fetch(request)
          .then((response) => {
            const copy = response.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
            return response;
          })
          .catch(() => cached)
    )
  );
});