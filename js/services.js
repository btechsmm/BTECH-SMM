/**
 * BTECH SMM — Services Module (Supabase — Phase 2A)
 * ----------------------------------------------------------------
 * Fetches the live services catalogue from Supabase once at app
 * bootstrap (see ServicesService.preload() in app.js) and caches it
 * in memory so every page — including synchronous helpers like
 * findService() — can read it without an extra round trip.
 *
 * IMPORTANT: the bundled catalogue in data/demo-data.js is ONLY ever
 * used when the browser is genuinely offline (installed-PWA
 * fallback per sw.js). A real Supabase error while online, or a
 * genuinely empty `services` table, is NOT masked by silently
 * swapping in the demo catalogue — doing that previously meant a
 * misconfigured table or RLS policy would show customers a fake
 * catalogue with service IDs that don't exist in the live database,
 * so "Order Now" would work right up until checkout, where
 * place_order() would fail because the service isn't real. Callers
 * should check `hasError` / `list().length === 0` and show a proper
 * error or empty state instead.
 */

import { supabase } from "./supabase.js";
import { SERVICES as FALLBACK_SERVICES, PLATFORMS, CATEGORIES } from "../data/demo-data.js";
import { formatCurrency, formatNumber, escapeHtml, debounce, initScrollReveal } from "./utils.js";

let _services = null;
let _hasError = false;
let _isOfflineFallback = false;
let _loading = null; // in-flight preload(), so overlapping callers share ONE request

function mapRow(row) {
  return {
    id: row.id,
    platform: row.platform,
    category: row.category,
    name: row.name,
    description: row.description,
    pricePer1000: Number(row.price_per_1000),
    min: row.min_quantity,
    max: row.max_quantity,
    unit: row.unit || undefined,
    featured: row.featured,
  };
}

function preload() {
  if (_services) return Promise.resolve(_services);
  if (!_loading) _loading = loadServices().finally(() => (_loading = null));
  return _loading;
}

async function loadServices() {
  try {
    const { data, error } = await supabase
      .from("services")
      .select("*")
      .eq("active", true)
      .eq("visible", true)
      .order("display_order", { ascending: true })
      .order("featured", { ascending: false });
    if (error) throw error;
    _services = (data || []).map(mapRow);
    _hasError = false;
  } catch (err) {
    console.error("Unable to load services from Supabase:", err.message || err);
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      // Genuinely offline (installed PWA) — show the bundled catalogue as a
      // read-only fallback rather than a blank screen.
      _services = FALLBACK_SERVICES;
      _isOfflineFallback = true;
    } else {
      // Online but the request failed (bad RLS policy, table missing, etc.)
      // — surface this as a real error rather than hiding it behind fake data.
      _services = [];
      _hasError = true;
    }
  }
  return _services;
}

function list() {
  return _services || [];
}

function hasError() {
  return _hasError;
}

function isOfflineFallback() {
  return _isOfflineFallback;
}

function platformLabel(id) {
  return PLATFORMS.find((p) => p.id === id)?.label || id;
}

function categoryLabel(id) {
  return CATEGORIES.find((c) => c.id === id)?.label || id;
}

function findService(id) {
  return list().find((s) => s.id === id) || null;
}

// Glyph-only artwork (white, via currentColor) for each platform's circular brand badge. The badge colour
// comes from .platform-badge--<id> in components.css, so the same artwork works at any size.
const PLATFORM_ICONS = {
  tiktok: `<svg viewBox="-12 -12 48 48" fill="currentColor" aria-hidden="true" focusable="false"><g transform="translate(-0.9 -0.9)" fill="#25f4ee"><path d="M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z"/></g><g transform="translate(0.9 0.9)" fill="#fe2c55"><path d="M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z"/></g><g fill="#fff"><path d="M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z"/></g></svg>`,
  instagram: `<svg viewBox="-4.35 -4.35 32.69 32.69" fill="currentColor" aria-hidden="true" focusable="false"><rect x="3.5" y="3.5" width="17" height="17" rx="5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="17.2" cy="6.8" r="1.2"/></svg>`,
  youtube: `<svg viewBox="-8.69 -8.69 41.38 41.38" fill="currentColor" aria-hidden="true" focusable="false"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>`,
  facebook: `<svg viewBox="-2.43 -2.68 30.36 30.36" fill="currentColor" aria-hidden="true" focusable="false"><path d="M14 21v-7.5h2.5l.4-3H14V8.4c0-.9.2-1.5 1.5-1.5H17V4.3C16.7 4.2 15.8 4 14.7 4c-2.2 0-3.7 1.3-3.7 3.8v2.7H8.5v3H11V21h3z"/></svg>`,
  x: `<svg viewBox="-14.09 -14.09 52.17 52.17" fill="currentColor" aria-hidden="true" focusable="false"><path d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z"/></svg>`,
  telegram: `<svg viewBox="-0.58 0.99 23.27 23.27" fill="currentColor" aria-hidden="true" focusable="false"><path d="M16.906 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>`,
};

function platformIcon(id) {
  return `<span class="platform-tag__icon platform-badge platform-badge--${id}" aria-hidden="true">${PLATFORM_ICONS[id] || ""}</span>`;
}

function serviceCard(svc) {
  const unit = svc.unit ? svc.unit : "1,000";
  return `
  <article class="service-card" data-reveal data-platform="${svc.platform}" data-category="${svc.category}">
    <div class="service-card__top">
      <span class="platform-tag platform-tag--${svc.platform}">${platformIcon(svc.platform)}${platformLabel(svc.platform)}</span>
      ${svc.featured ? '<span class="badge badge--accent">Popular</span>' : ""}
    </div>
    <h3 class="service-card__name">${escapeHtml(svc.name)}</h3>
    <p class="service-card__desc">${escapeHtml(svc.description)}</p>
    <dl class="service-card__meta">
      <div><dt>Starting at</dt><dd>${formatCurrency(svc.pricePer1000)} <span class="muted">/ ${unit}</span></dd></div>
      <div><dt>Min – Max</dt><dd>${formatNumber(svc.min)} – ${formatNumber(svc.max)}</dd></div>
    </dl>
    <a class="btn btn--primary btn--block" href="service-order?service=${svc.id}">Order Now</a>
  </article>`;
}

export function renderFeatured(container, count = 3) {
  if (!container) return;
  if (hasError()) {
    container.innerHTML = `<div class="empty-state empty-state--compact"><p>Unable to load services right now. Please try again shortly.</p></div>`;
    return;
  }
  const featured = list()
    .filter((s) => s.featured)
    .slice(0, count);
  if (featured.length === 0) {
    container.innerHTML = `<div class="empty-state empty-state--compact"><p>No services are currently available.</p></div>`;
    return;
  }
  container.innerHTML = featured.map(serviceCard).join("");
  initScrollReveal(".service-card[data-reveal]");
}

function categoryTile(categoryId, platformId, count) {
  return `
  <a class="catalogue-tile" data-reveal href="services?platform=${platformId}&category=${categoryId}">
    <span class="catalogue-tile__label">${escapeHtml(categoryLabel(categoryId))}</span>
    <span class="catalogue-tile__count">${count} service${count === 1 ? "" : "s"}</span>
  </a>`;
}

function platformTile(platformId, count) {
  return `
  <a class="catalogue-tile" data-reveal href="services?platform=${platformId}">
    <span class="catalogue-tile__icon platform-badge platform-badge--${platformId}" aria-hidden="true">${PLATFORM_ICONS[platformId] || ""}</span>
    <span class="catalogue-tile__label">${platformLabel(platformId)}</span>
    <span class="catalogue-tile__count">${count} service${count === 1 ? "" : "s"}</span>
  </a>`;
}

function renderBreadcrumb(platform, category) {
  const nav = document.querySelector("[data-services-breadcrumb]");
  if (!nav) return;
  if (!platform) {
    nav.style.display = "none";
    nav.innerHTML = "";
    return;
  }
  nav.style.display = "block";
  const parts = [`<a href="services">Services</a>`];
  parts.push(category ? `<a href="services?platform=${platform}">${platformLabel(platform)}</a>` : `<span>${platformLabel(platform)}</span>`);
  if (category) parts.push(`<span>${categoryLabel(category)}</span>`);
  nav.innerHTML = parts.join(` <span class="muted">/</span> `);
}

export function initServicesPage() {
  const grid = document.querySelector("[data-services-grid]");
  const tilesGrid = document.querySelector("[data-catalogue-tiles]");
  const searchInput = document.querySelector("[data-services-search]");
  const sortSelect = document.querySelector("[data-sort-filter]");
  const emptyState = document.querySelector("[data-services-empty]");
  const countLabel = document.querySelector("[data-services-count]");
  const heading = document.querySelector("[data-catalogue-heading]");
  if (!grid) return;

  // Presentation only: names the tile level being shown ("Platforms" / "Service types").
  function setHeading(text) {
    if (!heading) return;
    heading.textContent = text;
    heading.hidden = !text;
  }

  if (hasError()) {
    grid.hidden = true;
    if (countLabel) countLabel.textContent = "Unable to load services";
    if (emptyState) {
      emptyState.hidden = false;
      emptyState.innerHTML = `<h3>Unable to load services</h3><p>Something went wrong loading the catalogue. Please refresh the page or try again shortly.</p>`;
    }
    return;
  }

  function sortServices(services, sort) {
    if (sort === "price-asc") return services.slice().sort((a, b) => a.pricePer1000 - b.pricePer1000);
    if (sort === "price-desc") return services.slice().sort((a, b) => b.pricePer1000 - a.pricePer1000);
    if (sort === "name-asc") return services.slice().sort((a, b) => a.name.localeCompare(b.name));
    return services.slice().sort((a, b) => (b.featured ? 1 : 0) - (a.featured ? 1 : 0));
  }

  function showEmpty(message) {
    setHeading("");
    grid.hidden = true;
    tilesGrid.hidden = true;
    if (emptyState) {
      emptyState.hidden = false;
      emptyState.innerHTML = message;
    }
  }

  function showServiceGrid(services, sort) {
    setHeading("");
    tilesGrid.hidden = true;
    const sorted = sortServices(services, sort);
    if (sorted.length === 0) {
      showEmpty(
        `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg><h3>No services found</h3><p>Try a different search term, or go back and browse another category.</p>`
      );
      return;
    }
    if (emptyState) emptyState.hidden = true;
    grid.hidden = false;
    grid.innerHTML = sorted.map(serviceCard).join("");
    initScrollReveal(".service-card[data-reveal]");
  }

  // Renders whichever level of the hierarchy the URL currently points to:
  // no platform -> platform tiles; platform only -> category tiles within
  // it; platform + category -> the actual orderable services. A search
  // query bypasses all of that and flattens straight to matching results,
  // since "search across platform/type/name/description" and "hierarchical
  // browse" are two different, equally valid ways to find something.
  function render() {
    const params = new URLSearchParams(window.location.search);
    const platform = params.get("platform") || "";
    const category = params.get("category") || "";
    const query = (searchInput?.value || "").trim().toLowerCase();
    const sort = sortSelect?.value || "featured";
    const all = list();

    if (query) {
      renderBreadcrumb("", "");
      const matches = all.filter(
        (s) =>
          s.name.toLowerCase().includes(query) ||
          s.description.toLowerCase().includes(query) ||
          platformLabel(s.platform).toLowerCase().includes(query) ||
          categoryLabel(s.category).toLowerCase().includes(query)
      );
      if (countLabel) countLabel.textContent = `${matches.length} result${matches.length === 1 ? "" : "s"} for "${searchInput.value.trim()}"`;
      showServiceGrid(matches, sort);
      return;
    }

    if (!platform) {
      renderBreadcrumb("", "");
      const byPlatform = new Map();
      for (const s of all) byPlatform.set(s.platform, (byPlatform.get(s.platform) || 0) + 1);
      if (byPlatform.size === 0) {
        showEmpty(`<h3>No services are currently available</h3><p>Please check back soon.</p>`);
        if (countLabel) countLabel.textContent = "0 services";
        return;
      }
      if (countLabel) countLabel.textContent = `${PLATFORMS.filter((p) => byPlatform.has(p.id)).length || byPlatform.size} platform${byPlatform.size === 1 ? "" : "s"}, ${all.length} service${all.length === 1 ? "" : "s"} total`;
      grid.hidden = true;
      if (emptyState) emptyState.hidden = true;
      tilesGrid.hidden = false;
      setHeading("Platforms");
      tilesGrid.innerHTML = Array.from(byPlatform.entries())
        .sort((a, b) => platformLabel(a[0]).localeCompare(platformLabel(b[0])))
        .map(([id, count]) => platformTile(id, count))
        .join("");
      initScrollReveal(".catalogue-tile[data-reveal]");
      return;
    }

    const inPlatform = all.filter((s) => s.platform === platform);

    if (!category) {
      renderBreadcrumb(platform, "");
      const byCategory = new Map();
      for (const s of inPlatform) byCategory.set(s.category, (byCategory.get(s.category) || 0) + 1);
      if (byCategory.size === 0) {
        showEmpty(`<h3>No services available for ${platformLabel(platform)} yet</h3><p>Please check back soon, or browse another platform.</p>`);
        if (countLabel) countLabel.textContent = "0 services";
        return;
      }
      if (countLabel) countLabel.textContent = `${byCategory.size} service type${byCategory.size === 1 ? "" : "s"}`;
      grid.hidden = true;
      if (emptyState) emptyState.hidden = true;
      tilesGrid.hidden = false;
      setHeading("Service types");
      tilesGrid.innerHTML = Array.from(byCategory.entries())
        .sort((a, b) => categoryLabel(a[0]).localeCompare(categoryLabel(b[0])))
        .map(([id, count]) => categoryTile(id, platform, count))
        .join("");
      initScrollReveal(".catalogue-tile[data-reveal]");
      return;
    }

    renderBreadcrumb(platform, category);
    const leaf = inPlatform.filter((s) => s.category === category);
    if (countLabel) countLabel.textContent = `${leaf.length} service${leaf.length === 1 ? "" : "s"}`;
    showServiceGrid(leaf, sort);
  }

  searchInput?.addEventListener("input", debounce(render, 200));
  sortSelect?.addEventListener("change", render);
  window.addEventListener("popstate", render);

  // Intercept tile/breadcrumb clicks so browsing is instant (no full page
  // reload) while still updating the URL — back/forward and shareable
  // links both keep working since it's a real query-param-addressable state.
  document.addEventListener("click", (e) => {
    const link = e.target.closest("[data-catalogue-tiles] a, [data-services-breadcrumb] a");
    if (!link) return;
    e.preventDefault();
    if (searchInput) searchInput.value = "";
    history.pushState(null, "", link.getAttribute("href"));
    render();
  });

  render();
}

export const ServicesService = { preload, list, hasError, isOfflineFallback };
export const ServicesData = { PLATFORMS, CATEGORIES, platformLabel, categoryLabel, platformIcon };
export { findService };