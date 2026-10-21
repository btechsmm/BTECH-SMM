/**
 * BTECH SMM — Page shell (runs before auth and data loading)
 * ----------------------------------------------------------------
 * The customer pages are a permanent sidebar + top bar around the content. Those
 * used to be created only after the Supabase library had loaded and the session
 * had been checked, so on every navigation the sidebar vanished and the content
 * jumped sideways until that finished.
 *
 * This module has no network dependencies. It applies the saved theme and builds
 * the sidebar and the top-bar frame straight away, using the same markup
 * navigation.js uses later (navigation.js leaves it alone unless the signed-in
 * state turns out different from the guess made here).
 */

import { customerSidebar } from "./sidebar.js";

function applyTheme() {
  try {
    const saved = localStorage.getItem("btechsmm:theme");
    const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.dataset.theme = saved || (prefersDark ? "dark" : "light");
  } catch {
    /* storage blocked: main.js applies the theme again later */
  }
}

/**
 * Legacy-URL tidy-up. Render's redirect/rewrite rules are never applied to a path where a real file
 * exists, so /login.html cannot be 301'd to /login on the server (the /login -> /login.html REWRITE
 * handles the clean URL itself). Old bookmarks, installed-PWA start URLs, previously-issued
 * password-reset emails and printed ambassador QR codes still point at *.html, so when one of those
 * is opened the address bar is switched to the clean URL in place. Query string and hash are kept
 * (Supabase tokens, ?ref=, ?id=). It only acts when the path ends in ".html", so it cannot loop,
 * and it makes no extra request.
 */
function cleanAddressBar() {
  try {
    const { pathname, search, hash } = window.location;
    if (!/\.html$/i.test(pathname)) return;
    const clean = pathname.replace(/(^|\/)index\.html$/i, "$1").replace(/\.html$/i, "") || "/";
    window.history.replaceState(window.history.state, "", clean + search + hash);
  } catch {
    /* history API unavailable: the .html URL keeps working, it just isn't tidied */
  }
}

/**
 * Google sign-in return, handled here because this runs BEFORE supabase-js looks at the URL.
 *  - Failure/cancel: Supabase sends the user back to /login with ?error=... or #error=... . Only the short
 *    error CODES are kept (never the description text, which can contain internal detail) and the error
 *    parameters are removed from the address bar.
 *  - Success: the URL carries the session in its #fragment. supabase-js consumes it, and until then the
 *    login/register form is swapped for a "Signing you in..." message (see html[data-auth-return] in CSS).
 * Only login/register are touched, so password-recovery and email-confirmation links behave as before.
 */
let _authRedirectError = null;
const AUTH_ERROR_KEYS = ["error", "error_code", "error_description"];

function captureAuthRedirect() {
  try {
    const page = document.body?.dataset.page;
    if (page !== "login" && page !== "register") return;
    const url = new URL(window.location.href);
    const hash = new URLSearchParams(url.hash.replace(/^#/, ""));
    const query = url.searchParams;
    const pick = (k) => hash.get(k) || query.get(k) || "";
    const clean = (v) => (/^[A-Za-z0-9_.-]{1,64}$/.test(v) ? v : "");

    if (AUTH_ERROR_KEYS.some((k) => pick(k))) {
      _authRedirectError = { error: clean(pick("error")), code: clean(pick("error_code")) };
      AUTH_ERROR_KEYS.forEach((k) => {
        hash.delete(k);
        query.delete(k);
      });
      const qs = query.toString();
      const hs = hash.toString();
      window.history.replaceState(window.history.state, "", url.pathname + (qs ? `?${qs}` : "") + (hs ? `#${hs}` : ""));
    } else if (hash.get("access_token")) {
      document.documentElement.dataset.authReturn = "1";
    }
  } catch {
    /* worst case the form just shows as normal */
  }
}

/** The Google-return error captured at page load (once), as { error, code } of short codes, or null. */
export function takeAuthRedirectError() {
  const e = _authRedirectError;
  _authRedirectError = null;
  return e;
}

/** Supabase keeps the session in localStorage under sb-<project>-auth-token. */
function looksSignedIn() {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (/^sb-.+-auth-token$/.test(k) && localStorage.getItem(k)) return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

/**
 * The sidebar is saved (as a template with no active link) so prepaint.js, a tiny synchronous script at the
 * top of <body>, can draw it in the very first frame of the NEXT page. Without that, every click was a full page
 * load whose first frame had no sidebar, so it vanished and came back. Keep the key in step with prepaint.js.
 */
const SIDEBAR_TPL_KEY = "btech:sidebar-tpl:v1:";
const NO_ACTIVE_LINK = "\u0000";

function paintCustomerShell() {
  const body = document.body;
  if (!body || body.dataset.nav !== "customer") return;

  body.classList.add("has-sidebar");

  let aside = document.querySelector(".customer-sidebar");
  if (!aside) {
    body.insertAdjacentHTML("afterbegin", `<aside class="customer-sidebar" aria-label="Sidebar"></aside>`);
    aside = document.querySelector(".customer-sidebar");
  }
  const authed = looksSignedIn();
  const html = customerSidebar(body.dataset.page || "", authed);
  const tpl = customerSidebar(NO_ACTIVE_LINK, authed);

  // prepaint.js may already have drawn exactly this sidebar. Rebuilding identical markup is pointless
  // (and would drop hover/focus), so only touch the DOM when what is there is not the current template.
  if (aside.__tpl !== tpl) aside.innerHTML = html;
  aside._html = html;

  try {
    if (localStorage.getItem(SIDEBAR_TPL_KEY + (authed ? "a" : "g")) !== tpl) localStorage.setItem(SIDEBAR_TPL_KEY + (authed ? "a" : "g"), tpl);
  } catch {
    /* storage blocked: the sidebar is simply drawn by this module, as before */
  }

  const header = document.getElementById("site-header");
  if (header && !header.className) header.className = "topbar";
}

cleanAddressBar();
captureAuthRedirect();
applyTheme();
paintCustomerShell();