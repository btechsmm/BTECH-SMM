/**
 * BTECH SMM — Loyalty & Rewards (customer side)
 * ----------------------------------------------------------------
 * Display only. Every number here comes from the database:
 *  - get_my_loyalty()          summary, level, next level, rules (RPC)
 *  - loyalty_transactions      the caller's own points ledger (RLS-scoped)
 * Nothing is stored in localStorage and nothing here can change points, a
 * level or a price — those are decided by triggers/RPCs in the database.
 *
 * Loyalty points are NOT wallet money; the UI keeps the two clearly apart.
 */

import { supabase } from "./supabase.js";
import { formatCurrency, formatNumber, formatDateTime, escapeHtml } from "./utils.js";

const STAR = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8L3.5 9.7l5.9-.9L12 3.5z"/></svg>`;

const TYPE_LABEL = { earn: "Order", reversal: "Reversal", bonus: "Bonus", adjustment: "Adjustment", redemption: "Redemption" };
const HISTORY_PAGE = 15;

/** Loyalty summary for the signed-in customer, or null if unavailable. { enabled:false } when the programme is off. */
export async function fetchMyLoyalty() {
  try {
    const { data, error } = await supabase.rpc("get_my_loyalty");
    if (error || !data) return null;
    return data;
  } catch {
    return null;
  }
}

function levelName(d) {
  return d.level?.name || "Regular";
}

function discountLabel(d) {
  const pct = Number(d.level?.discount_percent || 0);
  return pct > 0 ? `${pct}% Loyalty Discount` : "No loyalty discount yet";
}

/** Requirements for the next level and overall progress (all minimums must be met). */
function nextLevelProgress(d) {
  const n = d.next_level;
  if (!n) return null;
  const parts = [];
  if (Number(n.min_spend) > 0) parts.push({ label: "Qualifying spend", cur: Number(d.qualifying_spend), target: Number(n.min_spend), money: true });
  if (Number(n.min_orders) > 0) parts.push({ label: "Qualifying orders", cur: Number(d.qualifying_orders), target: Number(n.min_orders) });
  if (Number(n.min_points) > 0) parts.push({ label: "Lifetime points", cur: Number(d.lifetime_points), target: Number(n.min_points) });
  const ratios = parts.map((p) => Math.min(1, p.cur / p.target));
  const pct = ratios.length ? Math.floor(Math.min(...ratios) * 100) : 100;
  return { parts, pct };
}

function fmtReq(p, value) {
  return p.money ? formatCurrency(value) : formatNumber(value);
}

/* ------------------------------ wallet card ------------------------------ */
export async function renderWalletLoyalty(container) {
  if (!container) return;
  const d = await fetchMyLoyalty();
  if (!d || d.enabled === false) {
    container.hidden = true;
    return;
  }
  container.hidden = false;
  container.innerHTML = `
    <div class="panel loyalty-summary">
      <div class="panel__head">
        <h3>Loyalty Rewards</h3>
        <a href="loyalty.html" class="link-btn">View Loyalty &amp; Rewards</a>
      </div>
      <div class="loyalty-summary__body">
        <div class="loyalty-stat">
          <span class="loyalty-stat__label">Loyalty points</span>
          <span class="loyalty-stat__value"><span class="loyalty-star" aria-hidden="true">${STAR}</span>${formatNumber(d.points)} <small>Points</small></span>
        </div>
        <div class="loyalty-stat">
          <span class="loyalty-stat__label">Level</span>
          <span class="loyalty-stat__value">${escapeHtml(levelName(d))}</span>
        </div>
        <div class="loyalty-stat">
          <span class="loyalty-stat__label">Discount</span>
          <span class="loyalty-stat__value">${Number(d.level?.discount_percent || 0)}%</span>
        </div>
      </div>
      <p class="loyalty-summary__note">Points are rewards for your activity. They are separate from your wallet balance and are not spendable money.</p>
    </div>`;
}

/* ------------------------------ loyalty page ----------------------------- */
function progressHtml(d) {
  const prog = nextLevelProgress(d);
  if (!d.next_level) {
    return `<div class="panel__body panel__body--padded"><p class="loyalty-note">You have reached the highest level. Thank you for being a loyal BTECH SMM customer.</p></div>`;
  }
  const rows = prog.parts
    .map((p) => {
      const remaining = Math.max(0, p.target - p.cur);
      return `<li><span>${p.label}</span><span>${fmtReq(p, p.cur)} / ${fmtReq(p, p.target)}${remaining > 0 ? ` <em>· ${fmtReq(p, remaining)} to go</em>` : ""}</span></li>`;
    })
    .join("");
  return `
    <div class="panel__body panel__body--padded">
      <div class="loyalty-progress__head">
        <strong>${escapeHtml(levelName(d))} &rarr; ${escapeHtml(d.next_level.name)}</strong>
        <span>${prog.pct}%</span>
      </div>
      <div class="delivery-progress__bar" role="progressbar" aria-valuenow="${prog.pct}" aria-valuemin="0" aria-valuemax="100" aria-label="Progress to ${escapeHtml(d.next_level.name)}">
        <div class="delivery-progress__bar-fill delivery-progress__bar-fill--processing" style="width:${prog.pct}%"></div>
      </div>
      <ul class="loyalty-req">${rows}</ul>
      <p class="loyalty-note">${Number(d.next_level.discount_percent) > 0 ? `${escapeHtml(d.next_level.name)} members get a ${Number(d.next_level.discount_percent)}% loyalty discount on eligible services. ` : ""}All requirements above must be met.</p>
    </div>`;
}

function levelsHtml(d) {
  const currentId = d.level?.id;
  const rows = (d.levels || [])
    .map((l) => {
      const reqs = [];
      if (Number(l.min_spend) > 0) reqs.push(`${formatCurrency(l.min_spend)} spend`);
      if (Number(l.min_orders) > 0) reqs.push(`${formatNumber(l.min_orders)} orders`);
      if (Number(l.min_points) > 0) reqs.push(`${formatNumber(l.min_points)} points`);
      return `<tr>
        <td data-label="Level"><strong>${escapeHtml(l.name)}</strong>${l.id === currentId ? ` <span class="badge badge--accent">You</span>` : ""}</td>
        <td data-label="Requirements">${reqs.length ? reqs.join(" · ") : "None"}</td>
        <td data-label="Discount">${Number(l.discount_percent)}%</td>
        <td data-label="Details">${escapeHtml(l.description || "—")}</td>
      </tr>`;
    })
    .join("");
  return `<div class="table-card"><table class="data-table"><thead><tr><th>Level</th><th>Requirements</th><th>Discount</th><th>Details</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function rulesHtml(d) {
  const c = d.config;
  const when = c.qualify_on === "paid" ? "paid for" : "completed";
  return `<ul class="loyalty-rules">
    <li>Earn <strong>${formatNumber(c.points_per_unit)}</strong> points for every <strong>${formatCurrency(c.spend_unit)}</strong> spent on qualifying orders${Number(c.min_qualifying_order) > 0 ? ` (minimum order ${formatCurrency(c.min_qualifying_order)})` : ""}.</li>
    <li>Points are added once an order is ${when}. Unpaid, cancelled and refunded orders do not earn points.</li>
    <li>If an order that earned points is refunded or cancelled, those points are removed.</li>
    <li>Loyalty points are not wallet money and cannot be exchanged for cash.</li>
    <li>Loyalty discounts apply only to eligible services and are shown before you confirm an order.</li>
  </ul>`;
}

function historyRowHtml(t) {
  const pts = Number(t.points);
  return `<div class="txn-row">
    <div class="txn-row__icon txn-row__icon--${pts >= 0 ? "in" : "out"}">${pts >= 0 ? "+" : "–"}</div>
    <div class="txn-row__body">
      <p class="txn-row__title">${TYPE_LABEL[t.type] || escapeHtml(t.type)}</p>
      <p class="txn-row__note">${escapeHtml(t.note || "")}</p>
      <span class="txn-row__date">${formatDateTime(t.created_at)}</span>
    </div>
    <div class="txn-row__amount ${pts >= 0 ? "txn-row__amount--in" : "txn-row__amount--out"}">${pts >= 0 ? "+" : ""}${formatNumber(pts)} pts</div>
  </div>`;
}

function initHistory(root) {
  const list = root.querySelector("[data-loyalty-history]");
  const empty = root.querySelector("[data-loyalty-history-empty]");
  const more = root.querySelector("[data-loyalty-history-more]");
  let offset = 0;

  async function loadPage() {
    more.disabled = true;
    const { data, error } = await supabase
      .from("loyalty_transactions")
      .select("id,type,points,note,created_at")
      .order("created_at", { ascending: false })
      .range(offset, offset + HISTORY_PAGE - 1);
    more.disabled = false;
    if (error) {
      if (offset === 0) empty.hidden = false;
      return;
    }
    if (offset === 0 && data.length === 0) {
      list.hidden = true;
      empty.hidden = false;
      more.hidden = true;
      return;
    }
    list.hidden = false;
    empty.hidden = true;
    list.insertAdjacentHTML("beforeend", data.map(historyRowHtml).join(""));
    offset += data.length;
    more.hidden = data.length < HISTORY_PAGE;
  }

  more.addEventListener("click", loadPage);
  return loadPage();
}

export async function initLoyaltyPage() {
  const root = document.querySelector("[data-loyalty-root]");
  if (!root) return;

  const d = await fetchMyLoyalty();
  if (!d) {
    root.innerHTML = `<div class="empty-state"><h3>Unable to load loyalty details</h3><p>Please try again shortly.</p><a href="wallet.html" class="btn btn--primary">View Wallet</a></div>`;
    return;
  }
  if (d.enabled === false) {
    root.innerHTML = `<div class="empty-state"><h3>Loyalty &amp; Rewards is coming soon</h3><p>The rewards programme isn't active yet. Check back shortly.</p><a href="services.html" class="btn btn--primary">Browse services</a></div>`;
    return;
  }

  root.innerHTML = `
    <div class="loyalty-hero">
      <div>
        <p class="loyalty-hero__label">Current level</p>
        <p class="loyalty-hero__level">${escapeHtml(levelName(d))} Member</p>
        <p class="loyalty-hero__discount">${escapeHtml(discountLabel(d))}</p>
      </div>
      <div class="loyalty-hero__points">
        <p class="loyalty-hero__label">Loyalty points</p>
        <p class="loyalty-hero__value"><span class="loyalty-star" aria-hidden="true">${STAR}</span>${formatNumber(d.points)}</p>
      </div>
    </div>

    <div class="stat-grid" style="margin-bottom:var(--sp-6)">
      <div class="stat-card"><p class="stat-card__label">Qualifying spend</p><p class="stat-card__value">${formatCurrency(d.qualifying_spend)}</p></div>
      <div class="stat-card"><p class="stat-card__label">Qualifying orders</p><p class="stat-card__value">${formatNumber(d.qualifying_orders)}</p></div>
      <div class="stat-card"><p class="stat-card__label">Current discount</p><p class="stat-card__value">${Number(d.level?.discount_percent || 0)}%</p></div>
    </div>

    <div class="panel" style="margin-bottom:var(--sp-6)">
      <div class="panel__head"><h3>Progress to next level</h3></div>
      ${progressHtml(d)}
    </div>

    <div class="panel" style="margin-bottom:var(--sp-6)">
      <div class="panel__head"><h3>Loyalty levels</h3></div>
      <div class="panel__body panel__body--padded">${levelsHtml(d)}</div>
    </div>

    <div class="panel" style="margin-bottom:var(--sp-6)">
      <div class="panel__head"><h3>Points history</h3></div>
      <div class="panel__body txn-scroll" data-loyalty-history hidden></div>
      <div class="empty-state empty-state--compact" data-loyalty-history-empty hidden><p>No points yet. Points appear here once your orders qualify.</p></div>
      <div class="panel__body panel__body--padded"><button type="button" class="btn btn--secondary btn--sm" data-loyalty-history-more hidden>Load more</button></div>
    </div>

    <div class="panel" style="margin-bottom:var(--sp-6)">
      <div class="panel__head"><h3>How it works</h3></div>
      <div class="panel__body panel__body--padded">${rulesHtml(d)}</div>
    </div>

    <div class="loyalty-actions">
      <a href="wallet.html" class="btn btn--secondary">View Wallet</a>
      <a href="services.html" class="btn btn--primary">Browse services</a>
    </div>`;

  await initHistory(root);
}
