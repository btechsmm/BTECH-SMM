/**
 * BTECH SMM — App Bootstrap (Supabase — Phase 4)
 * (Loaded by app.js after shell.js; see app.js for why.)
 * ----------------------------------------------------------------
 * Single entry point loaded (as a module) by every page. Applies
 * the saved theme, then AWAITS AuthService.init() (loads the
 * current Supabase session + profile) and ServicesService.preload()
 * (loads the live catalogue) before doing anything that depends on
 * "is someone logged in" or "what services exist" — navigation,
 * page guards, and every per-page init function all assume both are
 * ready by the time they run.
 */

import { AuthService } from "./auth.js";
import { initNavigation } from "./navigation.js";
import { renderFeatured, initServicesPage, ServicesService } from "./services.js";
import { initOrderForm, initOrdersList, initOrderDetails } from "./orders.js";
import { initWalletPage } from "./wallet.js";
import { initPayPage } from "./pay.js";
import { initLoyaltyPage } from "./loyalty.js";
import { initDashboard } from "./dashboard.js";
import { initProfilePage } from "./profile.js";
import { initAdminPage } from "./admin.js";
import { initSupportPage } from "./support.js";
import { initAuthForms } from "./auth-forms.js";
import { initAmbassadorPage, initVerifyPage } from "./ambassador.js";
import { initInsightsPage } from "./insights.js";
import { captureReferral, claimPendingReferral } from "./referral.js";
import { BUSINESS } from "./config.js";

function applyStoredTheme() {
  const saved = localStorage.getItem("btechsmm:theme");
  const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  const theme = saved || (prefersDark ? "dark" : "light");
  document.documentElement.dataset.theme = theme;
}

function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    const register = () => navigator.serviceWorker.register("sw.js").catch((err) => console.warn("Service worker registration failed:", err));
    // main.js is loaded after shell.js, so the window "load" event may already have fired.
    if (document.readyState === "complete") register();
    else window.addEventListener("load", register);
  }
}

function guardAuthPages() {
  if (document.body.dataset.requiresAuth === "true") {
    return AuthService.requireAuth("login");
  }
  return true;
}

async function initPage() {
  const page = document.body.dataset.page;
  switch (page) {
    case "home":
      await ServicesService.preload();
      renderFeatured(document.querySelector("[data-featured-services]"));
      break;
    case "services":
      await ServicesService.preload();
      initServicesPage();
      break;
    case "service-order":
      await initOrderForm();
      break;
    case "orders":
      await initOrdersList();
      break;
    case "order-details":
      await initOrderDetails();
      break;
    case "wallet":
      await initWalletPage();
      break;
    case "pay":
      await initPayPage();
      break;
    case "loyalty":
      await initLoyaltyPage();
      break;
    case "ambassador":
      await initAmbassadorPage();
      break;
    case "verify-ambassador":
      await initVerifyPage();
      break;
    case "insights":
      await initInsightsPage();
      break;
    case "dashboard":
      await initDashboard();
      break;
    case "profile":
      initProfilePage();
      break;
    case "admin":
      await initAdminPage();
      break;
    case "support":
      await initSupportPage();
      break;
    case "login":
    case "register":
    case "forgot-password":
    case "reset-password":
      initAuthForms(page);
      break;
    default:
      break;
  }
}

/** Fills any [data-biz-*] element from the central BUSINESS config (terms, privacy, etc.). */
function fillBusinessDetails() {
  document.querySelectorAll("[data-biz-email]").forEach((el) => {
    el.textContent = BUSINESS.email;
    if (el.tagName === "A") el.href = `mailto:${BUSINESS.email}`;
  });
  document.querySelectorAll("[data-biz-phone]").forEach((el) => {
    el.textContent = BUSINESS.phone;
    if (el.tagName === "A") el.href = `https://wa.me/${BUSINESS.whatsappNumber}`;
  });
  document.querySelectorAll("[data-biz-site]").forEach((el) => {
    el.textContent = BUSINESS.website.replace(/^https?:\/\//, "");
    if (el.tagName === "A") el.href = BUSINESS.website;
  });
}

// Pages that need the catalogue. Its request does not depend on the session (the query is the same
// public one for guests and customers), so it starts straight away instead of waiting behind the
// auth check: the two used to run back to back, which added a full network round trip to these pages.
const NEEDS_SERVICES = new Set(["home", "services", "service-order", "orders", "order-details", "dashboard"]);

async function boot() {
  applyStoredTheme();
  if (NEEDS_SERVICES.has(document.body.dataset.page)) ServicesService.preload();
  registerServiceWorker();
  captureReferral(); // remember ?ref=CODE before anything can navigate away
  fillBusinessDetails();

  await AuthService.init();

  const allowedToStay = guardAuthPages();
  if (!allowedToStay) return; // navigating away to login.html

  initNavigation();
  claimPendingReferral().catch(() => { }); // server validates; never blocks the page
  await initPage();
  mountSupportLauncher();
}

// Floating support chat on signed-in customer pages (the Support page embeds the chat itself).
const LAUNCHER_PAGES = new Set(["dashboard", "services", "service-order", "orders", "order-details", "wallet", "pay", "loyalty", "ambassador", "profile", "support", "home"]);
function mountSupportLauncher() {
  if (!LAUNCHER_PAGES.has(document.body.dataset.page)) return;
  import("./support-chat.js").then((m) => m.mountLauncher()).catch((err) => console.warn("Support chat unavailable:", err));
}

// main.js is imported dynamically (after shell.js has painted the sidebar), so DOMContentLoaded
// may already have fired by the time this runs.
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();