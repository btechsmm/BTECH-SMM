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
  const k = pfKey(id);
  const raw = String(id || "");
  return PLATFORMS.find((p) => p.id === id || p.id === k)?.label || PLATFORM_NAMES[k] || (raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : "");
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
  // Official WhatsApp glyph (speech bubble + handset). White on the brand green via .platform-badge--whatsapp.
  whatsapp: `<svg viewBox="-3 -3 30 30" fill="currentColor" aria-hidden="true" focusable="false"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z"/></svg>`,
  linkedin: `<svg viewBox="-4 -4 32 32" fill="currentColor" aria-hidden="true" focusable="false"><circle cx="6" cy="6" r="2"/><rect x="4" y="9" width="4" height="11"/><path d="M10 9h3.6v1.6c.6-1 1.8-1.9 3.6-1.9 3.2 0 3.8 2.1 3.8 4.8V20h-4v-5.6c0-1.3 0-2.6-1.6-2.6S14 13 14 14.4V20h-4z"/></svg>`,
  snapchat: `<svg viewBox="-4 -4 32 32" fill="currentColor" aria-hidden="true" focusable="false"><path d="M12 3.5c-3 0-4.6 2.2-4.6 4.8v2.2c-.5.2-1.5.3-1.9.4.1.7 1 .9 1.6 1.1-.4 1-1.2 1.9-2.5 2.3.1.6 1.2.9 2.2 1 .2.5.1 1 .8 1.1.8.1 1.6-.1 2.4.3.6.4 1.3 1.1 2 1.1s1.4-.7 2-1.1c.8-.4 1.6-.2 2.4-.3.7-.1.6-.6.8-1.1 1-.1 2.1-.4 2.2-1-1.3-.4-2.1-1.3-2.5-2.3.6-.2 1.5-.4 1.6-1.1-.4-.1-1.4-.2-1.9-.4V8.3c0-2.6-1.6-4.8-4.6-4.8z"/></svg>`,
  pinterest: `<svg viewBox="-4 -4 32 32" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M9.5 21l1.8-7.5M9 14.5C7.5 11 9 7 12.5 7c2.5 0 3.8 1.6 3.8 3.5 0 2.5-1.5 4-3.2 4-1 0-1.7-.7-1.5-1.7"/></svg>`,
};

// Platform ids can arrive in several spellings from the catalogue; normalise for icon/colour lookups.
const PLATFORM_ALIASES = { twitter: "x", "x-twitter": "x", fb: "facebook", ig: "instagram", yt: "youtube", wa: "whatsapp", tg: "telegram", snap: "snapchat" };
const PLATFORM_NAMES = { tiktok: "TikTok", instagram: "Instagram", youtube: "YouTube", facebook: "Facebook", x: "X", telegram: "Telegram", whatsapp: "WhatsApp", linkedin: "LinkedIn", snapchat: "Snapchat", pinterest: "Pinterest" };
try {
  if (Array.isArray(PLATFORMS) && !PLATFORMS.some((p) => p && p.id === "whatsapp")) PLATFORMS.push({ id: "whatsapp", label: "WhatsApp" });
} catch { /* frozen list: WhatsApp is still labelled and iconised through PLATFORM_NAMES / PLATFORM_ICONS */ }
const pfKey = (id) => { const k = String(id || "").toLowerCase().trim(); return PLATFORM_ALIASES[k] || k; };
const pfAttr = (id) => escapeHtml(pfKey(id));

function platformIcon(id) {
  const k = pfKey(id);
  return `<span class="platform-tag__icon platform-badge platform-badge--${pfAttr(k)}" data-platform="${pfAttr(k)}" aria-hidden="true">${PLATFORM_ICONS[k] || ""}</span>`;
}

/* ------------------------------------------------------------------------------------------------
   Display formatting. These helpers only change how a stored name is SHOWN. Stored values, ids, prices
   and provider mappings are never modified, and the original text stays available in a title="" tooltip
   and in search. Anything the admin adds or edits flows through the same functions automatically.
   ------------------------------------------------------------------------------------------------ */
const PICTO_RE = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{20E3}\u2605\u2606\u2713\u2714\u2715\u2716\u27A1\u2B50]/gu;
const KEEP_UPPER = new Set(["HQ", "HD", "UHD", "VIP", "AI", "API", "UK", "US", "USA", "IG", "FB", "TG", "YT", "TV", "KES", "NFT", "DM", "24H", "24/7", "OG", "LQ", "AAA"]);
const PLATFORM_PREFIX = /^(facebook|fb|instagram|insta|ig|tiktok|tik tok|tt|youtube|yt|twitter|x|telegram|tg|whatsapp|wa|linkedin|snapchat|pinterest)\b[\s:\-–—|]*/i;

function smartCase(t) {
  if (!/[a-z]/.test(t) && /[A-Z]/.test(t) && t.length > 3) {
    return t.toLowerCase().replace(/\b[\p{L}\d][\p{L}\d'/]*/gu, (w) => (KEEP_UPPER.has(w.toUpperCase()) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)));
  }
  return t;
}

function cleanText(raw) {
  return String(raw == null ? "" : raw)
    .replace(PICTO_RE, " ")
    .replace(/[•·▪►▶◆◇■□●○★☆»«~_=*]+/g, " ")
    .replace(/#\d{3,}\b/g, " ")                       // bare provider ids such as "#4512"
    .replace(/\b(?:sid|service[\s_-]?id|id)\s*[:#-]?\s*\d{2,}\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}
const trimEdges = (t) => t.replace(/^[\s\-–—:;,.|/]+|[\s\-–—:;,.|/]+$/g, "").trim();

/** Splits "Followers | Real | Refill 30D [Fast]" into a clean title plus short detail tags. */
function parseName(raw) {
  let t = cleanText(raw);
  const tags = [];
  t = t.replace(/\[([^\]]{1,28})\]|\(([^)]{1,28})\)/g, (_, a, b) => { const v = trimEdges(a || b || ""); if (v) tags.push(v); return " "; });
  const parts = t.split(/\s*\|\s*/).map(trimEdges).filter(Boolean);
  let title = parts.shift() || trimEdges(t);
  parts.forEach((x) => { if (x.length <= 28) tags.push(x); else title += " " + x; });
  const seen = new Set();
  const uniq = tags.map((x) => smartCase(x)).filter((x) => { const k = x.toLowerCase(); if (seen.has(k) || k === title.toLowerCase()) return false; seen.add(k); return true; });
  return { title: smartCase(trimEdges(title.replace(/\s+/g, " "))), tags: uniq.slice(0, 4) };
}

function stripPlatformPrefix(title, platformId) {
  const m = title.match(PLATFORM_PREFIX);
  if (!m) return title;
  const rest = title.slice(m[0].length).trim();
  const named = pfKey(m[1]) === pfKey(platformId) || !platformId;
  return rest.length >= 3 && named ? rest.charAt(0).toUpperCase() + rest.slice(1) : title;
}

function prettySlug(v) {
  const t = String(v || "");
  return /^[a-z0-9]+([-_][a-z0-9]+)+$/.test(t) ? t.replace(/[-_]+/g, " ").replace(/\b[a-z]/g, (c) => c.toUpperCase()) : t;
}
function displayCategory(id, platformId) {
  const label = parseName(prettySlug(categoryLabel(id))).title || String(id || "");
  return stripPlatformPrefix(label, platformId) || label;
}
function displayService(svc) {
  const { title, tags } = parseName(svc.name);
  return { title: stripPlatformPrefix(title, svc.platform) || title || String(svc.name || ""), tags };
}
const clip = (t, n) => (t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t);
function displayDescription(raw) {
  return clip(cleanText(String(raw || "").replace(/[\r\n]+/g, ". ").replace(/\.\s*\./g, ".")), 400);
}

// Small neutral glyphs for service types, picked from the (live) category name. Purely decorative.
const KIND_ICONS = {
  people: "M16 11a3 3 0 100-6 3 3 0 000 6zM8 11a3 3 0 100-6 3 3 0 000 6zM3 20c0-3 2.5-5 5-5s5 2 5 5M13 15c.7-.3 1.4-.5 2.2-.5 2.600 0 5 1.800 5 5.5",
  heart: "M12 20s-7-4.5-7-10a4 4 0 017-2.5A4 4 0 0119 10c0 5.5-7 10-7 10z",
  eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 15a3 3 0 100-6 3 3 0 000 6z",
  chat: "M4 5h16v11H9l-5 4z",
  share: "M18 8a3 3 0 100-6 3 3 0 000 6zM6 15a3 3 0 100-6 3 3 0 000 6zM18 22a3 3 0 100-6 3 3 0 000 6zM8.600 13.500l6.800 4M15.400 6.500l-6.800 4",
  save: "M6 3h12v18l-6-4-6 4z",
  play: "M6 4l14 8-14 8z",
  star: "M12 3l2.8 5.7 6.2.9-4.5 4.400 1.1 6.2L12 17.200 6.400 20.200l1.1-6.2L3 9.600l6.2-.9z",
  bolt: "M13 2L4 14h7l-1 8 9-12h-7z",
};
function kindIcon(label) {
  const t = String(label || "").toLowerCase();
  const k = /follow|subscri|member|fan|friend|audience|group|channel/.test(t) ? "people"
    : /like|react|love|heart|vote|poll/.test(t) ? "heart"
    : /view|impress|reach|watch|visit|traffic/.test(t) ? "eye"
    : /comment|repl|message|dm|mention/.test(t) ? "chat"
    : /share|repost|retweet|forward/.test(t) ? "share"
    : /save|bookmark|favou?rite/.test(t) ? "save"
    : /live|stream|play|listen|story|reel|video/.test(t) ? "play"
    : /review|rating|rate|star/.test(t) ? "star" : "bolt";
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="${KIND_ICONS[k]}"/></svg>`;
}

function serviceCard(svc) {
  const unit = svc.unit ? svc.unit : "1,000";
  const { title, tags } = displayService(svc);
  const desc = displayDescription(svc.description);
  return `
  <article class="service-card" data-reveal data-platform="${pfAttr(svc.platform)}" data-category="${escapeHtml(svc.category)}">
    <div class="service-card__top">
      <span class="platform-tag" data-platform="${pfAttr(svc.platform)}">${platformIcon(svc.platform)}${escapeHtml(platformLabel(svc.platform))}</span>
      ${svc.featured ? '<span class="badge badge--accent">Popular</span>' : ""}
    </div>
    <h3 class="service-card__name" title="${escapeHtml(svc.name)}">${escapeHtml(title)}</h3>
    ${tags.length ? `<ul class="service-card__tags" aria-label="Service details">${tags.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul>` : ""}
    ${desc ? `<p class="service-card__desc" title="${escapeHtml(String(svc.description || ""))}">${escapeHtml(desc)}</p>` : '<p class="service-card__desc"></p>'}
    <dl class="service-card__meta">
      <div class="service-card__price"><dt>Starting at</dt><dd>${formatCurrency(svc.pricePer1000)} <span class="muted">/ ${escapeHtml(unit)}</span></dd></div>
      <div><dt>Min – Max</dt><dd>${formatNumber(svc.min)} – ${formatNumber(svc.max)}</dd></div>
    </dl>
    <a class="btn btn--primary btn--block" href="service-order?service=${encodeURIComponent(svc.id)}">Order Now</a>
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

const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const fromPrice = (n) => (Number.isFinite(n) ? `From ${formatCurrency(n)}` : "");
const hrefFor = (platformId, categoryId) => `services?platform=${encodeURIComponent(platformId)}${categoryId ? `&category=${encodeURIComponent(categoryId)}` : ""}`;

function categoryTile(categoryId, platformId, info) {
  const label = displayCategory(categoryId, platformId);
  return `
  <a class="catalogue-tile catalogue-tile--type" data-reveal data-platform="${pfAttr(platformId)}" href="${hrefFor(platformId, categoryId)}" title="${escapeHtml(categoryLabel(categoryId))}">
    <span class="catalogue-tile__glyph" aria-hidden="true">${kindIcon(label)}</span>
    <span class="catalogue-tile__body">
      <span class="catalogue-tile__label">${escapeHtml(label)}</span>
      <span class="catalogue-tile__count">${plural(info.count, "service")}${info.min != null ? ` · ${fromPrice(info.min)}` : ""}</span>
    </span>
    <svg class="catalogue-tile__go" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M9 6l6 6-6 6"/></svg>
  </a>`;
}

function platformTile(platformId, info) {
  return `
  <a class="catalogue-tile catalogue-tile--platform" data-reveal data-platform="${pfAttr(platformId)}" href="${hrefFor(platformId)}">
    <span class="catalogue-tile__icon platform-badge platform-badge--${pfAttr(platformId)}" data-platform="${pfAttr(platformId)}" aria-hidden="true">${PLATFORM_ICONS[pfKey(platformId)] || ""}</span>
    <span class="catalogue-tile__body">
      <span class="catalogue-tile__label">${escapeHtml(platformLabel(platformId))}</span>
      ${info.count > 0
        ? `<span class="catalogue-tile__count">${plural(info.types, "service type")} · ${plural(info.count, "service")}</span>
      ${info.min != null ? `<span class="catalogue-tile__from">${fromPrice(info.min)}</span>` : ""}`
        : `<span class="catalogue-tile__count">Currently unavailable</span>`}
    </span>
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
  parts.push(category ? `<a href="${hrefFor(platform)}" data-platform="${pfAttr(platform)}">${escapeHtml(platformLabel(platform))}</a>` : `<span data-platform="${pfAttr(platform)}" aria-current="page">${escapeHtml(platformLabel(platform))}</span>`);
  if (category) parts.push(`<span aria-current="page">${escapeHtml(displayCategory(category, platform))}</span>`);
  nav.innerHTML = parts.join(` <span class="muted" aria-hidden="true">/</span> `);
}

// Groups live services into {count, min price, ...} per key, preserving the order the admin set (display_order).
function groupBy(list, keyFn) {
  const m = new Map();
  for (const s of list) {
    const k = keyFn(s);
    const g = m.get(k) || { key: k, count: 0, min: null, types: new Set(), order: m.size };
    g.count += 1;
    g.min = g.min == null ? s.pricePer1000 : Math.min(g.min, s.pricePer1000);
    g.types.add(s.category);
    m.set(k, g);
  }
  return [...m.values()].map((g) => ({ ...g, types: g.types.size }));
}

function sortTiles(groups, sort, labelFn) {
  const g = groups.slice();
  if (sort === "admin") return g.sort((a, b) => a.order - b.order);
  if (sort === "count") return g.sort((a, b) => b.count - a.count || labelFn(a.key).localeCompare(labelFn(b.key)));
  if (sort === "price") return g.sort((a, b) => (a.min ?? Infinity) - (b.min ?? Infinity) || labelFn(a.key).localeCompare(labelFn(b.key)));
  return g.sort((a, b) => labelFn(a.key).localeCompare(labelFn(b.key)));
}
const TILE_SORTS = [["name", "Name: A–Z"], ["admin", "Store order"], ["count", "Most services"], ["price", "Lowest price"]];
const SERVICE_SORTS = [["featured", "Featured first"], ["price-asc", "Price: low to high"], ["price-desc", "Price: high to low"], ["name-asc", "Name: A–Z"]];

// ---------------------------------------------------------------------------------------------------------------
// Platform page (sidebar + selected category). Everything shown comes from the live catalogue passed in; nothing
// here is hardcoded content. One DOM, two layouts: wide screens show the category sidebar next to the services,
// phones show either the category list OR the selected category (with Back + a compact switcher), never both.
// ---------------------------------------------------------------------------------------------------------------
const CHEVRON = `<svg class="cat-nav__go" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M9 6l6 6-6 6"/></svg>`;
const BACK_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M15 6l-6 6 6 6"/></svg>`;
const rangeText = (list) => {
  const mins = list.map((x) => x.pricePer1000).filter(Number.isFinite);
  return mins.length ? `From ${formatCurrency(Math.min(...mins))}` : "";
};

function platformHeaderHtml(platform, inPlatform, typeCount) {
  const bits = [plural(typeCount, "service type"), plural(inPlatform.length, "service"), rangeText(inPlatform)].filter(Boolean);
  return `
  <header class="cat-head">
    <span class="cat-head__badge platform-badge platform-badge--${pfAttr(platform)}" data-platform="${pfAttr(platform)}" aria-hidden="true">${PLATFORM_ICONS[pfKey(platform)] || ""}</span>
    <div class="cat-head__text">
      <h2 class="cat-head__title" data-cat-title tabindex="-1">${escapeHtml(platformLabel(platform))} Services</h2>
      <p class="cat-head__sub">${escapeHtml(bits.join(" · "))}</p>
    </div>
  </header>`;
}

function helpCardHtml(platform) {
  return `
  <aside class="cat-help" aria-label="Help">
    <h3 class="cat-help__title">Need help with ${escapeHtml(platformLabel(platform))}?</h3>
    <p class="cat-help__text">Our support team is ready to assist with any questions or issues.</p>
    <a class="btn btn--primary btn--block" href="support">Contact Support</a>
  </aside>`;
}

function navHtml(platform, groups, activeCategory) {
  const items = groups.map((g) => {
    const label = displayCategory(g.key, platform);
    const active = g.key === activeCategory;
    return `<li><a class="cat-nav__item${active ? " is-active" : ""}" data-cat-link data-cat-key="${escapeHtml(g.key)}" href="${hrefFor(platform, g.key)}" title="${escapeHtml(categoryLabel(g.key))}"${active ? ' aria-current="page"' : ""}>
      <span class="cat-nav__glyph" aria-hidden="true">${kindIcon(label)}</span>
      <span class="cat-nav__body"><span class="cat-nav__label">${escapeHtml(label)}</span><span class="cat-nav__count">${plural(g.count, "service")}${g.min != null ? ` · ${fromPrice(g.min)}` : ""}</span></span>${CHEVRON}</a></li>`;
  });
  return `<nav class="cat-nav" aria-label="${escapeHtml(platformLabel(platform))} service types"><p class="cat-nav__title">Service types</p><ul class="cat-nav__list">${items.join("")}</ul></nav>`;
}

function categoryMainHtml(platform, category, groups, leaf) {
  const label = displayCategory(category, platform);
  const meta = CATEGORIES.find((c) => c.id === category);
  const note = meta && typeof meta.description === "string" && meta.description.trim() ? displayDescription(meta.description) : rangeText(leaf);
  const options = groups.map((g) => `<option value="${hrefFor(platform, g.key)}"${g.key === category ? " selected" : ""}>${escapeHtml(displayCategory(g.key, platform))} (${g.count})</option>`).join("");
  return `
  <div class="cat-bar">
    <a class="cat-back" data-cat-link href="${hrefFor(platform)}">${BACK_ICON}<span>Back to Categories</span></a>
    <label class="cat-switch"><span class="sr-only">Switch service type</span>
      <select data-cat-switch aria-label="Switch service type">${options}</select></label>
  </div>
  <div class="cat-section">
    <span class="cat-section__glyph" aria-hidden="true">${kindIcon(label)}</span>
    <div class="cat-section__text">
      <h3 class="cat-section__title" data-cat-title tabindex="-1">${escapeHtml(label)}</h3>
      ${note ? `<p class="cat-section__note">${escapeHtml(note)}</p>` : ""}
    </div>
    <span class="cat-section__count">${plural(leaf.length, "service")}</span>
  </div>
  <div data-cat-services-slot></div>`;
}

function promptMainHtml(platform, inPlatform) {
  return `<div class="cat-prompt"><h3>Choose a service type</h3><p>Pick a type on the left to see its ${escapeHtml(platformLabel(platform))} services, prices and order limits.</p><p class="cat-prompt__meta">${escapeHtml([plural(inPlatform.length, "service"), rangeText(inPlatform)].filter(Boolean).join(" · "))}</p></div>`;
}

function unavailableHtml(platform) {
  return `
  <div class="cat-unavailable" data-platform="${pfAttr(platform)}">
    <span class="cat-unavailable__badge platform-badge platform-badge--${pfAttr(platform)}" data-platform="${pfAttr(platform)}" aria-hidden="true">${PLATFORM_ICONS[pfKey(platform)] || ""}</span>
    <h3>${escapeHtml(platformLabel(platform))} services are currently unavailable</h3>
    <p>We don't have any ${escapeHtml(platformLabel(platform))} services available right now. New services appear here as soon as they are added, so please check back soon.</p>
    <div class="cat-unavailable__actions">
      <a class="btn btn--primary" href="services" data-cat-link>Browse other platforms</a>
      <a class="btn btn--secondary" href="support">Contact Support</a>
    </div>
  </div>`;
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

  // The platform page layout lives in a container created here, so services.html needs no change.
  let layout = document.querySelector("[data-cat-layout]");
  if (!layout) {
    layout = document.createElement("div");
    layout.setAttribute("data-cat-layout", "");
    layout.hidden = true;
    (tilesGrid || grid).parentNode.insertBefore(layout, tilesGrid || grid);
  }
  // The services grid is moved into the layout for the selected-category view and put back everywhere else.
  const gridHome = { parent: grid.parentNode, next: grid.nextSibling };
  function restoreGrid() {
    if (grid.parentNode !== gridHome.parent) gridHome.parent.insertBefore(grid, gridHome.next && gridHome.next.parentNode === gridHome.parent ? gridHome.next : null);
  }
  function hideLayout() {
    document.body.classList.remove("cat-platform-view");
    restoreGrid();
    layout.hidden = true;
    layout.innerHTML = "";
  }
  let savedScroll = null;   // scroll position of the category list, restored when the user comes Back to it
  let lastCategory = "";    // the category they were just in, so the list can highlight where they were

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

  // The sort control adapts to the level being shown: tiles (platforms / service types) vs. services.
  let sortMode = "";
  const sortValues = { tiles: "name", services: "featured" };
  function setSortMode(mode) {
    if (!sortSelect || sortMode === mode) return;
    if (sortMode) sortValues[sortMode] = sortSelect.value;
    sortMode = mode;
    const opts = mode === "tiles" ? TILE_SORTS : SERVICE_SORTS;
    sortSelect.innerHTML = opts.map(([v, l]) => `<option value="${v}">${l}</option>`).join("");
    sortSelect.value = sortValues[mode];
    sortSelect.setAttribute("aria-label", mode === "tiles" ? "Sort categories" : "Sort services");
  }

  function sortServices(services, sort) {
    if (sort === "price-asc") return services.slice().sort((a, b) => a.pricePer1000 - b.pricePer1000);
    if (sort === "price-desc") return services.slice().sort((a, b) => b.pricePer1000 - a.pricePer1000);
    if (sort === "name-asc") return services.slice().sort((a, b) => a.name.localeCompare(b.name));
    return services.slice().sort((a, b) => (b.featured ? 1 : 0) - (a.featured ? 1 : 0));
  }

  function showEmpty(message) {
    hideLayout();
    setHeading("");
    grid.hidden = true;
    tilesGrid.hidden = true;
    if (emptyState) {
      emptyState.hidden = false;
      emptyState.innerHTML = message;
    }
  }

  function showServiceGrid(services, sort, { inLayout = false } = {}) {
    if (!inLayout) hideLayout();
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
    const all = list();
    const tileLevel = !query && !(platform && category);
    setSortMode(tileLevel ? "tiles" : "services");
    const sort = sortSelect?.value || (tileLevel ? "name" : "featured");

    if (query) {
      renderBreadcrumb("", "");
      const matches = all.filter(
        (s) =>
          s.name.toLowerCase().includes(query) ||
          displayService(s).title.toLowerCase().includes(query) ||
          String(s.description || "").toLowerCase().includes(query) ||
          platformLabel(s.platform).toLowerCase().includes(query) ||
          categoryLabel(s.category).toLowerCase().includes(query) ||
          displayCategory(s.category, s.platform).toLowerCase().includes(query)
      );
      if (countLabel) countLabel.textContent = `${matches.length} result${matches.length === 1 ? "" : "s"} for "${searchInput.value.trim()}"`;
      showServiceGrid(matches, sort);
      return;
    }

    if (!platform) {
      renderBreadcrumb("", "");
      hideLayout();
      const byPlatform = groupBy(all, (s) => s.platform);
      // WhatsApp is always offered as a platform so customers can reach its page; with no admin-configured services it
      // shows the "currently unavailable" state. No services, prices or categories are invented for it.
      if (all.length > 0 && !byPlatform.some((g) => pfKey(g.key) === "whatsapp")) {
        byPlatform.push({ key: "whatsapp", count: 0, min: null, types: 0, order: byPlatform.length });
      }
      if (all.length === 0) {
        showEmpty(`<h3>No services are currently available</h3><p>Please check back soon.</p>`);
        if (countLabel) countLabel.textContent = "0 services";
        return;
      }
      if (countLabel) countLabel.textContent = `${plural(byPlatform.filter((g) => g.count > 0).length, "platform")}, ${plural(all.length, "service")} total`;
      grid.hidden = true;
      if (emptyState) emptyState.hidden = true;
      tilesGrid.hidden = false;
      setHeading("Platforms");
      tilesGrid.innerHTML = sortTiles(byPlatform, sort, platformLabel)
        .map((g) => platformTile(g.key, g))
        .join("");
      initScrollReveal(".catalogue-tile[data-reveal]");
      return;
    }

    const inPlatform = all.filter((s) => s.platform === platform);

    if (inPlatform.length === 0) {
      renderBreadcrumb(platform, "");
      showEmpty(unavailableHtml(platform));
      if (countLabel) countLabel.textContent = `${platformLabel(platform)} services are currently unavailable`;
      return;
    }

    // A category with no services (stale link, or the admin hid them) falls back to the category list.
    let leaf = category ? inPlatform.filter((s) => s.category === category) : [];
    let activeCategory = category;
    if (category && leaf.length === 0) {
      activeCategory = "";
      history.replaceState(null, "", hrefFor(platform));
    }

    const groups = sortTiles(groupBy(inPlatform, (s) => s.category), sortMode === "tiles" ? sortSelect?.value || "name" : sortValues.tiles, (k) => displayCategory(k, platform));
    renderBreadcrumb(platform, activeCategory);
    renderPlatformLayout(platform, activeCategory, inPlatform, groups, leaf, sort);
  }

  let lastKey = null;
  function headerOffset() {
    return (parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--header-height")) || 68) + 8;
  }

  function renderPlatformLayout(platform, category, inPlatform, groups, leaf, sort) {
    tilesGrid.hidden = true;
    tilesGrid.innerHTML = ""; // the category list now lives in the layout; never keep a second copy
    grid.hidden = true;       // no stale service cards from a category the customer just left
    grid.innerHTML = "";
    setHeading("");
    if (emptyState) emptyState.hidden = true;
    restoreGrid();
    layout.hidden = false;
    document.body.classList.add("cat-platform-view"); // lets phones drop the duplicate page title (see catalogue.css)
    layout.className = `cat-layout ${category ? "cat-layout--category" : "cat-layout--list"}`;
    layout.setAttribute("data-platform", pfKey(platform));
    layout.innerHTML = `
      ${platformHeaderHtml(platform, inPlatform, groups.length)}
      <div class="cat-body">
        <div class="cat-side">${navHtml(platform, groups, category)}${helpCardHtml(platform)}</div>
        <section class="cat-main" aria-live="polite">${category ? categoryMainHtml(platform, category, groups, leaf) : promptMainHtml(platform, inPlatform)}</section>
      </div>`;

    if (category) {
      layout.querySelector("[data-cat-services-slot]").appendChild(grid);
      if (countLabel) countLabel.textContent = `${plural(leaf.length, "service")} in ${displayCategory(category, platform)}`;
      showServiceGrid(leaf, sort, { inLayout: true });
    } else {
      if (countLabel) countLabel.textContent = `${plural(groups.length, "service type")} · ${plural(inPlatform.length, "service")}`;
      initScrollReveal(".cat-nav__item");
    }

    // Browsing context: entering a category brings its start into view; returning to the list restores where the
    // customer was and marks the category they just left.
    const key = `${platform}|${category}`;
    if (key !== lastKey) {
      const userNavigated = lastKey !== null;
      if (category) {
        lastCategory = category;
        const top = layout.getBoundingClientRect().top + window.scrollY - headerOffset();
        if (window.scrollY > top) window.scrollTo(0, Math.max(0, top));
        if (userNavigated) layout.querySelector("[data-cat-title]")?.focus({ preventScroll: true });
      } else if (userNavigated) {
        const i = lastKey.indexOf("|");
        const cameBack = lastKey.slice(0, i) === platform && lastKey.slice(i + 1) !== "";
        if (cameBack) {
          if (savedScroll !== null) window.scrollTo(0, savedScroll);
          const last = lastCategory && Array.from(layout.querySelectorAll("[data-cat-key]")).find((a) => a.dataset.catKey === lastCategory);
          if (last) {
            last.classList.add("is-last");
            const r = last.getBoundingClientRect();
            if (r.top < headerOffset() || r.bottom > window.innerHeight) last.scrollIntoView({ block: "center" });
            last.focus({ preventScroll: true });
          }
        } else {
          // A different platform: start at its top, and forget the old platform's list position.
          savedScroll = null;
          lastCategory = "";
          const top = layout.getBoundingClientRect().top + window.scrollY - headerOffset();
          if (window.scrollY > top) window.scrollTo(0, Math.max(0, top));
        }
      }
      lastKey = key;
    }
  }

  searchInput?.addEventListener("input", debounce(render, 200));
  sortSelect?.addEventListener("change", render);
  window.addEventListener("popstate", render);

  // Intercept tile/breadcrumb clicks so browsing is instant (no full page
  // reload) while still updating the URL — back/forward and shareable
  // links both keep working since it's a real query-param-addressable state.
  document.addEventListener("click", (e) => {
    const link = e.target.closest("[data-catalogue-tiles] a, [data-services-breadcrumb] a, [data-cat-layout] a[data-cat-link]");
    if (!link) return;
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.button > 0) return; // let "open in new tab" work
    e.preventDefault();
    // Remember the list's scroll position when stepping from the category list into a category.
    const here = new URLSearchParams(window.location.search);
    if (here.get("platform") && !here.get("category") && /[?&]category=/.test(link.getAttribute("href") || "")) savedScroll = window.scrollY;
    if (searchInput) searchInput.value = "";
    history.pushState(null, "", link.getAttribute("href"));
    render();
  });
  // Compact category switcher (phones): jumps straight to another category without going back to the list.
  document.addEventListener("change", (e) => {
    const sel = e.target.closest?.("[data-cat-switch]");
    if (!sel || !sel.value) return;
    history.pushState(null, "", sel.value);
    render();
  });

  render();
}

export const ServicesService = { preload, list, hasError, isOfflineFallback };
export const ServicesData = { PLATFORMS, CATEGORIES, platformLabel, categoryLabel, platformIcon };
export { findService };