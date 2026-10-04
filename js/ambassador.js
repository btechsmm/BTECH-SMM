/**
 * BTECH SMM — Ambassador Program (customer side + public verification)
 * ----------------------------------------------------------------
 * Display and requests only. Everything that matters is decided in the database:
 *  - get_my_ambassador()            profile, stats and balances (RPC)
 *  - get_my_referrals()             referrals with identities masked (RPC)
 *  - ambassador_commissions         the caller's own earnings ledger (RLS)
 *  - ambassador_withdrawals         the caller's own withdrawals (RLS)
 *  - apply_for_ambassador()         submit an application (RPC)
 *  - request_ambassador_withdrawal  validated against the real balance (RPC)
 *  - verify_ambassador()            public, limited details (RPC)
 * The browser can't set a rate, an ID, a code, an earning or a balance.
 */

import { supabase } from "./supabase.js";
import { AuthService } from "./auth.js";
import { BUSINESS } from "./config.js";
import { renderBadge, downloadPng, downloadPdf } from "./badge.js";
import { formatCurrency, formatNumber, formatDate, formatDateTime, escapeHtml, showToast, setButtonLoading } from "./utils.js";

const referralLink = (code) => `${BUSINESS.website}/?ref=${encodeURIComponent(code)}`;
const verifyLink = (id) => `${BUSINESS.website}/verify-ambassador.html?id=${encodeURIComponent(id)}`;

const STATUS_BADGE = { approved: "completed", applicant: "pending", suspended: "pending", rejected: "cancelled", deactivated: "cancelled" };
const STATUS_LABEL = { approved: "Active", applicant: "Pending review", suspended: "Suspended", rejected: "Not approved", deactivated: "Deactivated" };

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

function initials(name) {
  return (name || "A").split(/\s+/).map((p) => p[0]).filter(Boolean).slice(0, 2).join("").toUpperCase();
}

/* --------------------------------- states -------------------------------- */
function applyFormHtml(d, defaultName) {
  const resubmit = d?.status === "rejected";
  return `
    <div class="panel"><div class="panel__head"><h3>${resubmit ? "Apply again" : "Apply to become an ambassador"}</h3></div>
    <div class="panel__body panel__body--padded">
      <form data-amb-apply novalidate>
        <p class="form-error" data-form-error role="alert"></p>
        <div class="form-field"><label for="amb-name">Display name</label>
          <input id="amb-name" name="display_name" type="text" maxlength="40" required value="${escapeHtml(defaultName)}" />
          <span class="form-hint">Shown on your badge and verification page.</span></div>
        <div class="form-field"><label for="amb-why">How will you promote BTECH SMM?</label>
          <textarea id="amb-why" name="motivation" rows="4" maxlength="1000" placeholder="Tell us about your audience or community."></textarea></div>
        <button type="submit" class="btn btn--primary btn--block">Submit application</button>
      </form></div></div>`;
}

function pitchHtml() {
  return `
    <div class="panel" style="margin-bottom:var(--sp-6)"><div class="panel__head"><h3>How the Ambassador Program works</h3></div>
    <div class="panel__body panel__body--padded"><ol class="amb-steps">
      <li><strong>Apply.</strong> Tell us how you'll promote BTECH SMM. Applications are reviewed by our team.</li>
      <li><strong>Get your link.</strong> Approved ambassadors receive a permanent Ambassador ID, a referral code, a link and a digital badge.</li>
      <li><strong>Refer customers.</strong> Share your link. Customers who sign up through it are linked to you.</li>
      <li><strong>Earn commission.</strong> You earn on qualifying orders your customers complete, at your commission rate. Registrations alone do not earn commission.</li>
    </ol></div></div>`;
}

function noticeHtml(title, text, extra = "") {
  return `<div class="panel" style="margin-bottom:var(--sp-6)"><div class="panel__body panel__body--padded"><h3 style="margin-bottom:var(--sp-2)">${title}</h3><p>${text}</p>${extra}</div></div>`;
}

function contactLine() {
  return `Questions? Email <a href="mailto:${BUSINESS.email}" style="color:var(--color-primary)">${BUSINESS.email}</a> or WhatsApp ${BUSINESS.phone}.`;
}

/* ------------------------------- dashboard ------------------------------- */
function kpi(label, value, sub = "") {
  return `<div class="stat-card"><p class="stat-card__label">${label}</p><p class="stat-card__value">${value}</p>${sub ? `<p class="adash-kpi__sub">${sub}</p>` : ""}</div>`;
}

function dashboardHtml(d) {
  const b = d.balances;
  const link = referralLink(d.referral_code);
  return `
    <div class="amb-hero">
      <div class="amb-hero__id">
        <span class="amb-avatar" aria-hidden="true">${escapeHtml(initials(d.display_name))}</span>
        <div>
          <h2 class="amb-hero__name">${escapeHtml(d.display_name)}</h2>
          <span class="badge badge--status badge--${STATUS_BADGE[d.status]}">${STATUS_LABEL[d.status]}</span>
        </div>
      </div>
      <dl class="amb-hero__meta">
        <div><dt>Ambassador ID</dt><dd>${escapeHtml(d.ambassador_code)}</dd></div>
        <div><dt>Referral code</dt><dd>${escapeHtml(d.referral_code)}</dd></div>
        <div><dt>Commission rate</dt><dd>${Number(d.commission_rate)}%</dd></div>
      </dl>
    </div>

    <div class="panel" style="margin-bottom:var(--sp-6)"><div class="panel__body panel__body--padded">
      <label class="stat-card__label" for="amb-link">Your referral link</label>
      <div class="amb-link">
        <input id="amb-link" type="text" readonly value="${escapeHtml(link)}" />
        <div class="amb-link__btns">
          <button type="button" class="btn btn--primary" data-amb-copy>Copy Link</button>
          <button type="button" class="btn btn--secondary" data-amb-share>Share</button>
          <a class="btn btn--secondary" href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer">Open Link</a>
        </div>
      </div>
      <p class="form-hint" style="margin:var(--sp-3) 0 0">Share it, customers sign up, and you earn on their qualifying orders.</p>
    </div></div>

    <div class="stat-grid" style="margin-bottom:var(--sp-6)">
      ${kpi("Total referrals", formatNumber(d.referrals))}
      ${kpi("Active referred customers", formatNumber(d.active_referrals), "Placed a qualifying order")}
      ${kpi("Qualifying orders", formatNumber(d.qualifying_orders))}
      ${kpi("Referred sales", formatCurrency(d.referred_sales))}
      ${kpi("Conversion rate", `${Number(d.conversion_rate)}%`, "Referrals who ordered")}
    </div>
    <div class="stat-grid" style="margin-bottom:var(--sp-6)">
      ${kpi("Commission generated", formatCurrency(b.generated), b.reversed > 0 ? `${formatCurrency(b.reversed)} reversed` : "")}
      ${kpi("Pending", formatCurrency(b.pending), `Released ${d.hold_days} days after an order qualifies`)}
      ${kpi("Available", formatCurrency(b.available), b.in_review > 0 ? `${formatCurrency(b.in_review)} in review` : "Ready to withdraw")}
      ${kpi("Withdrawn", formatCurrency(b.withdrawn))}
    </div>
    <p class="loyalty-note" style="margin-bottom:var(--sp-6)">Ambassador earnings are separate from your wallet balance and loyalty points.</p>

    <div class="amb-tabs" role="tablist" aria-label="Ambassador sections">
      <button type="button" role="tab" aria-selected="true" data-amb-tab="referrals">Referrals</button>
      <button type="button" role="tab" aria-selected="false" data-amb-tab="earnings">Earnings</button>
      <button type="button" role="tab" aria-selected="false" data-amb-tab="withdrawals">Withdrawals</button>
      <button type="button" role="tab" aria-selected="false" data-amb-tab="badge">Badge</button>
    </div>
    <div class="panel"><div class="panel__body panel__body--padded" data-amb-pane></div></div>`;
}

const table = (heads, rows, empty) =>
  rows.length
    ? `<div class="table-card"><table class="data-table"><thead><tr>${heads.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`
    : `<div class="empty-state empty-state--compact"><p>${empty}</p></div>`;

async function paneReferrals(el) {
  const { data, error } = await supabase.rpc("get_my_referrals", { p_limit: 50, p_offset: 0 });
  if (error) return void (el.innerHTML = `<p class="form-error">Couldn't load referrals. Please try again.</p>`);
  el.innerHTML = table(
    ["Customer", "Joined", "Qualifying orders", "Order value"],
    (data || []).map((r) => `<tr><td data-label="Customer">${escapeHtml(r.first_name)}</td><td data-label="Joined">${formatDate(r.joined_at)}</td><td data-label="Qualifying orders">${formatNumber(r.qualifying_orders)}</td><td data-label="Order value">${formatCurrency(r.order_value)}</td></tr>`),
    "No referral activity yet. Referral performance will appear after customers sign up with your link."
  );
}

function ledgerStatus(c) {
  if (c.type === "reversal") return "Reversal";
  if (c.type === "adjustment") return "Adjustment";
  if (c.status === "reversed") return "Reversed";
  return new Date(c.available_at) > new Date() ? `Pending until ${formatDate(c.available_at)}` : "Available";
}

async function paneEarnings(el) {
  const { data, error } = await supabase.from("ambassador_commissions").select("*").order("created_at", { ascending: false }).limit(50);
  if (error) return void (el.innerHTML = `<p class="form-error">Couldn't load earnings. Please try again.</p>`);
  el.innerHTML = table(
    ["Date", "Type", "Order", "Order value", "Rate", "Amount", "Status"],
    data.map((c) => `<tr>
      <td data-label="Date">${formatDateTime(c.created_at)}</td>
      <td data-label="Type">${{ earn: "Commission", reversal: "Reversal", adjustment: "Adjustment" }[c.type]}</td>
      <td data-label="Order">${c.order_id ? escapeHtml(c.order_id) : "—"}</td>
      <td data-label="Order value">${c.commissionable_amount > 0 ? formatCurrency(c.commissionable_amount) : "—"}</td>
      <td data-label="Rate">${c.type === "adjustment" ? "—" : `${Number(c.rate_percent)}%`}</td>
      <td data-label="Amount" class="${c.amount < 0 ? "txn-row__amount--out" : "txn-row__amount--in"}">${c.amount > 0 ? "+" : ""}${formatCurrency(c.amount)}</td>
      <td data-label="Status">${ledgerStatus(c)}</td></tr>`),
    "No earnings yet. Commission appears when a customer you referred completes a qualifying order."
  );
}

async function paneWithdrawals(el, d, reload) {
  const { data } = await supabase.from("ambassador_withdrawals").select("*").order("requested_at", { ascending: false }).limit(20);
  const open = (data || []).some((w) => w.status === "pending" || w.status === "approved");
  const avail = Number(d.balances.available);
  el.innerHTML = `
    <p class="loyalty-note" style="margin-bottom:var(--sp-4)">Available to withdraw: <strong>${formatCurrency(Math.max(avail, 0))}</strong>. Minimum withdrawal ${formatCurrency(d.min_withdrawal)}. Payouts are sent to your M-Pesa number after review.</p>
    ${open ? `<p class="form-hint" style="margin-bottom:var(--sp-4)">You have a withdrawal in progress. You can request another once it is completed or rejected.</p>` : `
    <form data-amb-withdraw novalidate style="margin-bottom:var(--sp-6)">
      <p class="form-error" data-form-error role="alert"></p>
      <div class="loyalty-admin-grid">
        <div class="form-field"><label for="wd-amount">Amount (KES)</label><input id="wd-amount" name="amount" type="number" min="${d.min_withdrawal}" step="1" required /></div>
        <div class="form-field"><label for="wd-phone">M-Pesa number</label><input id="wd-phone" name="phone" type="tel" placeholder="07XX XXX XXX" value="${escapeHtml(AuthService.getCurrentUser()?.phone || "")}" required /></div>
      </div>
      <button type="submit" class="btn btn--primary">Request withdrawal</button>
    </form>`}
    ${table(["Requested", "Amount", "Status", "Reference / note"],
      (data || []).map((w) => `<tr><td data-label="Requested">${formatDateTime(w.requested_at)}</td><td data-label="Amount">${formatCurrency(w.amount)}</td><td data-label="Status"><span class="badge badge--status badge--${{ pending: "pending", approved: "processing", paid: "completed", rejected: "cancelled" }[w.status]}">${w.status[0].toUpperCase() + w.status.slice(1)}</span></td><td data-label="Reference / note">${escapeHtml(w.payout_reference || w.admin_note || "—")}</td></tr>`),
      "No withdrawals yet.")}`;

  const form = el.querySelector("[data-amb-withdraw]");
  form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = form.querySelector("[data-form-error]");
    err.textContent = "";
    const btn = form.querySelector("[type=submit]");
    setButtonLoading(btn, true, "Submitting…");
    const { error } = await supabase.rpc("request_ambassador_withdrawal", { p_amount: Number(form.amount.value), p_phone: form.phone.value });
    setButtonLoading(btn, false);
    if (error) {
      err.textContent = error.message || "Couldn't submit your request. Please try again.";
      return;
    }
    showToast("Withdrawal request submitted.", "success");
    reload();
  });
}

async function paneBadge(el, d) {
  el.innerHTML = `
    <div class="amb-badge"><canvas data-amb-canvas aria-label="Your BTECH SMM Ambassador badge"></canvas></div>
    <div class="loyalty-actions" style="margin-top:var(--sp-4)">
      <button type="button" class="btn btn--primary" data-amb-png>Download Badge (PNG)</button>
      <button type="button" class="btn btn--secondary" data-amb-pdf>Download as PDF</button>
    </div>
    <p class="form-hint" style="margin-top:var(--sp-3)">The QR code opens your public verification page, which shows only your name, Ambassador ID, referral code and status.</p>`;
  const canvas = el.querySelector("[data-amb-canvas]");
  await renderBadge(canvas, {
    displayName: d.display_name, ambassadorCode: d.ambassador_code, referralCode: d.referral_code,
    status: d.status, issuedAt: d.approved_at, verifyUrl: verifyLink(d.ambassador_code), business: BUSINESS,
  });
  const file = `BTECH-SMM-Ambassador-${d.ambassador_code}`;
  el.querySelector("[data-amb-png]").addEventListener("click", () => downloadPng(canvas, `${file}.png`).then(() => showToast("Badge downloaded.", "success")).catch(() => showToast("Couldn't export the badge.", "error")));
  el.querySelector("[data-amb-pdf]").addEventListener("click", () => downloadPdf(canvas, `${file}.pdf`).then(() => showToast("Badge downloaded.", "success")).catch(() => showToast("Couldn't export the badge.", "error")));
}

/* --------------------------------- init ---------------------------------- */
export async function initAmbassadorPage() {
  const root = document.querySelector("[data-ambassador-root]");
  if (!root) return;

  const { data: d, error } = await supabase.rpc("get_my_ambassador");
  if (error || !d) {
    root.innerHTML = `<div class="empty-state"><h3>Unable to load the Ambassador Program</h3><p>Please try again shortly.</p></div>`;
    return;
  }

  const defaultName = (AuthService.getCurrentUser()?.name || "").trim();
  const wireApply = () =>
    root.querySelector("[data-amb-apply]")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = e.target;
      const err = f.querySelector("[data-form-error]");
      err.textContent = "";
      const btn = f.querySelector("[type=submit]");
      setButtonLoading(btn, true, "Submitting…");
      const { error: apErr } = await supabase.rpc("apply_for_ambassador", { p_display_name: f.display_name.value, p_motivation: f.motivation.value });
      setButtonLoading(btn, false);
      if (apErr) {
        err.textContent = apErr.message || "Couldn't submit your application.";
        return;
      }
      showToast("Application submitted.", "success");
      initAmbassadorPage();
    });

  if (!d.exists) {
    root.innerHTML = d.program_enabled
      ? pitchHtml() + applyFormHtml(null, defaultName)
      : noticeHtml("Applications are closed", `The Ambassador Program isn't accepting applications right now. ${contactLine()}`);
    return void wireApply();
  }
  if (d.status === "applicant") {
    root.innerHTML = noticeHtml("Application under review", `Thanks, ${escapeHtml(d.display_name)}. We received your application on ${formatDate(d.applied_at)} and will notify you once it has been reviewed.`);
    return;
  }
  if (d.status === "rejected") {
    root.innerHTML = noticeHtml("Application not approved", `Your application wasn't approved this time. You're welcome to apply again. ${contactLine()}`) + (d.program_enabled ? applyFormHtml(d, d.display_name) : "");
    return void wireApply();
  }
  if (d.status !== "approved") {
    root.innerHTML = noticeHtml(
      `Ambassador account ${d.status}`,
      `Your Ambassador ID is <strong>${escapeHtml(d.ambassador_code)}</strong>. Referral links and withdrawals are unavailable while your account is ${d.status}. ${contactLine()}`
    );
    return;
  }

  root.innerHTML = dashboardHtml(d);
  const link = referralLink(d.referral_code);

  root.querySelector("[data-amb-copy]").addEventListener("click", async () => {
    showToast((await copyText(link)) ? "Referral link copied!" : "Couldn't copy. Select the link and copy it manually.", "success");
  });
  root.querySelector("[data-amb-share]").addEventListener("click", async () => {
    const text = `Join BTECH SMM with my referral link: ${link}`;
    if (navigator.share) {
      try {
        await navigator.share({ title: "BTECH SMM", text: "Grow your social presence with BTECH SMM.", url: link });
        return;
      } catch (e) {
        if (e?.name === "AbortError") return;
      }
    }
    showToast((await copyText(text)) ? "Referral link copied!" : "Couldn't share. Copy the link instead.", "success");
  });

  const pane = root.querySelector("[data-amb-pane]");
  const panes = {
    referrals: () => paneReferrals(pane),
    earnings: () => paneEarnings(pane),
    withdrawals: () => paneWithdrawals(pane, d, () => initAmbassadorPage()),
    badge: () => paneBadge(pane, d),
  };
  const show = async (key) => {
    root.querySelectorAll("[data-amb-tab]").forEach((t) => t.setAttribute("aria-selected", String(t.dataset.ambTab === key)));
    pane.innerHTML = `<div class="skeleton" style="height:120px"></div>`;
    try {
      await panes[key]();
    } catch (err) {
      console.error(err);
      pane.innerHTML = `<p class="form-error">Something went wrong. Please try again.</p>`;
    }
  };
  root.querySelectorAll("[data-amb-tab]").forEach((t) => t.addEventListener("click", () => show(t.dataset.ambTab)));
  show("referrals");
}

/* ------------------------- public verification page ---------------------- */
export async function initVerifyPage() {
  const root = document.querySelector("[data-verify-root]");
  if (!root) return;
  const id = new URLSearchParams(window.location.search).get("id") || "";
  const { data, error } = id ? await supabase.rpc("verify_ambassador", { p_code: id }) : { data: null, error: null };

  if (error) {
    root.innerHTML = `<div class="verify-card"><h2>Verification unavailable</h2><p>We couldn't check this ambassador right now. Please try again shortly.</p></div>`;
    return;
  }
  if (!data?.found) {
    root.innerHTML = `<div class="verify-card verify-card--bad"><span class="verify-seal" aria-hidden="true">?</span><h2>Ambassador not found</h2><p>We couldn't find an ambassador with that ID. If you were given this badge, please contact ${escapeHtml(BUSINESS.name)} to confirm.</p><p><a href="mailto:${BUSINESS.email}" style="color:var(--color-primary)">${BUSINESS.email}</a> · ${BUSINESS.phone}</p></div>`;
    return;
  }
  const ok = data.status === "approved";
  root.innerHTML = `
    <div class="verify-card ${ok ? "verify-card--ok" : "verify-card--bad"}">
      <span class="verify-seal" aria-hidden="true">${ok ? "✓" : "!"}</span>
      <p class="eyebrow">${escapeHtml(BUSINESS.name)}</p>
      <h2>${ok ? "Verified Ambassador" : `Ambassador ${escapeHtml(data.status)}`}</h2>
      ${ok ? "" : `<p>This ambassador is not currently active. They are not authorised to represent ${escapeHtml(BUSINESS.name)} right now.</p>`}
      <dl class="verify-meta">
        <div><dt>Ambassador ID</dt><dd>${escapeHtml(data.ambassador_code)}</dd></div>
        <div><dt>Name</dt><dd>${escapeHtml(data.display_name)}</dd></div>
        ${ok && data.referral_code ? `<div><dt>Referral code</dt><dd>${escapeHtml(data.referral_code)}</dd></div>` : ""}
        <div><dt>Status</dt><dd>${escapeHtml(STATUS_LABEL[data.status] || data.status)}</dd></div>
        <div><dt>Date issued</dt><dd>${data.issued_at ? formatDate(data.issued_at) : "—"}</dd></div>
      </dl>
      <div class="loyalty-actions" style="justify-content:center">
        ${ok && data.referral_code ? `<a class="btn btn--primary" href="register.html?ref=${encodeURIComponent(data.referral_code)}">Join BTECH SMM</a>` : ""}
        <a class="btn btn--secondary" href="${BUSINESS.website}">Visit ${escapeHtml(BUSINESS.name)}</a>
      </div>
      <p class="form-hint" style="margin-top:var(--sp-4)">${escapeHtml(BUSINESS.email)} · ${escapeHtml(BUSINESS.phone)}</p>
    </div>`;
}
