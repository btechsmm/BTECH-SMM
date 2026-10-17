/**
 * BTECH SMM — Ambassador Program (customer side + public verification)
 * ----------------------------------------------------------------
 * Display and requests only. Everything that matters is decided in the database:
 *  - get_my_ambassador()            profile, stats and balances (RPC)
 *  - get_my_referrals()             referrals with identities masked (RPC)
 *  - ambassador_commissions         the caller's own earnings ledger (RLS)
 *  - ambassador_withdrawals         the caller's own withdrawals (RLS)
 *  - get_my_ambassador_application() / submit_ambassador_application()  the formal application (ambassador-apply.js)
 *  - request_ambassador_withdrawal  validated against the real balance (RPC)
 *  - verify_ambassador()            public, limited details (RPC)
 * The browser can't set a rate, an ID, a code, an earning or a balance.
 */

import { supabase } from "./supabase.js";
import { AuthService } from "./auth.js";
import { BUSINESS } from "./config.js";
import { renderBadge, downloadPng, downloadPdf } from "./badge.js";
import { createCropper, photoUrl, uploadPhoto, removePhoto } from "./photo.js";
import { formatNumber, formatDate, formatDateTime, escapeHtml, showToast, setButtonLoading } from "./utils.js";
import { applyEntryHtml, mountApplicationForm, applicationStatusHtml, wireReplyForm } from "./ambassador-apply.js";

/** Money on this page is always shown in KES, e.g. "KES 1,250.00" (the shared helper prints "Ksh"). Display only. */
const formatCurrency = (amount) =>
  new Intl.NumberFormat("en-KE", { style: "currency", currency: "KES", currencyDisplay: "code", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(amount) || 0);

const referralLink = (code) => `${BUSINESS.website}/?ref=${encodeURIComponent(code)}`;
const verifyLink = (id) => `${BUSINESS.website}/verify-ambassador?id=${encodeURIComponent(id)}`;

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

/* ------------------------- rewards card + balances ------------------------ */
const TXN_BADGE = { Pending: "pending", Released: "completed", Reversed: "cancelled", Reversal: "cancelled", Adjustment: "processing", "Pending review": "pending", "Approved, awaiting payout": "processing", Paid: "completed", Rejected: "cancelled" };

/** BTECH SMM Ambassador Rewards Card. Identity only: every figure below the card comes from the database. */
function rewardsCardHtml(d) {
  const url = d.photo_path ? photoUrl(d.photo_path) : null;
  return `
    <article class="rw-card" aria-label="BTECH SMM Ambassador Rewards Card">
      <svg class="rw-card__arcs" viewBox="0 0 400 250" aria-hidden="true" focusable="false"><g fill="none" stroke="#fff" stroke-opacity=".07"><circle cx="360" cy="-10" r="120"/><circle cx="360" cy="-10" r="170"/><circle cx="360" cy="-10" r="220"/></g></svg>
      <div class="rw-card__row">
        <img class="rw-card__logo" src="assets/brand/btech-smm-logo.png" alt="BTECH SMM" width="140" height="29" />
        <span class="rw-card__tag">Ambassador Rewards Card</span>
      </div>
      <div class="rw-card__person">
        ${url ? `<img class="rw-card__photo" src="${escapeHtml(url)}" alt="" data-rw-photo data-initials="${escapeHtml(initials(d.display_name))}" />` : `<span class="rw-card__photo rw-card__photo--initials" aria-hidden="true">${escapeHtml(initials(d.display_name))}</span>`}
        <div class="rw-card__who">
          <p class="rw-card__name">${escapeHtml(d.display_name)}</p>
          <span class="rw-card__status rw-card__status--${escapeHtml(d.status)}">${escapeHtml(STATUS_LABEL[d.status] || d.status)}</span>
        </div>
      </div>
      <dl class="rw-card__meta">
        <div><dt>Ambassador ID</dt><dd>${escapeHtml(d.ambassador_code || "—")}</dd></div>
        <div><dt>Referral code</dt><dd>${escapeHtml(d.referral_code || "—")}</dd></div>
      </dl>
      <p class="rw-card__fine">BTECH SMM rewards card. Not a bank or payment card.</p>
    </article>`;
}

/**
 * The four figures, exactly as get_my_ambassador() / ambassador_balances() compute them:
 *   Total Commission Earned = generated   Pending = earns still inside the hold period
 *   Available to Withdraw   = available   Total Withdrawn = withdrawals actually marked paid
 * "Available" already excludes anything in a pending/approved withdrawal.
 */
function balancesHtml(d) {
  const b = d.balances;
  const avail = Math.max(Number(b.available) || 0, 0);
  const min = Number(d.min_withdrawal) || 0;
  const inReview = Number(b.in_review) || 0;
  let reason = "";
  if (inReview > 0) reason = `You have a withdrawal in progress (${formatCurrency(inReview)}). You can request another once it is paid or rejected.`;
  else if (avail < min) reason = `The minimum withdrawal is ${formatCurrency(min)}.`;
  const adj = Number(b.adjustments) || 0;
  const earnedNotes = [Number(b.reversed) > 0 ? `${formatCurrency(b.reversed)} reversed` : "", adj !== 0 ? `${adj > 0 ? "+" : ""}${formatCurrency(adj)} adjustments` : ""].filter(Boolean).join(" · ");
  return `
    <div class="rw-balances">
      <section class="rw-primary" aria-labelledby="rw-avail-label">
        <div>
          <p class="rw-primary__label" id="rw-avail-label">Available to Withdraw</p>
          <p class="rw-primary__value" aria-live="polite">${formatCurrency(avail)}</p>
          <p class="rw-primary__sub" id="rw-avail-note">${reason ? escapeHtml(reason) : "Ready to withdraw to M-Pesa after review."}</p>
        </div>
        <button type="button" class="btn btn--primary rw-primary__cta" data-rw-withdraw ${reason ? "disabled" : ""} aria-describedby="rw-avail-note">Request Withdrawal</button>
      </section>
      <div class="rw-secondary">
        <div class="rw-stat"><p class="rw-stat__label">Total Commission Earned</p><p class="rw-stat__value">${formatCurrency(b.generated)}</p>${earnedNotes ? `<p class="rw-stat__sub">${escapeHtml(earnedNotes)}</p>` : ""}</div>
        <div class="rw-stat"><p class="rw-stat__label">Pending Commission</p><p class="rw-stat__value">${formatCurrency(b.pending)}</p><p class="rw-stat__sub">Released ${formatNumber(d.hold_days)} days after an order qualifies</p></div>
        <div class="rw-stat"><p class="rw-stat__label">Total Withdrawn</p><p class="rw-stat__value">${formatCurrency(b.withdrawn)}</p><p class="rw-stat__sub">Paid out to your M-Pesa</p></div>
      </div>
    </div>`;
}

function dashboardHtml(d) {
  const link = referralLink(d.referral_code);
  return `
    <section class="rw" aria-label="Rewards">
      ${rewardsCardHtml(d)}
      ${balancesHtml(d)}
    </section>

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
      <p class="form-hint" style="margin:var(--sp-3) 0 0">Share it, customers sign up, and you earn on their qualifying orders. Your commission rate is ${Number(d.commission_rate)}%.</p>
    </div></div>

    <div class="stat-grid" style="margin-bottom:var(--sp-6)">
      ${kpi("Total referrals", formatNumber(d.referrals))}
      ${kpi("Active referred customers", formatNumber(d.active_referrals), "Placed a qualifying order")}
      ${kpi("Qualifying orders", formatNumber(d.qualifying_orders))}
      ${kpi("Referred sales", formatCurrency(d.referred_sales))}
      ${kpi("Conversion rate", `${Number(d.conversion_rate)}%`, "Referrals who ordered")}
    </div>

    <div class="panel" style="margin-bottom:var(--sp-6)">
      <div class="panel__head"><h3>Transaction history</h3></div>
      <div class="panel__body panel__body--padded" data-rw-txns><div class="skeleton" style="height:120px"></div></div>
    </div>
    <p class="loyalty-note" style="margin-bottom:var(--sp-6)">Ambassador earnings are separate from your wallet balance and loyalty points.</p>

    <div class="amb-tabs" role="tablist" aria-label="Ambassador sections">
      <button type="button" role="tab" aria-selected="true" data-amb-tab="referrals">Referrals</button>
      <button type="button" role="tab" aria-selected="false" data-amb-tab="earnings">Earnings</button>
      <button type="button" role="tab" aria-selected="false" data-amb-tab="withdrawals">Withdrawals</button>
      <button type="button" role="tab" aria-selected="false" data-amb-tab="badge">Badge</button>
    </div>
    <div class="panel" data-amb-pane-panel><div class="panel__body panel__body--padded" data-amb-pane></div></div>`;
}

/** One merged list of the caller's own ledger rows and withdrawals. Statuses are the stored ones, never inferred. */
async function loadTransactions(el) {
  const [c, w] = await Promise.all([
    supabase.from("ambassador_commissions").select("id,type,amount,status,order_id,rate_percent,note,created_at,available_at").order("created_at", { ascending: false }).limit(30),
    supabase.from("ambassador_withdrawals").select("id,amount,phone,status,admin_note,payout_reference,requested_at,paid_at").order("requested_at", { ascending: false }).limit(30),
  ]);
  if (c.error || w.error) return void (el.innerHTML = `<p class="form-error">Couldn't load your transactions. Please try again.</p>`);

  const short = (id, prefix) => `${prefix}-${String(id).slice(0, 8).toUpperCase()}`;
  const comm = c.data.map((x) => {
    const released = x.type === "earn" && x.status === "pending" && new Date(x.available_at) <= new Date();
    const status = x.type === "reversal" ? "Reversal" : x.type === "adjustment" ? "Adjustment" : x.status === "reversed" ? "Reversed" : released ? "Released" : "Pending";
    return {
      at: x.created_at,
      ref: x.order_id || short(x.id, "CM"),
      desc: x.type === "earn" ? `Commission on order ${x.order_id} (${Number(x.rate_percent)}%)` : x.type === "reversal" ? "Commission reversed (order refunded or cancelled)" : x.note || "Adjustment",
      amount: Number(x.amount),
      status,
      note: status === "Pending" ? `Until ${formatDate(x.available_at)}` : "",
    };
  });
  const wd = w.data.map((x) => ({
    at: x.requested_at,
    ref: x.payout_reference || short(x.id, "WD"),
    desc: `Withdrawal to M-Pesa ending ${String(x.phone).slice(-3)}`,
    amount: -Number(x.amount),
    status: { pending: "Pending review", approved: "Approved, awaiting payout", paid: "Paid", rejected: "Rejected" }[x.status] || x.status,
    note: x.status === "rejected" && x.admin_note ? x.admin_note : x.status === "paid" && x.paid_at ? `Paid ${formatDate(x.paid_at)}` : "",
  }));
  const rows = [...comm, ...wd].sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 30);
  el.innerHTML = table(
    ["Date", "Reference", "Description", "Amount", "Status"],
    rows.map((r) => `<tr>
      <td data-label="Date">${formatDateTime(r.at)}</td>
      <td data-label="Reference">${escapeHtml(r.ref)}</td>
      <td data-label="Description">${escapeHtml(r.desc)}</td>
      <td data-label="Amount" class="${r.amount < 0 ? "txn-row__amount--out" : "txn-row__amount--in"}">${r.amount > 0 ? "+" : "−"}${formatCurrency(Math.abs(r.amount))}</td>
      <td data-label="Status"><span class="badge badge--status badge--${TXN_BADGE[r.status] || "pending"}">${escapeHtml(r.status)}</span>${r.note ? `<br /><span class="muted">${escapeHtml(r.note)}</span>` : ""}</td></tr>`),
    "No transactions yet. Commission appears here when a customer you referred completes a qualifying order."
  );
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
    <p class="form-hint" style="margin-top:var(--sp-3)">The QR code opens your public verification page, which shows only your photo, name, Ambassador ID, referral code and status.</p>
    <details class="amb-photo-change" ${d.photo_path ? "" : "open"} style="margin-top:var(--sp-4)">
      <summary>${d.photo_path ? "Change my photo" : "Add my photo"}</summary>
      ${photoChangeHtml()}
    </details>`;
  wirePhotoChange(el, () => initAmbassadorPage());
  const canvas = el.querySelector("[data-amb-canvas]");
  await renderBadge(canvas, {
    displayName: d.display_name, ambassadorCode: d.ambassador_code, referralCode: d.referral_code,
    status: d.status, issuedAt: d.approved_at, verifyUrl: verifyLink(d.ambassador_code), business: BUSINESS,
    photoUrl: photoUrl(d.photo_path),
  });
  const file = `BTECH-SMM-Ambassador-${d.ambassador_code}`;
  el.querySelector("[data-amb-png]").addEventListener("click", () => downloadPng(canvas, `${file}.png`).then(() => showToast("Badge downloaded.", "success")).catch(() => showToast("Couldn't export the badge.", "error")));
  el.querySelector("[data-amb-pdf]").addEventListener("click", () => downloadPdf(canvas, `${file}.pdf`).then(() => showToast("Badge downloaded.", "success")).catch(() => showToast("Couldn't export the badge.", "error")));
}

/** The photo doubles as the account avatar: reload the cached profile and repaint the header. */
async function refreshAvatar() {
  try {
    await AuthService.refreshProfile();
    window.dispatchEvent(new CustomEvent("btech:profile-updated"));
  } catch {
    /* the avatar will catch up on the next page load */
  }
}

/* ------------------------------ photo change ------------------------------ */
function photoChangeHtml() {
  return `<form data-amb-photo novalidate style="margin-top:var(--sp-3)">
    <div data-photo-cropper></div>
    <p class="form-error" data-form-error role="alert"></p>
    <button type="submit" class="btn btn--primary btn--sm">Save photo</button>
  </form>`;
}

function wirePhotoChange(scope, done) {
  const form = scope.querySelector("[data-amb-photo]");
  if (!form) return;
  const cropper = createCropper(form.querySelector("[data-photo-cropper]"));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = form.querySelector("[data-form-error]");
    err.textContent = "";
    if (!cropper.hasImage()) return void (err.textContent = "Choose a photo first.");
    const btn = form.querySelector("[type=submit]");
    setButtonLoading(btn, true, "Saving…");
    let path = null;
    try {
      path = await uploadPhoto(await cropper.getBlob());
      const { data, error } = await supabase.rpc("update_ambassador_photo", { p_photo_path: path });
      if (error) throw new Error(error.message || "Couldn't save your photo.");
      await removePhoto(data?.old_path); // the old file is no longer referenced
    } catch (ex) {
      await removePhoto(path);
      setButtonLoading(btn, false);
      err.textContent = ex.message;
      return;
    }
    setButtonLoading(btn, false);
    showToast("Photo updated.", "success");
    await refreshAvatar();
    done();
  });
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

  /**
   * No ambassador record yet (or a rejected one): the formal application lives in its own table
   * (see ambassador-apply.js). Applying creates NO ambassador record and grants nothing.
   */
  const renderApplyState = async (lead = "") => {
    const { data: app, error: appErr } = await supabase.rpc("get_my_ambassador_application");
    if (appErr) {
      root.innerHTML = lead + noticeHtml("Applications are temporarily unavailable", `We couldn't load the application form right now. Please try again shortly. ${contactLine()}`);
      return;
    }
    const open = app?.exists && (app.status === "submitted" || app.status === "clarification_requested");
    if (open) {
      root.innerHTML = lead + applicationStatusHtml(app);
      return void wireReplyForm(root, () => initAmbassadorPage());
    }
    const last = app?.exists && app.status === "declined" ? applicationStatusHtml(app) : "";
    if (!d.program_enabled) {
      root.innerHTML = lead + last + noticeHtml("Applications are closed", `The Ambassador Program isn't accepting applications right now. ${contactLine()}`);
      return;
    }
    root.innerHTML = lead + pitchHtml() + last + applyEntryHtml(last ? "Apply again" : "Apply to Become an Ambassador") + `<div data-apply-mount></div>`;
    const mount = root.querySelector("[data-apply-mount]");
    const cta = root.querySelector(".apply-cta");
    root.querySelector("[data-apply-open]").addEventListener("click", () => {
      cta.hidden = true;
      mountApplicationForm(mount, {
        existingPhotoPath: d.photo_path || null,
        onCancel: () => {
          mount.innerHTML = "";
          cta.hidden = false;
        },
      });
      mount.scrollIntoView({ behavior: "smooth", block: "start" });
      mount.querySelector("input,textarea")?.focus({ preventScroll: true });
    });
  };

  if (!d.exists) return void (await renderApplyState());

  if (d.status === "applicant") {
    root.innerHTML =
      noticeHtml("Application under review", `Thanks, ${escapeHtml(d.display_name)}. We received your application on ${formatDate(d.applied_at)} and will notify you once it has been reviewed.`,
        d.photo_path ? `<img class="amb-avatar amb-avatar--img amb-avatar--lg" src="${escapeHtml(photoUrl(d.photo_path))}" alt="Your submitted photo" />` : `<p class="form-error">A profile photo is required before approval. Please add one below.</p>`) +
      `<div class="panel"><div class="panel__body panel__body--padded"><details class="amb-photo-change" ${d.photo_path ? "" : "open"}><summary>${d.photo_path ? "Change my photo" : "Add my photo"}</summary>${photoChangeHtml()}</details></div></div>`;
    wirePhotoChange(root, () => initAmbassadorPage());
    return;
  }
  if (d.status === "rejected") {
    return void (await renderApplyState(noticeHtml("Application not approved", `Your earlier application wasn't approved. You're welcome to apply again. ${contactLine()}`)));
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

  // Card photo: if the image can't load, fall back to initials rather than a broken icon.
  root.querySelectorAll("[data-rw-photo]").forEach((img) =>
    img.addEventListener("error", () => {
      const span = document.createElement("span");
      span.className = "rw-card__photo rw-card__photo--initials";
      span.setAttribute("aria-hidden", "true");
      span.textContent = img.dataset.initials || "";
      img.replaceWith(span);
    })
  );

  // "Request Withdrawal" opens the existing withdrawal form (validated and enforced by
  // request_ambassador_withdrawal on the server). The button is disabled when the server-computed
  // balance is below the minimum or a request is already open.
  root.querySelector("[data-rw-withdraw]")?.addEventListener("click", async () => {
    await show("withdrawals");
    pane.closest("[data-amb-pane-panel]")?.scrollIntoView({ behavior: "smooth", block: "start" });
    pane.querySelector("input[name=amount]")?.focus({ preventScroll: true });
  });

  loadTransactions(root.querySelector("[data-rw-txns]")).catch((err) => {
    console.error(err);
    const el = root.querySelector("[data-rw-txns]");
    if (el) el.innerHTML = `<p class="form-error">Couldn't load your transactions. Please try again.</p>`;
  });
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
      ${ok && data.photo_path ? `<img class="verify-photo" src="${escapeHtml(photoUrl(data.photo_path))}" alt="Photo of ${escapeHtml(data.display_name)}" />` : ""}
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
        ${ok && data.referral_code ? `<a class="btn btn--primary" href="register?ref=${encodeURIComponent(data.referral_code)}">Join BTECH SMM</a>` : ""}
        <a class="btn btn--secondary" href="${BUSINESS.website}">Visit ${escapeHtml(BUSINESS.name)}</a>
      </div>
      <p class="form-hint" style="margin-top:var(--sp-4)">${escapeHtml(BUSINESS.email)} · ${escapeHtml(BUSINESS.phone)}</p>
    </div>`;
}