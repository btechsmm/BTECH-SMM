/**
 * BTECH SMM — Loyalty Management (admin section)
 * ----------------------------------------------------------------
 * Renders inside the existing admin page ([data-loyalty-admin]). Reads use the
 * admin-only RLS select policies; EVERY write goes through an admin_loyalty_*
 * RPC, which re-checks is_admin() on the server and records an audit row.
 * Hiding this UI from non-admins is a courtesy, not the security boundary.
 */

import { supabase } from "./supabase.js";
import { formatCurrency, formatNumber, formatDateTime, escapeHtml, showToast, debounce } from "./utils.js";

let root = null;
let overlay = null;
let levels = [];
let settings = null;

const AUDIT_LABEL = {
  settings_update: "Settings updated",
  level_create: "Level created",
  level_update: "Level updated",
  level_delete: "Level deleted",
  level_reorder: "Levels reordered",
  level_override: "Customer level set",
  points_adjustment: "Points adjusted",
  points_bonus: "Bonus points",
  service_rule: "Service rule",
};

/* ------------------------------ modal helper ----------------------------- */
function ensureOverlay() {
  if (overlay) return;
  overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.hidden = true;
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="lyl-modal-title">
      <div class="modal__head">
        <h3 id="lyl-modal-title" data-lyl-title></h3>
        <button class="icon-btn" type="button" data-lyl-close aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
      </div>
      <form data-lyl-form novalidate>
        <p class="form-error" data-lyl-error role="alert"></p>
        <div data-lyl-fields></div>
        <button type="submit" class="btn btn--primary btn--block" data-lyl-submit>Save</button>
      </form>
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay || e.target.closest("[data-lyl-close]")) overlay.hidden = true;
  });
}

export function openModal({ title, fieldsHtml, submitLabel = "Save", onSubmit }) {
  ensureOverlay();
  overlay.querySelector("[data-lyl-title]").textContent = title;
  overlay.querySelector("[data-lyl-fields]").innerHTML = fieldsHtml;
  overlay.querySelector("[data-lyl-error]").textContent = "";
  const btn = overlay.querySelector("[data-lyl-submit]");
  btn.textContent = submitLabel;
  btn.disabled = false;
  const form = overlay.querySelector("[data-lyl-form]");
  const fresh = form.cloneNode(true); // drops the previous submit handler
  form.replaceWith(fresh);
  fresh.addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = fresh.querySelector("[data-lyl-error]");
    const submit = fresh.querySelector("[data-lyl-submit]");
    err.textContent = "";
    submit.disabled = true;
    try {
      const values = Object.fromEntries(new FormData(fresh).entries());
      const message = await onSubmit(values, fresh);
      if (message) {
        err.textContent = message;
        submit.disabled = false;
        return;
      }
      overlay.hidden = true;
    } catch (ex) {
      err.textContent = ex?.message || "Something went wrong.";
      submit.disabled = false;
    }
  });
  overlay.hidden = false;
  fresh.querySelector("input,select,textarea")?.focus();
}

export async function rpc(name, args) {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw new Error(error.message || "Request failed.");
  return data;
}

export const numOrNull = (v) => (v === "" || v == null ? null : Number(v));
export const field = (label, input, hint = "") => `<div class="form-field"><label>${label}</label>${input}${hint ? `<span class="form-hint">${hint}</span>` : ""}</div>`;

/* -------------------------------- settings ------------------------------- */
function settingsHtml() {
  const s = settings;
  const chk = (n, v) => `<input type="checkbox" name="${n}" ${v ? "checked" : ""} />`;
  return `
  <form data-lyl-settings novalidate>
    <p class="form-error" data-lyl-settings-error role="alert"></p>
    <div class="loyalty-admin-grid">
      <label class="checkbox-row">${chk("enabled", s.enabled)} Loyalty system enabled</label>
      <label class="checkbox-row">${chk("bonus_enabled", s.bonus_enabled)} Promotional bonus points enabled</label>
      <label class="checkbox-row">${chk("discount_default_eligible", s.discount_default_eligible)} Discount applies to services with no rule</label>
    </div>
    <div class="loyalty-admin-grid">
      ${field("Points earned per unit", `<input name="points_per_unit" type="number" min="0" step="0.01" value="${s.points_per_unit}" required />`)}
      ${field("Spend unit (KES)", `<input name="spend_unit" type="number" min="1" step="0.01" value="${s.spend_unit}" required />`, "e.g. 10 points per KES 100")}
      ${field("Minimum qualifying order (KES)", `<input name="min_qualifying_order" type="number" min="0" step="0.01" value="${s.min_qualifying_order}" />`)}
      ${field("Maximum points per order", `<input name="max_points_per_order" type="number" min="1" step="1" value="${s.max_points_per_order ?? ""}" placeholder="No limit" />`)}
      ${field("Maximum discount (%)", `<input name="max_discount_percent" type="number" min="0" max="100" step="0.01" value="${s.max_discount_percent}" />`, "Hard cap on any loyalty discount")}
      ${field("Points are earned when an order is", `<select name="qualify_on"><option value="completed" ${s.qualify_on === "completed" ? "selected" : ""}>Paid and completed</option><option value="paid" ${s.qualify_on === "paid" ? "selected" : ""}>Paid</option></select>`)}
    </div>
    <button type="submit" class="btn btn--primary">Save settings</button>
  </form>`;
}

function wireSettings() {
  const form = root.querySelector("[data-lyl-settings]");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const errBox = form.querySelector("[data-lyl-settings-error]");
    errBox.textContent = "";
    const f = form.elements;
    const patch = {
      enabled: f.enabled.checked,
      bonus_enabled: f.bonus_enabled.checked,
      discount_default_eligible: f.discount_default_eligible.checked,
      points_per_unit: Number(f.points_per_unit.value),
      spend_unit: Number(f.spend_unit.value),
      min_qualifying_order: Number(f.min_qualifying_order.value || 0),
      max_points_per_order: f.max_points_per_order.value === "" ? "" : Number(f.max_points_per_order.value),
      max_discount_percent: Number(f.max_discount_percent.value || 0),
      qualify_on: f.qualify_on.value,
    };
    try {
      settings = await rpc("admin_loyalty_update_settings", { p_patch: patch, p_reason: null });
      showToast("Loyalty settings saved.", "success");
      await loadAudit();
    } catch (ex) {
      errBox.textContent = ex.message;
    }
  });
}

/* --------------------------------- levels -------------------------------- */
function levelFields(l = {}) {
  return `
    <input type="hidden" name="id" value="${l.id || ""}" />
    ${field("Level name", `<input name="name" type="text" required value="${escapeHtml(l.name || "")}" />`)}
    ${field("Description", `<input name="description" type="text" value="${escapeHtml(l.description || "")}" />`)}
    <div class="loyalty-admin-grid">
      ${field("Minimum points", `<input name="min_points" type="number" min="0" step="1" value="${l.min_points ?? 0}" />`, "Lifetime points. 0 = not required")}
      ${field("Minimum qualifying spend", `<input name="min_spend" type="number" min="0" step="0.01" value="${l.min_spend ?? 0}" />`)}
      ${field("Minimum qualifying orders", `<input name="min_orders" type="number" min="0" step="1" value="${l.min_orders ?? 0}" />`)}
      ${field("Discount (%)", `<input name="discount_percent" type="number" min="0" max="100" step="0.01" value="${l.discount_percent ?? 0}" />`)}
    </div>
    <label class="checkbox-row" style="margin-bottom:var(--sp-4)"><input type="checkbox" name="active" ${l.active === false ? "" : "checked"} /> Active</label>`;
}

function openLevelModal(l) {
  openModal({
    title: l ? "Edit level" : "Add level",
    fieldsHtml: levelFields(l),
    onSubmit: async (v, form) => {
      if (!v.name?.trim()) return "Level name is required.";
      await rpc("admin_loyalty_save_level", {
        p_level: {
          id: v.id || null,
          name: v.name.trim(),
          description: v.description || "",
          min_points: Number(v.min_points || 0),
          min_spend: Number(v.min_spend || 0),
          min_orders: Number(v.min_orders || 0),
          discount_percent: Number(v.discount_percent || 0),
          active: form.elements.active.checked,
        },
        p_reason: null,
      });
      showToast("Level saved.", "success");
      await Promise.all([loadLevels(), loadAudit()]);
    },
  });
}

async function loadLevels() {
  const { data, error } = await supabase.from("loyalty_levels").select("*").order("display_order");
  const body = root.querySelector("[data-lyl-levels-body]");
  if (error) {
    body.innerHTML = `<tr><td colspan="7">Unable to load levels.</td></tr>`;
    return;
  }
  levels = data;
  body.innerHTML = levels
    .map(
      (l, i) => `<tr>
      <td data-label="Level"><strong>${escapeHtml(l.name)}</strong>${l.active ? "" : ` <span class="badge">Inactive</span>`}</td>
      <td data-label="Min points">${formatNumber(l.min_points)}</td>
      <td data-label="Min spend">${formatCurrency(l.min_spend)}</td>
      <td data-label="Min orders">${formatNumber(l.min_orders)}</td>
      <td data-label="Discount">${Number(l.discount_percent)}%</td>
      <td data-label="Order">${i + 1}</td>
      <td data-label="Actions"><div class="loyalty-actions-cell">
        <button type="button" class="btn btn--secondary btn--sm" data-lyl-edit="${l.id}">Edit</button>
        <button type="button" class="btn btn--secondary btn--sm" data-lyl-up="${l.id}" ${i === 0 ? "disabled" : ""} aria-label="Move up">&uarr;</button>
        <button type="button" class="btn btn--secondary btn--sm" data-lyl-down="${l.id}" ${i === levels.length - 1 ? "disabled" : ""} aria-label="Move down">&darr;</button>
        <button type="button" class="btn btn--secondary btn--sm" data-lyl-del="${l.id}">Delete</button>
      </div></td>
    </tr>`
    )
    .join("");
}

async function moveLevel(id, dir) {
  const ids = levels.map((l) => l.id);
  const i = ids.indexOf(id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  await rpc("admin_loyalty_reorder_levels", { p_ids: ids });
  await Promise.all([loadLevels(), loadAudit()]);
}

/* ----------------------------- service rules ----------------------------- */
async function loadRules() {
  const [{ data: services }, { data: rules }] = await Promise.all([
    supabase.from("services").select("id,name,platform,price_per_1000,unit").order("name"),
    supabase.from("service_loyalty_rules").select("*"),
  ]);
  const byId = new Map((rules || []).map((r) => [r.service_id, r]));
  const body = root.querySelector("[data-lyl-rules-body]");
  body.innerHTML = (services || [])
    .map((s) => {
      const r = byId.get(s.id);
      const eligible = r ? r.discount_eligible : settings.discount_default_eligible;
      return `<tr>
        <td data-label="Service">${escapeHtml(s.name)}</td>
        <td data-label="Discount">${eligible ? "Eligible" : "Not eligible"}${r ? "" : ` <span class="muted">(default)</span>`}</td>
        <td data-label="Earns points">${r && !r.earns_points ? "No" : "Yes"}</td>
        <td data-label="Max discount">${r?.max_discount_percent != null ? Number(r.max_discount_percent) + "%" : "—"}</td>
        <td data-label="Price floor">${r?.min_price_per_1000 != null ? formatCurrency(r.min_price_per_1000) : "None"}</td>
        <td data-label="Actions"><button type="button" class="btn btn--secondary btn--sm" data-lyl-rule="${s.id}">Edit</button></td>
      </tr>`;
    })
    .join("");
  body._services = services || [];
  body._rules = byId;
}

function openRuleModal(serviceId) {
  const body = root.querySelector("[data-lyl-rules-body]");
  const svc = body._services.find((s) => s.id === serviceId);
  const r = body._rules.get(serviceId);
  const eligible = r ? r.discount_eligible : settings.discount_default_eligible;
  openModal({
    title: `Loyalty rules — ${svc.name}`,
    fieldsHtml: `
      <label class="checkbox-row" style="margin-bottom:var(--sp-3)"><input type="checkbox" name="discount_eligible" ${eligible ? "checked" : ""} /> Loyalty discount applies to this service</label>
      <label class="checkbox-row" style="margin-bottom:var(--sp-4)"><input type="checkbox" name="earns_points" ${r && !r.earns_points ? "" : "checked"} /> Orders for this service earn points</label>
      ${field("Maximum loyalty discount (%)", `<input name="max_discount" type="number" min="0" max="100" step="0.01" value="${r?.max_discount_percent ?? ""}" placeholder="Use global maximum" />`)}
      ${field("Minimum selling price (KES per 1,000 / unit)", `<input name="min_price" type="number" min="0" step="0.01" value="${r?.min_price_per_1000 ?? ""}" placeholder="None" />`, `Current price ${formatCurrency(svc.price_per_1000)}. A discount never takes the price below this. Never shown to customers.`)}`,
    onSubmit: async (v, form) => {
      await rpc("admin_loyalty_upsert_service_rule", {
        p_service_id: serviceId,
        p_discount_eligible: form.elements.discount_eligible.checked,
        p_earns_points: form.elements.earns_points.checked,
        p_max_discount: numOrNull(v.max_discount),
        p_min_price: numOrNull(v.min_price),
        p_reason: null,
      });
      showToast("Service rule saved.", "success");
      await Promise.all([loadRules(), loadAudit()]);
    },
  });
}

/* -------------------------------- customers ------------------------------ */
async function loadCustomers(search = "") {
  const body = root.querySelector("[data-lyl-customers-body]");
  try {
    const rows = await rpc("admin_loyalty_customers", { p_search: search, p_limit: 25, p_offset: 0 });
    body.innerHTML = rows.length
      ? rows
        .map(
          (c) => `<tr>
        <td data-label="Customer">${escapeHtml(c.name || "—")}</td>
        <td data-label="Email">${escapeHtml(c.email)}</td>
        <td data-label="Level">${escapeHtml(c.level_name || "—")}${c.overridden ? ` <span class="badge badge--accent">Manual</span>` : ""}</td>
        <td data-label="Points">${formatNumber(c.points)}</td>
        <td data-label="Spend">${formatCurrency(c.qualifying_spend)}</td>
        <td data-label="Orders">${formatNumber(c.qualifying_orders)}</td>
        <td data-label="Discount">${Number(c.discount_percent)}%</td>
        <td data-label="Last order">${c.last_qualifying_order_at ? formatDateTime(c.last_qualifying_order_at) : "—"}</td>
        <td data-label="Actions"><div class="loyalty-actions-cell">
          <button type="button" class="btn btn--secondary btn--sm" data-lyl-adjust="${c.user_id}" data-name="${escapeHtml(c.name || c.email)}">Points</button>
          <button type="button" class="btn btn--secondary btn--sm" data-lyl-setlevel="${c.user_id}" data-name="${escapeHtml(c.name || c.email)}">Level</button>
        </div></td>
      </tr>`
        )
        .join("")
      : `<tr><td colspan="9">No customers found.</td></tr>`;
  } catch (ex) {
    body.innerHTML = `<tr><td colspan="9">${escapeHtml(ex.message)}</td></tr>`;
  }
}

function openAdjustModal(userId, name) {
  openModal({
    title: `Adjust points — ${name}`,
    submitLabel: "Apply adjustment",
    fieldsHtml: `
      ${field("Points (use a negative number to remove)", `<input name="points" type="number" step="1" required />`)}
      ${field("Type", `<select name="kind"><option value="adjustment">Adjustment</option><option value="bonus" ${settings.bonus_enabled ? "" : "disabled"}>Promotional bonus${settings.bonus_enabled ? "" : " (disabled in settings)"}</option></select>`)}
      ${field("Reason (required, recorded in the audit log)", `<textarea name="reason" rows="2" required></textarea>`)}`,
    onSubmit: async (v) => {
      const points = Number(v.points);
      if (!Number.isInteger(points) || points === 0) return "Enter a whole, non-zero number of points.";
      if (!v.reason?.trim()) return "A reason is required.";
      await rpc("admin_loyalty_adjust_points", { p_user: userId, p_points: points, p_kind: v.kind, p_reason: v.reason.trim() });
      showToast("Points updated.", "success");
      await Promise.all([loadCustomers(root.querySelector("[data-lyl-search]").value.trim()), loadAudit()]);
    },
  });
}

function openSetLevelModal(userId, name) {
  const opts = [`<option value="">Automatic (based on activity)</option>`, ...levels.map((l) => `<option value="${l.id}">${escapeHtml(l.name)}</option>`)].join("");
  openModal({
    title: `Set level — ${name}`,
    fieldsHtml: `
      ${field("Level", `<select name="level">${opts}</select>`, "A manual level overrides the automatic one until you set it back to Automatic.")}
      ${field("Reason (required, recorded in the audit log)", `<textarea name="reason" rows="2" required></textarea>`)}`,
    onSubmit: async (v) => {
      if (!v.reason?.trim()) return "A reason is required.";
      await rpc("admin_loyalty_set_level_override", { p_user: userId, p_level: v.level || null, p_reason: v.reason.trim() });
      showToast("Customer level updated.", "success");
      await Promise.all([loadCustomers(root.querySelector("[data-lyl-search]").value.trim()), loadAudit()]);
    },
  });
}

/* ---------------------------------- audit -------------------------------- */
function summarise(a) {
  if (a.action === "points_adjustment" || a.action === "points_bonus") {
    const c = a.new_value?.change;
    return `${c > 0 ? "+" : ""}${c} pts (balance ${a.previous_value?.points_balance} → ${a.new_value?.points_balance})`;
  }
  if (a.action === "level_override") return "Manual level changed";
  if (a.action === "settings_update") return "Programme settings changed";
  if (a.action === "level_reorder") return "Display order changed";
  if (a.action === "service_rule") return "Service rule changed";
  return a.new_value?.name || a.previous_value?.name || "";
}

async function loadAudit() {
  const body = root.querySelector("[data-lyl-audit-body]");
  const { data, error } = await supabase.from("loyalty_audit_log").select("*").order("created_at", { ascending: false }).limit(25);
  if (error) {
    body.innerHTML = `<tr><td colspan="5">Unable to load the audit log.</td></tr>`;
    return;
  }
  const ids = [...new Set(data.flatMap((a) => [a.admin_id, a.user_id]).filter(Boolean))];
  const { data: people } = ids.length ? await supabase.from("profiles").select("id,name,email").in("id", ids) : { data: [] };
  const who = new Map((people || []).map((p) => [p.id, p.name || p.email]));
  body.innerHTML = data.length
    ? data
      .map(
        (a) => `<tr>
        <td data-label="Date">${formatDateTime(a.created_at)}</td>
        <td data-label="Admin">${escapeHtml(who.get(a.admin_id) || "—")}</td>
        <td data-label="Action">${AUDIT_LABEL[a.action] || escapeHtml(a.action)}</td>
        <td data-label="Customer">${a.user_id ? escapeHtml(who.get(a.user_id) || "—") : "—"}</td>
        <td data-label="Details">${escapeHtml(summarise(a))}${a.reason ? `<br /><span class="muted">${escapeHtml(a.reason)}</span>` : ""}</td>
      </tr>`
      )
      .join("")
    : `<tr><td colspan="5">No admin actions recorded yet.</td></tr>`;
}

/* ---------------------------------- init --------------------------------- */
const table = (headers, bodyAttr) =>
  `<div class="table-card"><table class="data-table"><thead><tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody ${bodyAttr}></tbody></table></div>`;

export async function initLoyaltyAdmin() {
  root = document.querySelector("[data-loyalty-admin]");
  if (!root) return;

  const { data, error } = await supabase.from("loyalty_settings").select("*").maybeSingle();
  if (error || !data) {
    root.innerHTML = `<div class="panel__body panel__body--padded"><p class="muted">Loyalty tables are not available yet. Run <code>migration_loyalty.sql</code> in the Supabase SQL editor.</p></div>`;
    return;
  }
  settings = data;

  root.innerHTML = `
    <div class="panel__body panel__body--padded loyalty-admin-block"><h3>General settings</h3>${settingsHtml()}</div>
    <div class="panel__body panel__body--padded loyalty-admin-block">
      <div class="loyalty-admin-head"><h3>Levels</h3><button type="button" class="btn btn--primary btn--sm" data-lyl-add-level>Add level</button></div>
      <p class="form-hint">Order levels from lowest to highest. A customer gets the highest level whose minimums are all met.</p>
      ${table(["Level", "Min points", "Min spend", "Min orders", "Discount", "Order", "Actions"], "data-lyl-levels-body")}
    </div>
    <div class="panel__body panel__body--padded loyalty-admin-block"><h3>Service rules</h3>
      <p class="form-hint">Set which services earn points and get discounts, and a minimum selling price that discounts can never go below.</p>
      ${table(["Service", "Discount", "Earns points", "Max discount", "Price floor", "Actions"], "data-lyl-rules-body")}
    </div>
    <div class="panel__body panel__body--padded loyalty-admin-block"><h3>Customer loyalty</h3>
      <input type="search" class="admin-users-search" placeholder="Search customers by name or email…" data-lyl-search style="width:100%;max-width:320px;margin-bottom:var(--sp-3)" />
      ${table(["Customer", "Email", "Level", "Points", "Spend", "Orders", "Discount", "Last order", "Actions"], "data-lyl-customers-body")}
    </div>
    <div class="panel__body panel__body--padded loyalty-admin-block"><h3>Audit log</h3>
      ${table(["Date", "Admin", "Action", "Customer", "Details"], "data-lyl-audit-body")}
    </div>`;

  wireSettings();

  if (root._lylWired) {
    // The admin page re-initialises after review actions; the listener is already attached.
    const again = root.querySelector("[data-lyl-search]");
    again.addEventListener("input", debounce(() => loadCustomers(again.value.trim()), 250));
    await Promise.all([loadLevels(), loadRules(), loadCustomers(), loadAudit()]);
    return;
  }
  root._lylWired = true;

  root.addEventListener("click", async (e) => {
    const t = e.target.closest("button");
    if (!t) return;
    try {
      if (t.hasAttribute("data-lyl-add-level")) return openLevelModal(null);
      if (t.dataset.lylEdit) return openLevelModal(levels.find((l) => l.id === t.dataset.lylEdit));
      if (t.dataset.lylUp) return await moveLevel(t.dataset.lylUp, -1);
      if (t.dataset.lylDown) return await moveLevel(t.dataset.lylDown, 1);
      if (t.dataset.lylDel) {
        const l = levels.find((x) => x.id === t.dataset.lylDel);
        if (!window.confirm(`Delete the "${l.name}" level? This only works if no customer currently holds it.`)) return;
        await rpc("admin_loyalty_delete_level", { p_id: l.id, p_reason: null });
        showToast("Level deleted.", "success");
        return await Promise.all([loadLevels(), loadAudit()]);
      }
      if (t.dataset.lylRule) return openRuleModal(t.dataset.lylRule);
      if (t.dataset.lylAdjust) return openAdjustModal(t.dataset.lylAdjust, t.dataset.name);
      if (t.dataset.lylSetlevel) return openSetLevelModal(t.dataset.lylSetlevel, t.dataset.name);
    } catch (ex) {
      showToast(ex.message || "Action failed.", "error", 5000);
    }
  });

  const search = root.querySelector("[data-lyl-search]");
  search.addEventListener("input", debounce(() => loadCustomers(search.value.trim()), 250));

  await Promise.all([loadLevels(), loadRules(), loadCustomers(), loadAudit()]);
}