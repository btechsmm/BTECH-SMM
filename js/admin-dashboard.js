/**
 * BTECH SMM — Admin Dashboard analytics (presentation only)
 * ----------------------------------------------------------------
 * Renders KPI cards and charts from data the admin page already has:
 *   orders, profiles   handed in by admin.js (no duplicate requests on load)
 *   payments           one read-only select (admin RLS: payments_select_admin)
 *   services           names/platforms, seeded from ServicesService + one select
 * It writes nothing, changes no backend behaviour and calls no RPC/Edge Function.
 *
 * Charts are plain inline SVG/HTML — no chart library, no CDN, nothing for the
 * service worker or the PWA to cache. Every number comes from real rows; when a
 * period has no data the section says so instead of drawing anything.
 *
 * Not shown on purpose: profit/margin. Provider rates are stored in USD and the
 * database has no exchange rate, so a KES margin can't be calculated honestly.
 */

import { supabase } from "./supabase.js";
import { ServicesService, ServicesData } from "./services.js";
import { formatCurrency, formatNumber, escapeHtml } from "./utils.js";

const ROW_CAP = 1000; // Supabase's default max rows per select
const DAY = 86400000;

const RANGES = [
  { key: "7d", title: "Last 7 days", days: 7 },
  { key: "30d", title: "Last 30 days", days: 30 },
  { key: "90d", title: "Last 90 days", days: 90 },
  { key: "12m", title: "Last 12 months", months: 12 },
  { key: "all", title: "All time" },
];

const ORDER_STATUS = {
  pending: { label: "Pending", color: "var(--color-warning)" },
  processing: { label: "Processing", color: "var(--color-primary)" },
  completed: { label: "Completed", color: "var(--color-success)" },
  cancelled: { label: "Cancelled", color: "var(--color-error)" },
};

const PAYMENT_STATUS = {
  paid: { label: "Paid", color: "var(--color-success)" },
  pending: { label: "Pending", color: "var(--color-warning)" },
  failed: { label: "Failed", color: "var(--color-error)" },
  cancelled: { label: "Cancelled", color: "var(--color-muted)" },
  expired: { label: "Expired", color: "var(--border-strong)" },
};

const st = {
  orders: [],
  profiles: [],
  meta: new Map(), // service id -> { name, platform }
  payments: null,
  paymentsError: false,
  range: "30d",
};

let root = null;

/* ------------------------------ date helpers ----------------------------- */
const pad = (n) => String(n).padStart(2, "0");
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const bucketKey = (d, mode) => (mode === "month" ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}` : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
const bucketLabel = (d, mode) =>
  mode === "month" ? d.toLocaleDateString("en-KE", { month: "short", year: "2-digit" }) : d.toLocaleDateString("en-KE", { day: "numeric", month: "short" });

function earliest() {
  let t = Infinity;
  for (const o of st.orders) t = Math.min(t, new Date(o.created_at).getTime());
  for (const p of st.payments || []) t = Math.min(t, new Date(p.created_at).getTime());
  return Number.isFinite(t) ? new Date(t) : null;
}

function windowFor(key) {
  const cfg = RANGES.find((r) => r.key === key) || RANGES[1];
  const end = new Date();
  let start;
  let mode = "day";
  if (cfg.days) {
    start = new Date(startOfDay(end).getTime() - (cfg.days - 1) * DAY);
  } else if (cfg.months) {
    start = new Date(end.getFullYear(), end.getMonth() - (cfg.months - 1), 1);
    mode = "month";
  } else {
    const first = earliest();
    start = first ? startOfDay(first) : startOfDay(end);
    if ((end - start) / DAY > 92) {
      mode = "month";
      start = new Date(start.getFullYear(), start.getMonth(), 1);
    }
  }
  return { key: cfg.key, title: cfg.title, days: cfg.days, start, end, mode, hasPrev: cfg.key !== "all" };
}

function buckets(w) {
  const out = [];
  const cur = new Date(w.start);
  while (cur <= w.end) {
    out.push({ key: bucketKey(cur, w.mode), label: bucketLabel(cur, w.mode) });
    if (w.mode === "day") cur.setDate(cur.getDate() + 1);
    else cur.setMonth(cur.getMonth() + 1);
  }
  return out;
}

function bucketize(items, w, getDate, getVal, pred = () => true) {
  const bs = buckets(w);
  const idx = new Map(bs.map((b, i) => [b.key, i]));
  const vals = new Array(bs.length).fill(0);
  for (const it of items) {
    if (!pred(it)) continue;
    const d = new Date(getDate(it));
    if (d < w.start || d > w.end) continue;
    const i = idx.get(bucketKey(d, w.mode));
    if (i != null) vals[i] += getVal(it);
  }
  return { labels: bs.map((b) => b.label), vals };
}

/* -------------------------------- metrics -------------------------------- */
const sum = (arr, f) => arr.reduce((t, x) => t + f(x), 0);
const isDeposit = (p) => p.payment_type === "wallet_deposit";

function metrics(start, end) {
  const inR = (iso) => {
    const t = new Date(iso);
    return t >= start && t <= end;
  };
  const os = st.orders.filter((o) => inR(o.created_at));
  const paid = os.filter((o) => o.payment_status === "paid");
  const deps = st.payments ? st.payments.filter((p) => isDeposit(p) && p.status === "paid" && inR(p.created_at)) : null;
  return {
    orders: os,
    total: os.length,
    paid,
    revenue: sum(paid, (o) => Number(o.amount)),
    pending: os.filter((o) => o.status === "pending").length,
    processing: os.filter((o) => o.status === "processing").length,
    completed: os.filter((o) => o.status === "completed").length,
    cancelled: os.filter((o) => o.status === "cancelled").length,
    deposits: deps ? sum(deps, (p) => Number(p.amount)) : null,
    depositCount: deps ? deps.length : 0,
    newCustomers: st.profiles.filter((p) => p.role === "customer" && inR(p.created_at)).length,
  };
}

/** A previous-period comparison is only legitimate if the loaded rows reach back that far. */
function covers(rows, prevStart) {
  if (rows.length < ROW_CAP) return true;
  return new Date(rows[rows.length - 1].created_at) <= prevStart;
}

function delta(curr, prev, ok, w) {
  if (!ok || !w.hasPrev || !(prev > 0)) return "";
  const pct = ((curr - prev) / prev) * 100;
  const cls = pct > 0.05 ? "up" : pct < -0.05 ? "down" : "flat";
  const arrow = cls === "up" ? "▲" : cls === "down" ? "▼" : "•";
  const prevTitle = w.days ? `previous ${w.days} days` : "previous 12 months";
  return `<span class="adash-delta adash-delta--${cls}">${arrow} ${Math.abs(pct).toFixed(1)}%</span> <span class="adash-kpi__muted">vs ${prevTitle}</span>`;
}

/* ------------------------------ small pieces ----------------------------- */
const skeleton = (h = 220) => `<div class="skeleton" style="height:${h}px"></div>`;
const emptyHtml = (msg = "No data available for this period.") => `<div class="adash-empty"><p>${msg}</p></div>`;
const errorHtml = (msg, retry) => `<div class="adash-empty adash-empty--error"><p>${msg}</p><button type="button" class="btn btn--secondary btn--sm" data-adash-retry="${retry}">Retry</button></div>`;

function niceMax(v, integer) {
  if (!(v > 0)) return integer ? 4 : 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  const m = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  const max = m * p;
  return integer ? Math.max(max, 1) : max;
}

const compact = (v) => (v >= 1e6 ? `${+(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${+(v / 1e3).toFixed(1)}k` : String(Math.round(v * 100) / 100));

/* ---------------------------- SVG line / bar chart ----------------------- */
export function chart(el, { type, labels, series, money, integer, title }) {
  const W = 760;
  const H = 270;
  const L = money ? 62 : 44;
  const R = 14;
  const T = 14;
  const B = 28;
  const iw = W - L - R;
  const ih = H - T - B;
  const n = labels.length;
  const all = series.flatMap((s) => s.values);
  const yMax = niceMax(Math.max(0, ...all), integer);
  const steps = integer ? Math.min(4, yMax) : 4;
  const yAt = (v) => T + ih - (v / yMax) * ih;
  const xAt = (i) => (type === "bar" ? L + (iw / n) * (i + 0.5) : n === 1 ? L + iw / 2 : L + (i * iw) / (n - 1));
  const fmtAxis = (v) => (money ? `KES ${compact(v)}` : compact(v));
  const fmtTip = (v) => (money ? formatCurrency(v) : formatNumber(v));

  let grid = "";
  for (let i = 0; i <= steps; i++) {
    const v = (yMax * i) / steps;
    grid += `<line x1="${L}" x2="${W - R}" y1="${yAt(v)}" y2="${yAt(v)}" class="adash-grid" /><text x="${L - 8}" y="${yAt(v) + 4}" text-anchor="end" class="adash-axis">${fmtAxis(v)}</text>`;
  }
  const every = Math.max(1, Math.ceil(n / 6));
  let xl = "";
  labels.forEach((lb, i) => {
    if (i % every === 0) xl += `<text x="${xAt(i)}" y="${H - 8}" text-anchor="middle" class="adash-axis">${escapeHtml(lb)}</text>`;
  });

  let marks = "";
  if (type === "line") {
    series.forEach((s) => {
      const pts = s.values.map((v, i) => `${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`);
      if (series.length === 1 && n > 1) marks += `<polygon points="${xAt(0)},${yAt(0)} ${pts.join(" ")} ${xAt(n - 1)},${yAt(0)}" style="fill:${s.color}" class="adash-area" />`;
      marks += `<polyline points="${pts.join(" ")}" style="stroke:${s.color}" class="adash-line" />`;
      if (n <= 14) s.values.forEach((v, i) => (marks += `<circle cx="${xAt(i)}" cy="${yAt(v)}" r="3" style="fill:${s.color}" />`));
    });
  } else {
    const bw = Math.min(28, (iw / n) * 0.62);
    series.forEach((s) =>
      s.values.forEach((v, i) => {
        if (v > 0) marks += `<rect x="${xAt(i) - bw / 2}" y="${yAt(v)}" width="${bw}" height="${yAt(0) - yAt(v)}" rx="2" style="fill:${s.color}" />`;
      })
    );
  }

  const legend =
    series.length > 1
      ? `<ul class="adash-legend adash-legend--inline">${series.map((s) => `<li><span class="adash-swatch" style="background:${s.color}"></span>${escapeHtml(s.name)}</li>`).join("")}</ul>`
      : "";

  el.insertAdjacentHTML(
    "beforeend",
    `${legend}<div class="adash-chart">
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${escapeHtml(title)}" preserveAspectRatio="xMidYMid meet">
        ${grid}${xl}${marks}
        <line class="adash-hover-line" x1="0" x2="0" y1="${T}" y2="${T + ih}" style="visibility:hidden" />
        <rect class="adash-hit" x="${L}" y="${T}" width="${iw}" height="${ih}" fill="transparent" />
      </svg>
      <div class="adash-tip" hidden></div>
    </div>`
  );

  const wrap = el.querySelector(".adash-chart");
  const svg = wrap.querySelector("svg");
  const tip = wrap.querySelector(".adash-tip");
  const vline = wrap.querySelector(".adash-hover-line");
  const hide = () => {
    tip.hidden = true;
    vline.style.visibility = "hidden";
  };
  svg.addEventListener("pointermove", (e) => {
    const box = svg.getBoundingClientRect();
    const x = ((e.clientX - box.left) / box.width) * W;
    let i = type === "bar" ? Math.floor(((x - L) / iw) * n) : Math.round(((x - L) / iw) * (n - 1));
    i = Math.max(0, Math.min(n - 1, i));
    const cx = xAt(i);
    vline.setAttribute("x1", cx);
    vline.setAttribute("x2", cx);
    vline.style.visibility = "visible";
    tip.innerHTML = `<strong>${escapeHtml(labels[i])}</strong>${series
      .map((s) => `<span><i class="adash-swatch" style="background:${s.color}"></i>${escapeHtml(s.name)}: ${fmtTip(s.values[i])}</span>`)
      .join("")}`;
    tip.hidden = false;
    const left = (cx / W) * box.width;
    tip.style.left = `${Math.min(Math.max(left, 70), box.width - 70)}px`;
  });
  svg.addEventListener("pointerleave", hide);
}

/* ---------------------------------- donut -------------------------------- */
export function donut(el, items, { centerLabel, money }) {
  const total = sum(items, (i) => i.value);
  const C = 2 * Math.PI * 38;
  let offset = 0;
  const segs = items
    .map((i) => {
      const len = (i.value / total) * C;
      const seg = `<circle cx="50" cy="50" r="38" fill="none" stroke-width="14" style="stroke:${i.color}" stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 50 50)"><title>${escapeHtml(i.label)}: ${formatNumber(i.value)}</title></circle>`;
      offset += len;
      return seg;
    })
    .join("");
  const legend = items
    .map(
      (i) =>
        `<li><span class="adash-swatch" style="background:${i.color}"></span><span class="adash-legend__name">${escapeHtml(i.label)}</span><span class="adash-legend__val">${formatNumber(i.value)}${i.sub ? ` <em>${i.sub}</em>` : ""}<em>${((i.value / total) * 100).toFixed(0)}%</em></span></li>`
    )
    .join("");
  el.innerHTML = `<div class="adash-donut">
    <div class="adash-donut__ring"><svg viewBox="0 0 100 100" role="img" aria-label="${escapeHtml(centerLabel)} breakdown">${segs}</svg>
      <div class="adash-donut__center"><strong>${money ? compact(total) : formatNumber(total)}</strong><span>${escapeHtml(centerLabel)}</span></div></div>
    <ul class="adash-legend">${legend}</ul></div>`;
}

/* ------------------------------ horizontal bars -------------------------- */
export function hbars(el, rows) {
  const max = Math.max(...rows.map((r) => r.value));
  el.innerHTML = `<ul class="adash-bars">${rows
    .map(
      (r) => `<li>
      <div class="adash-bars__row"><span class="adash-bars__label" title="${escapeHtml(r.label)}">${escapeHtml(r.label)}</span><span class="adash-bars__value">${r.display}</span></div>
      <div class="adash-bars__track"><div class="adash-bars__fill" style="width:${Math.max(2, (r.value / max) * 100)}%"></div></div>
      ${r.sub ? `<span class="adash-bars__sub">${r.sub}</span>` : ""}
    </li>`
    )
    .join("")}</ul>`;
}

/* -------------------------------- sections ------------------------------- */
function renderKpis(el, w) {
  const cur = metrics(w.start, w.end);
  const span = w.end - w.start;
  const prevStart = new Date(w.start.getTime() - span - 1);
  const prevEnd = new Date(w.start.getTime() - 1);
  const prev = metrics(prevStart, prevEnd);
  const okOrders = covers(st.orders, prevStart);
  const okPay = st.payments ? covers(st.payments, prevStart) : false;
  const totalCustomers = st.profiles.filter((p) => p.role === "customer").length;

  const card = (label, value, sub, accent = false) =>
    `<div class="stat-card adash-kpi${accent ? " stat-card--accent" : ""}"><p class="stat-card__label">${label}</p><p class="stat-card__value">${value}</p><p class="adash-kpi__sub">${sub}</p></div>`;

  const depositValue = st.payments ? formatCurrency(cur.deposits) : st.paymentsError ? "Unavailable" : "…";
  const depositSub = st.payments ? `${formatNumber(cur.depositCount)} deposit${cur.depositCount === 1 ? "" : "s"} ${delta(cur.deposits, prev.deposits, okPay, w)}` : "";

  el.innerHTML =
    card("Revenue", formatCurrency(cur.revenue), `${formatNumber(cur.paid.length)} paid order${cur.paid.length === 1 ? "" : "s"} ${delta(cur.revenue, prev.revenue, okOrders, w)}`, true) +
    card("Orders", formatNumber(cur.total), delta(cur.total, prev.total, okOrders, w) || `<span class="adash-kpi__muted">placed in period</span>`) +
    card("Completed", formatNumber(cur.completed), cur.total ? `<span class="adash-kpi__muted">${Math.round((cur.completed / cur.total) * 100)}% of orders placed</span>` : `<span class="adash-kpi__muted">No orders yet</span>`) +
    card("In progress", formatNumber(cur.pending + cur.processing), `<span class="adash-kpi__muted">${formatNumber(cur.pending)} pending · ${formatNumber(cur.processing)} processing</span>`) +
    card("Customers", formatNumber(totalCustomers), `<span class="adash-kpi__muted">+${formatNumber(cur.newCustomers)} new in period</span>`) +
    card("Wallet deposits", depositValue, depositSub || `<span class="adash-kpi__muted">M-Pesa top-ups</span>`) +
    (st.orders.length >= ROW_CAP ? `<p class="adash-note">Showing the latest ${formatNumber(ROW_CAP)} orders; totals for older periods may be incomplete.</p>` : "");
}

function renderRevenue(el, w) {
  const d = bucketize(st.orders, w, (o) => o.created_at, (o) => Number(o.amount), (o) => o.payment_status === "paid");
  const total = sum(d.vals, (v) => v);
  if (!(total > 0)) return void (el.innerHTML = emptyHtml());
  const per = w.mode === "month" ? "month" : "day";
  el.innerHTML = `<div class="adash-summary"><div><span>Revenue in period</span><strong>${formatCurrency(total)}</strong></div><div><span>Average per ${per}</span><strong>${formatCurrency(total / d.vals.length)}</strong></div><div><span>Best ${per}</span><strong>${formatCurrency(Math.max(...d.vals))}</strong></div></div>`;
  chart(el, { type: "line", labels: d.labels, series: [{ name: "Revenue", color: "var(--color-primary)", values: d.vals }], money: true, title: "Revenue trend" });
}

function renderActivity(el, w) {
  const os = st.orders;
  const mk = (pred) => bucketize(os, w, (o) => o.created_at, () => 1, pred).vals;
  const placed = bucketize(os, w, (o) => o.created_at, () => 1);
  if (!sum(placed.vals, (v) => v)) return void (el.innerHTML = emptyHtml());
  chart(el, {
    type: "line",
    labels: placed.labels,
    integer: true,
    title: "Order activity",
    series: [
      { name: "Placed", color: "var(--color-primary)", values: placed.vals },
      { name: "Completed", color: "var(--color-success)", values: mk((o) => o.status === "completed") },
      { name: "Cancelled", color: "var(--color-error)", values: mk((o) => o.status === "cancelled") },
    ],
  });
  el.insertAdjacentHTML("beforeend", `<p class="adash-foot">Grouped by the date each order was placed, with its current status.</p>`);
}

function renderStatus(el, w) {
  const m = metrics(w.start, w.end);
  const items = Object.entries(ORDER_STATUS)
    .map(([k, v]) => ({ label: v.label, color: v.color, value: m.orders.filter((o) => o.status === k).length }))
    .filter((i) => i.value > 0);
  if (!items.length) return void (el.innerHTML = emptyHtml());
  donut(el, items, { centerLabel: "orders" });
}

function serviceInfo(id) {
  return st.meta.get(id) || { name: "Unknown service", platform: "" };
}

function renderTopServices(el, w) {
  const m = metrics(w.start, w.end);
  const by = new Map();
  for (const o of m.orders) {
    const r = by.get(o.service_id) || { count: 0, revenue: 0 };
    r.count += 1;
    if (o.payment_status === "paid") r.revenue += Number(o.amount);
    by.set(o.service_id, r);
  }
  const rows = [...by.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 7);
  if (!rows.length) return void (el.innerHTML = emptyHtml());
  hbars(
    el,
    rows.map(([id, r]) => ({ label: serviceInfo(id).name, value: r.count, display: `${formatNumber(r.count)} order${r.count === 1 ? "" : "s"}`, sub: `${formatCurrency(r.revenue)} paid revenue` }))
  );
}

function renderPlatforms(el, w) {
  const m = metrics(w.start, w.end);
  const by = new Map();
  for (const o of m.orders) {
    const p = serviceInfo(o.service_id).platform;
    if (!p) continue;
    const r = by.get(p) || { count: 0, revenue: 0 };
    r.count += 1;
    if (o.payment_status === "paid") r.revenue += Number(o.amount);
    by.set(p, r);
  }
  if (!by.size) return void (el.innerHTML = emptyHtml());
  const byRevenue = sum([...by.values()], (r) => r.revenue) > 0;
  const rows = [...by.entries()].sort((a, b) => (byRevenue ? b[1].revenue - a[1].revenue : b[1].count - a[1].count));
  hbars(
    el,
    rows.map(([p, r]) => ({
      label: ServicesData.platformLabel(p),
      value: byRevenue ? r.revenue : r.count,
      display: byRevenue ? formatCurrency(r.revenue) : `${formatNumber(r.count)} orders`,
      sub: byRevenue ? `${formatNumber(r.count)} order${r.count === 1 ? "" : "s"}` : "",
    }))
  );
}

function paymentsGate(el, retryKey) {
  if (st.payments) return true;
  el.innerHTML = st.paymentsError ? errorHtml("Payment data couldn't be loaded.", retryKey) : skeleton(180);
  return false;
}

function renderPayments(el, w) {
  if (!paymentsGate(el, "payments")) return;
  const inR = (iso) => {
    const t = new Date(iso);
    return t >= w.start && t <= w.end;
  };
  const list = st.payments.filter((p) => inR(p.created_at));
  const group = (keys) => list.filter((p) => keys.includes(p.status));
  const defs = [
    ["paid", ["paid"]],
    ["pending", ["pending", "processing"]],
    ["failed", ["failed"]],
    ["cancelled", ["cancelled"]],
    ["expired", ["expired"]],
  ];
  const items = defs
    .map(([k, keys]) => ({ label: PAYMENT_STATUS[k].label, color: PAYMENT_STATUS[k].color, value: group(keys).length, sub: formatCurrency(sum(group(keys), (p) => Number(p.amount))) }))
    .filter((i) => i.value > 0);
  if (!items.length) return void (el.innerHTML = emptyHtml());
  donut(el, items, { centerLabel: "M-Pesa requests" });
}

function renderWallet(el, w) {
  if (!paymentsGate(el, "payments")) return;
  const d = bucketize(st.payments, w, (p) => p.created_at, (p) => Number(p.amount), (p) => isDeposit(p) && p.status === "paid");
  const total = sum(d.vals, (v) => v);
  if (!(total > 0)) return void (el.innerHTML = emptyHtml());
  const count = st.payments.filter((p) => isDeposit(p) && p.status === "paid" && new Date(p.created_at) >= w.start && new Date(p.created_at) <= w.end).length;
  el.innerHTML = `<div class="adash-summary"><div><span>Deposited in period</span><strong>${formatCurrency(total)}</strong></div><div><span>Deposits</span><strong>${formatNumber(count)}</strong></div></div>`;
  chart(el, { type: "bar", labels: d.labels, series: [{ name: "Deposits", color: "var(--color-success)", values: d.vals }], money: true, title: "Wallet deposits" });
}

/* ------------------------------ orchestration ---------------------------- */
const SECTIONS = {
  "[data-adash-kpis]": renderKpis,
  "[data-adash-revenue]": renderRevenue,
  "[data-adash-activity]": renderActivity,
  "[data-adash-status]": renderStatus,
  "[data-adash-top]": renderTopServices,
  "[data-adash-platform]": renderPlatforms,
  "[data-adash-payments]": renderPayments,
  "[data-adash-wallet]": renderWallet,
};
const PAYMENT_DEPENDENT = ["[data-adash-kpis]", "[data-adash-payments]", "[data-adash-wallet]"];
const META_DEPENDENT = ["[data-adash-top]", "[data-adash-platform]"];

function mount(sel) {
  const el = document.querySelector(sel);
  if (!el) return;
  try {
    el.innerHTML = "";
    SECTIONS[sel](el, windowFor(st.range));
  } catch (err) {
    console.error(`Admin dashboard section ${sel} failed:`, err);
    el.innerHTML = errorHtml("This section couldn't be displayed.", sel);
  }
}

function renderAll() {
  const w = windowFor(st.range);
  document.querySelectorAll("[data-adash-range-label]").forEach((n) => (n.textContent = w.title));
  root.querySelectorAll("[data-range]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.range === st.range)));
  Object.keys(SECTIONS).forEach(mount);
}

async function loadPayments() {
  st.paymentsError = false;
  try {
    const { data, error } = await supabase.from("payments").select("id,payment_type,amount,status,created_at").order("created_at", { ascending: false });
    if (error) throw error;
    st.payments = data || [];
  } catch (err) {
    console.error("Admin dashboard: payments unavailable:", err?.message || err);
    st.payments = null;
    st.paymentsError = true;
  }
  PAYMENT_DEPENDENT.forEach(mount);
}

async function loadMeta() {
  try {
    const { data, error } = await supabase.from("services").select("id,name,platform");
    if (error) throw error;
    for (const s of data || []) st.meta.set(s.id, { name: s.name, platform: s.platform });
  } catch (err) {
    console.error("Admin dashboard: service names unavailable:", err?.message || err);
  }
  META_DEPENDENT.forEach(mount);
}

async function refreshAll(btn) {
  btn.disabled = true;
  btn.setAttribute("aria-busy", "true");
  try {
    const [o, p] = await Promise.all([
      supabase.from("orders").select("*").order("created_at", { ascending: false }),
      supabase.from("profiles").select("id,role,created_at"),
    ]);
    if (!o.error) st.orders = o.data || [];
    if (!p.error) st.profiles = p.data || [];
  } catch (err) {
    console.error("Admin dashboard refresh failed:", err);
  }
  renderAll();
  await Promise.all([loadPayments(), loadMeta()]);
  const stamp = root.querySelector("[data-adash-updated]");
  if (stamp) stamp.textContent = `Updated ${new Date().toLocaleTimeString("en-KE", { hour: "2-digit", minute: "2-digit" })}`;
  btn.disabled = false;
  btn.removeAttribute("aria-busy");
}

export async function initAdminDashboard({ orders, profiles }) {
  root = document.querySelector("[data-adash]");
  if (!root) return;
  st.orders = orders || [];
  st.profiles = profiles || [];
  for (const s of ServicesService.list()) st.meta.set(s.id, { name: s.name, platform: s.platform });

  if (!root.dataset.wired) {
    root.dataset.wired = "1";
    root.addEventListener("click", (e) => {
      const rangeBtn = e.target.closest("[data-range]");
      if (rangeBtn) {
        st.range = rangeBtn.dataset.range;
        return renderAll();
      }
      const refresh = e.target.closest("[data-adash-refresh]");
      if (refresh) return void refreshAll(refresh);
      const retry = e.target.closest("[data-adash-retry]");
      if (retry) {
        const key = retry.dataset.adashRetry;
        return key === "payments" ? void loadPayments() : mount(key);
      }
    });
  }

  renderAll();
  const stamp = root.querySelector("[data-adash-updated]");
  if (stamp) stamp.textContent = `Updated ${new Date().toLocaleTimeString("en-KE", { hour: "2-digit", minute: "2-digit" })}`;
  await Promise.all([loadPayments(), loadMeta()]);
}