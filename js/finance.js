/**
 * BTECH SMM — Finance & Accounts (admin only, inside BTECH INSIGHTS → Finance)
 * ----------------------------------------------------------------
 * Every figure comes from an admin-only Postgres function (admin_finance_*). The browser only
 * formats and filters: it never calculates a balance, cost or profit that the page then treats as
 * authoritative. Amounts are KES. Delix rates/balance are KES for BTECH accounting (the "USD" label
 * Delix shows is not converted); that interpretation lives in the database, not here.
 */

import { supabase } from "./supabase.js";
import { chart } from "./admin-dashboard.js";
import { formatCurrency, formatNumber, formatDate, escapeHtml, showToast } from "./utils.js";

const num = (v) => Number(v) || 0;
const PAGE = 25;
const SUBTABS = [
  ["overview", "Overview"],
  ["activity", "Financial activity"],
  ["recon", "Reconciliation"],
  ["corrections", "Estimate corrections"],
];
const TYPES = [
  ["", "All activity"],
  ["wallet_deposit", "Wallet deposits"],
  ["order_payment", "Direct order payments"],
  ["order_sale", "Order sales"],
  ["refund", "Refunds"],
  ["provider_cost", "Provider costs"],
  ["commission", "Ambassador commissions"],
  ["ambassador_payout", "Ambassador payouts"],
  ["wallet_tx_", "Wallet transactions"],
];
const SEV = { critical: ["Critical", "fin-tag--red"], warning: ["Needs review", "fin-tag--amber"], info: ["For information", "fin-tag--blue"] };

const st = { sub: "overview", type: "", status: "", q: "", offset: 0, balanceBusyUntil: 0 };

const tag = (text, cls = "fin-tag--grey") => `<span class="fin-tag ${cls}">${escapeHtml(text)}</span>`;
const money = (v) => formatCurrency(num(v));

function delta(cur, prev) {
  if (!(Math.abs(num(prev)) >= 1)) return `<span class="adash-kpi__muted">No previous data to compare</span>`;
  const p = ((num(cur) - num(prev)) / Math.abs(num(prev))) * 100;
  const cls = p > 0.05 ? "up" : p < -0.05 ? "down" : "flat";
  return `<span class="adash-delta adash-delta--${cls}">${cls === "up" ? "▲" : cls === "down" ? "▼" : "•"} ${Math.abs(p).toFixed(1)}%</span> <span class="adash-kpi__muted">vs previous period</span>`;
}

/* ------------------------------ card building ---------------------------- */
const I = (d) => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${d}</svg>`;
const ICON = {
  trend: I('<path d="M4 17l5-5 4 4 7-8"/><path d="M15 8h5v5"/>'),
  receipt: I('<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>'),
  coins: I('<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6"/><path d="M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/>'),
  wallet: I('<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18"/><circle cx="16" cy="14.5" r="1"/>'),
  clock: I('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  alert: I('<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17.5v.01"/>'),
  tag: I('<path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8.5" r="1"/>'),
  undo: I('<path d="M9 7L4 12l5 5"/><path d="M4 12h10a6 6 0 010 12"/>'),
  users: I('<circle cx="9" cy="8" r="3.2"/><path d="M3 20c.6-3.4 3-5 6-5s5.4 1.6 6 5"/><path d="M16 5.5a3 3 0 010 5M18 15c1.8.6 2.8 2.2 3 5"/>'),
  check: I('<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.7 2.7L16 9.5"/>'),
  shield: I('<path d="M12 3l7 3v6c0 4.5-3 8-7 9-4-1-7-4.5-7-9V6z"/>'),
  send: I('<path d="M21 3L3 11l7 3 3 7z"/><path d="M10 14l11-11"/>'),
  bank: I('<path d="M3 10l9-6 9 6"/><path d="M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 20h18"/>'),
};

/** "-Ksh 1,234.50" -> sign, currency and figure as separate spans (same text, easier to scale). */
function amountHtml(v) {
  const t = money(v).replace(/\u00a0/g, " ");
  const m = /^(-?)\s*([A-Za-z]{2,4})\s*(.+)$/.exec(t);
  if (!m) return escapeHtml(t);
  return `${m[1] ? `<span class="fin-sign" aria-label="minus">−</span>` : ""}<span class="fin-cur">${escapeHtml(m[2])}</span> <span class="fin-fig">${escapeHtml(m[3])}</span>`;
}

/**
 * Supporting card (light, compact). `tone` is a meaning, not a decoration:
 * positive | negative | pending | cost | liability | muted. The status word is always printed.
 */
function kpi(label, value, sub = "", status = null, statusCls = "fin-tag--grey", { icon = "coins", tone = "neutral", raw = false } = {}) {
  return `<div class="fin-mini fin-mini--${tone}" tabindex="0"><div class="fin-mini__top"><span class="fin-mini__icon">${ICON[icon] || ""}</span><p class="fin-mini__label">${label}</p>${status ? tag(status, statusCls) : ""}</div>
    <p class="fin-mini__value">${raw ? value : amountHtml(value)}</p><p class="fin-mini__sub">${sub}</p></div>`;
}

/** Premium hero wallet card (deep navy / BTECH blue). Amounts come straight from the server figures. */
function hero(variant, { label, icon, amount, chips = "", lines = [], action = "", attrs = "" }) {
  return `<article class="fin-hero fin-hero--${variant}" tabindex="0" ${attrs}>
    <svg class="fin-hero__arcs" viewBox="0 0 400 250" aria-hidden="true" focusable="false"><g fill="none" stroke="#fff" stroke-opacity=".07"><circle cx="372" cy="-10" r="110"/><circle cx="372" cy="-10" r="160"/><circle cx="372" cy="-10" r="210"/></g></svg>
    <div class="fin-hero__row"><img class="fin-hero__logo" src="assets/brand/btech-smm-logo.png" alt="BTECH SMM" width="112" height="23" /><span class="fin-hero__icon">${ICON[icon] || ""}</span></div>
    <div class="fin-hero__body">
      <p class="fin-hero__label">${label}</p>
      <p class="fin-hero__amount">${amount}</p>
      <p class="fin-hero__chips">${chips}</p>
    </div>
    <div class="fin-hero__foot">${lines.filter(Boolean).map((l) => `<p>${l}</p>`).join("")}${action}</div>
  </article>`;
}

const section = (title, meta, body) => `<section class="fin-section"><h3 class="adash-h">${title} <span class="adash-h__meta">${meta}</span></h3>${body}</section>`;

async function rpc(name, args = {}) {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw new Error(error.message || "Request failed");
  return data;
}

/* ------------------------------ Delix wallet ----------------------------- */
function walletCard(w) {
  const refresh = `<button type="button" class="fin-hero__btn" data-fin-refresh-balance>Refresh balance</button>`;
  if (!w || !w.available) {
    return hero("wallet", {
      label: "Delix Provider Wallet", icon: "bank", amount: `<span class="fin-fig fin-fig--na">Balance unavailable</span>`,
      chips: tag("Unavailable", "fin-tag--grey"), attrs: "data-fin-wallet",
      lines: [escapeHtml(w?.reason || w?.last_error || "Delix has not returned a balance yet."), w?.last_error ? `<span class="fin-hero__err">Last error: ${escapeHtml(w.last_error)}</span>` : ""],
      action: refresh
    });
  }
  const ok = w.ok !== false;
  const rep = w.currency_reported ? `Delix labels it “${escapeHtml(w.currency_reported)}”` : `Delix sends no currency field`;
  return hero("wallet", {
    label: "Delix Provider Wallet", icon: "bank", amount: amountHtml(w.balance), attrs: "data-fin-wallet",
    chips: ok ? tag("Connected", "fin-tag--green") : tag("Last refresh failed", "fin-tag--red"),
    lines: [
      `Provider prepaid funds — not customer money and not business cash. ${rep}; BTECH treats the amount as KES (no conversion).`,
      `Last successful refresh: ${w.last_success_at ? escapeHtml(new Date(w.last_success_at).toLocaleString("en-KE")) : "never"}`,
      ok ? "" : `<span class="fin-hero__err">Last error: ${escapeHtml(w.last_error || "unknown")}. Showing the last good balance.</span>`],
    action: refresh
  });
}

async function refreshBalance(el, btn) {
  const now = Date.now();
  if (now < st.balanceBusyUntil) return void showToast("Please wait a few seconds before refreshing again.", "error");
  st.balanceBusyUntil = now + 30000;
  btn.disabled = true;
  btn.textContent = "Refreshing…";
  try {
    const { data, error } = await supabase.functions.invoke("delix-provider", { body: { action: "check-balance" } });
    if (error) throw new Error("Could not reach the provider function.");
    if (data && data.ok === false) throw new Error(data.error || "Balance could not be retrieved.");
    showToast("Delix balance refreshed.", "success");
  } catch (e) {
    showToast(e.message, "error", 5000);
  }
  await render(el.__w, el);
}

/* -------------------------------- overview ------------------------------- */
async function renderOverview(el, w) {
  const d = await rpc("admin_finance_overview", { p_from: w.from.toISOString(), p_to: w.to.toISOString() });
  const c = d.cur;
  const p = d.prev;
  const a = d.ambassadors;
  const covPct = num(c.net_revenue) > 0 ? Math.round((num(c.covered_revenue) / num(c.net_revenue)) * 100) : 100;
  const gapNote = num(c.uncovered_orders) > 0
    ? `<p class="fin-note fin-note--amber"><strong>${formatNumber(c.uncovered_orders)} paid order${num(c.uncovered_orders) === 1 ? "" : "s"} (${money(c.uncovered_revenue)}) have no provider cost yet</strong> — not yet sent to the provider, or the provider mapping/rate is missing. They are left out of profit, not guessed. See Reconciliation.</p>` : "";
  const backNote = num(c.cost_backfilled) > 0
    ? `<p class="fin-note fin-note--blue">${formatNumber(c.cost_backfilled)} order cost${num(c.cost_backfilled) === 1 ? " was" : "s were"} filled in afterwards using the current Delix rate (the rate at the time was not stored). They are estimates.</p>` : "";
  const flagNote = num(d.critical_flags) > 0
    ? `<p class="fin-note fin-note--red"><strong>${formatNumber(d.critical_flags)} critical reconciliation item${num(d.critical_flags) === 1 ? "" : "s"}</strong> need review. Figures below are not confirmed as reconciled. <a href="#" data-fin-goto="recon">Open reconciliation</a></p>` : "";

  const nop = num(d.net_operating_profit);
  const netRev = hero("revenue", {
    label: "Net order revenue", icon: "trend", amount: amountHtml(c.net_revenue), chips: tag("Actual", "fin-tag--green"),
    lines: [delta(c.net_revenue, p.net_revenue), `Gross sales ${money(c.gross_sales)} − refunds ${money(c.refunds)} · ${formatNumber(c.orders_paid)} paid orders`]
  });
  const netOp = hero("profit", {
    label: "Net operating profit", icon: "coins", amount: amountHtml(d.net_operating_profit),
    chips: tag("Estimated", "fin-tag--amber") + (nop < 0 ? " " + tag("Loss", "fin-tag--red") : ""),
    lines: [`After provider costs and ambassador commission expense only · ${delta(d.net_operating_profit, d.net_operating_profit_prev)}`, `Profit covers ${covPct}% of net revenue`]
  });

  el.querySelector("[data-fin-body]").innerHTML = `
    ${flagNote}${gapNote}${backNote}
    <div class="fin-hero-grid" role="group" aria-label="Key balances">${netRev}${netOp}${walletCard(d.delix_wallet)}</div>
    ${section("Revenue and profit", "orders created in this period · all amounts KES", `<div class="fin-grid">
      ${kpi("Gross order sales", c.gross_sales, `${formatNumber(c.orders_paid)} paid orders · after loyalty discounts, before refunds`, "Actual", "fin-tag--green", { icon: "receipt", tone: "positive" })}
      ${kpi("Gross profit", d.gross_profit, `Covers ${covPct}% of net revenue · ${delta(d.gross_profit, d.gross_profit_prev)}`, num(c.uncovered_orders) ? "Partial" : "Estimated", "fin-tag--amber", { icon: "trend", tone: num(d.gross_profit) < 0 ? "negative" : "positive" })}
      ${kpi("Provider costs", c.provider_cost, `${formatNumber(c.cost_orders)} orders · Delix rate × quantity ÷ 1000`, "Rate snapshot", "fin-tag--blue", { icon: "coins", tone: "cost" })}
    </div>`)}
    ${section("Customer money", "cash received and money held", `<div class="fin-grid">
      ${kpi("Customer payments received", num(c.deposits) + num(c.direct_order_payments), `${money(c.deposits)} wallet deposits · ${money(c.direct_order_payments)} direct order payments`, "Actual", "fin-tag--green", { icon: "check", tone: "positive" })}
      ${kpi("Pending / failed payments", `${amountHtml(c.payments_pending)} <span class="fin-mini__slash">/</span> ${amountHtml(c.payments_failed)}`, "Not money received", "Not revenue", "fin-tag--grey", { icon: "clock", tone: "pending", raw: true })}
      ${kpi("Customer wallet liabilities", d.wallet_liabilities, `${formatNumber(d.wallets_funded)} funded wallets · owed to customers, not income`, "Liability", "fin-tag--amber", { icon: "wallet", tone: "liability" })}
      ${kpi("Wallet spend on orders", c.wallet_spend, "Wallet balances used to pay orders (not extra revenue)", null, "fin-tag--grey", { icon: "wallet", tone: "neutral" })}
    </div>`)}
    ${section("Discounts and refunds", "already reflected in net revenue", `<div class="fin-grid">
      ${kpi("Discounts & loyalty redemptions", c.discounts, `List price ${money(c.list_sales)} → charged ${money(c.gross_sales)}. Points issued are not a cost.`, "Actual", "fin-tag--green", { icon: "tag", tone: "neutral" })}
      ${kpi("Refunds", c.refunds, `${formatNumber(c.refund_count)} refunded order${num(c.refund_count) === 1 ? "" : "s"} · the provider cost is not recovered automatically`, "Actual", "fin-tag--green", { icon: "undo", tone: "negative" })}
    </div>`)}
    ${section("Ambassadors", "commission is an expense; a payout is cash out", `<div class="fin-grid">
      ${kpi("Ambassador commissions", c.commission_expense, `${money(c.commission_earned)} earned · ${money(c.commission_reversed)} reversed · ${money(c.commission_adjustments)} adjustments`, "Expense", "fin-tag--blue", { icon: "users", tone: "cost" })}
      ${kpi("Pending release", a.commission_pending_release, "Earned, still inside the hold period — not withdrawable", "Pending", "fin-tag--amber", { icon: "clock", tone: "pending" })}
      ${kpi("Approved & available", a.commission_available, "Released and not yet requested", "Liability", "fin-tag--amber", { icon: "wallet", tone: "liability" })}
      ${kpi("Withdrawals awaiting approval", a.awaiting_approval, "Requested by ambassadors", "Pending", "fin-tag--amber", { icon: "clock", tone: "pending" })}
      ${kpi("Approved, awaiting payment", a.approved_unpaid, "Approved by an admin, not yet marked paid", "Pending", "fin-tag--amber", { icon: "send", tone: "pending" })}
      ${kpi("Ambassador payouts", c.payouts_paid, `${money(a.paid_total)} paid in total · marked paid with an M-Pesa reference`, "Confirmed paid", "fin-tag--green", { icon: "check", tone: "positive" })}
    </div>`)}
    ${section("Control", "data quality", `<div class="fin-grid">
      ${kpi("Unreconciled items", formatNumber(d.unreconciled), `${formatNumber(d.critical_flags)} critical`, num(d.unreconciled) ? "Review" : "Clear", num(d.unreconciled) ? "fin-tag--red" : "fin-tag--green", { icon: num(d.unreconciled) ? "alert" : "shield", tone: num(d.unreconciled) ? "negative" : "positive", raw: true })}
    </div>`)}
    <div class="panel adash-card fin-trend"><div class="panel__head"><h3>Daily net revenue and provider cost</h3><span class="adash-card__meta">Africa/Nairobi days</span></div><div class="panel__body panel__body--padded" data-fin-trend></div></div>
    <details class="fin-defs"><summary>How these figures are defined</summary><dl>${Object.entries(d.definitions).map(([k, v]) => `<dt>${escapeHtml(k.replace(/_/g, " "))}</dt><dd>${escapeHtml(v)}</dd>`).join("")}</dl>
      <p>Source tables: orders, payments, transactions, wallets, ambassador_commissions, ambassador_withdrawals. Nothing on this page is entered by hand.</p></details>`;

  const box = el.querySelector("[data-fin-trend]");
  const t = d.trend || [];
  if (!t.some((r) => num(r.net_revenue) > 0 || num(r.provider_cost) > 0)) box.innerHTML = `<div class="adash-empty"><p>No orders in this period.</p></div>`;
  else chart(box, {
    type: "line", labels: t.map((r) => formatDate(r.day)), series: [
      { name: "Net revenue", color: "var(--color-primary)", values: t.map((r) => num(r.net_revenue)) },
      { name: "Provider cost", color: "var(--color-warning)", values: t.map((r) => num(r.provider_cost)) }], money: true, title: "Daily net revenue and provider cost"
  });
}

/* -------------------------------- activity ------------------------------- */
const TYPE_LABEL = {
  wallet_deposit: "Wallet deposit", order_payment: "Order payment (M-Pesa)", order_sale: "Order sale", refund: "Refund", provider_cost: "Provider cost",
  commission_earn: "Commission earned", commission_reversal: "Commission reversed", commission_adjustment: "Commission adjustment", ambassador_payout: "Ambassador payout",
  wallet_tx_deposit: "Wallet credit (deposit)", wallet_tx_order: "Wallet debit (order)", wallet_tx_refund: "Wallet refund credit",
};
const typeLabel = (t) => TYPE_LABEL[t] || t.replace(/_/g, " ");

function actRow(r) {
  const dirTxt = r.direction === "credit" ? "Credit" : r.direction === "debit" ? "Debit" : "Memo";
  const dirCls = r.direction === "credit" ? "fin-tag--green" : r.direction === "debit" ? "fin-tag--blue" : "fin-tag--grey";
  return `<tr data-fin-open="${escapeHtml(r.entity_type)}|${escapeHtml(r.entity_id)}" tabindex="0" role="button">
    <td data-label="Date">${escapeHtml(new Date(r.date).toLocaleString("en-KE"))}</td>
    <td data-label="Reference">${escapeHtml(r.reference || "—")}</td>
    <td data-label="Type">${escapeHtml(typeLabel(r.type))}</td>
    <td data-label="Related">${r.order_id ? `Order ${escapeHtml(r.order_id)}` : ""}${r.customer ? `<br /><span class="muted">${escapeHtml(r.customer)}</span>` : ""}${r.counterparty ? `<br /><span class="muted">${escapeHtml(r.counterparty)}</span>` : ""}</td>
    <td data-label="Direction">${tag(dirTxt, dirCls)}</td>
    <td data-label="Amount" class="fin-num">${formatCurrency(r.amount)}</td>
    <td data-label="Status">${escapeHtml(r.status || "—")}</td>
    <td data-label="Reconciliation">${r.recon_state === "review" ? tag("Review", "fin-tag--red") : tag("Matched", "fin-tag--green")}</td></tr>`;
}

async function renderActivity(el, w) {
  const args = { p_from: w.from.toISOString(), p_to: w.to.toISOString(), p_type: st.type || null, p_search: st.q || null, p_status: st.status || null, p_limit: PAGE, p_offset: st.offset };
  const body = el.querySelector("[data-fin-body]");
  if (!body.querySelector("[data-fin-act-filters]")) {
    body.innerHTML = `
      <form class="fin-filters" data-fin-act-filters>
        <label>Type<select name="type">${TYPES.map(([v, l]) => `<option value="${v}" ${v === st.type ? "selected" : ""}>${l}</option>`).join("")}</select></label>
        <label>Status<input name="status" value="${escapeHtml(st.status)}" placeholder="e.g. paid" maxlength="30" /></label>
        <label class="fin-grow">Search<input name="q" value="${escapeHtml(st.q)}" placeholder="Reference, order, customer, ambassador" maxlength="80" /></label>
        <button class="btn btn--primary btn--sm" type="submit">Apply</button>
        <button class="btn btn--secondary btn--sm" type="button" data-fin-export>Export CSV</button>
      </form>
      <div data-fin-act-table></div>`;
  }
  const holder = body.querySelector("[data-fin-act-table]");
  holder.innerHTML = `<div class="skeleton" style="height:160px"></div>`;
  const d = await rpc("admin_finance_activity", args);
  const rows = d.rows || [];
  const pages = Math.max(1, Math.ceil(num(d.total) / PAGE));
  const page = Math.floor(st.offset / PAGE) + 1;
  holder.innerHTML = rows.length
    ? `<div class="table-card"><table class="data-table fin-table"><thead><tr><th>Date</th><th>Reference</th><th>Type</th><th>Related</th><th>Direction</th><th>Amount (KES)</th><th>Status</th><th>Reconciliation</th></tr></thead><tbody>${rows.map(actRow).join("")}</tbody></table></div>
       <div class="fin-pager"><span>${formatNumber(d.total)} record${num(d.total) === 1 ? "" : "s"} · page ${page} of ${pages}</span>
       <span><button class="btn btn--secondary btn--sm" data-fin-page="-1" ${page <= 1 ? "disabled" : ""}>Previous</button> <button class="btn btn--secondary btn--sm" data-fin-page="1" ${page >= pages ? "disabled" : ""}>Next</button></span></div>
       <p class="adash-foot">Debit/credit is from BTECH's side: credit = money or revenue recognised, debit = cost or money paid out, memo = recorded but not posted (pending, failed or wallet movement). Select a row for details.</p>`
    : `<div class="adash-empty"><p>No financial activity matches these filters in this period.</p></div>`;
}

const csvCell = (v) => {
  let s = v == null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // spreadsheet formula injection guard
  return `"${s.replace(/"/g, '""')}"`;
};

async function exportCsv(w, btn) {
  btn.disabled = true;
  try {
    const d = await rpc("admin_finance_activity", { p_from: w.from.toISOString(), p_to: w.to.toISOString(), p_type: st.type || null, p_search: st.q || null, p_status: st.status || null, p_limit: 5000, p_offset: 0, p_for_export: true });
    const cols = ["date", "type", "reference", "order_id", "counterparty", "direction", "amount", "currency", "status", "recon_state"];
    const lines = [cols.join(",")].concat((d.rows || []).map((r) => cols.map((c) => csvCell(r[c])).join(",")));
    const blob = new Blob([lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `btech-finance-activity-${w.from.toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    showToast(`Exported ${formatNumber((d.rows || []).length)} records${num(d.total) > 5000 ? " (first 5,000 — narrow the filters for the rest)" : ""}. Customer names and emails are not included.`, "success", 5000);
  } catch (e) {
    showToast(e.message, "error", 5000);
  }
  btn.disabled = false;
}

function kv(label, value) {
  return value == null || value === "" ? "" : `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(String(value))}</dd>`;
}

async function openDetail(el, key) {
  const [type, id] = key.split("|");
  let d;
  try {
    d = await rpc("admin_finance_entity", { p_type: type, p_id: id });
  } catch (e) {
    return void showToast(e.message, "error");
  }
  const flags = (d.flags || []).map((f) => `<li>${tag(f.check, "fin-tag--red")} ${escapeHtml(f.detail)}</li>`).join("");
  let main = "";
  let extra = "";
  if (d.order) {
    const o = d.order;
    main = kv("Order", o.id) + kv("Service", o.service_id) + kv("Quantity", o.quantity) + kv("Price charged (KES)", o.amount) + kv("List price (KES)", o.list_amount) +
      kv("Loyalty discount (KES)", o.loyalty_discount_amount) + kv("Order status", o.status) + kv("Payment status", o.payment_status) + kv("Provider", o.provider) +
      kv("Provider order", o.provider_order_id) + kv("Provider status", o.provider_status) + kv("Provider cost (KES)", o.provider_cost_kes) + kv("Cost basis", o.provider_cost_status) +
      (d.customer ? kv("Customer", `${d.customer.name} ${d.customer.email}`) : "");
    const b = o.provider_cost_basis;
    if (b?.ok) extra += `<p class="fin-note fin-note--blue">Cost = rate KES ${escapeHtml(String(b.rate_kes))} × ${escapeHtml(String(b.quantity))} ÷ ${escapeHtml(String(b.rate_per_quantity))}. Delix sent the rate as ${escapeHtml(String(b.rate_as_sent))} “${escapeHtml(String(b.label_currency || ""))}”; interpreted as ${escapeHtml(String(b.rate_currency))}${b.fx_applied ? ` and converted at ${escapeHtml(String(b.fx_applied))}` : " with no exchange conversion"}.</p>`;
    else if (b) extra += `<p class="fin-note fin-note--amber">No cost recorded: ${escapeHtml(b.reason || "unknown")}</p>`;
    if (d.payments?.length) extra += `<h4>Payments</h4><ul>${d.payments.map((p) => `<li>${escapeHtml(p.status)} · ${formatCurrency(p.amount)} · ${escapeHtml(p.receipt || "no receipt")}</li>`).join("")}</ul>`;
    if (d.commissions?.length) extra += `<h4>Commission</h4><ul>${d.commissions.map((c) => `<li>${escapeHtml(c.type)} · ${formatCurrency(c.amount)} · ${escapeHtml(c.status)}</li>`).join("")}</ul>`;
    if (d.refunds?.length) extra += `<h4>Refund requests</h4><ul>${d.refunds.map((r) => `<li>${escapeHtml(r.status)} · ${formatCurrency(r.amount)}</li>`).join("")}</ul>`;
    if (d.cost_corrections?.length) extra += `<h4>Cost corrections</h4><ul>${d.cost_corrections.map((c) => `<li>${escapeHtml(new Date(c.created_at).toLocaleString("en-KE"))}: ${escapeHtml(JSON.stringify(c.old_value))} → ${escapeHtml(JSON.stringify(c.new_value))} — ${escapeHtml(c.reason)}</li>`).join("")}</ul>`;
    if (o.provider_order_id)
      extra += `<form class="fin-correct" data-fin-correct="${escapeHtml(o.id)}"><h4>Correct the provider cost</h4>
        <p class="form-hint">Use this when the Delix panel shows a different charge. The original value is kept in the corrections log.</p>
        <label>New cost (KES)<input name="cost" type="number" step="0.0001" min="0" required /></label>
        <label>Reason (required)<input name="reason" minlength="5" maxlength="300" required placeholder="e.g. Delix invoice #… showed KES 30" /></label>
        <button class="btn btn--primary btn--sm" type="submit">Record correction</button></form>`;
  } else if (d.payment) {
    const p = d.payment;
    main = kv("Payment", p.id) + kv("Type", p.payment_type) + kv("Amount (KES)", p.amount) + kv("Status", p.status) + kv("M-Pesa receipt", p.mpesa_receipt_number) + kv("Result", p.result_description) + kv("Created", p.created_at);
  } else if (d.commission) {
    const c = d.commission;
    main = kv("Ambassador", d.ambassador) + kv("Type", c.type) + kv("Amount (KES)", c.amount) + kv("Commissionable (KES)", c.commissionable_amount) + kv("Rate %", c.rate_percent) + kv("Status", c.status) + kv("Order", c.order_id) + kv("Available from", c.available_at);
  } else if (d.withdrawal) {
    const x = d.withdrawal;
    main = kv("Ambassador", d.ambassador) + kv("Amount (KES)", x.amount) + kv("Status", x.status) + kv("Requested", x.requested_at) + kv("Reviewed", x.reviewed_at) + kv("Paid", x.paid_at) + kv("M-Pesa reference", x.payout_reference) + kv("Admin note", x.admin_note);
  } else if (d.transaction) {
    const x = d.transaction;
    main = kv("Wallet transaction", x.id) + kv("Type", x.type) + kv("Amount (KES)", x.amount) + kv("Status", x.status) + kv("Note", x.note) + kv("Customer", d.customer) + kv("Created", x.created_at);
  } else main = `<p>${escapeHtml(d.error || "No details.")}</p>`;

  const host = document.createElement("div");
  host.className = "modal-overlay";
  host.innerHTML = `<div class="modal fin-modal" role="dialog" aria-modal="true" aria-label="Financial record"><div class="modal__head"><h3>Financial record</h3><button type="button" class="btn btn--secondary btn--sm" data-fin-close>Close</button></div>
    <div class="modal__body">${flags ? `<ul class="fin-flags">${flags}</ul>` : ""}<dl class="fin-dl">${main}</dl>${extra}</div></div>`;
  document.body.appendChild(host);
  const close = () => host.remove();
  host.addEventListener("click", (e) => {
    if (e.target === host || e.target.closest("[data-fin-close]")) close();
  });
  host.addEventListener("keydown", (e) => e.key === "Escape" && close());
  host.querySelector("[data-fin-close]").focus();
  host.querySelector("[data-fin-correct]")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    const btn = f.querySelector("button[type=submit]");
    btn.disabled = true;
    try {
      await rpc("admin_correct_order_cost", { p_order: f.dataset.finCorrect, p_cost: Number(f.cost.value), p_reason: f.reason.value });
      showToast("Correction recorded.", "success");
      close();
      await render(el.__w, el);
    } catch (err) {
      showToast(err.message, "error", 5000);
      btn.disabled = false;
    }
  });
}

/* ----------------------------- reconciliation ---------------------------- */
/* Payments held for manual review (TUMA attempts with an unknown outcome or a failed verification).
   Read-only. Uses the existing admin-only RLS policy payments_select_admin; customers cannot read other users' rows.
   Degrades silently to nothing if the needs_review column doesn't exist yet (migration not applied). */
async function heldPaymentsHtml() {
  const { data, error } = await supabase.from("payments")
    .select("id,user_id,payment_type,order_id,amount,verified_amount,status,provider,created_at,result_description")
    .or("needs_review.eq.true,and(provider.eq.tuma,status.in.(pending,processing))").order("created_at", { ascending: false }).limit(50);
  if (error || !data?.length) return "";
  return `<details class="fin-check" open><summary>${tag("Critical", "fin-tag--red")} <strong>Payments held for review</strong> <span class="muted">${formatNumber(data.length)} item${data.length === 1 ? "" : "s"}</span></summary>
    <dl class="fin-dl"><dt>What this means</dt><dd>Money may have been received, or may be about to be, but the system could not safely confirm it. Nothing was credited automatically.</dd><dt>Recommended action</dt><dd>Open the TUMA dashboard and find the transaction. If it shows as paid, press Confirm paid and type the amount TUMA shows; the customer is then credited once. If not paid, do nothing and do not credit.</dd></dl>
    <div class="table-card"><table class="data-table"><thead><tr><th>When</th><th>Type</th><th>Amount (KES)</th><th>Status</th><th>Detail</th><th></th></tr></thead><tbody>${data.map((p) => `<tr><td data-label="When">${escapeHtml(new Date(p.created_at).toLocaleString("en-KE"))}</td><td data-label="Type">${escapeHtml(p.payment_type)}${p.order_id ? " " + escapeHtml(String(p.order_id).slice(0, 12)) : ""} · ${escapeHtml(p.provider)}</td><td data-label="Amount" class="fin-num">${formatCurrency(p.amount)}${p.verified_amount != null && Number(p.verified_amount) !== Number(p.amount) ? ` (verified ${formatCurrency(p.verified_amount)})` : ""}</td><td data-label="Status">${escapeHtml(p.status)}</td><td data-label="Detail">${escapeHtml(p.result_description || "")} <span class="muted">${escapeHtml(String(p.id).slice(0, 8))} · user ${escapeHtml(String(p.user_id).slice(0, 8))}</span></td><td data-label="Action">${p.provider === "tuma" && ["pending", "processing", "expired"].includes(p.status) ? `<button class="btn btn--secondary btn--sm" data-fin-confirm="${escapeHtml(p.id)}|${escapeHtml(String(p.amount))}">Confirm paid</button>` : ""}</td></tr>`).join("")}</tbody></table></div></details>`;
}

/* Paid orders not yet submitted to Delix, with their submission state and retry actions. Admin-only: orders are read through
   orders_select_admin and order_fulfilments through order_fulfilments_select_admin; customers cannot read this ledger.
   Shows nothing if the fulfilment migration isn't applied yet (ledger query fails) or nothing is waiting. */
const FUL_LABEL = { none: ["Not attempted", "fin-tag--amber"], failed: ["Failed, safe to retry", "fin-tag--amber"], submitting: ["In progress", "fin-tag--grey"], stuck: ["Stuck: check Delix", "fin-tag--red"], needs_review: ["Unknown outcome: check Delix", "fin-tag--red"] };
async function unsentOrdersHtml() {
  const { data: orders, error } = await supabase.from("orders").select("id,user_id,amount,status,created_at")
    .eq("payment_status", "paid").is("provider_order_id", null).neq("status", "cancelled").order("created_at", { ascending: false }).limit(50);
  if (error || !orders?.length) return "";
  const { data: jobs, error: jerr } = await supabase.from("order_fulfilments").select("order_id,status,attempts,last_error,claimed_at").in("order_id", orders.map((o) => o.id));
  if (jerr) return "";
  const byId = Object.fromEntries((jobs || []).map((j) => [j.order_id, j]));
  const rows = orders.map((o) => {
    const j = byId[o.id];
    const key = !j ? "none" : j.status === "submitting" && Date.now() - new Date(j.claimed_at).getTime() > 10 * 60_000 ? "stuck" : j.status;
    const [txt, cls] = FUL_LABEL[key] || FUL_LABEL.none;
    const held = key === "needs_review" || key === "stuck";
    const act = key === "none" || key === "failed" ? `<button class="btn btn--secondary btn--sm" data-fin-ful="submit|${escapeHtml(o.id)}">Submit to Delix</button>`
      : held ? `<button class="btn btn--secondary btn--sm" data-fin-ful="retry|${escapeHtml(o.id)}">Release for retry</button> <button class="btn btn--secondary btn--sm" data-fin-ful="submitted|${escapeHtml(o.id)}">Mark as sent</button>` : "";
    return `<tr><td data-label="Order">${escapeHtml(String(o.id).slice(0, 12))}</td><td data-label="Amount" class="fin-num">${formatCurrency(o.amount)}</td><td data-label="Delix">${tag(txt, cls)} ${j ? `<span class="muted">${formatNumber(j.attempts)} attempt${j.attempts === 1 ? "" : "s"}${j.last_error ? " · " + escapeHtml(j.last_error) : ""}</span>` : ""}</td><td data-label="Action">${act}</td></tr>`;
  }).join("");
  return `<details class="fin-check" open><summary>${tag("Critical", "fin-tag--red")} <strong>Paid orders not submitted to Delix</strong> <span class="muted">${formatNumber(orders.length)} order${orders.length === 1 ? "" : "s"}</span></summary>
    <dl class="fin-dl"><dt>What this means</dt><dd>The customer has paid but the order has not reached Delix. "Unknown outcome" means a request may have created the Delix order, so it is never retried automatically: check the Delix panel first.</dd></dl>
    <div class="table-card"><table class="data-table"><thead><tr><th>Order</th><th>Amount (KES)</th><th>Delix submission</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></details>`;
}

async function confirmPayment(el, btn) {
  const [id, expected] = btn.dataset.finConfirm.split("|");
  const amt = window.prompt(`Open the TUMA dashboard and find this payment (reference ${id.slice(0, 8)}).\nType the amount TUMA shows as PAID, in KES:`);
  if (amt === null || amt.trim() === "") return;
  const receipt = window.prompt("M-Pesa receipt number shown by TUMA (optional):") || "";
  btn.disabled = true;
  try {
    const r = await rpc("admin_confirm_tuma_payment", { p_payment_id: id, p_amount: Number(amt), p_receipt: receipt });
    if (!r?.ok) throw new Error(`Not confirmed (${r?.reason || "unknown"}).${r?.reason === "amount_mismatch" ? ` Expected KES ${expected}.` : ""}`);
    showToast(r.already ? "Already confirmed earlier." : "Payment confirmed and credited.", "success", 5000);
  } catch (err) {
    showToast(err.message, "error", 6000);
  }
  render(el.__w, el);
}

async function fulfilAction(el, btn) {
  const [action, orderId] = btn.dataset.finFul.split("|");
  let ref = null;
  if (action === "submitted") {
    ref = (window.prompt("Enter the Delix order ID you found in the Delix panel for this order:") || "").trim();
    if (!ref) return;
  } else if (action === "retry" && !window.confirm("Only release this if you have checked Delix and no order exists for it. Releasing a real order will create a duplicate. Continue?")) return;
  btn.disabled = true;
  try {
    if (action === "submit") {
      const { data, error } = await supabase.functions.invoke("delix-provider", { body: { action: "create-order", order_id: orderId } });
      if (error || !data?.ok) throw new Error(data?.error || "Could not reach the provider function.");
      showToast("Order submitted to Delix.", "success");
    } else {
      const r = await rpc("admin_resolve_fulfilment", { p_order_id: orderId, p_action: action, p_provider_order_id: ref });
      if (!r?.ok) throw new Error(`Not changed (${r?.reason || "unknown"}).`);
      showToast(action === "retry" ? "Released for retry." : "Marked as sent.", "success");
    }
  } catch (err) {
    showToast(err.message, "error", 6000);
  }
  render(el.__w, el);
}

async function renderRecon(el) {
  const d = await rpc("admin_finance_reconciliation");
  const held = (await heldPaymentsHtml().catch(() => "")) + (await unsentOrdersHtml().catch(() => ""));
  const checks = d.checks || [];
  const open = checks.filter((c) => num(c.count) > 0).sort((a, b) => ["critical", "warning", "info"].indexOf(a.severity) - ["critical", "warning", "info"].indexOf(b.severity));
  const clean = checks.filter((c) => num(c.count) === 0);
  el.querySelector("[data-fin-body]").innerHTML = `
    <p class="fin-note ${open.some((c) => c.severity === "critical") ? "fin-note--red" : open.length ? "fin-note--amber" : "fin-note--green"}">
      ${open.length ? `<strong>${open.length} check${open.length === 1 ? "" : "s"} found discrepancies.</strong> Nothing has been changed automatically: each item needs a person to confirm the cause. Reconciliation is not complete until these are resolved.` : "<strong>No discrepancies found</strong> by the checks below."}
      <span class="muted"> Generated ${escapeHtml(new Date(d.generated_at).toLocaleString("en-KE"))}.</span></p>
    ${held}
    <div class="fin-recon-actions"><button class="btn btn--secondary btn--sm" data-fin-backfill>Fill missing provider costs</button>
      <span class="form-hint">Fills only orders sent to a provider with no cost, using the current provider rate. Logged in the audit trail.</span></div>
    ${open.map((c) => {
    const [txt, cls] = SEV[c.severity] || SEV.info;
    return `<details class="fin-check" open><summary>${tag(txt, cls)} <strong>${escapeHtml(c.check_id)} · ${escapeHtml(c.title)}</strong> <span class="muted">${formatNumber(c.count)} item${num(c.count) === 1 ? "" : "s"} · ${formatCurrency(c.amount)}</span></summary>
        <dl class="fin-dl"><dt>Probable cause</dt><dd>${escapeHtml(c.probable_cause)}</dd><dt>Recommended action</dt><dd>${escapeHtml(c.recommended_action)}</dd><dt>Resolved?</dt><dd>No — open</dd></dl>
        <div class="table-card"><table class="data-table"><thead><tr><th>Record</th><th>Amount (KES)</th><th>Detail</th></tr></thead><tbody>${(c.sample || []).map((s) => `<tr data-fin-open="${escapeHtml(s.entity_type)}|${escapeHtml(s.entity_id)}" tabindex="0" role="button"><td data-label="Record">${escapeHtml(s.entity_type)} ${escapeHtml(String(s.entity_id).slice(0, 12))}</td><td data-label="Amount" class="fin-num">${formatCurrency(s.amount)}</td><td data-label="Detail">${escapeHtml(s.detail)}</td></tr>`).join("")}</tbody></table></div>
        ${num(c.count) > (c.sample || []).length ? `<p class="adash-foot">Showing the first ${(c.sample || []).length} of ${formatNumber(c.count)}.</p>` : ""}</details>`;
  }).join("")}
    ${clean.length ? `<details class="fin-check"><summary>${tag("Clear", "fin-tag--green")} <strong>${clean.length} check${clean.length === 1 ? "" : "s"} with no findings</strong></summary><ul>${clean.map((c) => `<li>${escapeHtml(c.check_id)} · ${escapeHtml(c.title)}</li>`).join("")}</ul></details>` : ""}
    <h3 class="adash-h" style="margin-top:var(--sp-6)">Corrections log <span class="adash-h__meta">append-only</span></h3>
    ${(d.corrections || []).length ? `<div class="table-card"><table class="data-table"><thead><tr><th>When</th><th>Record</th><th>Change</th><th>Reason</th></tr></thead><tbody>${d.corrections.map((c) => `<tr><td data-label="When">${escapeHtml(new Date(c.created_at).toLocaleString("en-KE"))}</td><td data-label="Record">${escapeHtml(c.entity_type)} ${escapeHtml(c.entity_id)}</td><td data-label="Change">${escapeHtml(JSON.stringify(c.old_value))} → ${escapeHtml(JSON.stringify(c.new_value))}</td><td data-label="Reason">${escapeHtml(c.reason)}</td></tr>`).join("")}</tbody></table></div>` : `<div class="adash-empty"><p>No corrections have been recorded.</p></div>`}`;
}

/* ------------------------- estimate comparison --------------------------- */
async function renderCorrections(el, w) {
  const d = await rpc("admin_finance_estimate_comparison", { p_from: w.from.toISOString(), p_to: w.to.toISOString() });
  const rows = d.rows || [];
  el.querySelector("[data-fin-body]").innerHTML = `
    <p class="fin-note fin-note--blue"><strong>Delix rates are interpreted as KES.</strong> “Previous method” shows what the old calculation produced by multiplying the same rate by the USD→KES setting${d.fx_in_settings ? ` (${escapeHtml(String(d.fx_in_settings))})` : " (not currently set)"}. No stored order, payment or commission was changed; costs are recorded on new columns.</p>
    ${rows.length ? `<div class="table-card"><table class="data-table"><thead><tr><th>Service</th><th>Paid orders</th><th>Revenue</th><th>Cost (KES, corrected)</th><th>Cost (previous method)</th><th>Profit (corrected)</th><th>Profit (previous method)</th></tr></thead><tbody>${rows.map((r) => `<tr><td data-label="Service">${escapeHtml(r.service)}${r.uses_backfilled_cost ? ` ${tag("includes backfilled", "fin-tag--blue")}` : ""}</td><td data-label="Paid orders">${formatNumber(r.orders)}</td><td data-label="Revenue" class="fin-num">${formatCurrency(r.revenue)}</td><td data-label="Cost (corrected)" class="fin-num">${formatCurrency(r.cost_corrected_kes)}</td><td data-label="Cost (previous)" class="fin-num">${r.cost_previous_method_kes == null ? "—" : formatCurrency(r.cost_previous_method_kes)}</td><td data-label="Profit (corrected)" class="fin-num">${formatCurrency(r.profit_corrected_kes)}</td><td data-label="Profit (previous)" class="fin-num">${r.profit_previous_method_kes == null ? "—" : formatCurrency(r.profit_previous_method_kes)}</td></tr>`).join("")}</tbody></table></div>` : `<div class="adash-empty"><p>No paid orders with a recorded provider cost in this period.</p></div>`}
    <p class="adash-foot">The previous-method columns are for comparison only and are not used anywhere else. The USD→KES setting should only ever be applied to amounts that are genuinely in US dollars.</p>`;
}

/* --------------------------------- shell --------------------------------- */
async function render(w, el) {
  el.__w = w;
  const body = el.querySelector("[data-fin-body]");
  el.querySelectorAll("[data-fin-sub]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.finSub === st.sub)));
  if (st.sub !== "activity") body.innerHTML = `<div class="skeleton" style="height:220px"></div>`;
  try {
    if (st.sub === "activity") await renderActivity(el, w);
    else if (st.sub === "recon") await renderRecon(el);
    else if (st.sub === "corrections") await renderCorrections(el, w);
    else await renderOverview(el, w);
  } catch (e) {
    body.innerHTML = `<div class="adash-empty"><p>Couldn't load this section: ${escapeHtml(e.message)}</p><button class="btn btn--secondary btn--sm" data-fin-retry>Try again</button></div>`;
  }
}

export async function renderFinanceCentre(holder, w) {
  // Insights hands this function a detached holder and then moves its children into the page, so the
  // listeners live on our own root element (which moves with them), never on the holder.
  holder.innerHTML = `<div class="fin" data-fin-root>
    <div class="fin-head"><p class="muted">All amounts are Kenyan shillings (KES). Figures are calculated on the server from the order, payment, wallet and ambassador records for the selected period.</p></div>
    <div class="amb-tabs fin-subtabs" role="tablist" aria-label="Finance sections">${SUBTABS.map(([k, l]) => `<button type="button" role="tab" data-fin-sub="${k}" aria-selected="${k === st.sub}">${l}</button>`).join("")}</div>
    <div data-fin-body></div></div>`;
  const el = holder.querySelector("[data-fin-root]");
  el.__w = w;
  {
    el.addEventListener("click", async (e) => {
      const sub = e.target.closest("[data-fin-sub]");
      if (sub) {
        st.sub = sub.dataset.finSub;
        st.offset = 0;
        return void render(el.__w, el);
      }
      const go = e.target.closest("[data-fin-goto]");
      if (go) {
        e.preventDefault();
        st.sub = go.dataset.finGoto;
        return void render(el.__w, el);
      }
      if (e.target.closest("[data-fin-retry]")) return void render(el.__w, el);
      const rb = e.target.closest("[data-fin-refresh-balance]");
      if (rb) return void refreshBalance(el, rb);
      const pg = e.target.closest("[data-fin-page]");
      if (pg) {
        st.offset = Math.max(0, st.offset + Number(pg.dataset.finPage) * PAGE);
        return void render(el.__w, el);
      }
      if (e.target.closest("[data-fin-export]")) return void exportCsv(el.__w, e.target.closest("[data-fin-export]"));
      if (e.target.closest("[data-fin-backfill]")) {
        const btn = e.target.closest("[data-fin-backfill]");
        btn.disabled = true;
        try {
          const n = await rpc("admin_backfill_provider_costs", { p_reason: "Admin ran Fill missing provider costs from Reconciliation" });
          showToast(`${formatNumber(n)} order cost${n === 1 ? "" : "s"} filled in.`, "success");
        } catch (err) {
          showToast(err.message, "error", 5000);
        }
        return void render(el.__w, el);
      }
      const cp = e.target.closest("[data-fin-confirm]");
      if (cp) return void confirmPayment(el, cp);
      const fb = e.target.closest("[data-fin-ful]");
      if (fb) return void fulfilAction(el, fb);
      const row = e.target.closest("[data-fin-open]");
      if (row) return void openDetail(el, row.dataset.finOpen);
    });
    el.addEventListener("keydown", (e) => {
      const row = e.target.closest?.("[data-fin-open]");
      if (row && (e.key === "Enter" || e.key === " ")) {
        e.preventDefault();
        openDetail(el, row.dataset.finOpen);
      }
    });
    el.addEventListener("submit", (e) => {
      const f = e.target.closest("[data-fin-act-filters]");
      if (!f) return;
      e.preventDefault();
      st.type = f.type.value;
      st.status = f.status.value.trim();
      st.q = f.q.value.trim();
      st.offset = 0;
      render(el.__w, el);
    });
  }
  await render(w, el);
}