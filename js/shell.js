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

function paintCustomerShell() {
  const body = document.body;
  if (!body || body.dataset.nav !== "customer") return;

  body.classList.add("has-sidebar");

  let aside = document.querySelector(".customer-sidebar");
  if (!aside) {
    body.insertAdjacentHTML("afterbegin", `<aside class="customer-sidebar" aria-label="Sidebar"></aside>`);
    aside = document.querySelector(".customer-sidebar");
  }
  const html = customerSidebar(body.dataset.page || "", looksSignedIn());
  aside.innerHTML = html;
  aside._html = html;

  const header = document.getElementById("site-header");
  if (header && !header.className) header.className = "topbar";
}

cleanAddressBar();
applyTheme();
paintCustomerShell();