/**
 * BTECH SMM — App Bootstrap (Supabase — Phase 4)
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
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch((err) => console.warn("Service worker registration failed:", err));
    });
  }
}

function guardAuthPages() {
  if (document.body.dataset.requiresAuth === "true") {
    return AuthService.requireAuth("login.html");
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

document.addEventListener("DOMContentLoaded", async () => {
  applyStoredTheme();
  registerServiceWorker();
  captureReferral(); // remember ?ref=CODE before anything can navigate away
  fillBusinessDetails();

  await AuthService.init();

  const allowedToStay = guardAuthPages();
  if (!allowedToStay) return; // navigating away to login.html

  initNavigation();
  claimPendingReferral().catch(() => { }); // server validates; never blocks the page
  await initPage();
});