/**
 * BTECH CUSTOMER SUPPORT — Admin Portal: "Customer Service & Support"
 * ----------------------------------------------------------------
 * Mounts into [data-support-admin] on admin.html. Every read/write goes through an admin_support_*
 * RPC that re-checks is_admin() on the server (and audit-logs changes); hiding this panel from
 * non-admins is a courtesy, not the security boundary. Internal notes are shown here only and are
 * never visible to customers or sent to the AI. All dynamic text is escaped.
 */
import { supabase } from "./supabase.js";
import { escapeHtml, showToast, formatDateTime } from "./utils.js";

const STATUS_LABEL = { open: "Open", in_progress: "In progress", awaiting_customer: "Awaiting customer", resolved: "Resolved", closed: "Closed" };
const CATEGORY_LABEL = { general: "General", account: "Account", service: "Service", order: "Order", payment: "Payment", refund: "Refund", cancellation: "Cancellation", security: "Security", other: "Other" };
const PRIORITIES = ["low", "normal", "high", "urgent"];
const f = { status: "active", priority: "", category: "", q: "" };
let root, staff = [], tab = "tickets", page = 0;
const PAGE = 20;

const rpc = async (name, args) => {
  const { data, error } = await supabase.rpc(name, args || {});
  if (error) throw error;
  return data;
};
const pill = (p) => `<span class="sa-pill sa-pill--${escapeHtml(p)}">${escapeHtml(p)}</span>`;
const opts = (map, sel, blank) => (blank != null ? `<option value="">${escapeHtml(blank)}</option>` : "") + Object.entries(map).map(([k, v]) => `<option value="${k}" ${k === sel ? "selected" : ""}>${escapeHtml(v)}</option>`).join("");
const fail = (e) => showToast((e && e.message) || "Something went wrong.", "error");

export async function initSupportAdmin() {
  root = document.querySelector("[data-support-admin]");
  if (!root) return;
  staff = await rpc("admin_support_staff").catch(() => []);
  shell();
  await showTab("tickets");
}

function shell() {
  root.innerHTML = `
    <div class="panel__body panel__body--padded">
      <div class="sa-tabs" role="tablist">
        ${[["tickets", "Tickets"], ["kb", "Knowledge base"], ["settings", "Assistant settings"], ["analytics", "Analytics"]]
      .map(([k, l]) => `<button class="sa-tab" role="tab" data-tab="${k}" aria-selected="${k === tab}">${l}</button>`).join("")}
      </div>
      <div data-sa-body></div>
    </div>`;
  root.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
}

async function showTab(t) {
  tab = t;
  root.querySelectorAll("[data-tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === t)));
  const body = root.querySelector("[data-sa-body]");
  body.innerHTML = '<div class="skeleton" style="height:120px"></div>';
  try {
    if (t === "tickets") await listView(body);
    else if (t === "kb") await kbView(body);
    else if (t === "settings") await settingsView(body);
    else await analyticsView(body);
  } catch (e) { body.innerHTML = `<p class="muted">Could not load this section. ${escapeHtml(e.message || "")}</p>`; }
}

// ---------------------------------------------------------------- tickets
async function listView(body) {
  const res = await rpc("admin_support_list", { p_status: f.status, p_priority: f.priority, p_category: f.category, p_search: f.q, p_limit: PAGE, p_offset: page * PAGE });
  const statusOpts = { active: "Active (not resolved)", "": "All", ...STATUS_LABEL };
  body.innerHTML = `
    <div class="sa-bar">
      <select data-f="status" aria-label="Status">${opts(statusOpts, f.status)}</select>
      <select data-f="priority" aria-label="Priority">${opts(Object.fromEntries(PRIORITIES.map((p) => [p, p])), f.priority, "All priorities")}</select>
      <select data-f="category" aria-label="Category">${opts(CATEGORY_LABEL, f.category, "All categories")}</select>
      <input data-f="q" type="search" placeholder="Search ticket ref, customer, order" value="${escapeHtml(f.q)}" aria-label="Search" />
    </div>
    <div class="sa-table-wrap"><table class="sa-table">
      <thead><tr><th>Ref</th><th>Subject</th><th>Customer</th><th>Category</th><th>Priority</th><th>Status</th><th>Updated</th></tr></thead>
      <tbody>${res.rows.map((r) => `
        <tr data-open="${escapeHtml(r.id)}" tabindex="0">
          <td>${escapeHtml(r.id)}</td><td>${escapeHtml(r.subject)}${r.source === "ai_chat" ? ' <span class="sa-pill">AI chat</span>' : ""}</td>
          <td>${escapeHtml(r.customer_name || "")}<br><small class="muted">${escapeHtml(r.customer_email || "")}</small></td>
          <td>${escapeHtml(CATEGORY_LABEL[r.category] || r.category)}</td><td>${pill(r.priority)}</td>
          <td>${escapeHtml(STATUS_LABEL[r.status] || r.status)}</td><td>${formatDateTime(r.updated_at)}</td></tr>`).join("") || '<tr><td colspan="7" class="muted">No tickets match.</td></tr>'}
      </tbody></table></div>
    <div class="sa-bar" style="margin-top:12px"><span class="muted">${res.total} ticket(s)</span>
      <button class="btn btn--ghost btn--sm" data-prev ${page === 0 ? "disabled" : ""}>Previous</button>
      <button class="btn btn--ghost btn--sm" data-next ${(page + 1) * PAGE >= res.total ? "disabled" : ""}>Next</button></div>`;
  let timer;
  body.querySelectorAll("[data-f]").forEach((el) => el.addEventListener(el.tagName === "INPUT" ? "input" : "change", () => {
    f[el.dataset.f] = el.value; page = 0; clearTimeout(timer);
    timer = setTimeout(() => listView(body).then(() => { const q = body.querySelector('[data-f="q"]'); if (document.activeElement === document.body && el.tagName === "INPUT") { q.focus(); q.setSelectionRange(q.value.length, q.value.length); } }), el.tagName === "INPUT" ? 350 : 0);
  }));
  body.querySelector("[data-prev]").addEventListener("click", () => { page--; listView(body); });
  body.querySelector("[data-next]").addEventListener("click", () => { page++; listView(body); });
  body.querySelectorAll("[data-open]").forEach((tr) => {
    const go = () => detailView(body, tr.dataset.open);
    tr.addEventListener("click", go); tr.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
  });
}

async function detailView(body, id) {
  const d = await rpc("admin_support_get", { p_ticket: id }).catch((e) => { fail(e); return null; });
  if (!d) return;
  const t = d.ticket, c = d.customer || {};
  const firstUser = d.messages.find((m) => m.sender === "user" && m.visibility === "customer");
  body.innerHTML = `
    <button class="btn btn--ghost btn--sm" data-back>&larr; All tickets</button>
    <h3 style="margin:12px 0 4px">${escapeHtml(t.id)} &middot; ${escapeHtml(t.subject)}</h3>
    <p class="muted">${escapeHtml(CATEGORY_LABEL[t.category] || t.category)} &middot; ${pill(t.priority)} &middot; ${escapeHtml(STATUS_LABEL[t.status] || t.status)} &middot; opened ${formatDateTime(t.created_at)}</p>
    <div class="sa-detail"><div>
      <div class="sa-box"><h4>Original complaint</h4><div style="white-space:pre-wrap">${escapeHtml(firstUser ? firstUser.message : "")}</div></div>
      ${t.ai_summary ? `<div class="sa-box"><h4>AI summary</h4><div>${escapeHtml(t.ai_summary)}</div></div>` : ""}
      <div class="sa-box"><h4>Conversation with the customer</h4>
        ${d.messages.map((m) => `<div class="tk-msg tk-msg--${m.sender} ${m.visibility === "internal" ? "sa-note" : ""}"><small>${m.visibility === "internal" ? "INTERNAL NOTE (not visible to customer) &middot; " : ""}${m.sender === "support" ? escapeHtml(m.author || "Support") : "Customer"} &middot; ${formatDateTime(m.created_at)}</small>${escapeHtml(m.message)}</div>`).join("")}
      </div>
      <div class="sa-box sa-form"><h4>Reply to customer</h4>
        <textarea data-reply rows="3" maxlength="2000" placeholder="Visible to the customer" aria-label="Reply"></textarea>
        <div class="sa-bar" style="margin-top:8px"><button class="btn btn--primary btn--sm" data-send="reply">Send reply</button>
          <button class="btn btn--ghost btn--sm" data-send="info_request">Request more info</button></div></div>
      <div class="sa-box sa-note sa-form"><h4>Internal note</h4>
        <textarea data-note rows="2" maxlength="2000" placeholder="Staff only. Never shown to the customer or the AI." aria-label="Internal note"></textarea>
        <div style="margin-top:8px"><button class="btn btn--ghost btn--sm" data-save-note>Save note</button></div></div>
      ${d.conversation.length ? `<details class="sa-box"><summary><b>AI conversation (${d.conversation.length} messages)</b></summary>${d.conversation.map((m) => `<div class="tk-msg tk-msg--${m.role === "user" ? "user" : "support"}"><small>${m.role === "user" ? "Customer" : "Assistant"} &middot; ${formatDateTime(m.created_at)}</small>${escapeHtml(m.content)}</div>`).join("")}</details>` : ""}
    </div><div>
      <div class="sa-box"><h4>Customer</h4>${escapeHtml(c.name || "")}<br>${escapeHtml(c.email || "")}<br>${escapeHtml(c.phone || "")}
        ${t.related_order_id ? `<br><br>Order: <b>${escapeHtml(t.related_order_id)}</b>${t.related_amount != null ? ` &middot; Ksh ${Number(t.related_amount).toLocaleString("en-KE")}` : ""}` : ""}</div>
      <div class="sa-box sa-form"><h4>Manage</h4>
        <label>Assigned to</label><select data-set="assign"><option value="">Unassigned</option>${staff.map((s) => `<option value="${s.id}" ${s.id === t.assigned_to ? "selected" : ""}>${escapeHtml(s.name || s.email)}</option>`).join("")}</select>
        <label>Team</label><input data-set="team" value="${escapeHtml(t.assigned_team || "")}" maxlength="60" />
        <label>Priority</label><select data-set="priority">${PRIORITIES.map((p) => `<option ${p === t.priority ? "selected" : ""}>${p}</option>`).join("")}</select>
        <label>Status</label><select data-set="status">${Object.entries(STATUS_LABEL).filter(([k]) => ["open", "in_progress", "awaiting_customer"].includes(k)).map(([k, v]) => `<option value="${k}" ${k === t.status ? "selected" : ""}>${v}</option>`).join("")}${["resolved", "closed"].includes(t.status) ? `<option selected disabled>${STATUS_LABEL[t.status]}</option>` : ""}</select>
        <div class="sa-bar" style="margin-top:10px"><button class="btn btn--ghost btn--sm" data-act="escalate">Escalate</button>
          ${["resolved", "closed"].includes(t.status) ? '<button class="btn btn--ghost btn--sm" data-act="reopen">Reopen</button>' : '<button class="btn btn--ghost btn--sm" data-act="close">Close</button>'}</div>
        ${["resolved", "closed"].includes(t.status) ? "" : `<label>Resolution (shown to the customer)</label><textarea data-resolution rows="2" maxlength="1000"></textarea><button class="btn btn--primary btn--sm" style="margin-top:8px" data-act="resolve">Resolve</button>`}
        <p class="muted" style="font-size:12px;margin-top:10px">Resolving or replying never refunds, credits a wallet, cancels an order or pays commission. Use the existing Refunds and Cancellations sections for those.</p></div>
      <div class="sa-box"><h4>History</h4>${d.events.map((e) => `<div class="muted" style="font-size:12px">${formatDateTime(e.created_at)} &middot; ${escapeHtml(e.event)}${e.actor ? " &middot; " + escapeHtml(e.actor) : ""}</div>`).join("")}</div>
    </div></div>`;
  const refresh = () => detailView(body, id);
  const run = async (p, msg) => { try { await p; if (msg) showToast(msg, "success"); await refresh(); } catch (e) { fail(e); } };
  body.querySelector("[data-back]").addEventListener("click", () => listView(body));
  body.querySelectorAll("[data-send]").forEach((b) => b.addEventListener("click", () => run(rpc("admin_support_reply", { p_ticket: id, p_message: body.querySelector("[data-reply]").value, p_kind: b.dataset.send }), "Sent to customer.")));
  body.querySelector("[data-save-note]").addEventListener("click", () => run(rpc("admin_support_note", { p_ticket: id, p_note: body.querySelector("[data-note]").value }), "Note saved."));
  body.querySelectorAll("[data-set]").forEach((el) => el.addEventListener("change", () => run(rpc("admin_support_set", { p_ticket: id, p_action: el.dataset.set, p_value: el.value }), "Updated.")));
  body.querySelectorAll("[data-act]").forEach((b) => b.addEventListener("click", () => {
    const a = b.dataset.act;
    if (a === "escalate") return run(rpc("admin_support_set", { p_ticket: id, p_action: "escalate", p_value: body.querySelector('[data-set="team"]').value || null }), "Escalated.");
    const r = body.querySelector("[data-resolution]");
    run(rpc("admin_support_set", { p_ticket: id, p_action: a, p_resolution: r ? r.value : null }), "Updated.");
  }));
}

// ---------------------------------------------------------------- knowledge base
async function kbView(body) {
  const list = await rpc("admin_support_kb_list");
  body.innerHTML = `<p class="muted">Only approved, active entries are used by the assistant. Do not add prices (live service data is used) or policies BTECH has not decided.</p>
    <button class="btn btn--primary btn--sm" data-new>Add entry</button>
    <div class="sa-table-wrap"><table class="sa-table"><thead><tr><th>Topic</th><th>Title</th><th>Active</th><th></th></tr></thead><tbody>
    ${list.map((k) => `<tr><td>${escapeHtml(k.topic)}</td><td>${escapeHtml(k.title)}</td><td>${k.active ? "Yes" : "No"}</td><td><button class="btn btn--ghost btn--sm" data-edit="${k.id}">Edit</button></td></tr>`).join("")}</tbody></table></div><div data-form></div>`;
  const form = (k) => {
    const box = body.querySelector("[data-form]");
    box.innerHTML = `<div class="sa-box sa-form"><h4>${k ? "Edit entry" : "New entry"}</h4>
      <label>Topic</label><input data-k="topic" maxlength="40" value="${escapeHtml(k ? k.topic : "")}" />
      <label>Title</label><input data-k="title" maxlength="140" value="${escapeHtml(k ? k.title : "")}" />
      <label>Answer (what the assistant may say)</label><textarea data-k="body" rows="5" maxlength="2500">${escapeHtml(k ? k.body : "")}</textarea>
      <label>Search keywords (English and Kiswahili, space separated)</label><input data-k="keywords" maxlength="400" value="${escapeHtml(k ? k.keywords : "")}" />
      <label><input type="checkbox" data-k="active" ${!k || k.active ? "checked" : ""} style="width:auto" /> Active</label>
      <div class="sa-bar" style="margin-top:10px"><button class="btn btn--primary btn--sm" data-save>Save</button></div></div>`;
    box.querySelector("[data-save]").addEventListener("click", async () => {
      const g = (n) => box.querySelector(`[data-k="${n}"]`);
      try {
        await rpc("admin_support_kb_save", { p_id: k ? k.id : null, p_topic: g("topic").value, p_title: g("title").value, p_body: g("body").value, p_keywords: g("keywords").value, p_active: g("active").checked });
        showToast("Saved.", "success"); kbView(body);
      } catch (e) { fail(e); }
    });
    box.scrollIntoView({ block: "nearest" });
  };
  body.querySelector("[data-new]").addEventListener("click", () => form(null));
  body.querySelectorAll("[data-edit]").forEach((b) => b.addEventListener("click", () => form(list.find((k) => k.id === b.dataset.edit))));
}

// ---------------------------------------------------------------- settings
const NUM = [
  ["max_input_chars", "Max characters per customer message"], ["max_history_messages", "Earlier messages sent to the AI"],
  ["max_output_tokens", "Max AI reply length (tokens)"], ["per_user_limit", "AI messages per customer per window"],
  ["per_user_window_minutes", "Window length (minutes)"], ["per_user_daily_limit", "AI messages per customer per day"],
  ["global_daily_limit", "AI messages for everyone per day"], ["max_open_tickets", "Max open tickets per customer"],
];
async function settingsView(body) {
  const { settings: s, rules } = await rpc("admin_support_settings_get");
  body.innerHTML = `<div class="sa-box sa-form"><h4>Assistant</h4>
    <label><input type="checkbox" data-s="ai_enabled" ${s.ai_enabled ? "checked" : ""} style="width:auto" /> AI assistant enabled (tickets always work)</label>
    <label>Model</label><input data-s="model" value="${escapeHtml(s.model)}" maxlength="80" />
    ${NUM.map(([k, l]) => `<label>${l}</label><input type="number" data-s="${k}" value="${s[k]}" />`).join("")}
    <label><input type="checkbox" data-s="web_search_enabled" ${s.web_search_enabled ? "checked" : ""} style="width:auto" /> Allow web search on the domains below (off by default)</label>
    <label>Allowed web search domains (one per line, official sources only)</label><textarea data-s="web_search_domains" rows="3">${escapeHtml((s.web_search_domains || []).join("\n"))}</textarea>
    <p class="muted" style="font-size:12px">The API key is a server secret (ANTHROPIC_API_KEY) and is not editable here.</p></div>
    <div class="sa-box sa-form"><h4>Ticket priority by category</h4><div class="sa-grid">${rules.map((r) => `<div><label>${escapeHtml(CATEGORY_LABEL[r.category] || r.category)}</label><select data-rule="${r.category}">${PRIORITIES.map((p) => `<option ${p === r.priority ? "selected" : ""}>${p}</option>`).join("")}</select></div>`).join("")}</div></div>
    <button class="btn btn--primary btn--sm" data-save>Save settings</button>`;
  body.querySelector("[data-save]").addEventListener("click", async () => {
    const patch = {};
    body.querySelectorAll("[data-s]").forEach((el) => {
      const k = el.dataset.s;
      patch[k] = el.type === "checkbox" ? el.checked : el.type === "number" ? Number(el.value) : k === "web_search_domains" ? el.value.split("\n").map((x) => x.trim().toLowerCase()).filter(Boolean) : el.value.trim();
    });
    const pr = {}; body.querySelectorAll("[data-rule]").forEach((el) => { pr[el.dataset.rule] = el.value; });
    try { await rpc("admin_support_settings_update", { p_patch: patch, p_rules: pr }); showToast("Settings saved.", "success"); } catch (e) { fail(e); }
  });
}

// ---------------------------------------------------------------- analytics
async function analyticsView(body) {
  const to = new Date(Date.now() + 864e5), from = new Date(Date.now() - 30 * 864e5);
  const a = await rpc("admin_support_analytics", { p_from: from.toISOString(), p_to: to.toISOString() });
  const stat = (l, v) => `<div class="sa-stat"><b>${v ?? "—"}</b><span class="muted">${l}</span></div>`;
  const obj = (o) => Object.entries(o || {}).map(([k, v]) => `${escapeHtml(CATEGORY_LABEL[k] || STATUS_LABEL[k] || k)}: ${v}`).join(" &middot; ") || "None";
  body.innerHTML = `<p class="muted">Last 30 days, from real records.</p><div class="sa-grid">
    ${stat("Tickets", a.tickets)}${stat("From AI chat", a.tickets_from_ai)}${stat("Open now", a.open_now)}${stat("Avg first reply (hours)", a.avg_first_reply_hours)}
    ${stat("Conversations", a.conversations)}${stat("AI messages", a.ai_messages)}${stat("Input tokens", a.input_tokens)}${stat("Output tokens", a.output_tokens)}
    ${stat("Feedback average (1-5)", a.feedback_avg)}${stat("Feedback responses", a.feedback_count)}</div>
    <div class="sa-box" style="margin-top:12px"><h4>By category</h4>${obj(a.by_category)}</div>
    <div class="sa-box"><h4>By priority</h4>${obj(a.by_priority)}</div><div class="sa-box"><h4>By status</h4>${obj(a.by_status)}</div>`;
}