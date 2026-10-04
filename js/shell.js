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

applyTheme();
paintCustomerShell();
