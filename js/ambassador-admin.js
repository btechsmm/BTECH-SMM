/**
 * BTECH SMM — Ambassador Management (admin section)
 * ----------------------------------------------------------------
 * Mounts into [data-ambassador-admin] on admin.html. Reads use the admin-only
 * RLS select policies or admin_* RPCs; EVERY write goes through an
 * admin_* RPC that re-checks is_admin() on the server and writes an audit_logs
 * row. Hiding this panel from non-admins is a courtesy, not the security
 * boundary. Money figures are shown exactly as the database computes them.
 */

import { supabase } from "./supabase.js";
import { BUSINESS } from "./config.js";
import { formatCurrency, formatNumber, formatDate, formatDateTime, escapeHtml, showToast, debounce } from "./utils.js";
import { openModal, rpc, field, numOrNull } from "./loyalty-admin.js";
import { photoUrl } from "./photo.js";

let root = null;
let settings = null;
let rows = [];
let currentId = null;
const filter = { status: "", q: "" };

const BADGE = { applicant: "pending", approved: "completed", suspended: "processing", rejected: "cancelled", deactivated: "cancelled" };
const LABEL = { applicant: "Pending", approved: "Active", suspended: "Suspended", rejected: "Rejected", deactivated: "Deactivated" };
const WD_BADGE = { pending: "pending", approved: "processing", paid: "completed", rejected: "cancelled" };

const avatar = (a, big = false) => (a.photo_path ? `<img class="amb-avatar amb-avatar--img${big ? " amb-avatar--lg" : ""}" src="${escapeHtml(photoUrl(a.photo_path))}" alt="" />` : `<span class="amb-avatar${big ? " amb-avatar--lg" : ""}" aria-hidden="true">${escapeHtml((a.display_name || "?")[0].toUpperCase())}</span>`);
const link = (code) => `${BUSINESS.website}/?ref=${encodeURIComponent(code)}`;
const badge = (map, label, status) => `<span class="badge badge--status badge--${map[status]}">${label[status] || status}</span>`;
const reasonField = (required = true) => field(required ? "Reason (required, recorded in the audit log)" : "Note (optional)", `<textarea name="reason" rows="2" ${required ? "required" : ""}></textarea>`);

const table = (heads, bodyAttr) =>
  `<div class="table-card"><table class="data-table"><thead><tr>${heads.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody ${bodyAttr}></tbody></table></div>`;

/* -------------------------------- settings ------------------------------- */
function settingsHtml() {
  const s = settings;
  return `<form data-amb-settings novalidate>
    <p class="form-error" data-amb-settings-error role="alert"></p>
    <div class="loyalty-admin-grid">
      <label class="checkbox-row"><input type="checkbox" name="program_enabled" ${s.program_enabled ? "checked" : ""} /> Program open (applications and new referrals)</label>
    </div>
    <div class="loyalty-admin-grid">
      ${field("Default commission rate (%)", `<input name="default_commission_rate" type="number" min="0" max="100" step="0.01" value="${s.default_commission_rate}" />`, "Given to new applicants. Per-ambassador rates are set below.")}
      ${field("Commission is earned when an order is", `<select name="qualify_on"><option value="completed" ${s.qualify_on === "completed" ? "selected" : ""}>Paid and completed</option><option value="paid" ${s.qualify_on === "paid" ? "selected" : ""}>Paid</option></select>`)}
      ${field("Hold period (days)", `<input name="hold_days" type="number" min="0" step="1" value="${s.hold_days}" />`, "Commission becomes withdrawable after this many days.")}
      ${field("Minimum withdrawal (KES)", `<input name="min_withdrawal" type="number" min="1" step="1" value="${s.min_withdrawal}" />`)}
      ${field("Attribution window (days)", `<input name="attribution_window_days" type="number" min="0" step="1" value="${s.attribution_window_days}" />`, "A new customer can be linked to an ambassador only within this time of signing up, and only before their first order.")}
    </div>
    <button type="submit" class="btn btn--primary">Save program settings</button>
  </form>`;
}

function wireSettings() {
  const form = root.querySelector("[data-amb-settings]");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = form.querySelector("[data-amb-settings-error]");
    err.textContent = "";
    const f = form.elements;
    try {
      settings = await rpc("admin_update_ambassador_settings", {
        p_patch: {
          program_enabled: f.program_enabled.checked,
          default_commission_rate: Number(f.default_commission_rate.value),
          qualify_on: f.qualify_on.value,
          hold_days: Number(f.hold_days.value),
          min_withdrawal: Number(f.min_withdrawal.value),
          attribution_window_days: Number(f.attribution_window_days.value),
        },
        p_reason: null,
      });
      showToast("Program settings saved.", "success");
      loadAudit();
    } catch (ex) {
      err.textContent = ex.message;
    }
  });
}

/* ------------------------------- directory ------------------------------- */
async function loadList() {
  const body = root.querySelector("[data-amb-body]");
  try {
    rows = await rpc("admin_list_ambassadors", { p_status: filter.status || null, p_search: filter.q || null, p_limit: 50, p_offset: 0 });
  } catch (ex) {
    body.innerHTML = `<tr><td colspan="9">${escapeHtml(ex.message)}</td></tr>`;
    return;
  }
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="9">${filter.status || filter.q ? "No ambassadors match this filter." : "No ambassadors yet. Approved ambassadors will appear here."}</td></tr>`;
    return;
  }
  body.innerHTML = rows
    .map(
      (a) => `<tr>
      <td data-label="Ambassador"><div class="amb-cell">${avatar(a)}<span><strong>${escapeHtml(a.display_name)}</strong><br /><span class="muted">${escapeHtml(a.email)}</span></span></div></td>
      <td data-label="ID / Code">${a.ambassador_code ? escapeHtml(a.ambassador_code) : "—"}<br /><span class="muted">${a.referral_code ? escapeHtml(a.referral_code) : ""}</span></td>
      <td data-label="Status">${badge(BADGE, LABEL, a.status)}</td>
      <td data-label="Rate">${Number(a.commission_rate)}%</td>
      <td data-label="Referrals">${formatNumber(a.referrals)} <span class="muted">(${formatNumber(a.active_referrals)} active)</span></td>
      <td data-label="Qualifying orders">${formatNumber(a.qualifying_orders)}</td>
      <td data-label="Generated">${formatCurrency(a.balances.generated)}</td>
      <td data-label="Available">${formatCurrency(a.balances.available)}<br /><span class="muted">${formatCurrency(a.balances.withdrawn)} withdrawn</span></td>
      <td data-label="Actions"><div class="loyalty-actions-cell">
        <button type="button" class="btn btn--secondary btn--sm" data-amb-manage="${a.id}">Manage</button>
        ${a.status === "applicant" && a.photo_path ? `<button type="button" class="btn btn--primary btn--sm" data-amb-act="approve" data-id="${a.id}">Approve</button>` : ""}
      </div></td></tr>`
    )
    .join("");
}

/* --------------------------------- detail -------------------------------- */
function statusModal(a, action) {
  const needsReason = ["reject", "suspend", "deactivate"].includes(action);
  const verb = { approve: "Approve", reject: "Reject", suspend: "Suspend", reactivate: "Reactivate", deactivate: "Deactivate" }[action];
  openModal({
    title: `${verb} — ${a.display_name}`,
    submitLabel: verb,
    fieldsHtml: reasonField(needsReason),
    onSubmit: async (v) => {
      if (needsReason && !v.reason?.trim()) return "A reason is required.";
      await rpc("admin_review_ambassador", { p_id: a.id, p_action: action, p_reason: v.reason || null });
      showToast(`Ambassador ${action === "approve" ? "approved" : action + "d"}.`, "success");
      await refreshAll();
    },
  });
}

function rateModal(a) {
  openModal({
    title: `Commission rate — ${a.display_name}`,
    fieldsHtml: `${field("New commission rate (%)", `<input name="rate" type="number" min="0" max="100" step="0.01" value="${a.commission_rate}" required />`, "Applies to FUTURE qualifying orders only. Existing commissions keep the rate they were created with.")}${reasonField()}`,
    onSubmit: async (v) => {
      if (!v.reason?.trim()) return "A reason is required.";
      await rpc("admin_set_commission_rate", { p_id: a.id, p_rate: numOrNull(v.rate), p_reason: v.reason.trim() });
      showToast("Commission updated.", "success");
      await refreshAll();
    },
  });
}

function adjustModal(a) {
  openModal({
    title: `Commission adjustment — ${a.display_name}`,
    submitLabel: "Apply adjustment",
    fieldsHtml: `${field("Amount (KES). Use a negative number to deduct.", `<input name="amount" type="number" step="0.01" required />`, "Recorded as a separate ledger entry; nothing is edited or deleted.")}${reasonField()}`,
    onSubmit: async (v) => {
      const amount = Number(v.amount);
      if (!Number.isFinite(amount) || amount === 0) return "Enter a non-zero amount.";
      if (!v.reason?.trim()) return "A reason is required.";
      await rpc("admin_commission_adjustment", { p_id: a.id, p_amount: amount, p_reason: v.reason.trim() });
      showToast("Adjustment recorded.", "success");
      await refreshAll();
    },
  });
}

function codeModal(a) {
  openModal({
    title: `Referral code — ${a.display_name}`,
    fieldsHtml: `${field("New referral code", `<input name="code" type="text" maxlength="16" required value="${escapeHtml(a.referral_code || "")}" />`, "4–16 letters or digits. Existing referrals and commissions are unaffected; the old link stops working.")}${reasonField()}`,
    onSubmit: async (v) => {
      if (!v.reason?.trim()) return "A reason is required.";
      await rpc("admin_set_referral_code", { p_id: a.id, p_code: v.code, p_reason: v.reason.trim() });
      showToast("Referral code updated.", "success");
      await refreshAll();
    },
  });
}

function notesModal(a) {
  openModal({
    title: `Internal notes — ${a.display_name}`,
    fieldsHtml: field("Notes (visible to admins only)", `<textarea name="notes" rows="5">${escapeHtml(a.admin_notes || "")}</textarea>`),
    onSubmit: async (v) => {
      await rpc("admin_save_ambassador_notes", { p_id: a.id, p_notes: v.notes || "" });
      showToast("Notes saved.", "success");
      await refreshAll();
    },
  });
}

async function renderDetail(id) {
  currentId = id;
  const box = root.querySelector("[data-amb-detail]");
  const a = rows.find((r) => r.id === id);
  if (!a) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const b = a.balances;
  const acts = [];
  if (a.status === "applicant") acts.push(...(a.photo_path ? [["approve", "Approve", "primary"]] : []), ["reject", "Reject", "secondary"]);
  if (a.status === "approved") acts.push(["suspend", "Suspend", "secondary"], ["deactivate", "Deactivate", "secondary"]);
  if (a.status === "suspended" || a.status === "deactivated") acts.push(["reactivate", "Reactivate", "primary"]);
  if (a.status === "suspended") acts.push(["deactivate", "Deactivate", "secondary"]);

  box.innerHTML = `
    <div class="panel__head"><h3 class="amb-cell">${avatar(a, true)}<span>${escapeHtml(a.display_name)} ${badge(BADGE, LABEL, a.status)}</span></h3>
      <button type="button" class="btn btn--secondary btn--sm" data-amb-close>Close</button></div>
    <div class="panel__body panel__body--padded">
      <dl class="amb-hero__meta amb-hero__meta--admin">
        <div><dt>Ambassador ID</dt><dd>${a.ambassador_code ? escapeHtml(a.ambassador_code) : "Assigned on approval"}</dd></div>
        <div><dt>Referral code</dt><dd>${a.referral_code ? escapeHtml(a.referral_code) : "—"}</dd></div>
        <div><dt>Commission rate</dt><dd>${Number(a.commission_rate)}%</dd></div>
        <div><dt>Account</dt><dd>${escapeHtml(a.account_name || "—")} · ${escapeHtml(a.email)}</dd></div>
        <div><dt>Applied</dt><dd>${formatDate(a.applied_at)}</dd></div>
        <div><dt>Approved</dt><dd>${a.approved_at ? formatDate(a.approved_at) : "—"}</dd></div>
        <div><dt>Last activity</dt><dd>${a.last_activity_at ? formatDateTime(a.last_activity_at) : "—"}</dd></div>
        ${a.referral_code ? `<div class="amb-hero__wide"><dt>Referral link</dt><dd>${escapeHtml(link(a.referral_code))} <button type="button" class="btn btn--secondary btn--sm" data-amb-copy="${escapeHtml(link(a.referral_code))}">Copy</button></dd></div>` : ""}
      </dl>
      <div class="stat-grid" style="margin:var(--sp-4) 0">
        <div class="stat-card"><p class="stat-card__label">Referrals</p><p class="stat-card__value">${formatNumber(a.referrals)}</p><p class="adash-kpi__sub">${formatNumber(a.active_referrals)} active</p></div>
        <div class="stat-card"><p class="stat-card__label">Generated</p><p class="stat-card__value">${formatCurrency(b.generated)}</p><p class="adash-kpi__sub">${formatCurrency(b.reversed)} reversed</p></div>
        <div class="stat-card"><p class="stat-card__label">Pending</p><p class="stat-card__value">${formatCurrency(b.pending)}</p></div>
        <div class="stat-card"><p class="stat-card__label">Available</p><p class="stat-card__value">${formatCurrency(b.available)}</p><p class="adash-kpi__sub">${formatCurrency(b.in_review)} in review</p></div>
        <div class="stat-card"><p class="stat-card__label">Withdrawn</p><p class="stat-card__value">${formatCurrency(b.withdrawn)}</p></div>
      </div>
      ${a.status === "applicant" && !a.photo_path ? `<p class="form-error">This applicant has no profile photo yet, so they can't be approved. Ask them to add one from their Ambassador page.</p>` : ""}
      ${a.motivation ? `<p class="loyalty-note"><strong>Application:</strong> ${escapeHtml(a.motivation)}</p>` : ""}
      ${a.admin_notes ? `<p class="loyalty-note"><strong>Internal notes:</strong> ${escapeHtml(a.admin_notes)}</p>` : ""}
      <div class="loyalty-actions" style="margin:var(--sp-4) 0">
        ${acts.map(([k, l, t]) => `<button type="button" class="btn btn--${t} btn--sm" data-amb-act="${k}" data-id="${a.id}">${l}</button>`).join("")}
        ${a.ambassador_code ? `<button type="button" class="btn btn--secondary btn--sm" data-amb-rate="${a.id}">Set commission %</button>
        <button type="button" class="btn btn--secondary btn--sm" data-amb-adjust="${a.id}">Adjust commission</button>
        <button type="button" class="btn btn--secondary btn--sm" data-amb-code="${a.id}">Change referral code</button>` : ""}
        <button type="button" class="btn btn--secondary btn--sm" data-amb-notes="${a.id}">Notes</button>
      </div>
      <div class="two-col">
        <div><h3 style="font-size:var(--fs-base)">Recent commission entries</h3><div data-amb-ledger><div class="skeleton" style="height:80px"></div></div></div>
        <div><h3 style="font-size:var(--fs-base)">Commission rate history</h3><div data-amb-rates><div class="skeleton" style="height:80px"></div></div></div>
      </div>
    </div>`;
  box.scrollIntoView({ behavior: "smooth", block: "nearest" });

  const [{ data: led }, { data: rh }] = await Promise.all([
    supabase.from("ambassador_commissions").select("*").eq("ambassador_id", id).order("created_at", { ascending: false }).limit(15),
    supabase.from("ambassador_rate_history").select("*").eq("ambassador_id", id).order("changed_at", { ascending: false }).limit(15),
  ]);
  if (currentId !== id) return;
  box.querySelector("[data-amb-ledger]").innerHTML = (led || []).length
    ? `<ul class="amb-mini">${led.map((c) => `<li><span>${formatDate(c.created_at)} · ${c.type}${c.order_id ? ` · ${escapeHtml(c.order_id)}` : ""}${c.type === "earn" ? ` · ${Number(c.rate_percent)}%` : ""}${c.status === "reversed" ? " · reversed" : ""}</span><strong>${c.amount > 0 ? "+" : ""}${formatCurrency(c.amount)}</strong></li>`).join("")}</ul>`
    : `<p class="muted">No commission entries yet.</p>`;
  const ids = [...new Set((rh || []).map((r) => r.changed_by).filter(Boolean))];
  const { data: people } = ids.length ? await supabase.from("profiles").select("id,name,email").in("id", ids) : { data: [] };
  const who = new Map((people || []).map((p) => [p.id, p.name || p.email]));
  box.querySelector("[data-amb-rates]").innerHTML = (rh || []).length
    ? `<ul class="amb-mini">${rh.map((r) => `<li><span>${formatDate(r.changed_at)} · ${escapeHtml(who.get(r.changed_by) || "admin")}${r.reason ? `<br /><span class="muted">${escapeHtml(r.reason)}</span>` : ""}</span><strong>${r.old_rate == null ? "—" : Number(r.old_rate) + "%"} → ${Number(r.new_rate)}%</strong></li>`).join("")}</ul>`
    : `<p class="muted">No rate changes yet.</p>`;
}

/* ------------------------------- withdrawals ----------------------------- */
let wdFilter = "pending";
async function loadWithdrawals() {
  const body = root.querySelector("[data-amb-wd-body]");
  try {
    const list = await rpc("admin_list_withdrawals", { p_status: wdFilter || null, p_limit: 50 });
    body.innerHTML = list.length
      ? list
        .map(
          (w) => `<tr>
        <td data-label="Requested">${formatDateTime(w.requested_at)}</td>
        <td data-label="Ambassador">${escapeHtml(w.display_name)}<br /><span class="muted">${escapeHtml(w.ambassador_code || "")}</span></td>
        <td data-label="Amount">${formatCurrency(w.amount)}</td>
        <td data-label="M-Pesa number">${escapeHtml(w.phone)}</td>
        <td data-label="Balance now">${formatCurrency(w.available_now)}</td>
        <td data-label="Status">${badge(WD_BADGE, { pending: "Pending", approved: "Approved", paid: "Paid", rejected: "Rejected" }, w.status)}${w.payout_reference ? `<br /><span class="muted">${escapeHtml(w.payout_reference)}</span>` : ""}</td>
        <td data-label="Actions"><div class="loyalty-actions-cell">
          ${w.status === "pending" ? `<button type="button" class="btn btn--primary btn--sm" data-wd="approve" data-id="${w.id}" data-amt="${w.amount}">Approve</button>` : ""}
          ${w.status === "approved" ? `<button type="button" class="btn btn--primary btn--sm" data-wd="mark_paid" data-id="${w.id}" data-amt="${w.amount}" data-phone="${escapeHtml(w.phone)}">Mark paid</button>` : ""}
          ${w.status === "pending" || w.status === "approved" ? `<button type="button" class="btn btn--secondary btn--sm" data-wd="reject" data-id="${w.id}" data-amt="${w.amount}">Reject</button>` : ""}
        </div></td></tr>`
        )
        .join("")
      : `<tr><td colspan="7">No ${wdFilter || ""} withdrawal requests.</td></tr>`;
  } catch (ex) {
    body.innerHTML = `<tr><td colspan="7">${escapeHtml(ex.message)}</td></tr>`;
  }
}

function withdrawalModal(action, id, amount, phone) {
  const titles = { approve: "Approve withdrawal", reject: "Reject withdrawal", mark_paid: "Mark as paid" };
  const fields = {
    approve: field("Note (optional)", `<textarea name="note" rows="2"></textarea>`),
    reject: field("Reason (required, shown to the ambassador)", `<textarea name="note" rows="2" required></textarea>`),
    mark_paid: `<p class="loyalty-note" style="margin-bottom:var(--sp-3)">Send ${formatCurrency(amount)} to ${escapeHtml(phone)} by M-Pesa first, then record the receipt. Payouts are not automated.</p>${field("M-Pesa receipt / reference", `<input name="reference" type="text" required />`)}`,
  };
  openModal({
    title: `${titles[action]} — ${formatCurrency(amount)}`,
    submitLabel: titles[action],
    fieldsHtml: fields[action],
    onSubmit: async (v) => {
      if (action === "reject" && !v.note?.trim()) return "A reason is required.";
      if (action === "mark_paid" && !v.reference?.trim()) return "Enter the M-Pesa receipt.";
      await rpc("admin_review_withdrawal", { p_id: id, p_action: action, p_note: v.note || null, p_reference: v.reference || null });
      showToast(action === "approve" ? "Withdrawal approved." : action === "reject" ? "Withdrawal rejected." : "Withdrawal marked as paid.", "success");
      await refreshAll();
    },
  });
}

/* ---------------------------------- audit -------------------------------- */
const AUDIT_LABEL = {
  ambassador_approve: "Ambassador approved", ambassador_reject: "Application rejected", ambassador_suspend: "Ambassador suspended",
  ambassador_reactivate: "Ambassador reactivated", ambassador_deactivate: "Ambassador deactivated", commission_rate_change: "Commission rate changed",
  commission_adjustment: "Commission adjusted", referral_code_change: "Referral code changed", ambassador_notes: "Notes updated",
  withdrawal_approve: "Withdrawal approved", withdrawal_reject: "Withdrawal rejected", withdrawal_mark_paid: "Withdrawal paid",
  ambassador_settings_update: "Program settings changed", business_setting_change: "Business setting changed",
};

function auditDetail(a) {
  const p = a.previous_value || {};
  const n = a.new_value || {};
  if (a.action === "commission_rate_change") return `${p.commission_rate}% → ${n.commission_rate}%`;
  if (a.action === "commission_adjustment") return `${n.amount > 0 ? "+" : ""}${formatCurrency(n.amount)}`;
  if (a.action === "referral_code_change") return `${p.referral_code || "—"} → ${n.referral_code}`;
  if (a.action.startsWith("withdrawal_")) return `${formatCurrency(n.amount)} · ${p.status} → ${n.status}`;
  if (a.action.startsWith("ambassador_") && n.status) return `${p.status} → ${n.status}${n.ambassador_code ? ` (${n.ambassador_code})` : ""}`;
  return "";
}

async function loadAudit() {
  const body = root.querySelector("[data-amb-audit-body]");
  const { data, error } = await supabase.from("audit_logs").select("*").order("created_at", { ascending: false }).limit(25);
  if (error) return void (body.innerHTML = `<tr><td colspan="4">Unable to load the audit log.</td></tr>`);
  const ids = [...new Set(data.map((a) => a.admin_id))];
  const { data: people } = ids.length ? await supabase.from("profiles").select("id,name,email").in("id", ids) : { data: [] };
  const who = new Map((people || []).map((p) => [p.id, p.name || p.email]));
  body.innerHTML = data.length
    ? data.map((a) => `<tr><td data-label="Date">${formatDateTime(a.created_at)}</td><td data-label="Admin">${escapeHtml(who.get(a.admin_id) || "—")}</td><td data-label="Action">${AUDIT_LABEL[a.action] || escapeHtml(a.action)}</td><td data-label="Details">${escapeHtml(auditDetail(a))}${a.reason ? `<br /><span class="muted">${escapeHtml(a.reason)}</span>` : ""}</td></tr>`).join("")
    : `<tr><td colspan="4">No admin actions recorded yet.</td></tr>`;
}

async function refreshAll() {
  await Promise.all([loadList(), loadWithdrawals(), loadAudit()]);
  if (currentId) await renderDetail(currentId);
}

/* ---------------------------------- init --------------------------------- */
export async function initAmbassadorAdmin() {
  root = document.querySelector("[data-ambassador-admin]");
  if (!root) return;

  const { data, error } = await supabase.from("ambassador_settings").select("*").maybeSingle();
  if (error || !data) {
    root.innerHTML = `<div class="panel__body panel__body--padded"><p class="muted">Ambassador tables are not available yet. Run <code>migration_ambassador.sql</code> in the Supabase SQL editor.</p></div>`;
    return;
  }
  settings = data;

  root.innerHTML = `
    <div class="panel__body panel__body--padded loyalty-admin-block"><h3>Program settings</h3>${settingsHtml()}</div>
    <div class="panel__body panel__body--padded loyalty-admin-block">
      <h3>Ambassadors</h3>
      <div class="filters-bar" style="margin-bottom:var(--sp-3)">
        <div class="filters-bar__search"><input type="search" placeholder="Search name, email, ID or code…" aria-label="Search ambassadors" data-amb-search /></div>
        <select data-amb-status aria-label="Filter by status">
          <option value="">All statuses</option><option value="applicant">Pending applications</option><option value="approved">Active</option>
          <option value="suspended">Suspended</option><option value="rejected">Rejected</option><option value="deactivated">Deactivated</option>
        </select>
      </div>
      ${table(["Ambassador", "ID / Code", "Status", "Rate", "Referrals", "Qualifying orders", "Generated", "Available", "Actions"], "data-amb-body")}
    </div>
    <div class="panel" data-amb-detail hidden style="margin:0 var(--sp-5) var(--sp-5)"></div>
    <div class="panel__body panel__body--padded loyalty-admin-block">
      <div class="loyalty-admin-head"><h3>Withdrawals</h3>
        <select data-amb-wd-filter aria-label="Filter withdrawals"><option value="pending">Pending</option><option value="approved">Approved (to pay)</option><option value="paid">Paid</option><option value="rejected">Rejected</option><option value="">All</option></select></div>
      ${table(["Requested", "Ambassador", "Amount", "M-Pesa number", "Balance now", "Status", "Actions"], "data-amb-wd-body")}
    </div>
    <div class="panel__body panel__body--padded loyalty-admin-block"><h3>Audit log</h3>
      ${table(["Date", "Admin", "Action", "Details"], "data-amb-audit-body")}
    </div>`;

  wireSettings();

  root.addEventListener("click", async (e) => {
    const t = e.target.closest("button");
    if (!t) return;
    const find = (id) => rows.find((r) => r.id === id);
    try {
      if (t.dataset.ambManage) return await renderDetail(t.dataset.ambManage);
      if (t.hasAttribute("data-amb-close")) {
        currentId = null;
        return void (root.querySelector("[data-amb-detail]").hidden = true);
      }
      if (t.dataset.ambAct) return statusModal(find(t.dataset.id), t.dataset.ambAct);
      if (t.dataset.ambRate) return rateModal(find(t.dataset.ambRate));
      if (t.dataset.ambAdjust) return adjustModal(find(t.dataset.ambAdjust));
      if (t.dataset.ambCode) return codeModal(find(t.dataset.ambCode));
      if (t.dataset.ambNotes) return notesModal(find(t.dataset.ambNotes));
      if (t.dataset.ambCopy) {
        await navigator.clipboard.writeText(t.dataset.ambCopy);
        return showToast("Referral link copied!", "success");
      }
      if (t.dataset.wd) return withdrawalModal(t.dataset.wd, t.dataset.id, Number(t.dataset.amt), t.dataset.phone);
    } catch (ex) {
      showToast(ex.message || "Action failed.", "error", 5000);
    }
  });

  const search = root.querySelector("[data-amb-search]");
  search.addEventListener("input", debounce(() => { filter.q = search.value.trim(); loadList(); }, 250));
  root.querySelector("[data-amb-status]").addEventListener("change", (e) => { filter.status = e.target.value; loadList(); });
  root.querySelector("[data-amb-wd-filter]").addEventListener("change", (e) => { wdFilter = e.target.value; loadWithdrawals(); });

  await Promise.all([loadList(), loadWithdrawals(), loadAudit()]);
}