/**
 * BTECH SMM — BTECH INSIGHTS
 * ----------------------------------------------------------------
 * Business intelligence for admins. Every figure comes from a read-only,
 * admin-only Postgres function (insights_*) that aggregates inside the
 * database for the chosen date window, so the browser never downloads raw
 * order/customer tables. It describes what happened; it makes no decisions.
 *
 * Observations are plain comparisons of this period with the equal-length
 * period before it, shown only when there is enough data to be meaningful.
 * Otherwise the page says: "Not enough data to determine a reliable trend."
 */

import { supabase } from "./supabase.js";
import { AuthService } from "./auth.js";
import { chart, donut, hbars } from "./admin-dashboard.js";
import { formatCurrency, formatNumber, formatDate, escapeHtml, showToast } from "./utils.js";

const DAY = 86400000;
const NO_TREND = "Not enough data to determine a reliable trend.";

const RANGES = [
  ["today", "Today"], ["yesterday", "Yesterday"], ["7d", "Last 7 days"], ["30d", "Last 30 days"],
  ["month", "This month"], ["prevmonth", "Previous month"], ["year", "This year"], ["custom", "Custom range"],
];
const TABS = [
  ["overview", "Overview"], ["orders", "Orders"], ["services", "Services"], ["customers", "Customers"],
  ["loyalty", "Rewards & Loyalty"], ["ambassadors", "Ambassadors"], ["finance", "Finance"], ["provider", "Provider"],
];

const st = { range: "30d", from: "", to: "", tab: "overview", cache: new Map(), svcSort: "orders" };
let root = null;

/* ------------------------------- date window ----------------------------- */
const sod = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

/** Returns { from: Date, to: Date (exclusive), label } for a preset or a custom pair. */
export function windowFor(key, customFrom, customTo, now = new Date()) {
  const today = sod(now);
  const next = new Date(today.getTime() + DAY);
  switch (key) {
    case "today": return { from: today, to: next, label: "Today" };
    case "yesterday": return { from: new Date(today.getTime() - DAY), to: today, label: "Yesterday" };
    case "7d": return { from: new Date(today.getTime() - 6 * DAY), to: next, label: "Last 7 days" };
    case "month": return { from: new Date(now.getFullYear(), now.getMonth(), 1), to: next, label: "This month" };
    case "prevmonth": return { from: new Date(now.getFullYear(), now.getMonth() - 1, 1), to: new Date(now.getFullYear(), now.getMonth(), 1), label: "Previous month" };
    case "year": return { from: new Date(now.getFullYear(), 0, 1), to: next, label: "This year" };
    case "custom": {
      const f = customFrom ? sod(new Date(`${customFrom}T00:00:00`)) : null;
      const t = customTo ? sod(new Date(`${customTo}T00:00:00`)) : null;
      if (!f || !t || Number.isNaN(f) || Number.isNaN(t) || t < f) return null;
      return { from: f, to: new Date(t.getTime() + DAY), label: "Custom range" };
    }
    default: return { from: new Date(today.getTime() - 29 * DAY), to: next, label: "Last 30 days" };
  }
}

const rangeText = (w) => {
  const last = new Date(w.to.getTime() - DAY);
  return sod(w.from).getTime() === sod(last).getTime() ? formatDate(w.from) : `${formatDate(w.from)} – ${formatDate(last)}`;
};

/* --------------------------------- helpers ------------------------------- */
const num = (v) => Number(v) || 0;

/** % change, or null when the earlier period is too small to compare honestly. */
export function pctChange(cur, prev, minPrev = 1) {
  if (!(prev >= minPrev)) return null;
  return ((cur - prev) / prev) * 100;
}

function deltaHtml(cur, prev, { minPrev = 1, label = "vs previous period" } = {}) {
  const p = pctChange(cur, prev, minPrev);
  if (p === null) return `<span class="adash-kpi__muted">No previous data to compare</span>`;
  const cls = p > 0.05 ? "up" : p < -0.05 ? "down" : "flat";
  return `<span class="adash-delta adash-delta--${cls}">${cls === "up" ? "▲" : cls === "down" ? "▼" : "•"} ${Math.abs(p).toFixed(1)}%</span> <span class="adash-kpi__muted">${label}</span>`;
}

const card = (label, value, sub = "", href = "") =>
  `<${href ? `a href="${href}"` : "div"} class="stat-card adash-kpi${href ? " ins-link" : ""}"><p class="stat-card__label">${label}</p><p class="stat-card__value">${value}</p><p class="adash-kpi__sub">${sub}</p></${href ? "a" : "div"}>`;

const panel = (title, body, meta = "") => `<div class="panel adash-card"><div class="panel__head"><h3>${title}</h3>${meta ? `<span class="adash-card__meta">${meta}</span>` : ""}</div><div class="panel__body panel__body--padded">${body}</div></div>`;
const empty = (msg = "No data available for this period.") => `<div class="adash-empty"><p>${msg}</p></div>`;
const tbl = (heads, rows, emptyMsg) =>
  rows.length ? `<div class="table-card"><table class="data-table"><thead><tr>${heads.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>` : empty(emptyMsg);

function zeroFill(series, w, bucket, key) {
  const map = new Map(series.map((r) => [r.d, num(r[key])]));
  const labels = [];
  const vals = [];
  const cur = new Date(w.from);
  while (cur < w.to) {
    const k = bucket === "month" ? `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, "0")}-01` : `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, "0")}-${String(cur.getDate()).padStart(2, "0")}`;
    labels.push(bucket === "month" ? cur.toLocaleDateString("en-KE", { month: "short", year: "2-digit" }) : cur.toLocaleDateString("en-KE", { day: "numeric", month: "short" }));
    vals.push(map.get(k) || 0);
    if (bucket === "month") cur.setMonth(cur.getMonth() + 1);
    else cur.setDate(cur.getDate() + 1);
  }
  return { labels, vals };
}

/* ---------------------------------- data --------------------------------- */
function currentWindow() {
  return windowFor(st.range, st.from, st.to);
}

async function load(name, w, extra = {}) {
  const key = `${name}|${w.from.toISOString()}|${w.to.toISOString()}|${JSON.stringify(extra)}`;
  if (st.cache.has(key)) return st.cache.get(key);
  const args = name === "attention" ? {} : { p_from: w.from.toISOString(), p_to: w.to.toISOString(), ...extra };
  const p = supabase.rpc(`insights_${name}`, args).then(({ data, error }) => {
    if (error) throw new Error(error.message || "Request failed");
    return data;
  });
  st.cache.set(key, p);
  p.catch(() => st.cache.delete(key)); // never cache a failure
  return p;
}

/* ------------------------------ observations ----------------------------- */
/**
 * Pure: turns already-fetched aggregates into plain-language observations.
 * Thresholds keep tiny samples from producing misleading statements.
 */
export function buildObservations({ orders, services, customers, ambassadors, provider, attention, loyalty }) {
  const out = [];
  const add = (kind, text) => out.push({ kind, text });

  if (orders) {
    const c = orders.totals.cur;
    const p = orders.totals.prev;
    const rev = pctChange(num(c.revenue), num(p.revenue), 1);
    if (rev !== null && num(p.paid) >= 3 && Math.abs(rev) >= 10) add("revenue", `Revenue ${rev > 0 ? "increased" : "decreased"} ${Math.abs(rev).toFixed(0)}% compared with the previous period.`);
    const ord = pctChange(num(c.total), num(p.total), 5);
    if (ord !== null && Math.abs(ord) >= 15) add("orders", `Order volume ${ord > 0 ? "increased" : "decreased"} ${Math.abs(ord).toFixed(0)}% compared with the previous period.`);
    if (num(c.total) >= 10 && num(c.cancelled) / num(c.total) >= 0.2) add("orders", `${Math.round((num(c.cancelled) / num(c.total)) * 100)}% of orders in this period were cancelled.`);
  }
  if (services) {
    const rows = services.rows || [];
    const up = rows.filter((r) => num(r.prev_orders) >= 3 && num(r.orders) - num(r.prev_orders) >= 3 && num(r.orders) / num(r.prev_orders) >= 1.5).sort((a, b) => num(b.orders) - num(b.prev_orders) - (num(a.orders) - num(a.prev_orders)))[0];
    if (up) add("service", `${up.name} orders increased from ${formatNumber(up.prev_orders)} to ${formatNumber(up.orders)} compared with the previous period.`);
    const down = rows.filter((r) => num(r.prev_orders) >= 5 && num(r.orders) / num(r.prev_orders) <= 0.6).sort((a, b) => num(b.prev_orders) - num(b.orders) - (num(a.prev_orders) - num(a.orders)))[0];
    if (down) add("service", `${down.name} orders declined from ${formatNumber(down.prev_orders)} to ${formatNumber(down.orders)} compared with the previous period.`);
    const refunded = rows.filter((r) => num(r.orders) >= 5 && num(r.refunded) / num(r.orders) >= 0.2)[0];
    if (refunded) add("service", `${refunded.name} has a high refund share (${formatNumber(refunded.refunded)} of ${formatNumber(refunded.orders)} orders).`);
  }
  if (customers && num(customers.active_cur) >= 5) {
    const share = (num(customers.returning_cur) / num(customers.active_cur)) * 100;
    add("customers", `${formatNumber(customers.returning_cur)} of ${formatNumber(customers.active_cur)} active customers (${share.toFixed(0)}%) had ordered before this period.`);
    const act = pctChange(num(customers.active_cur), num(customers.active_prev), 5);
    if (act !== null && Math.abs(act) >= 15) add("customers", `Active customers ${act > 0 ? "increased" : "decreased"} ${Math.abs(act).toFixed(0)}% compared with the previous period.`);
  }
  if (ambassadors) {
    const q = pctChange(num(ambassadors.cur.qualifying_orders), num(ambassadors.prev.qualifying_orders), 3);
    if (q !== null && Math.abs(q) >= 15) add("ambassadors", `Ambassador referrals generated ${q > 0 ? "more" : "fewer"} qualifying orders than the previous period (${formatNumber(ambassadors.prev.qualifying_orders)} → ${formatNumber(ambassadors.cur.qualifying_orders)}).`);
  }
  if (provider) {
    const total = num(provider.submitted_cur);
    if (total >= 5 && num(provider.failed_cur) / total >= 0.1) add("provider", `${Math.round((num(provider.failed_cur) / total) * 100)}% of provider orders in this period were cancelled or failed (${formatNumber(provider.failed_cur)} of ${formatNumber(total)}).`);
  }
  if (loyalty?.available && loyalty.enabled && num(loyalty.near_next_level) > 0) add("loyalty", `${formatNumber(loyalty.near_next_level)} loyalty member${num(loyalty.near_next_level) === 1 ? " is" : "s are"} within 20% of the next level's spend requirement.`);
  if (attention && num(attention.pending_old) > 0) add("operations", `${formatNumber(attention.pending_old)} order${num(attention.pending_old) === 1 ? " has" : "s have"} remained pending longer than the configured threshold (${attention.pending_hours} hours).`);
  return out;
}

const KIND = { revenue: "Revenue", orders: "Orders", service: "Service", customers: "Customers", ambassadors: "Ambassadors", provider: "Provider", loyalty: "Loyalty", operations: "Operations" };

function observationsHtml(list) {
  return list.length
    ? `<ul class="ins-obs">${list.map((o) => `<li><span class="ins-obs__tag">${KIND[o.kind]}</span><span>${escapeHtml(o.text)}</span></li>`).join("")}</ul>`
    : empty(NO_TREND);
}

/** Pure: the Attention Required list, each item with the place to act on it. */
export function buildAttention(a) {
  if (!a) return [];
  const n = (k) => num(a[k]);
  const items = [
    [n("pending_old"), `${n("pending_old")} order${n("pending_old") === 1 ? " has" : "s have"} been pending longer than ${a.pending_hours} hours`, "View Orders", "admin#orders-section"],
    [n("awaiting_submission"), `${n("awaiting_submission")} paid order${n("awaiting_submission") === 1 ? " is" : "s are"} still waiting to be sent to the provider`, "View Provider", "admin#provider-section"],
    [n("refund_requests"), `${n("refund_requests")} refund request${n("refund_requests") === 1 ? " is" : "s are"} awaiting a decision`, "Review Refunds", "admin#refunds-section"],
    [n("cancellation_requests"), `${n("cancellation_requests")} cancellation request${n("cancellation_requests") === 1 ? " is" : "s are"} awaiting a decision`, "Review Cancellations", "admin#cancellations-section"],
    [n("withdrawals_pending"), `${n("withdrawals_pending")} ambassador withdrawal${n("withdrawals_pending") === 1 ? " is" : "s are"} awaiting approval`, "Review Withdrawals", "admin#ambassadors-section"],
    [n("withdrawals_to_pay"), `${n("withdrawals_to_pay")} approved withdrawal${n("withdrawals_to_pay") === 1 ? " is" : "s are"} waiting to be paid`, "Pay Withdrawals", "admin#ambassadors-section"],
    [n("applications_pending"), `${n("applications_pending")} ambassador application${n("applications_pending") === 1 ? " is" : "s are"} awaiting review`, "Review Applications", "admin#ambassadors-section"],
    [n("payments_failed_24h"), `${n("payments_failed_24h")} M-Pesa payment${n("payments_failed_24h") === 1 ? "" : "s"} failed or expired in the last 24 hours`, "View Payments", "#tab-finance"],
    [n("ambassadors_suspended"), `${n("ambassadors_suspended")} ambassador${n("ambassadors_suspended") === 1 ? " is" : "s are"} currently suspended`, "View Ambassadors", "admin#ambassadors-section"],
    [n("services_hidden"), `${n("services_hidden")} service${n("services_hidden") === 1 ? " is" : "s are"} hidden from customers`, "View Services", "admin#services-section"],
    [n("open_tickets"), `${n("open_tickets")} support ticket${n("open_tickets") === 1 ? " is" : "s are"} open`, "View Support", "support"],
  ];
  return items.filter((i) => i[0] > 0).map(([, text, action, href]) => ({ text, action, href }));
}

function attentionHtml(list) {
  return list.length
    ? `<ul class="ins-attn">${list.map((i) => `<li><span>${escapeHtml(i.text)}</span><a class="btn btn--secondary btn--sm" href="${i.href}" ${i.href.startsWith("#") ? "data-ins-tab-link" : ""}>${i.action}</a></li>`).join("")}</ul>`
    : `<div class="adash-empty"><p>Nothing needs attention right now.</p></div>`;
}

/* -------------------------------- renderers ------------------------------ */
function chartInto(el, cfg) {
  el.innerHTML = "";
  chart(el, cfg);
}

function renderOrdersBlocks(o, w) {
  const c = o.totals.cur;
  const p = o.totals.prev;
  const aov = num(c.paid) ? num(c.revenue) / num(c.paid) : 0;
  const paov = num(p.paid) ? num(p.revenue) / num(p.paid) : 0;
  return { c, p, aov, paov, w };
}

function overviewHtml(d, w) {
  const o = d.orders;
  const f = d.finance;
  const a = d.ambassadors;
  const cu = d.customers;
  const cells = [];
  if (o) {
    const { c, p, aov, paov } = renderOrdersBlocks(o, w);
    cells.push(
      card("Revenue", formatCurrency(c.revenue), deltaHtml(num(c.revenue), num(p.revenue)), "#tab-orders"),
      card("Orders", formatNumber(c.total), deltaHtml(num(c.total), num(p.total), { minPrev: 1 }), "#tab-orders"),
      card("Average order value", formatCurrency(aov), deltaHtml(aov, paov), "#tab-orders")
    );
  }
  if (cu) cells.push(card("New customers", formatNumber(cu.new_cur), deltaHtml(num(cu.new_cur), num(cu.new_prev)), "#tab-customers"));
  if (f) cells.push(card("Wallet deposits", formatCurrency(f.deposits_cur), deltaHtml(num(f.deposits_cur), num(f.deposits_prev)), "#tab-finance"));
  if (a) cells.push(card("Commissions generated", formatCurrency(a.cur.generated), deltaHtml(num(a.cur.generated), num(a.prev.generated)), "#tab-ambassadors"));
  return `<div class="adash-kpis">${cells.join("")}</div>`;
}

async function renderOverview(el, w) {
  el.innerHTML = `<div class="skeleton" style="height:120px"></div>`;
  const names = ["orders", "services", "customers", "finance", "ambassadors", "provider", "loyalty", "attention"];
  const results = await Promise.allSettled(names.map((n) => load(n, w)));
  const d = Object.fromEntries(names.map((n, i) => [n, results[i].status === "fulfilled" ? results[i].value : null]));
  const failed = names.filter((n, i) => results[i].status === "rejected");
  if (failed.length === names.length) return void (el.innerHTML = errorBox(results[0].reason?.message));

  const obs = buildObservations(d);
  el.innerHTML = `
    ${failed.length ? `<p class="form-hint">Some sections couldn't be loaded (${failed.join(", ")}). The rest is shown below.</p>` : ""}
    ${d.orders || d.finance ? overviewHtml(d, w) : ""}
    <div class="adash-grid-2" style="margin-top:var(--sp-4)">
      ${panel("Attention required", d.attention ? attentionHtml(buildAttention(d.attention)) : empty("Couldn't load this section."))}
      ${panel("Observations", observationsHtml(obs), "Compared with the previous period")}
    </div>
    <div style="margin-top:var(--sp-4)">${panel("Revenue trend", `<div data-ins-chart></div>`, "KES, paid orders")}</div>
    <div class="adash-grid-2" style="margin-top:var(--sp-4)">
      ${panel("Order status", `<div data-ins-status></div>`)}
      ${panel("Most ordered services", `<div data-ins-top></div>`)}
    </div>`;

  if (d.orders) {
    const s = zeroFill(d.orders.series, w, d.orders.bucket, "revenue");
    const box = el.querySelector("[data-ins-chart]");
    if (s.vals.some((v) => v > 0)) chartInto(box, { type: "line", labels: s.labels, series: [{ name: "Revenue", color: "var(--color-primary)", values: s.vals }], money: true, title: "Revenue trend" });
    else box.innerHTML = empty();
    statusDonut(el.querySelector("[data-ins-status]"), d.orders.totals.cur);
  }
  const top = el.querySelector("[data-ins-top]");
  const svc = (d.services?.rows || []).slice(0, 6);
  if (svc.length) hbars(top, svc.map((r) => ({ label: r.name, value: num(r.orders), display: `${formatNumber(r.orders)} orders`, sub: `${formatCurrency(r.revenue)} paid revenue` })));
  else top.innerHTML = empty();
}

const ORDER_STATUS = [["pending", "Pending", "var(--color-warning)"], ["processing", "Processing", "var(--color-primary)"], ["completed", "Completed", "var(--color-success)"], ["cancelled", "Cancelled", "var(--color-error)"]];
function statusDonut(el, c) {
  const items = ORDER_STATUS.map(([k, label, color]) => ({ label, color, value: num(c[k]) })).filter((i) => i.value > 0);
  if (!items.length) return void (el.innerHTML = empty());
  donut(el, items, { centerLabel: "orders" });
}

async function renderOrders(el, w) {
  const o = await load("orders", w);
  const { c, p, aov, paov } = renderOrdersBlocks(o, w);
  el.innerHTML = `
    <div class="adash-kpis">
      ${card("Total sales (paid)", formatCurrency(c.revenue), deltaHtml(num(c.revenue), num(p.revenue)))}
      ${card("Total orders", formatNumber(c.total), deltaHtml(num(c.total), num(p.total)))}
      ${card("Average order value", formatCurrency(aov), deltaHtml(aov, paov))}
      ${card("Completed", formatNumber(c.completed), deltaHtml(num(c.completed), num(p.completed)))}
      ${card("In progress", formatNumber(num(c.pending) + num(c.processing)), `${formatNumber(c.pending)} pending · ${formatNumber(c.processing)} processing`)}
      ${card("Cancelled", formatNumber(c.cancelled), deltaHtml(num(c.cancelled), num(p.cancelled)))}
      ${card("Refunded", formatNumber(c.refunded), "Orders with refunded payment")}
    </div>
    <div style="margin-top:var(--sp-4)">${panel("Revenue trend", `<div data-ins-rev></div>`, "KES, paid orders")}</div>
    <div class="adash-grid-2" style="margin-top:var(--sp-4)">
      ${panel("Order activity", `<div data-ins-act></div>`, "By order date")}
      ${panel("Order status", `<div data-ins-status></div>`)}
    </div>
    <p class="adash-foot">Grouped by the date each order was placed, in East Africa Time.</p>`;
  const rev = zeroFill(o.series, w, o.bucket, "revenue");
  const box = el.querySelector("[data-ins-rev]");
  if (rev.vals.some((v) => v > 0)) chartInto(box, { type: "line", labels: rev.labels, series: [{ name: "Revenue", color: "var(--color-primary)", values: rev.vals }], money: true, title: "Revenue" });
  else box.innerHTML = empty();
  const placed = zeroFill(o.series, w, o.bucket, "orders");
  const act = el.querySelector("[data-ins-act]");
  if (placed.vals.some((v) => v > 0)) {
    chartInto(act, {
      type: "line", labels: placed.labels, integer: true, title: "Order activity",
      series: [
        { name: "Placed", color: "var(--color-primary)", values: placed.vals },
        { name: "Completed", color: "var(--color-success)", values: zeroFill(o.series, w, o.bucket, "completed").vals },
        { name: "Cancelled", color: "var(--color-error)", values: zeroFill(o.series, w, o.bucket, "cancelled").vals },
      ],
    });
  } else act.innerHTML = empty();
  statusDonut(el.querySelector("[data-ins-status]"), c);
}

const SORTS = {
  orders: ["Most ordered", (a, b) => num(b.orders) - num(a.orders)],
  revenue: ["Highest revenue", (a, b) => num(b.revenue) - num(a.revenue)],
  profit: ["Highest estimated profit", (a, b) => estProfit(b) - estProfit(a)],
  growth: ["Fastest growing", (a, b) => growth(b) - growth(a)],
  declining: ["Declining", (a, b) => growth(a) - growth(b)],
  refunded: ["Most refunded", (a, b) => num(b.refunded) - num(a.refunded)],
  failed: ["Most failed / cancelled", (a, b) => num(b.cancelled) + num(b.provider_failed) - (num(a.cancelled) + num(a.provider_failed))],
};
const growth = (r) => (num(r.prev_orders) >= 3 ? (num(r.orders) - num(r.prev_orders)) / num(r.prev_orders) : -Infinity);
const estProfit = (r) => (r.est_cost_kes == null ? -Infinity : num(r.revenue) - num(r.est_cost_kes));

async function renderServices(el, w) {
  const d = await load("services", w);
  let svcBox = null; // captured once: `el` is a detached holder whose children are moved into the page
  const draw = () => {
    const rows = d.rows.slice().sort(SORTS[st.svcSort][1]);
    svcBox.innerHTML = tbl(
      ["Service", "Category", "Provider", "Price / 1,000", "Provider rate", "Orders", "Revenue", "Est. profit", "Completion", "Refunded", "Failed", "Trend", "Visible"],
      rows.map((r) => {
        const tr = num(r.prev_orders) >= 3 ? `${num(r.orders) >= num(r.prev_orders) ? "▲" : "▼"} ${Math.abs(((num(r.orders) - num(r.prev_orders)) / num(r.prev_orders)) * 100).toFixed(0)}%` : "—";
        return `<tr>
          <td data-label="Service"><strong>${escapeHtml(r.name)}</strong><br /><span class="muted">${escapeHtml(r.platform)}</span></td>
          <td data-label="Category">${escapeHtml(r.category)}</td>
          <td data-label="Provider">${escapeHtml(r.provider_name || "—")}</td>
          <td data-label="Price / 1,000">${formatCurrency(r.price_per_1000)}</td>
          <td data-label="Provider rate">${r.provider_rate == null ? "—" : `${Number(r.provider_rate)} ${escapeHtml(r.provider_currency || "")}`}</td>
          <td data-label="Orders">${formatNumber(r.orders)}</td>
          <td data-label="Revenue">${formatCurrency(r.revenue)}</td>
          <td data-label="Est. profit">${r.est_cost_kes == null ? "—" : `${formatCurrency(num(r.revenue) - num(r.est_cost_kes))} <span class="muted">(estimated)</span>`}</td>
          <td data-label="Completion">${num(r.orders) ? `${Math.round((num(r.completed) / num(r.orders)) * 100)}%` : "—"}</td>
          <td data-label="Refunded">${formatNumber(r.refunded)}</td>
          <td data-label="Failed">${formatNumber(num(r.cancelled) + num(r.provider_failed))}</td>
          <td data-label="Trend">${tr}</td>
          <td data-label="Visible">${r.visible && r.active ? "Yes" : r.active ? "Hidden" : "Inactive"}</td></tr>`;
      }),
      "No service activity in this period."
    );
  };
  el.innerHTML = `
    ${d.fx_set ? "" : `<p class="form-hint">Provider rates are stored in USD. Set the USD→KES rate in the Finance tab to see estimated profit per service.</p>`}
    <div class="filters-bar" style="margin:var(--sp-3) 0">
      <label class="stat-card__label" for="ins-sort" style="margin:0 var(--sp-3) 0 0">Sort by</label>
      <select id="ins-sort" data-ins-sort>${Object.entries(SORTS).map(([k, [l]]) => `<option value="${k}" ${k === st.svcSort ? "selected" : ""}>${l}</option>`).join("")}</select>
    </div>
    <div data-ins-svc></div>
    <p class="adash-foot">Showing measurable metrics only. Estimated profit = paid revenue − (provider rate × quantity × exchange rate) for per-quantity services with a known USD rate. It is an estimate, not audited accounting profit.</p>`;
  svcBox = el.querySelector("[data-ins-svc]");
  el.querySelector("[data-ins-sort]").addEventListener("change", (e) => {
    st.svcSort = e.target.value;
    draw();
  });
  draw();
}

async function renderCustomers(el, w) {
  const d = await load("customers", w);
  el.innerHTML = `
    <div class="adash-kpis">
      ${card("Total customers", formatNumber(d.total))}
      ${card("New customers", formatNumber(d.new_cur), deltaHtml(num(d.new_cur), num(d.new_prev)))}
      ${card("Active customers", formatNumber(d.active_cur), deltaHtml(num(d.active_cur), num(d.active_prev)))}
      ${card("Returning customers", formatNumber(d.returning_cur), "Ordered before this period")}
      ${card("Without orders in period", formatNumber(Math.max(0, num(d.total) - num(d.active_cur))), "Customers with no orders in this period")}
      ${card("Referred by ambassadors", formatNumber(d.referred_total), `${formatNumber(d.referred_new)} new in period`)}
    </div>
    <div style="margin-top:var(--sp-4)">${panel("Top customers by paid spend", tbl(["Customer", "Orders", "Paid spend", "Last order", "Source"],
      (d.top || []).map((c) => `<tr><td data-label="Customer"><strong>${escapeHtml(c.name || "—")}</strong><br /><span class="muted">${escapeHtml(c.email)}</span></td><td data-label="Orders">${formatNumber(c.orders)}</td><td data-label="Paid spend">${formatCurrency(c.spend)}</td><td data-label="Last order">${formatDate(c.last_order_at)}</td><td data-label="Source">${c.referred ? "Ambassador referral" : "Direct"}</td></tr>`),
      "No customer orders in this period."))}</div>`;
}

async function renderLoyalty(el, w) {
  const d = await load("loyalty", w);
  if (!d.available) return void (el.innerHTML = panel("Rewards & Loyalty", empty("The loyalty system hasn't been set up yet.")));
  el.innerHTML = `
    ${d.enabled ? "" : `<p class="form-hint">Loyalty is currently switched off. Figures below reflect past activity.</p>`}
    <div class="adash-kpis">
      ${card("Loyalty members", formatNumber(d.members))}
      ${card("Points issued", formatNumber(d.issued_cur), deltaHtml(num(d.issued_cur), num(d.issued_prev)))}
      ${card("Points redeemed", formatNumber(d.redeemed_cur), "Redemption is not enabled yet")}
      ${card("Outstanding points", formatNumber(d.outstanding_points))}
      ${card("Discounts granted", formatCurrency(d.discounts_cur), `${formatNumber(d.discounted_orders_cur)} discounted orders`)}
      ${card("Members earning in period", formatNumber(d.active_members))}
      ${card("Near next level", formatNumber(d.near_next_level), "Within 20% of the next level's spend")}
    </div>
    <div style="margin-top:var(--sp-4)">${panel("Members by level", `<div data-ins-levels></div>`)}</div>`;
  const box = el.querySelector("[data-ins-levels]");
  const lv = (d.levels || []).filter((l) => num(l.members) > 0);
  if (lv.length) hbars(box, lv.map((l) => ({ label: l.level, value: num(l.members), display: `${formatNumber(l.members)} members` })));
  else box.innerHTML = empty("No loyalty members yet.");
}

async function renderAmbassadors(el, w) {
  const d = await load("ambassadors", w);
  const s = d.by_status || {};
  const total = Object.values(s).reduce((t, v) => t + num(v), 0);
  el.innerHTML = `
    <div class="adash-kpis">
      ${card("Ambassadors", formatNumber(total), `${formatNumber(s.approved)} active · ${formatNumber(s.applicant)} pending · ${formatNumber(s.suspended)} suspended`)}
      ${card("New ambassadors", formatNumber(d.new_approved), "Approved in period")}
      ${card("Referrals", formatNumber(d.cur.referrals), deltaHtml(num(d.cur.referrals), num(d.prev.referrals), { minPrev: 1 }))}
      ${card("Qualifying orders", formatNumber(d.cur.qualifying_orders), deltaHtml(num(d.cur.qualifying_orders), num(d.prev.qualifying_orders)))}
      ${card("Referral revenue", formatCurrency(d.cur.referred_value), "Order value from referred customers")}
      ${card("Commission generated", formatCurrency(d.cur.generated), deltaHtml(num(d.cur.generated), num(d.prev.generated)))}
      ${card("Commission reversed", formatCurrency(d.cur.reversed))}
      ${card("Withdrawals awaiting payout", formatCurrency(d.withdrawals.pending_amount), `${formatNumber(d.withdrawals.pending_count)} request${num(d.withdrawals.pending_count) === 1 ? "" : "s"}`)}
    </div>
    <div style="margin-top:var(--sp-4)">${panel("Ambassador performance", tbl(["Ambassador", "Status", "Rate", "Referrals", "Qualifying orders", "Referred value", "Commission"],
      (d.top || []).map((a) => `<tr><td data-label="Ambassador"><strong>${escapeHtml(a.display_name)}</strong><br /><span class="muted">${escapeHtml(a.ambassador_code || "")}</span></td><td data-label="Status">${escapeHtml(a.status)}</td><td data-label="Rate">${num(a.commission_rate)}%</td><td data-label="Referrals">${formatNumber(a.referrals)}</td><td data-label="Qualifying orders">${formatNumber(a.qualifying_orders)}</td><td data-label="Referred value">${formatCurrency(a.referred_value)}</td><td data-label="Commission">${formatCurrency(a.generated)}</td></tr>`),
      "No ambassador activity yet. Approved ambassadors will appear here."), "Selected period")}</div>
    <p class="adash-foot">Ambassador earnings are tracked separately from wallet balances and loyalty points. <a href="admin#ambassadors-section" style="color:var(--color-primary)">Manage ambassadors</a></p>`;
}

async function renderFinance(el, w) {
  const f = await load("finance", w);
  const est = f.estimate || {};
  const cost = num(est.est_cost);
  const cov = num(est.covered_revenue);
  const covPct = num(f.revenue) > 0 ? Math.round((cov / num(f.revenue)) * 100) : 0;
  el.innerHTML = `
    <h3 class="adash-h" style="margin:0 0 var(--sp-3)">Actual money <span class="adash-h__meta">recorded in the database</span></h3>
    <div class="adash-kpis">
      ${card("Wallet deposits", formatCurrency(f.deposits_cur), deltaHtml(num(f.deposits_cur), num(f.deposits_prev)))}
      ${card("Customer spending (paid orders)", formatCurrency(f.revenue))}
      ${card("Wallet spend on orders", formatCurrency(f.wallet_spend))}
      ${card("Outstanding wallet balances", formatCurrency(f.wallet_outstanding), `${formatNumber(f.wallets_funded)} funded wallets`)}
      ${card("Refunded orders", formatCurrency(f.refunded_value), `${formatNumber(f.refunded_count)} order${num(f.refunded_count) === 1 ? "" : "s"}`)}
      ${card("Loyalty discounts", formatCurrency(f.loyalty_discounts), "Already deducted from revenue")}
      ${card("Ambassador commission", formatCurrency(f.commissions_generated), `${formatCurrency(f.commissions_reversed)} reversed · ${formatCurrency(f.commission_adjustments)} adjustments`)}
      ${card("Withdrawals paid", formatCurrency(f.withdrawals_paid), `${formatCurrency(f.withdrawals_pending)} awaiting payout`)}
      ${card("Failed / expired payments", formatNumber(f.payments_failed), `${formatNumber(f.payments_cancelled)} cancelled`)}
    </div>
    <h3 class="adash-h" style="margin:var(--sp-6) 0 var(--sp-3)">Estimated <span class="adash-h__meta">not audited accounting profit</span></h3>
    <div class="adash-kpis">
      ${est.fx ? `
        ${card("Estimated provider cost", formatCurrency(cost), "Estimated")}
        ${card("Estimated gross profit", formatCurrency(cov - cost), `Estimated · covers ${covPct}% of revenue`)}
        ${card("USD → KES rate used", String(num(est.fx)), "Set by an admin")}` :
      card("Estimated gross profit", "—", "Set the USD → KES rate below to calculate an estimate")}
    </div>
    <form class="loyalty-admin-grid" data-ins-fx style="margin-top:var(--sp-4);max-width:520px">
      <div class="form-field"><label for="ins-fx">USD → KES exchange rate</label>
        <input id="ins-fx" name="fx" type="number" step="0.01" min="0" value="${est.fx ? num(est.fx) : ""}" placeholder="e.g. 129" />
        <span class="form-hint">Provider rates are stored in USD. The estimate covers per-quantity services with a known rate only.</span></div>
      <div><button type="submit" class="btn btn--primary btn--sm">Save rate</button></div>
    </form>`;
  el.querySelector("[data-ins-fx]").addEventListener("submit", async (e) => {
    e.preventDefault();
    const { error } = await supabase.rpc("admin_set_business_setting", { p_key: "usd_kes_rate", p_value: e.target.fx.value || null });
    if (error) return void showToast(error.message || "Couldn't save the rate.", "error", 5000);
    showToast("Exchange rate saved.", "success");
    st.cache.clear();
    render();
  });
}

async function renderProvider(el, w) {
  const d = await load("provider", w);
  const rate = num(d.submitted_cur) ? Math.round((num(d.failed_cur) / num(d.submitted_cur)) * 100) : 0;
  el.innerHTML = `
    <div class="adash-kpis">
      ${card("Orders sent to providers", formatNumber(d.submitted_cur), deltaHtml(num(d.submitted_cur), num(d.submitted_prev)))}
      ${card("Cancelled / failed by provider", formatNumber(d.failed_cur), num(d.submitted_cur) ? `${rate}% of provider orders` : "No provider orders")}
      ${card("Awaiting submission", formatNumber(d.awaiting_submission), `Paid, not sent after ${d.thresholds.submit_minutes} min`)}
      ${card("Slow processing", formatNumber(d.slow_processing), `Processing for over ${d.thresholds.pending_hours} h`)}
    </div>
    <div style="margin-top:var(--sp-4)">${panel("By provider", tbl(["Provider", "Orders", "Completed", "Cancelled / failed"],
      (d.by_provider || []).map((p) => `<tr><td data-label="Provider">${escapeHtml(p.provider)}</td><td data-label="Orders">${formatNumber(p.orders)}</td><td data-label="Completed">${formatNumber(p.completed)}</td><td data-label="Cancelled / failed">${formatNumber(p.failed)}</td></tr>`),
      "No provider orders in this period."))}</div>
    <p class="adash-foot">Failure counts use the status text returned by the provider. Provider balance isn't shown because the current integration doesn't read it.</p>`;
}

/* --------------------------------- shell --------------------------------- */
const errorBox = (msg) => `<div class="adash-empty adash-empty--error"><p>${escapeHtml(msg || "This section couldn't be loaded.")}</p><button type="button" class="btn btn--secondary btn--sm" data-ins-retry>Retry</button></div>`;
const RENDER = { overview: renderOverview, orders: renderOrders, services: renderServices, customers: renderCustomers, loyalty: renderLoyalty, ambassadors: renderAmbassadors, finance: renderFinance, provider: renderProvider };

async function render() {
  const w = currentWindow();
  const pane = root.querySelector("[data-ins-pane]");
  root.querySelectorAll("[data-ins-tab]").forEach((t) => t.setAttribute("aria-selected", String(t.dataset.insTab === st.tab)));
  root.querySelectorAll("[data-ins-range]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.insRange === st.range)));
  root.querySelector("[data-ins-custom]").hidden = st.range !== "custom";
  if (!w) {
    root.querySelector("[data-ins-label]").textContent = "Choose a start and end date";
    pane.innerHTML = empty("Select a valid custom range to see insights.");
    return;
  }
  root.querySelector("[data-ins-label]").textContent = `${w.label}: ${rangeText(w)}`;
  const mine = ++renderToken;
  pane.innerHTML = `<div class="skeleton" style="height:180px"></div>`;
  try {
    const holder = document.createElement("div");
    await RENDER[st.tab](holder, w);
    if (mine !== renderToken) return;
    pane.replaceChildren(...holder.childNodes);
    wireTabLinks(pane);
  } catch (err) {
    if (mine !== renderToken) return;
    console.error("BTECH INSIGHTS:", err);
    pane.innerHTML = errorBox(err.message);
  }
}
let renderToken = 0;

function wireTabLinks(pane) {
  pane.querySelectorAll("a[href^='#tab-']").forEach((a) =>
    a.addEventListener("click", (e) => {
      e.preventDefault();
      st.tab = a.getAttribute("href").slice(5);
      render();
    })
  );
}

export async function initInsightsPage() {
  root = document.querySelector("[data-insights-root]");
  if (!root) return;
  const user = AuthService.getCurrentUser();
  if (!user || user.role !== "admin") {
    root.innerHTML = `<div class="empty-state"><h3>Admin access required</h3><p>BTECH INSIGHTS is available to administrators only.</p><a href="dashboard" class="btn btn--primary">Back to dashboard</a></div>`;
    return;
  }
  const today = new Date().toISOString().slice(0, 10);
  root.innerHTML = `
    <div class="page-head adash-head">
      <div><h1>BTECH INSIGHTS</h1><p class="muted">What is happening across BTECH SMM, what changed and what needs attention.</p></div>
      <a href="admin" class="btn btn--secondary btn--sm">Back to Admin</a>
    </div>
    <div class="ins-filters">
      <div class="ins-ranges" role="group" aria-label="Date range">${RANGES.map(([k, l]) => `<button type="button" data-ins-range="${k}" aria-pressed="${k === st.range}">${l}</button>`).join("")}</div>
      <div class="ins-custom" data-ins-custom hidden>
        <label>From <input type="date" data-ins-from max="${today}" /></label>
        <label>To <input type="date" data-ins-to max="${today}" /></label>
        <button type="button" class="btn btn--primary btn--sm" data-ins-apply>Apply</button>
      </div>
      <p class="ins-label" data-ins-label aria-live="polite"></p>
    </div>
    <div class="amb-tabs" role="tablist" aria-label="Insights sections">${TABS.map(([k, l]) => `<button type="button" role="tab" data-ins-tab="${k}" aria-selected="${k === st.tab}">${l}</button>`).join("")}</div>
    <div data-ins-pane></div>`;

  root.addEventListener("click", (e) => {
    const r = e.target.closest("[data-ins-range]");
    if (r) {
      st.range = r.dataset.insRange;
      if (st.range !== "custom") render();
      else root.querySelector("[data-ins-custom]").hidden = false;
      return void root.querySelectorAll("[data-ins-range]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.insRange === st.range)));
    }
    const t = e.target.closest("[data-ins-tab]");
    if (t) {
      st.tab = t.dataset.insTab;
      return void render();
    }
    if (e.target.closest("[data-ins-apply]")) {
      st.from = root.querySelector("[data-ins-from]").value;
      st.to = root.querySelector("[data-ins-to]").value;
      if (!currentWindow()) return void showToast("Choose a valid start and end date.", "error");
      return void render();
    }
    if (e.target.closest("[data-ins-retry]")) {
      st.cache.clear();
      render();
    }
  });
  await render();
}
