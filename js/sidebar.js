/**
 * BTECH SMM — Sidebar markup (no app dependencies)
 * ----------------------------------------------------------------
 * The permanent customer sidebar's link lists, icons and markup, kept free of
 * auth/Supabase imports so shell.js can paint the sidebar the moment the page
 * loads, instead of waiting for the Supabase library and the session check.
 * navigation.js imports from here, so there is still one definition.
 */

// The permanent sidebar's own link groups (section 4 of the brief) — a
// deliberately separate list from MARKETING_LINKS/APP_LINKS above, since
// the sidebar's grouping, icon set and included pages don't exactly match
// either of the two legacy nav lists.
export const SIDEBAR_MAIN_GUEST = [
  { href: "index.html", label: "Home", key: "home", icon: "home" },
  { href: "services.html", label: "Services", key: "services", icon: "services" },
  { href: "index.html#how-it-works", label: "How It Works", key: "how-it-works", icon: "how-it-works" },
  { href: "index.html#about", label: "About", key: "about", icon: "about" },
  { href: "support.html", label: "Support", key: "support", icon: "support" },
];
export const SIDEBAR_ACCOUNT_GUEST = [{ href: "login.html", label: "Dashboard", key: "dashboard-guest", icon: "dashboard" }];

export const SIDEBAR_MAIN_AUTH = [
  { href: "index.html", label: "Home", key: "home", icon: "home" },
  { href: "services.html", label: "Services", key: "services", icon: "services" },
  { href: "index.html#how-it-works", label: "How It Works", key: "how-it-works", icon: "how-it-works" },
  { href: "support.html", label: "Support", key: "support", icon: "support" },
];
export const SIDEBAR_ACCOUNT_AUTH = [
  { href: "dashboard.html", label: "Dashboard", key: "dashboard", icon: "dashboard" },
  { href: "orders.html", label: "My Orders", key: "orders", icon: "orders" },
  { href: "wallet.html", label: "Wallet", key: "wallet", icon: "wallet" },
  { href: "loyalty.html", label: "Loyalty &amp; Rewards", key: "loyalty", icon: "loyalty" },
  { href: "ambassador.html", label: "Ambassador Program", key: "ambassador", icon: "ambassador" },
  { href: "profile.html", label: "Profile", key: "profile", icon: "profile" },
];

export const ICONS = {
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

function sidebarLinkHtml(l, activeKey) {
  const active = l.key === activeKey;
  return `
    <a href="${l.href}" class="sidebar-link ${active ? "sidebar-link--active" : ""}" ${active ? 'aria-current="page"' : ""}>
      <span class="sidebar-link__icon" aria-hidden="true">${ICONS[l.icon] || ""}</span>
      <span class="sidebar-link__label">${l.label}</span>
    </a>`;
}

/** `authed` decides which link set is shown (signed-in customer vs guest). */
export function customerSidebar(activeKey, authed) {
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

