/**
 * BTECH SMM — Admin Module (Supabase — Phase 2A)
 * ----------------------------------------------------------------
 * Backed by real cross-user data, so this checks the signed-in
 * user's `role` (from the `profiles` table) before rendering
 * anything. RLS also independently blocks a non-admin from reading
 * other users' orders/profiles even if this client-side check were
 * bypassed — this check exists for a clean UI message, not as the
 * security boundary itself. The "Admin" nav link is also now hidden
 * for non-admins (see navigation.js) so the panel isn't advertised
 * to accounts that can't use it — but that's a UX nicety on top of,
 * not instead of, the RLS + role check enforcement here.
 *
 * The Users section reads every row from `profiles` live — the
 * `profiles_select_admin` RLS policy in schema.sql is what actually
 * allows an admin account to see rows other than their own; this
 * module doesn't grant that itself.
 *
 * To make your own account an admin, run in the Supabase SQL editor:
 *   update public.profiles set role = 'admin' where email = 'you@example.com';
 */

import { supabase } from "./supabase.js";
import { AuthService } from "./auth.js";
import { ServicesService, ServicesData } from "./services.js";
import { initLoyaltyAdmin } from "./loyalty-admin.js";
import { initAdminDashboard } from "./admin-dashboard.js";
import { formatCurrency, formatNumber, formatDate, formatDateTime, escapeHtml, setText, debounce, setButtonLoading, showToast, generateId, friendlyError } from "./utils.js";

const STATUS_LABEL = { pending: "Pending", processing: "Processing", completed: "Completed", cancelled: "Cancelled" };
const PAYMENT_LABEL = { unpaid: "Awaiting payment", paid: "Paid", refunded: "Refunded" };

let _users = [];

function renderRestricted() {
  const main = document.querySelector("#main .container");
  if (!main) return;
  main.innerHTML = `
    <div class="empty-state">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 3l7 3v6c0 4.5-3 8-7 9-4-1-7-4.5-7-9V6l7-3z"/></svg>
      <h3>Admin access required</h3>
      <p>Your account doesn't have admin access. Contact an existing admin if you believe this is a mistake.</p>
      <a href="dashboard.html" class="btn btn--primary">Back to dashboard</a>
    </div>`;
}

function userInitials(name, email) {
  const source = (name || "").trim() || (email || "U");
  return source
    .split(" ")
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

function renderUsersTable(rows) {
  const body = document.querySelector("[data-admin-users-body]");
  const empty = document.querySelector("[data-admin-users-empty]");
  const table = body?.closest("table");
  if (!body) return;

  if (rows.length === 0) {
    if (table) table.hidden = true;
    if (empty) empty.hidden = false;
    return;
  }
  if (table) table.hidden = false;
  if (empty) empty.hidden = true;

  body.innerHTML = rows
    .map(
      (u) => `<tr>
        <td data-label="User">
          <div style="display:flex;align-items:center;gap:var(--sp-2)">
            <span class="avatar" style="width:28px;height:28px;font-size:var(--fs-xs)">${userInitials(u.name, u.email)}</span>
            <span>${escapeHtml(u.name || "—")}</span>
          </div>
        </td>
        <td data-label="Email">${escapeHtml(u.email)}</td>
        <td data-label="Role"><span class="badge ${u.role === "admin" ? "badge--accent" : ""}">${u.role === "admin" ? "Admin" : "Customer"}</span></td>
        <td data-label="Joined">${formatDate(u.created_at)}</td>
      </tr>`
    )
    .join("");
}

function initUsersSearch() {
  const input = document.querySelector("[data-users-search]");
  if (!input || input.dataset.wired) return;
  input.dataset.wired = "true";
  input.addEventListener(
    "input",
    debounce(() => {
      const query = input.value.trim().toLowerCase();
      const filtered = !query
        ? _users
        : _users.filter((u) => (u.name || "").toLowerCase().includes(query) || (u.email || "").toLowerCase().includes(query));
      renderUsersTable(filtered);
    }, 200)
  );
}

function requestStatusBadge(status) {
  const cls = status === "approved" ? "completed" : status === "rejected" ? "cancelled" : "pending";
  const label = status === "approved" ? "Approved" : status === "rejected" ? "Rejected" : "Pending";
  return `<span class="badge badge--status badge--${cls}">${label}</span>`;
}

function renderRequestActionCell(id, isPending) {
  if (!isPending) return "—";
  return `
    <div style="display:flex;gap:6px;flex-wrap:wrap">
      <button type="button" class="btn btn--secondary btn--sm" data-review-approve="${id}">Approve</button>
      <button type="button" class="btn btn--secondary btn--sm" data-review-reject="${id}">Reject</button>
    </div>`;
}

async function loadCancellations(profileById) {
  const body = document.querySelector("[data-admin-cancellations-body]");
  const empty = document.querySelector("[data-admin-cancellations-empty]");
  const { data, error } = await supabase.from("order_cancellations").select("*").order("requested_at", { ascending: false });
  const rows = error ? [] : data || [];

  setText("[data-admin-cancellations-count]", String(rows.filter((r) => r.status === "pending").length));

  if (!body) return;
  const table = body.closest("table");
  if (rows.length === 0) {
    if (table) table.hidden = true;
    if (empty) empty.hidden = false;
    return;
  }
  if (table) table.hidden = false;
  if (empty) empty.hidden = true;

  body.innerHTML = rows
    .map(
      (r) => `<tr data-cancellation-row="${r.id}">
        <td data-label="Order ID">${escapeHtml(r.order_id)}</td>
        <td data-label="Customer">${escapeHtml(profileById.get(r.user_id)?.email || "—")}</td>
        <td data-label="Reason">${escapeHtml(r.reason || "—")}</td>
        <td data-label="Requested">${formatDateTime(r.requested_at)}</td>
        <td data-label="Status">${requestStatusBadge(r.status)}</td>
        <td data-label="Action">${renderRequestActionCell(r.id, r.status === "pending")}</td>
      </tr>`
    )
    .join("");

  body.querySelectorAll("[data-review-approve]").forEach((btn) =>
    btn.addEventListener("click", () => reviewCancellation(btn.dataset.reviewApprove, true))
  );
  body.querySelectorAll("[data-review-reject]").forEach((btn) =>
    btn.addEventListener("click", () => reviewCancellation(btn.dataset.reviewReject, false))
  );
}

async function reviewCancellation(requestId, approve) {
  let note = "";
  if (!approve) {
    note = window.prompt("Optional reason for rejecting this cancellation request:") || "";
  }
  const { error } = await supabase.rpc("review_cancellation_request", { p_request_id: requestId, p_approve: approve, p_admin_note: note });
  if (error) {
    alert(error.message || "Something went wrong. Please try again.");
    return;
  }
  await initAdminPage();
}

async function loadRefunds(profileById) {
  const body = document.querySelector("[data-admin-refunds-body]");
  const empty = document.querySelector("[data-admin-refunds-empty]");
  const { data, error } = await supabase.from("refund_requests").select("*").order("requested_at", { ascending: false });
  const rows = error ? [] : data || [];

  setText("[data-admin-refunds-count]", String(rows.filter((r) => r.status === "pending").length));

  if (!body) return;
  const table = body.closest("table");
  if (rows.length === 0) {
    if (table) table.hidden = true;
    if (empty) empty.hidden = false;
    return;
  }
  if (table) table.hidden = false;
  if (empty) empty.hidden = true;

  body.innerHTML = rows
    .map(
      (r) => `<tr data-refund-row="${r.id}">
        <td data-label="Order ID">${escapeHtml(r.order_id)}</td>
        <td data-label="Customer">${escapeHtml(profileById.get(r.user_id)?.email || "—")}</td>
        <td data-label="Amount">${formatCurrency(Number(r.amount))}</td>
        <td data-label="Reason">${escapeHtml(r.reason || "—")}</td>
        <td data-label="Requested">${formatDateTime(r.requested_at)}</td>
        <td data-label="Status">${requestStatusBadge(r.status)}</td>
        <td data-label="Action">${renderRequestActionCell(r.id, r.status === "pending")}</td>
      </tr>`
    )
    .join("");

  body.querySelectorAll("[data-review-approve]").forEach((btn) =>
    btn.addEventListener("click", () => reviewRefund(btn.dataset.reviewApprove, true))
  );
  body.querySelectorAll("[data-review-reject]").forEach((btn) =>
    btn.addEventListener("click", () => reviewRefund(btn.dataset.reviewReject, false))
  );
}

async function reviewRefund(requestId, approve) {
  let note = "";
  if (!approve) {
    note = window.prompt("Optional reason for rejecting this refund request:") || "";
  }
  const { error } = await supabase.rpc("review_refund_request", { p_request_id: requestId, p_approve: approve, p_admin_note: note });
  if (error) {
    alert(error.message || "Something went wrong. Please try again.");
    return;
  }
  await initAdminPage();
}

const PROVIDER_NAME = "Delix Gains";

function fmtDateTimeOrDash(iso) {
  return iso ? formatDateTime(iso) : "—";
}

async function invokeProvider(action, extra = {}) {
  const { data, error } = await supabase.functions.invoke("delix-provider", { body: { action, ...extra } });

  // Every expected outcome (success or handled failure) now comes back as
  // HTTP 200 with { ok, ... } — see the Edge Function's router comment for
  // why. So `error` here should only ever fire for a genuine network-level
  // failure: function not deployed, wrong name, CORS blocked, DNS/fetch
  // failure. Surface real diagnostic detail for that case instead of a
  // single generic string, since that's exactly the class of failure that
  // needs a human to actually look at devtools.
  if (error) {
    console.error("[provider] network-level invoke failure:", error);
    const detail = error?.message || error?.name || "no further detail available";
    throw new Error(
      `Could not reach the provider function (${detail}). Check that "delix-provider" is deployed under that exact name, and check the browser Network tab / Supabase Edge Function logs for more.`
    );
  }

  if (!data?.ok) {
    throw new Error(data?.error || "The provider function returned an unexpected response.");
  }

  return data;
}

function setProviderMessage(text, isError = false) {
  const el = document.querySelector("[data-provider-message]");
  if (!el) return;
  el.textContent = text || "";
  el.style.color = isError ? "var(--color-error)" : "";
}

async function loadProviderMappings() {
  const body = document.querySelector("[data-provider-mappings-body]");
  const empty = document.querySelector("[data-provider-mappings-empty]");
  if (!body) return;

  const { data: provider } = await supabase.from("providers").select("id, active").eq("name", PROVIDER_NAME).single();
  if (!provider) {
    setProviderMessage(`No "${PROVIDER_NAME}" provider row found — run migration_delix_provider.sql.`, true);
    return;
  }

  const { data: mappings } = await supabase
    .from("provider_services")
    .select("*, services(name)")
    .eq("provider_id", provider.id)
    .not("service_id", "is", null)
    .order("last_provider_sync", { ascending: false });

  const rows = mappings || [];
  const table = body.closest("table");
  if (rows.length === 0) {
    if (table) table.hidden = true;
    if (empty) empty.hidden = false;
    return;
  }
  if (table) table.hidden = false;
  if (empty) empty.hidden = true;

  body.innerHTML = rows
    .map((m) => {
      const syncBadge =
        m.provider_sync_ok === true
          ? `<span class="badge badge--status badge--completed">OK</span>`
          : m.provider_sync_ok === false
            ? `<span class="badge badge--status badge--cancelled">Not found on provider</span>`
            : `<span class="badge badge--status badge--pending">Not yet synced</span>`;
      return `<tr>
        <td data-label="BTECH Service">${escapeHtml(m.services?.name || m.service_id)}</td>
        <td data-label="Delix Service ID">${escapeHtml(m.provider_service_ref)}</td>
        <td data-label="Provider Name">${escapeHtml(m.provider_name || "—")}</td>
        <td data-label="Rate (USD)">${m.provider_rate != null ? "$" + Number(m.provider_rate).toFixed(2) : "—"}</td>
        <td data-label="Refill / Cancel">${m.provider_refill ? "✓" : "✕"} / ${m.provider_cancel ? "✓" : "✕"}</td>
        <td data-label="Status">${syncBadge}</td>
        <td data-label="Last Synced">${fmtDateTimeOrDash(m.last_provider_sync)}</td>
        <td data-label="">
          <div style="display:flex;gap:6px">
            <button type="button" class="btn btn--secondary btn--sm" data-edit-mapping="${m.id}" data-current-ref="${escapeHtml(m.provider_service_ref)}">Edit</button>
            <button type="button" class="btn btn--secondary btn--sm" data-unmap="${m.id}">Unmap</button>
          </div>
        </td>
      </tr>`;
    })
    .join("");

  body.querySelectorAll("[data-edit-mapping]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const next = window.prompt("New Delix service ID for this mapping:", btn.dataset.currentRef);
      if (!next || next.trim() === "" || next.trim() === btn.dataset.currentRef) return;
      try {
        await invokeProvider("update-mapping", { mapping_id: btn.dataset.editMapping, provider_service_ref: next.trim() });
        await Promise.all([loadProviderMappings(), loadProviderCatalogue()]);
        setProviderMessage("Mapping updated. Click Sync Services to pull its live rate/details.");
      } catch (err) {
        setProviderMessage(err.message, true);
      }
    })
  );

  body.querySelectorAll("[data-unmap]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      if (!confirm("Unmap this BTECH service from Delix Gains? The catalogue entry itself is kept, just unlinked.")) return;
      try {
        await invokeProvider("unmap-service", { mapping_id: btn.dataset.unmap });
        await Promise.all([loadProviderMappings(), loadProviderCatalogue()]);
      } catch (err) {
        setProviderMessage(err.message, true);
      }
    })
  );
}

function populateMapServiceSelect(services) {
  const select = document.querySelector("#map-service-select");
  if (!select) return;
  select.innerHTML = services.map((s) => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join("");
}

const CONNECTION_STATUS_LABEL = {
  connected: "Connected",
  unavailable: "Provider unavailable",
  invalid_credentials: "Invalid provider credentials",
  timeout: "Timed out",
  config_missing: "Configuration missing",
};

function renderProviderStatus(result) {
  const label = result.connected ? "Connected" : CONNECTION_STATUS_LABEL[result.status] || "Failed";
  setText("[data-provider-connection]", label);
  setText("[data-provider-services-status]", result.servicesOk ? `Retrieved (${result.servicesCount})` : "Failed");
  setText("[data-provider-balance-value]", result.balance ? `${Number(result.balance.balance).toFixed(2)} ${result.balance.currency}` : "—");
  setText("[data-provider-checked-at]", fmtDateTimeOrDash(result.checkedAt));
  if (result.error) setProviderMessage(result.error, true);
  else setProviderMessage("");
}

async function loadProviderStoredStatus() {
  const { data } = await supabase.from("site_settings").select("value, updated_at").eq("key", "delix_connection_status").single();
  if (data?.value) {
    renderProviderStatus({ ...data.value, checkedAt: data.value.checked_at || data.updated_at });
  }
}

const CATALOGUE_PAGE_SIZE = 20;
let _cataloguePage = 0;
let _catalogueSearch = "";

async function loadProviderCatalogue() {
  const body = document.querySelector("[data-provider-catalogue-body]");
  const empty = document.querySelector("[data-provider-catalogue-empty]");
  const pageLabel = document.querySelector("[data-catalogue-page-label]");
  if (!body) return;

  const { data: provider } = await supabase.from("providers").select("id").eq("name", PROVIDER_NAME).single();
  if (!provider) return;

  let query = supabase
    .from("provider_services")
    .select("*, services(name)", { count: "exact" })
    .eq("provider_id", provider.id);

  if (_catalogueSearch.trim()) {
    const q = _catalogueSearch.trim();
    query = query.or(`provider_name.ilike.%${q}%,provider_category.ilike.%${q}%,provider_service_ref.ilike.%${q}%`);
  }

  const from = _cataloguePage * CATALOGUE_PAGE_SIZE;
  const to = from + CATALOGUE_PAGE_SIZE - 1;
  const { data: rows, count, error } = await query.order("provider_name", { ascending: true }).range(from, to);

  const table = body.closest("table");
  if (error || !rows || rows.length === 0) {
    if (table) table.hidden = true;
    if (empty) {
      empty.hidden = false;
      empty.querySelector("p").textContent = _catalogueSearch.trim()
        ? "No catalogue services match your search."
        : "No provider catalogue yet — click Sync Services to import it from Delix.";
    }
    if (pageLabel) pageLabel.textContent = "";
    return;
  }
  if (table) table.hidden = false;
  if (empty) empty.hidden = true;

  body.innerHTML = rows
    .map((r) => {
      const mappedLabel = r.services?.name
        ? `<span class="badge badge--status badge--completed">${escapeHtml(r.services.name)}</span>`
        : `<span class="badge badge--status badge--pending">Not mapped</span>`;
      const availLabel = r.provider_sync_ok === false ? `<span class="badge badge--status badge--cancelled">Unavailable</span>` : "";
      return `<tr>
        <td data-label="Delix ID">${escapeHtml(r.provider_service_ref)}</td>
        <td data-label="Name"><span class="truncate">${escapeHtml(r.provider_name || "—")}</span></td>
        <td data-label="Category"><span class="truncate">${escapeHtml(r.provider_category || "—")}</span></td>
        <td data-label="Rate (USD)">${r.provider_rate != null ? "$" + Number(r.provider_rate).toFixed(2) : "—"}</td>
        <td data-label="Min–Max">${r.provider_min ?? "—"}–${r.provider_max ?? "—"}</td>
        <td data-label="Mapped">${mappedLabel} ${availLabel}</td>
        <td data-label="">${r.service_id
          ? ""
          : `<button type="button" class="btn btn--secondary btn--sm" data-catalogue-map="${r.provider_service_ref}">Map…</button>`
        }</td>
      </tr>`;
    })
    .join("");

  const totalPages = Math.max(1, Math.ceil((count || 0) / CATALOGUE_PAGE_SIZE));
  if (pageLabel) pageLabel.textContent = `Page ${_cataloguePage + 1} of ${totalPages} (${count} total)`;
  document.querySelector("[data-catalogue-prev]")?.toggleAttribute("disabled", _cataloguePage === 0);
  document.querySelector("[data-catalogue-next]")?.toggleAttribute("disabled", _cataloguePage + 1 >= totalPages);

  body.querySelectorAll("[data-catalogue-map]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const select = document.querySelector("#map-service-select");
      const btechServiceId = select?.value;
      if (!btechServiceId) {
        setProviderMessage("Choose a BTECH service in the Map Service form below first, then click Map… again.", true);
        return;
      }
      try {
        await invokeProvider("map-service", { service_id: btechServiceId, provider_service_ref: btn.dataset.catalogueMap });
        setProviderMessage("Mapped.");
        await Promise.all([loadProviderMappings(), loadProviderCatalogue()]);
      } catch (err) {
        setProviderMessage(err.message, true);
      }
    })
  );
}

function initProviderCatalogueControls() {
  const searchInput = document.querySelector("[data-catalogue-search]");
  searchInput?.addEventListener(
    "input",
    debounce(() => {
      _catalogueSearch = searchInput.value;
      _cataloguePage = 0;
      loadProviderCatalogue();
    }, 250)
  );
  document.querySelector("[data-catalogue-prev]")?.addEventListener("click", () => {
    if (_cataloguePage > 0) {
      _cataloguePage--;
      loadProviderCatalogue();
    }
  });
  document.querySelector("[data-catalogue-next]")?.addEventListener("click", () => {
    _cataloguePage++;
    loadProviderCatalogue();
  });
}

function initProviderSection(services) {
  populateMapServiceSelect(services);
  loadProviderMappings();
  loadProviderStoredStatus();
  loadProviderCatalogue();
  initProviderCatalogueControls();

  document.querySelector("[data-provider-test]")?.addEventListener("click", async (e) => {
    setButtonLoading(e.currentTarget, true, "Testing…");
    setProviderMessage("");
    try {
      const result = await invokeProvider("test-connection");
      renderProviderStatus(result);
    } catch (err) {
      setProviderMessage(err.message, true);
    }
    setButtonLoading(e.currentTarget, false);
  });

  document.querySelector("[data-provider-balance]")?.addEventListener("click", async (e) => {
    setButtonLoading(e.currentTarget, true, "Checking…");
    setProviderMessage("");
    try {
      const { balance, checkedAt } = await invokeProvider("check-balance");
      setText("[data-provider-balance-value]", `${Number(balance.balance).toFixed(2)} ${balance.currency}`);
      setText("[data-provider-checked-at]", fmtDateTimeOrDash(checkedAt));
    } catch (err) {
      setProviderMessage(err.message, true);
    }
    setButtonLoading(e.currentTarget, false);
  });

  document.querySelector("[data-provider-sync]")?.addEventListener("click", async (e) => {
    setButtonLoading(e.currentTarget, true, "Syncing…");
    setProviderMessage("");
    try {
      const result = await invokeProvider("sync-services");
      setProviderMessage(
        `Received ${result.received} service(s) from Delix — ${result.created} new, ${result.updated} updated, ${result.unchanged} unchanged, ` +
        `${result.unavailable} no longer offered${result.failed ? `, ${result.failed} failed to save` : ""}.`
      );
      await loadProviderMappings();
      await loadProviderCatalogue();
    } catch (err) {
      setProviderMessage(err.message, true);
    }
    setButtonLoading(e.currentTarget, false);
  });

  document.querySelector("[data-provider-map-form]")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const submitBtn = form.querySelector("[type=submit]");
    const service_id = form.querySelector("#map-service-select").value;
    const provider_service_ref = form.querySelector("#map-provider-ref").value.trim();
    if (!provider_service_ref) {
      setProviderMessage("Type a Delix service ID, or use \"Map…\" directly from the catalogue table above.", true);
      return;
    }
    setButtonLoading(submitBtn, true, "Mapping…");
    setProviderMessage("");
    try {
      await invokeProvider("map-service", { service_id, provider_service_ref });
      form.reset();
      await Promise.all([loadProviderMappings(), loadProviderCatalogue()]);
      setProviderMessage("Mapped. Click Sync Services to pull its live rate/details.");
    } catch (err) {
      setProviderMessage(err.message, true);
    }
    setButtonLoading(submitBtn, false);
  });
}

export async function initAdminPage() {
  const user = AuthService.getCurrentUser();
  if (!user || user.role !== "admin") {
    renderRestricted();
    return;
  }

  await ServicesService.preload();
  const services = ServicesService.list();

  const [{ data: orders }, { data: tickets }, { data: profiles, error: profilesError }] = await Promise.all([
    supabase.from("orders").select("*").order("created_at", { ascending: false }),
    supabase.from("support_tickets").select("*").eq("status", "open"),
    supabase.from("profiles").select("*").order("created_at", { ascending: false }),
  ]);

  const orderList = orders || [];
  // Revenue only counts orders that have actually been paid for. Until
  // M-Pesa (Phase 5) is connected, every order is created with
  // payment_status = 'unpaid', so this will correctly read KSh 0 rather
  // than inventing revenue out of unpaid orders.
  const revenue = orderList.filter((o) => o.payment_status === "paid").reduce((sum, o) => sum + Number(o.amount), 0);
  const pending = orderList.filter((o) => o.status === "pending").length;
  const completed = orderList.filter((o) => o.status === "completed").length;

  _users = profiles || [];
  const profileById = new Map(_users.map((p) => [p.id, p]));

  setText("[data-admin-users]", String(_users.length));
  setText("[data-admin-orders]", String(orderList.length));
  setText("[data-admin-revenue]", formatCurrency(revenue));
  setText("[data-admin-pending]", String(pending));
  setText("[data-admin-completed]", String(completed));
  setText("[data-admin-services]", String(services.length));
  setText("[data-admin-tickets]", String((tickets || []).length));

  const errorBox = document.querySelector("[data-admin-users-error]");
  if (profilesError) {
    console.error("Unable to load users:", profilesError.message || profilesError);
    document.querySelector("[data-admin-users-body]")?.closest("table")?.setAttribute("hidden", "");
    document.querySelector("[data-admin-users-empty]")?.setAttribute("hidden", "");
    if (errorBox) errorBox.hidden = false;
  } else {
    if (errorBox) errorBox.hidden = true;
    renderUsersTable(_users);
    initUsersSearch();
  }

  initAdminDashboard({ orders: orderList, profiles: _users }).catch((err) => console.error("Admin dashboard analytics failed:", err));

  await Promise.all([loadCancellations(profileById), loadRefunds(profileById)]);
  initProviderSection(services);

  const ordersBody = document.querySelector("[data-admin-orders-body]");
  if (ordersBody) {
    ordersBody.innerHTML = orderList
      .slice(0, 8)
      .map((o) => {
        const service = services.find((s) => s.id === o.service_id);
        const paymentStatus = o.payment_status || "unpaid";
        const paymentCls = paymentStatus === "paid" ? "completed" : paymentStatus === "refunded" ? "cancelled" : "pending";
        const cust = profileById.get(o.user_id);
        return `<tr>
          <td data-label="Order ID">${o.id}</td>
          <td data-label="Customer">${escapeHtml(cust?.name || cust?.email || "—")}</td>
          <td data-label="Service">${escapeHtml(service?.name || "—")}</td>
          <td data-label="Amount">${formatCurrency(Number(o.amount))}</td>
          <td data-label="Payment"><span class="badge badge--status badge--${paymentCls}">${PAYMENT_LABEL[paymentStatus] || paymentStatus}</span></td>
          <td data-label="Status"><span class="badge badge--status badge--${o.status}">${STATUS_LABEL[o.status]}</span></td>
          <td data-label="Provider">${o.provider_status ? `<span class="badge">${escapeHtml(o.provider_status)}</span>` : "—"}</td>
          <td data-label="Date">${formatDateTime(o.created_at)}</td>
        </tr>`;
      })
      .join("");
  }

  await initServicesManagement();
  await initLoyaltyAdmin().catch((err) => console.error("Loyalty admin failed to load:", err));
}

let _adminServices = [];
let _adminServicesSearch = "";

async function loadAdminServices() {
  const { data, error } = await supabase
    .from("services")
    .select("*, provider_services(provider_rate, provider_currency, provider_name, provider_service_ref)")
    .order("display_order", { ascending: true })
    .order("name", { ascending: true });
  if (error) {
    console.error("Unable to load services for admin:", error.message || error);
    return [];
  }
  return data || [];
}

function renderAdminServicesTable() {
  const body = document.querySelector("[data-admin-services-body]");
  const empty = document.querySelector("[data-admin-services-empty]");
  if (!body) return;

  const q = _adminServicesSearch.trim().toLowerCase();
  const filtered = !q ? _adminServices : _adminServices.filter((s) => s.name.toLowerCase().includes(q) || s.category.toLowerCase().includes(q) || s.platform.toLowerCase().includes(q));

  const table = body.closest("table");
  if (filtered.length === 0) {
    if (table) table.hidden = true;
    if (empty) empty.hidden = false;
    return;
  }
  if (table) table.hidden = false;
  if (empty) empty.hidden = true;

  body.innerHTML = filtered
    .map((s) => {
      const mapping = Array.isArray(s.provider_services) ? s.provider_services[0] : s.provider_services;
      const providerLabel = mapping
        ? `${escapeHtml(mapping.provider_name || "Delix #" + mapping.provider_service_ref)}`
        : `<span class="muted">Not mapped</span>`;
      const providerCost = mapping?.provider_rate != null ? `$${Number(mapping.provider_rate).toFixed(2)}` : "—";
      return `<tr data-service-row="${s.id}">
        <td data-label="Service">
          <div style="display:flex;align-items:center;gap:6px">
            <span class="platform-tag platform-tag--${s.platform}">${ServicesData.platformIcon(s.platform)}${ServicesData.platformLabel(s.platform)}</span>
          </div>
          <div style="margin-top:4px;font-weight:600">${escapeHtml(s.name)}</div>
        </td>
        <td data-label="Provider mapping">${providerLabel}</td>
        <td data-label="Provider cost">${providerCost}</td>
        <td data-label="BTECH price">${formatCurrency(s.price_per_1000)}</td>
        <td data-label="Margin">—</td>
        <td data-label="Min–Max">${formatNumber(s.min_quantity)}–${formatNumber(s.max_quantity)}</td>
        <td data-label="Active">${s.active ? `<span class="badge badge--completed">Yes</span>` : `<span class="badge badge--cancelled">No</span>`}</td>
        <td data-label="Visible">${s.visible ? `<span class="badge badge--completed">Yes</span>` : `<span class="badge badge--cancelled">No</span>`}</td>
        <td data-label=""><button type="button" class="btn btn--secondary btn--sm" data-edit-service="${s.id}">Edit</button></td>
      </tr>`;
    })
    .join("");

  body.querySelectorAll("[data-edit-service]").forEach((btn) =>
    btn.addEventListener("click", () => openServiceModal(_adminServices.find((s) => s.id === btn.dataset.editService)))
  );
}

function populateServiceSelectOptions() {
  const platformList = document.querySelector("#svc-platform-options");
  const categoryList = document.querySelector("#svc-category-options");
  // Suggest both the original known set AND whatever platforms/categories
  // are actually in use right now — so admin can pick an existing one for
  // consistency, or freely type a brand-new one (e.g. "Comments", "Live
  // Views", "Spotify") with zero code change, per the brief's explicit
  // "don't hard-code the hierarchy" requirement.
  const knownPlatforms = new Set(ServicesData.PLATFORMS.map((p) => p.id));
  const knownCategories = new Set(ServicesData.CATEGORIES.map((c) => c.id));
  _adminServices.forEach((s) => {
    knownPlatforms.add(s.platform);
    knownCategories.add(s.category);
  });
  if (platformList) platformList.innerHTML = Array.from(knownPlatforms).map((p) => `<option value="${escapeHtml(p)}">`).join("");
  if (categoryList) categoryList.innerHTML = Array.from(knownCategories).map((c) => `<option value="${escapeHtml(c)}">`).join("");
}

function openServiceModal(service) {
  const modal = document.querySelector("[data-service-modal]");
  const form = document.querySelector("[data-service-form]");
  const title = document.querySelector("[data-service-modal-title]");
  if (!modal || !form) return;
  form.reset();
  form.querySelector("[data-form-error]").textContent = "";

  if (service) {
    title.textContent = "Edit Service";
    form.querySelector("[name=id]").value = service.id;
    form.querySelector("[name=name]").value = service.name;
    form.querySelector("[name=description]").value = service.description || "";
    form.querySelector("[name=platform]").value = service.platform;
    form.querySelector("[name=category]").value = service.category;
    form.querySelector("[name=price_per_1000]").value = service.price_per_1000;
    form.querySelector("[name=display_order]").value = service.display_order ?? 0;
    form.querySelector("[name=min_quantity]").value = service.min_quantity;
    form.querySelector("[name=max_quantity]").value = service.max_quantity;
    form.querySelector("[name=active]").checked = !!service.active;
    form.querySelector("[name=visible]").checked = !!service.visible;
    form.querySelector("[name=featured]").checked = !!service.featured;
    form.querySelector("[name=refill_enabled]").checked = !!service.refill_enabled;
    form.querySelector("[name=cancel_enabled]").checked = !!service.cancel_enabled;
  } else {
    title.textContent = "Add Service";
    form.querySelector("[name=id]").value = "";
  }
  modal.hidden = false;
}

async function initServicesManagement() {
  _adminServices = await loadAdminServices();
  populateServiceSelectOptions();
  renderAdminServicesTable();

  document.querySelector("[data-admin-services-search]")?.addEventListener(
    "input",
    debounce((e) => {
      _adminServicesSearch = e.target.value;
      renderAdminServicesTable();
    }, 200)
  );

  const modal = document.querySelector("[data-service-modal]");
  document.querySelector("[data-add-service]")?.addEventListener("click", () => openServiceModal(null));
  document.querySelectorAll("[data-service-modal-close]").forEach((b) => b.addEventListener("click", () => (modal.hidden = true)));

  document.querySelector("[data-service-form]")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const errorBox = form.querySelector("[data-form-error]");
    const submitBtn = form.querySelector("[type=submit]");
    errorBox.textContent = "";

    const id = form.querySelector("[name=id]").value;
    const name = form.querySelector("[name=name]").value.trim();
    const price = Number(form.querySelector("[name=price_per_1000]").value);
    const min = Number(form.querySelector("[name=min_quantity]").value);
    const max = Number(form.querySelector("[name=max_quantity]").value);

    if (name.length < 2) return void (errorBox.textContent = "Please enter a service name.");
    if (!Number.isFinite(price) || price <= 0) return void (errorBox.textContent = "Price must be a positive number.");
    if (!Number.isFinite(min) || min <= 0) return void (errorBox.textContent = "Minimum quantity must be a positive number.");
    if (!Number.isFinite(max) || max < min) return void (errorBox.textContent = "Maximum quantity must be greater than or equal to the minimum.");

    const payload = {
      name,
      description: form.querySelector("[name=description]").value.trim(),
      platform: form.querySelector("[name=platform]").value,
      category: form.querySelector("[name=category]").value,
      price_per_1000: price,
      min_quantity: min,
      max_quantity: max,
      display_order: Number(form.querySelector("[name=display_order]").value) || 0,
      active: form.querySelector("[name=active]").checked,
      visible: form.querySelector("[name=visible]").checked,
      featured: form.querySelector("[name=featured]").checked,
      refill_enabled: form.querySelector("[name=refill_enabled]").checked,
      cancel_enabled: form.querySelector("[name=cancel_enabled]").checked,
    };

    setButtonLoading(submitBtn, true, "Saving…");
    // Client-side checks above are for a fast/clear message only — the
    // actual enforcement is the services_price_positive / services_min_positive
    // / services_max_gte_min CHECK constraints in Postgres and the
    // services_write_admin RLS policy, both of which apply no matter how
    // this request is made.
    const { error } = id
      ? await supabase.from("services").update(payload).eq("id", id)
      : await supabase.from("services").insert({ id: generateId("svc"), ...payload });
    setButtonLoading(submitBtn, false);

    if (error) {
      errorBox.textContent = friendlyError("generic");
      console.error("Service save failed:", error);
      return;
    }

    modal.hidden = true;
    _adminServices = await loadAdminServices();
    populateServiceSelectOptions();
    renderAdminServicesTable();
    showToast(id ? "Service updated." : "Service created.", "success");
  });
}