/**
 * BTECH SMM — Navigation Module
 * ----------------------------------------------------------------
 * Three independent nav layouts, chosen by `data-nav` on <body>:
 *
 *   data-nav="customer"  — the permanent left sidebar + top bar used by
 *                          every customer-facing page (marketing pages
 *                          like Home/Services/Support included, not just
 *                          the authenticated app pages). Mobile (<768px)
 *                          hides the sidebar and falls back to the
 *                          existing bottom nav (authenticated) plus a
 *                          top-bar menu button that opens a dropdown with
 *                          the full link list (unauthenticated, or any
 *                          link the bottom nav doesn't cover).
 *   data-nav="admin"     — the ORIGINAL horizontal app header/bottom nav,
 *                          unchanged, used only by admin.html. Admin is
 *                          explicitly exempt from the permanent sidebar
 *                          per the brief, and keeps whatever
 *                          collapse/toggle behavior it already had.
 *   data-nav="marketing" — the original simple centered header, unchanged,
 *                          used only by the four auth pages (login,
 *                          register, forgot/reset password), which don't
 *                          suit a sidebar shell around a centered form.
 *
 * Pages opt in by including:
 *   <header id="site-header"></header>        ... page content ...
 *   <div id="bottom-nav-slot"></div>          (customer/admin pages)
 *   <footer id="site-footer"></footer>
 * and setting `<body data-page="..." data-nav="customer|admin|marketing">`.
 *
 * Wallet balance: the top bar's wallet pill reads the same wallet row
 * every other page reads (via fetchWalletBalance() in wallet-pay.js — the
 * one existing wallet data source, not a second one). It refreshes on
 * load, when the tab regains focus, and whenever any other module
 * dispatches a `btech:wallet-updated` window event (wallet.js and
 * orders.js do this after a deposit or a wallet order-payment succeeds).
 */

import { AuthService } from "./auth.js";
import { NotificationsService } from "./notifications.js";
import { WHATSAPP_NUMBER, WHATSAPP_DEFAULT_MESSAGE, BUSINESS } from "./config.js";
import { fetchWalletBalance } from "./wallet-pay.js";
import { formatCurrency, escapeHtml } from "./utils.js";
import { avatarInner } from "./avatar.js";

const MARKETING_LINKS = [
  { href: "index.html", label: "Home", key: "home" },
  { href: "services.html", label: "Services", key: "services" },
  { href: "index.html#how-it-works", label: "How It Works", key: "how-it-works" },
  { href: "index.html#about", label: "About", key: "about" },
  { href: "support.html", label: "Support", key: "support" },
];

const APP_LINKS = [
  { href: "dashboard.html", label: "Home", key: "dashboard", icon: "home" },
  { href: "orders.html", label: "Orders", key: "orders", icon: "orders" },
  { href: "wallet.html", label: "Wallet", key: "wallet", icon: "wallet" },
  { href: "profile.html", label: "Profile", key: "profile", icon: "profile" },
];

// The permanent sidebar's own link groups (section 4 of the brief) — a
// deliberately separate list from MARKETING_LINKS/APP_LINKS above, since
// the sidebar's grouping, icon set and included pages don't exactly match
// either of the two legacy nav lists.
const SIDEBAR_MAIN_GUEST = [
  { href: "index.html", label: "Home", key: "home", icon: "home" },
  { href: "services.html", label: "Services", key: "services", icon: "services" },
  { href: "index.html#how-it-works", label: "How It Works", key: "how-it-works", icon: "how-it-works" },
  { href: "index.html#about", label: "About", key: "about", icon: "about" },
  { href: "support.html", label: "Support", key: "support", icon: "support" },
];
const SIDEBAR_ACCOUNT_GUEST = [{ href: "login.html", label: "Dashboard", key: "dashboard-guest", icon: "dashboard" }];

const SIDEBAR_MAIN_AUTH = [
  { href: "index.html", label: "Home", key: "home", icon: "home" },
  { href: "services.html", label: "Services", key: "services", icon: "services" },
  { href: "index.html#how-it-works", label: "How It Works", key: "how-it-works", icon: "how-it-works" },
  { href: "support.html", label: "Support", key: "support", icon: "support" },
];
const SIDEBAR_ACCOUNT_AUTH = [
  { href: "dashboard.html", label: "Dashboard", key: "dashboard", icon: "dashboard" },
  { href: "orders.html", label: "My Orders", key: "orders", icon: "orders" },
  { href: "wallet.html", label: "Wallet", key: "wallet", icon: "wallet" },
  { href: "loyalty.html", label: "Loyalty &amp; Rewards", key: "loyalty", icon: "loyalty" },
  { href: "ambassador.html", label: "Ambassador Program", key: "ambassador", icon: "ambassador" },
  { href: "profile.html", label: "Profile", key: "profile", icon: "profile" },
];

const ICONS = {
  home: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/></svg>`,
  orders: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 9h8M8 13h8M8 17h5"/></svg>`,
  wallet: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18"/><circle cx="16" cy="14" r="1"/></svg>`,
  ambassador: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="3.5"/><path d="M5 20c.7-3.6 3.4-5.5 7-5.5s6.3 1.9 7 5.5"/><path d="M17.5 3.5l.7 1.5 1.6.2-1.2 1.1.3 1.6-1.4-.8-1.4.8.3-1.6-1.2-1.1 1.6-.2z"/></svg>`,
  loyalty: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8L3.5 9.7l5.9-.9L12 3.5z"/></svg>`,
  profile: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="3.5"/><path d="M5 20c1.5-4 5-5.5 7-5.5s5.5 1.5 7 5.5"/></svg>`,
  bell: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8a6 6 0 10-12 0c0 7-3 8-3 8h18s-3-1-3-8"/><path d="M13.7 21a2 2 0 01-3.4 0"/></svg>`,
  menu: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h16M4 12h16M4 17h16"/></svg>`,
  close: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18"/></svg>`,
  sun: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>`,
  moon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z"/></svg>`,
  plus: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M5 12h14"/></svg>`,
  services: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/></svg>`,
  "how-it-works": `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 015 .3c0 1.7-2 1.7-2.2 3.4"/><path d="M12 17h.01"/></svg>`,
  about: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 8v.01M12 11.5V16"/></svg>`,
  support: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 13a8 8 0 0116 0"/><rect x="3" y="13" width="5" height="6" rx="1.5"/><rect x="16" y="13" width="5" height="6" rx="1.5"/></svg>`,
  dashboard: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3.5" y="3.5" width="7" height="8" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="5" rx="1.5"/><rect x="13.5" y="11.5" width="7" height="9" rx="1.5"/><rect x="3.5" y="14.5" width="7" height="6" rx="1.5"/></svg>`,
  shield: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3l7 3v6c0 4.5-3 8-7 9-4-1-7-4.5-7-9V6l7-3z"/><path d="M9 12l2 2 4-4"/></svg>`,
  caret: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>`,
};

// ---------------------------------------------------------------------------
// data-nav="marketing" — auth pages only, unchanged from before.
// ---------------------------------------------------------------------------
function marketingHeader(activeKey) {
  const authed = AuthService.isAuthenticated();
  const links = MARKETING_LINKS.map(
    (l) => `<a href="${l.href}" class="nav-link ${l.key === activeKey ? "nav-link--active" : ""}">${l.label}</a>`
  ).join("");
  return `
  <div class="header-inner container">
    <a href="index.html" class="brand" aria-label="BTECH SMM home">
      <img src="assets/brand/btech-smm-logo.png" alt="BTECH SMM" class="brand__logo" width="140" height="29" />
    </a>
    <nav class="nav-desktop" aria-label="Primary">
      ${links}
    </nav>
    <div class="header-actions">
      <button class="icon-btn" type="button" data-theme-toggle aria-label="Toggle dark mode">${ICONS.moon}</button>
      ${authed
      ? `<a href="dashboard.html" class="btn btn--primary btn--sm">Dashboard</a>`
      : `<a href="login.html" class="nav-link nav-link--login">Login</a><a href="register.html" class="btn btn--primary btn--sm">Get Started</a>`
    }
      <button class="icon-btn nav-toggle" type="button" data-mobile-menu-toggle aria-label="Open menu" aria-expanded="false">${ICONS.menu}</button>
    </div>
  </div>
  <div class="nav-mobile" data-mobile-menu>
    ${links}
    <hr class="nav-mobile__divider" />
    ${authed
      ? `<a href="dashboard.html" class="nav-link">Dashboard</a><a href="#" class="nav-link" data-logout>Logout</a>`
      : `<a href="login.html" class="nav-link">Login</a><a href="register.html" class="nav-link">Get Started</a>`
    }
  </div>`;
}

// ---------------------------------------------------------------------------
// data-nav="admin" — the original app header, unchanged, admin.html only.
// Kept as its own function (not shared with the customer sidebar) so future
// admin-specific changes (a collapsible admin sidebar, etc.) can happen
// without touching the customer layout at all.
// ---------------------------------------------------------------------------
function adminHeader(activeKey) {
  const user = AuthService.getCurrentUser();
  const links = APP_LINKS.map(
    (l) => `<a href="${l.href}" class="app-nav-link ${l.key === activeKey ? "app-nav-link--active" : ""}">${l.label}</a>`
  ).join("");
  return `
  <div class="header-inner container">
    <a href="dashboard.html" class="brand" aria-label="BTECH SMM home">
      <img src="assets/brand/btech-smm-logo.png" alt="BTECH SMM" class="brand__logo" width="140" height="29" />
    </a>
    <nav class="nav-desktop nav-desktop--app" aria-label="Primary">
      ${links}
      <a href="support.html" class="app-nav-link">Support</a>
      <a href="admin.html" class="app-nav-link ${activeKey === "insights" ? "" : "app-nav-link--active"}">Admin</a>
      <a href="insights.html" class="app-nav-link ${activeKey === "insights" ? "app-nav-link--active" : ""}">Insights</a>
    </nav>
    <div class="header-actions">
      <button class="icon-btn" type="button" data-theme-toggle aria-label="Toggle dark mode">${ICONS.moon}</button>
      <a href="profile.html" class="avatar" aria-label="Profile">${avatarInner(user)}</a>
      <button class="icon-btn nav-toggle" type="button" data-mobile-menu-toggle aria-label="Open menu" aria-expanded="false">${ICONS.menu}</button>
    </div>
  </div>
  <div class="nav-mobile" data-mobile-menu>
    ${links}
    <a href="support.html" class="app-nav-link">Support</a>
    <a href="admin.html" class="app-nav-link">Admin</a>
    <hr class="nav-mobile__divider" />
    <a href="#" class="nav-link" data-logout>Logout</a>
  </div>`;
}

// ---------------------------------------------------------------------------
// data-nav="customer" — the new permanent sidebar + top bar.
// ---------------------------------------------------------------------------
function sidebarLinkHtml(l, activeKey) {
  const active = l.key === activeKey;
  return `
    <a href="${l.href}" class="sidebar-link ${active ? "sidebar-link--active" : ""}" ${active ? 'aria-current="page"' : ""}>
      <span class="sidebar-link__icon" aria-hidden="true">${ICONS[l.icon] || ""}</span>
      <span class="sidebar-link__label">${l.label}</span>
    </a>`;
}

function customerSidebar(activeKey) {
  const authed = AuthService.isAuthenticated();
  const main = authed ? SIDEBAR_MAIN_AUTH : SIDEBAR_MAIN_GUEST;
  const account = authed ? SIDEBAR_ACCOUNT_AUTH : SIDEBAR_ACCOUNT_GUEST;
  return `
  <div class="sidebar__logo">
    <a href="${authed ? "dashboard.html" : "index.html"}" aria-label="BTECH SMM home">
      <img src="assets/brand/btech-smm-logo.png" alt="BTECH SMM" width="150" height="31" />
    </a>
  </div>
  <nav class="sidebar__nav" aria-label="Primary">
    <p class="sidebar__group-label">Main</p>
    ${main.map((l) => sidebarLinkHtml(l, activeKey)).join("")}
    <p class="sidebar__group-label">Account</p>
    ${account.map((l) => sidebarLinkHtml(l, activeKey)).join("")}
  </nav>
  <div class="sidebar__trust">
    <span class="sidebar__trust-icon" aria-hidden="true">${ICONS.shield}</span>
    <div>
      <p class="sidebar__trust-title">Safe &amp; Secure</p>
      <p class="sidebar__trust-text">Your data and payments are always protected.</p>
    </div>
  </div>`;
}

function walletPillHtml() {
  return `
  <a class="wallet-pill" href="wallet.html" data-wallet-pill aria-label="Wallet balance">
    <span class="wallet-pill__icon" aria-hidden="true">${ICONS.wallet}</span>
    <span class="wallet-pill__text">
      <span class="wallet-pill__label">Wallet Balance</span>
      <span class="wallet-pill__value" data-wallet-pill-value>Ksh —</span>
    </span>
  </a>`;
}

function customerTopbar(authed, user) {
  return `
  <div class="topbar__inner">
    <button class="icon-btn topbar__menu-btn" type="button" data-mobile-menu-toggle aria-label="Open menu" aria-expanded="false">${ICONS.menu}</button>
    <div class="topbar__actions">
      ${authed ? walletPillHtml() : ""}
      ${authed
      ? `<button class="icon-btn notif-btn" type="button" data-notif-toggle aria-label="Notifications">
          ${ICONS.bell}
          <span class="notif-badge" data-notif-badge hidden>0</span>
        </button>
        <div class="notif-panel" data-notif-panel hidden>
          <div class="notif-panel__head">
            <span>Notifications</span>
            <button type="button" class="link-btn" data-mark-all-read>Mark all read</button>
          </div>
          <div class="notif-panel__list" data-notif-list></div>
        </div>`
      : ""
    }
      <button class="icon-btn" type="button" data-theme-toggle aria-label="Toggle dark mode">${ICONS.moon}</button>
      ${authed && user?.role === "admin" ? `<a href="admin.html" class="admin-portal-btn">${ICONS.shield}<span>Admin Portal</span></a>` : ""}
      ${authed
      ? `<a href="profile.html" class="topbar__profile" aria-label="Profile">
          <span class="avatar avatar--sm">${avatarInner(user)}</span>
          <span class="topbar__profile-name">${escapeHtml(user?.name || "Account")}</span>
          <span class="topbar__profile-caret" aria-hidden="true">${ICONS.caret}</span>
        </a>`
      : `<a href="login.html" class="nav-link nav-link--login">Login</a><a href="register.html" class="btn btn--primary btn--sm">Get Started</a>`
    }
    </div>
  </div>`;
}

function customerMobileMenu(activeKey) {
  const authed = AuthService.isAuthenticated();
  const user = AuthService.getCurrentUser();
  const main = authed ? SIDEBAR_MAIN_AUTH : SIDEBAR_MAIN_GUEST;
  const account = authed ? SIDEBAR_ACCOUNT_AUTH : SIDEBAR_ACCOUNT_GUEST;
  const all = [...main, ...account];
  const links = all
    .map((l) => `<a href="${l.href}" class="nav-link ${l.key === activeKey ? "nav-link--active" : ""}">${l.label}</a>`)
    .join("");
  return `
  <div class="nav-mobile" data-mobile-menu>
    ${links}
    ${authed && user?.role === "admin" ? `<a href="admin.html" class="nav-link">Admin Portal</a>` : ""}
    <hr class="nav-mobile__divider" />
    ${authed ? `<a href="#" class="nav-link" data-logout>Logout</a>` : `<a href="login.html" class="nav-link">Login</a><a href="register.html" class="nav-link">Get Started</a>`}
  </div>`;
}

function bottomNav(activeKey) {
  const home = APP_LINKS.find((l) => l.key === "dashboard");
  const orders = APP_LINKS.find((l) => l.key === "orders");
  const wallet = APP_LINKS.find((l) => l.key === "wallet");
  const profile = APP_LINKS.find((l) => l.key === "profile");
  const item = (l) => `
    <a href="${l.href}" class="bottom-nav__item ${l.key === activeKey ? "bottom-nav__item--active" : ""}">
      ${ICONS[l.icon]}
      <span>${l.label}</span>
    </a>`;
  return `<nav class="bottom-nav" aria-label="Primary">
    ${item(home)}
    ${item(orders)}
    <a href="services.html" class="bottom-nav__cta" aria-label="New order">${ICONS.plus}</a>
    ${item(wallet)}
    ${item(profile)}
  </nav>`;
}

function whatsappFab() {
  const message = encodeURIComponent(WHATSAPP_DEFAULT_MESSAGE);
  return `
  <a class="whatsapp-fab" href="https://wa.me/${WHATSAPP_NUMBER}?text=${message}" target="_blank" rel="noopener noreferrer" aria-label="Chat with BTECH SMM support on WhatsApp">
    <svg viewBox="0 0 32 32" width="26" height="26" aria-hidden="true">
      <path fill="#fff" d="M16 3C9.4 3 4 8.4 4 15c0 2.2.6 4.3 1.7 6.1L4 29l8.1-1.7c1.7.9 3.6 1.4 5.9 1.4 6.6 0 12-5.4 12-12S22.6 3 16 3zm0 21.8c-1.9 0-3.7-.5-5.3-1.4l-.4-.2-4.8 1 1-4.7-.2-.4C5.5 17.5 5 16.3 5 15c0-6.1 4.9-11 11-11s11 4.9 11 11-4.9 11-11 11z"/>
      <path fill="#fff" d="M21.6 18.1c-.3-.2-1.8-.9-2.1-1-.3-.1-.5-.2-.7.2-.2.3-.8 1-1 1.2-.2.2-.4.2-.7.1-.3-.2-1.3-.5-2.4-1.5-.9-.8-1.5-1.8-1.7-2.1-.2-.3 0-.5.1-.6.1-.1.3-.4.4-.5.1-.2.2-.3.3-.5.1-.2 0-.4 0-.5 0-.2-.7-1.7-1-2.3-.3-.6-.5-.5-.7-.5h-.6c-.2 0-.5.1-.8.4-.3.3-1 1-1 2.4s1 2.8 1.2 3c.1.2 2 3 4.8 4.2.7.3 1.2.5 1.6.6.7.2 1.3.2 1.8.1.5-.1 1.8-.7 2-1.4.3-.7.3-1.3.2-1.4-.1-.2-.3-.3-.6-.4z"/>
    </svg>
  </a>`;
}

function footer() {
  return `
  <div class="container footer-inner">
    <div class="footer-brand">
      <img src="assets/brand/btech-smm-logo.png" alt="BTECH SMM" class="brand__logo" width="150" height="31" />
      <p>Social Media Marketing &amp; Digital Growth</p>
    </div>
    <div class="footer-links">
      <div class="footer-col">
        <h4>Company</h4>
        <a href="index.html">Home</a>
        <a href="services.html">Services</a>
        <a href="index.html#about">About</a>
      </div>
      <div class="footer-col">
        <h4>Support</h4>
        <a href="support.html">Support</a>
        <a href="terms.html">Terms</a>
        <a href="privacy.html">Privacy</a>
      </div>
      <div class="footer-col">
        <h4>Contact</h4>
        <a href="mailto:${BUSINESS.email}">${BUSINESS.email}</a>
        <a href="https://wa.me/${BUSINESS.whatsappNumber}" target="_blank" rel="noopener noreferrer">${BUSINESS.phone}</a>
        <span class="footer-text">Nairobi, Kenya</span>
      </div>
    </div>
  </div>
  <div class="container footer-bottom">
    <p>&copy; 2026 BTECH SMM. All rights reserved.</p>
  </div>`;
}

// ---------------------------------------------------------------------------
// Wallet balance pill: one shared render/refresh path used on every
// customer page. Reads the same wallet row wallet.html reads — no second
// source of truth. Never shows a number until the query has actually
// resolved.
// ---------------------------------------------------------------------------
async function refreshWalletPill() {
  const valueEls = document.querySelectorAll("[data-wallet-pill-value]");
  if (valueEls.length === 0 || !AuthService.isAuthenticated()) return;
  const balance = await fetchWalletBalance();
  valueEls.forEach((el) => {
    el.textContent = balance === null ? "Unavailable" : formatCurrency(balance);
  });
}

function wireWalletPillRefresh() {
  window.addEventListener("btech:wallet-updated", refreshWalletPill);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshWalletPill();
  });
}

function wireInteractions(root = document) {
  const menuToggle = root.querySelector("[data-mobile-menu-toggle]");
  const menu = root.querySelector("[data-mobile-menu]");
  if (menuToggle && menu) {
    menuToggle.addEventListener("click", () => {
      const open = menu.classList.toggle("nav-mobile--open");
      menuToggle.setAttribute("aria-expanded", String(open));
      menuToggle.innerHTML = open ? ICONS.close : ICONS.menu;
    });
  }

  const notifToggle = root.querySelector("[data-notif-toggle]");
  const notifPanel = root.querySelector("[data-notif-panel]");
  if (notifToggle && notifPanel) {
    NotificationsService.initAndRender(root);
    notifToggle.addEventListener("click", async () => {
      notifPanel.hidden = !notifPanel.hidden;
      if (!notifPanel.hidden) await NotificationsService.initAndRender(root);
    });
    const markAllBtn = root.querySelector("[data-mark-all-read]");
    markAllBtn?.addEventListener("click", async () => {
      await NotificationsService.markAllRead();
      NotificationsService.renderList(root.querySelector("[data-notif-list]"));
      await NotificationsService.renderBadge();
    });
    document.addEventListener("click", (e) => {
      if (!notifPanel.contains(e.target) && !notifToggle.contains(e.target)) {
        notifPanel.hidden = true;
      }
    });
  }

  root.querySelectorAll("[data-logout]").forEach((btn) =>
    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      await AuthService.logout();
      window.location.href = "index.html";
    })
  );

  const themeToggle = root.querySelector("[data-theme-toggle]");
  if (themeToggle) {
    themeToggle.innerHTML = document.documentElement.dataset.theme === "dark" ? ICONS.sun : ICONS.moon;
    themeToggle.addEventListener("click", () => {
      const isDark = document.documentElement.dataset.theme === "dark";
      const next = isDark ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      localStorage.setItem("btechsmm:theme", next);
      themeToggle.innerHTML = next === "dark" ? ICONS.sun : ICONS.moon;
    });
  }
}

// When the user's photo changes (Ambassador page), refresh the header avatars in place.
let avatarListenerBound = false;
function bindAvatarRefresh() {
  if (avatarListenerBound) return;
  avatarListenerBound = true;
  window.addEventListener("btech:profile-updated", () => {
    const u = AuthService.getCurrentUser();
    document.querySelectorAll(".topbar__profile .avatar, a.avatar[aria-label='Profile']").forEach((el) => (el.innerHTML = avatarInner(u)));
  });
}

export function initNavigation() {
  bindAvatarRefresh();
  const body = document.body;
  const navType = body.dataset.nav || "marketing";
  const activeKey = body.dataset.page || "";
  const header = document.getElementById("site-header");
  const footerEl = document.getElementById("site-footer");
  const bottomSlot = document.getElementById("bottom-nav-slot");
  const authed = AuthService.isAuthenticated();
  const user = AuthService.getCurrentUser();

  if (navType === "customer") {
    document.body.classList.add("has-sidebar");
    if (!document.querySelector(".customer-sidebar")) {
      document.body.insertAdjacentHTML("afterbegin", `<aside class="customer-sidebar" aria-label="Sidebar"></aside>`);
    }
    document.querySelector(".customer-sidebar").innerHTML = customerSidebar(activeKey);

    if (header) {
      header.className = "topbar";
      header.innerHTML = customerTopbar(authed, user);
    }
    if (!document.querySelector("[data-mobile-menu]")) {
      document.body.insertAdjacentHTML("beforeend", customerMobileMenu(activeKey));
    }
    if (bottomSlot) {
      // Bottom nav only makes sense for a signed-in customer (it links to
      // Orders/Wallet/Profile); a guest on mobile uses the top-bar menu
      // button instead, same as on desktop/tablet just without the sidebar.
      bottomSlot.outerHTML = authed ? bottomNav(activeKey) : "<div hidden></div>";
    }
    if (footerEl) {
      footerEl.className = "site-footer";
      footerEl.innerHTML = footer();
    }
    wireWalletPillRefresh();
    refreshWalletPill();
  } else if (navType === "admin") {
    if (header) {
      header.className = "site-header";
      header.innerHTML = adminHeader(activeKey);
    }
    if (bottomSlot) bottomSlot.outerHTML = bottomNav(activeKey);
    if (footerEl) {
      footerEl.className = "site-footer";
      footerEl.innerHTML = footer();
    }
  } else {
    if (header) {
      header.className = "site-header";
      header.innerHTML = marketingHeader(activeKey);
    }
    if (footerEl) {
      footerEl.className = "site-footer";
      footerEl.innerHTML = footer();
    }
  }

  if (!document.querySelector(".whatsapp-fab")) {
    document.body.insertAdjacentHTML("beforeend", whatsappFab());
  }
  wireFabFooterVisibility();
  wireInteractions(document);
}

/**
 * The WhatsApp button is fixed bottom-right so it's always reachable, but
 * that means it inevitably sits on top of whatever is at that screen
 * position once the user scrolls to the very end of the page — which is
 * the footer. Rather than leave it permanently overlapping the footer's
 * "Contact" column, fade/disable it while the footer is actually on
 * screen, and bring it back once the user scrolls back up.
 */
function wireFabFooterVisibility() {
  const fab = document.querySelector(".whatsapp-fab");
  const footerEl = document.getElementById("site-footer");
  if (!fab || !footerEl || typeof IntersectionObserver === "undefined") return;
  const observer = new IntersectionObserver(
    (entries) => {
      const footerVisible = entries.some((e) => e.isIntersecting);
      fab.classList.toggle("whatsapp-fab--hidden", footerVisible);
    },
    { rootMargin: "0px 0px -40% 0px" }
  );
  observer.observe(footerEl);
}