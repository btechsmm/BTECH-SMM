/**
 * BTECH SMM — Orders Module (Supabase — Phase 2A, wallet-first payment)
 * ----------------------------------------------------------------
 * Orders are paid from the customer's wallet.
 *
 *  - Placing an order (service-order.html): the page shows the order total
 *    and the CURRENT wallet balance. If the wallet covers the total, the
 *    order is created and paid in one atomic step; if not, the customer
 *    tops up through the existing M-Pesa card, then places the order.
 *  - An existing unpaid order (order-details.html) is paid the same way.
 *
 * Both paths go through the wallet-order-pay Edge Function, which calls the
 * wallet_place_order()/wallet_pay_order() Postgres functions (see
 * supabase/migration_wallet_order_payment.sql). Those re-check the balance,
 * the authoritative order amount, ownership, order/payment status, service
 * and quantity under row locks. Everything this file shows about balances
 * and totals is display only — the server never trusts it.
 *
 * Wallet top-ups use the existing mpesa-daraja flow via js/mpesa-card.js;
 * an order is never marked paid because an STK push was merely accepted.
 */

import { supabase } from "./supabase.js";
import { findService, ServicesService, ServicesData } from "./services.js";
import { formatCurrency, formatNumber, formatDateTime, timeAgo, isValidUrl, generateId, escapeHtml, showToast, setButtonLoading, friendlyError, debounce } from "./utils.js";
import { fetchWalletBalance, computeWalletState, walletSummaryHtml, invokeWalletPay } from "./wallet-pay.js";
import { openMpesaTopUp } from "./mpesa-card.js";
import { fetchOrderProgress } from "./order-progress.js";

const STATUS_LABEL = { pending: "Pending", processing: "Processing", completed: "Completed", cancelled: "Cancelled" };
const PAYMENT_LABEL = { unpaid: "Awaiting payment", paid: "Paid", refunded: "Refunded" };

function mapOrderRow(row) {
  return {
    id: row.id,
    serviceId: row.service_id,
    target: row.target,
    quantity: row.quantity,
    amount: Number(row.amount),
    listAmount: row.list_amount != null ? Number(row.list_amount) : null,
    discountAmount: Number(row.loyalty_discount_amount || 0),
    discountPercent: Number(row.loyalty_discount_percent || 0),
    status: row.status,
    paymentStatus: row.payment_status || "unpaid",
    progress: row.progress,
    providerSubmitted: !!row.provider_order_id,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function calculateTotal(quantity, pricePer1000, unit) {
  if (unit) return pricePer1000 * quantity;
  return Math.round((quantity / 1000) * pricePer1000);
}

const LIFECYCLE_STEPS = ["pending", "processing", "completed"];

/** The pending -> processing -> completed lifecycle stepper. Kept as its own function so a status refresh (see initOrderProgressPanel) can redraw it without re-rendering the whole page. */
function stepTrackerHtml(status, progress) {
  const currentIndex = status === "cancelled" ? -1 : LIFECYCLE_STEPS.indexOf(status);
  return `
    <div class="progress-track" role="img" aria-label="Order progress: ${progress}%">
      ${LIFECYCLE_STEPS
      .map(
        (s, i) => `
        <div class="progress-track__step ${i <= currentIndex ? "progress-track__step--done" : ""}">
          <span class="progress-track__dot"></span>
          <span class="progress-track__label">${STATUS_LABEL[s]}</span>
        </div>`
      )
      .join('<span class="progress-track__line"></span>')}
    </div>`;
}

function statusBadge(status) {
  return `<span class="badge badge--status badge--${status}">${STATUS_LABEL[status] || status}</span>`;
}

function paymentBadge(paymentStatus) {
  const cls = paymentStatus === "paid" ? "badge--completed" : paymentStatus === "refunded" ? "badge--cancelled" : "badge--pending";
  return `<span class="badge badge--status ${cls}">${PAYMENT_LABEL[paymentStatus] || paymentStatus}</span>`;
}

/* -------------------- service-order.html -------------------- */
export async function initOrderForm() {
  const form = document.querySelector("[data-order-form]");
  if (!form) return;

  await ServicesService.preload();
  const params = new URLSearchParams(window.location.search);
  const service = findService(params.get("service"));

  const infoBox = document.querySelector("[data-service-info]");
  if (ServicesService.hasError()) {
    infoBox.innerHTML = `<div class="empty-state"><p>Unable to load this service right now. Please try again shortly.</p><a class="btn btn--primary" href="services">Browse services</a></div>`;
    form.hidden = true;
    return;
  }
  if (!service) {
    infoBox.innerHTML = `<div class="empty-state"><p>We couldn't find that service.</p><a class="btn btn--primary" href="services">Browse services</a></div>`;
    form.hidden = true;
    return;
  }

  const unit = service.unit ? service.unit : "1,000";
  infoBox.innerHTML = `
    <span class="platform-tag platform-tag--${service.platform}">${ServicesData.platformIcon(service.platform)}${ServicesData.platformLabel(service.platform)}</span>
    <h2>${escapeHtml(service.name)}</h2>
    <p class="muted">${escapeHtml(service.description)}</p>
    <dl class="service-card__meta">
      <div><dt>Price</dt><dd>${formatCurrency(service.pricePer1000)} / ${unit}</dd></div>
      <div><dt>Min – Max</dt><dd>${formatNumber(service.min)} – ${formatNumber(service.max)}</dd></div>
    </dl>`;

  const quantityInput = form.querySelector("[name=quantity]");
  const urlInput = form.querySelector("[name=target]");
  const submitBtn = form.querySelector("[data-order-submit]") || form.querySelector("[type=submit]");
  const errorBox = form.querySelector("[data-form-error]");
  const panel = form.querySelector("[data-wallet-panel]");
  quantityInput.min = service.min;
  quantityInput.max = service.max;
  quantityInput.value = service.min;
  quantityInput.placeholder = `Between ${formatNumber(service.min)} and ${formatNumber(service.max)}`;

  // Display-only state. The server re-checks everything when the order is placed.
  let walletBalance = null;
  let walletLoaded = false;
  let submitting = false;
  // One id per placement attempt, reused if the request is retried after a
  // network failure so the server can recognise a repeat and never charge twice.
  let attemptId = null;

  // Display-only loyalty quote from the database (quote_my_order). The charged
  // price is decided server-side when the order is created; if the quote
  // function isn't available, this stays null and the normal price is shown.
  let quote = null;

  function currentTotal() {
    const qty = Number(quantityInput.value) || 0;
    if (quote && quote.quantity === qty) return Number(quote.final_amount);
    return calculateTotal(qty, service.pricePer1000, service.unit);
  }

  function renderBreakdown() {
    const totalEl = form.querySelector("[data-total-price]");
    if (totalEl) totalEl.textContent = formatCurrency(currentTotal());
    const box = form.querySelector("[data-loyalty-breakdown]");
    if (!box) return;
    const q = quote && quote.quantity === (Number(quantityInput.value) || 0) ? quote : null;
    if (q && Number(q.discount_amount) > 0) {
      box.innerHTML = `<div class="wallet-panel" style="margin-bottom:var(--sp-4)"><dl class="wallet-panel__rows">
        <div class="wallet-panel__row"><dt>Service Price</dt><dd>${formatCurrency(q.list_amount)}</dd></div>
        <div class="wallet-panel__row"><dt>Loyalty Discount (${Number(q.discount_percent)}%)</dt><dd>-${formatCurrency(q.discount_amount)}</dd></div>
        <div class="wallet-panel__row wallet-panel__row--total"><dt>Final Price</dt><dd>${formatCurrency(q.final_amount)}</dd></div>
      </dl></div>`;
    } else if (q && q.eligible === false && Number(q.member_discount_percent) > 0) {
      box.innerHTML = `<p class="form-hint" style="margin-bottom:var(--sp-4)">Loyalty discount unavailable for this service.</p>`;
    } else {
      box.innerHTML = "";
    }
  }

  const refreshQuote = debounce(async () => {
    const qty = Number(quantityInput.value);
    if (!Number.isInteger(qty) || qty < service.min || qty > service.max) {
      quote = null;
      renderWallet();
      return;
    }
    try {
      const { data, error } = await supabase.rpc("quote_my_order", { p_service_id: service.id, p_quantity: qty });
      quote = !error && data && Number.isFinite(Number(data.final_amount)) ? { ...data, quantity: qty } : null;
    } catch {
      quote = null;
    }
    renderWallet();
  }, 250);

  function renderWallet() {
    renderBreakdown();
    const state = computeWalletState(currentTotal(), walletBalance);
    if (panel) {
      panel.innerHTML = walletLoaded ? walletSummaryHtml(state) : `<div class="skeleton" style="height:150px"></div>`;
    }
    if (submitting) return state;
    // The label is rewritten on every render, so drop any label that
    // setButtonLoading() remembered earlier.
    delete submitBtn.dataset.originalText;
    submitBtn.disabled = !state.sufficient;
    submitBtn.textContent = state.sufficient ? `Place Order — ${formatCurrency(state.total)}` : "Place Order";
    return state;
  }

  async function refreshWallet() {
    walletBalance = await fetchWalletBalance();
    walletLoaded = true;
    return renderWallet();
  }

  function openTopUp() {
    const state = computeWalletState(currentTotal(), walletBalance);
    const shortage = Math.ceil(state.shortage);
    openMpesaTopUp({
      amount: shortage || undefined,
      minAmount: shortage || undefined,
      shortage: shortage || undefined,
      doneLabel: "Continue to order",
      onPaid: () => refreshWallet(),
    });
  }

  quantityInput.addEventListener("input", () => {
    attemptId = null;
    renderWallet();
    refreshQuote();
  });
  urlInput.addEventListener("input", () => {
    attemptId = null;
  });
  panel?.addEventListener("click", async (e) => {
    if (e.target.closest("[data-topup-open]")) openTopUp();
    if (e.target.closest("[data-wallet-retry]")) await refreshWallet();
  });
  // Pick up balance changes made elsewhere (a top-up finishing, another tab spending).
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && !submitting) refreshWallet();
  });

  renderWallet();
  refreshQuote();
  await refreshWallet();

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (submitting) return; // double-click / double-Enter guard
    errorBox.textContent = "";

    const target = urlInput.value.trim();
    const quantity = Number(quantityInput.value);

    if (!isValidUrl(target)) {
      errorBox.textContent = "Please enter a valid link to your social media profile, post or video — not a page on this site.";
      return;
    }
    if (!Number.isFinite(quantity) || quantity <= 0) {
      errorBox.textContent = "Quantity must be a positive number.";
      return;
    }
    if (!Number.isInteger(quantity)) {
      errorBox.textContent = "Quantity must be a whole number.";
      return;
    }
    if (quantity < service.min || quantity > service.max) {
      errorBox.textContent = `Quantity must be between ${formatNumber(service.min)} and ${formatNumber(service.max)}.`;
      return;
    }

    // Lock the form BEFORE any await, so a double-click or a second Enter
    // can't start a second request while the first is still in flight.
    submitting = true;
    setButtonLoading(submitBtn, true, "Placing order…");

    // Re-read the balance right before submitting so the UI decision is as
    // fresh as possible. This is still only a convenience: the database makes
    // the real decision atomically under a lock.
    const state = await refreshWallet();
    if (state.unknown || !state.sufficient) {
      submitting = false;
      setButtonLoading(submitBtn, false);
      renderWallet(); // restores the right label / disabled state
      if (state.unknown) {
        errorBox.textContent = "We couldn't load your wallet balance. Please try again.";
      } else {
        errorBox.textContent = "Your wallet balance is not enough to complete this order.";
        openTopUp();
      }
      return;
    }

    attemptId = attemptId || generateId("ORD").toUpperCase();

    const result = await invokeWalletPay({
      action: "place-order",
      order_id: attemptId,
      service_id: service.id,
      target,
      quantity,
    });

    if (!result.ok) {
      submitting = false;
      setButtonLoading(submitBtn, false);
      // Nothing was charged for a rejected request, so a fresh id is safe.
      // After a network failure the outcome is unknown: keep the same id so a
      // retry can never create or charge a second order.
      if (result.code !== "network") attemptId = null;
      errorBox.textContent = result.error || friendlyError("generic");
      await refreshWallet(); // also re-renders the panel and button label
      return;
    }

    // Stay in the loading state (submitting = true) while we navigate away.
    showToast(
      result.fulfilment === "queued"
        ? "Order paid from your wallet. It's queued and will be submitted shortly."
        : "Order placed and paid from your wallet.",
      "success",
      5000
    );
    window.location.href = `order-details?id=${encodeURIComponent(result.order.id)}`;
  });
}

/* -------------------- orders.html -------------------- */
export async function initOrdersList() {
  const tbody = document.querySelector("[data-orders-body]");
  const empty = document.querySelector("[data-orders-empty]");
  const searchInput = document.querySelector("[data-orders-search]");
  const statusFilter = document.querySelector("[data-orders-status-filter]");
  if (!tbody) return;

  await ServicesService.preload();
  const { data, error } = await supabase.from("orders").select("*").order("created_at", { ascending: false });

  if (error || !data || data.length === 0) {
    tbody.closest("table")?.setAttribute("hidden", "");
    if (empty) empty.hidden = false;
    document.querySelector(".filters-bar")?.setAttribute("hidden", "");
    return;
  }

  const orders = data.map(mapOrderRow);

  function renderRows(list) {
    if (list.length === 0) {
      tbody.closest("table").hidden = true;
      if (empty) {
        empty.hidden = false;
        empty.querySelector("h3").textContent = "No orders match your search";
        empty.querySelector("p").textContent = "Try a different search term or clear the status filter.";
      }
      return;
    }
    tbody.closest("table").hidden = false;
    if (empty) empty.hidden = true;

    tbody.innerHTML = list
      .map((o) => {
        const service = findService(o.serviceId);
        return `
        <tr class="order-row" data-href="order-details?id=${o.id}" tabindex="0">
          <td data-label="Order ID"><span class="order-id">${o.id}</span></td>
          <td data-label="Service">${escapeHtml(service?.name || "—")}</td>
          <td data-label="Platform">${service ? ServicesData.platformLabel(service.platform) : "—"}</td>
          <td data-label="Target"><span class="truncate">${escapeHtml(o.target)}</span></td>
          <td data-label="Quantity">${formatNumber(o.quantity)}</td>
          <td data-label="Amount">${formatCurrency(o.amount)}</td>
          <td data-label="Payment">${paymentBadge(o.paymentStatus)}</td>
          <td data-label="Status">${statusBadge(o.status)}</td>
          <td data-label="Date">${formatDateTime(o.createdAt)}</td>
        </tr>`;
      })
      .join("");

    tbody.querySelectorAll(".order-row").forEach((row) => {
      const go = () => (window.location.href = row.dataset.href);
      row.addEventListener("click", go);
      row.addEventListener("keydown", (e) => {
        if (e.key === "Enter") go();
      });
    });
  }

  function applyFilters() {
    const query = (searchInput?.value || "").trim().toLowerCase();
    const status = statusFilter?.value || "";
    const filtered = orders.filter((o) => {
      const matchesQuery = !query || o.id.toLowerCase().includes(query) || o.target.toLowerCase().includes(query);
      const matchesStatus = !status || o.status === status;
      return matchesQuery && matchesStatus;
    });
    renderRows(filtered);
  }

  searchInput?.addEventListener("input", debounce(applyFilters, 200));
  statusFilter?.addEventListener("change", applyFilters);

  renderRows(orders);
}

/* -------------------- order-details.html -------------------- */
export async function initOrderDetails() {
  const container = document.querySelector("[data-order-details]");
  if (!container) return;

  await ServicesService.preload();
  const params = new URLSearchParams(window.location.search);
  const { data, error } = await supabase.from("orders").select("*").eq("id", params.get("id")).single();

  if (error || !data) {
    container.innerHTML = `<div class="empty-state"><p>We couldn't find that order.</p><a class="btn btn--primary" href="orders">Back to orders</a></div>`;
    return;
  }

  const order = mapOrderRow(data);
  const service = findService(order.serviceId);

  const [{ data: cancellations }, { data: refunds }] = await Promise.all([
    supabase.from("order_cancellations").select("*").eq("order_id", order.id).order("requested_at", { ascending: false }).limit(1),
    supabase.from("refund_requests").select("*").eq("order_id", order.id).order("requested_at", { ascending: false }).limit(1),
  ]);
  const latestCancellation = (cancellations || [])[0] || null;
  const latestRefund = (refunds || [])[0] || null;

  const canCancel = ["pending", "processing"].includes(order.status) && latestCancellation?.status !== "pending";
  const canRefund = order.status !== "cancelled" && latestRefund?.status !== "pending";
  // Unpaid orders that are still live can be paid from the wallet. (The
  // database re-checks all of this; this only decides whether to show the panel.)
  const canPay = order.paymentStatus === "unpaid" && ["pending", "processing"].includes(order.status) && latestCancellation?.status !== "pending";
  const showProgress = order.paymentStatus === "paid";

  const REQUEST_STATUS_LABEL = { pending: "Pending review", approved: "Approved", rejected: "Rejected" };

  container.innerHTML = `
    <div class="order-details__head">
      <div>
        <span class="order-id">${order.id}</span>
        <h1>${escapeHtml(service?.name || "Order")}</h1>
      </div>
      <div style="display:flex;gap:var(--sp-2);flex-wrap:wrap" data-status-badges>
        ${statusBadge(order.status)}
        ${paymentBadge(order.paymentStatus)}
      </div>
    </div>
    ${order.paymentStatus === "unpaid"
      ? `<p class="form-hint" style="margin-top:var(--sp-3)">This order is awaiting payment.</p>`
      : ""
    }

    <div data-progress-track>${stepTrackerHtml(order.status, order.progress)}</div>

    <div class="detail-grid">
      <div class="detail-item"><span>Platform</span><strong>${service ? `${ServicesData.platformIcon(service.platform)} ${ServicesData.platformLabel(service.platform)}` : "—"}</strong></div>
      <div class="detail-item"><span>Target URL</span><strong class="truncate">${escapeHtml(order.target)}</strong></div>
      <div class="detail-item"><span>Quantity</span><strong>${formatNumber(order.quantity)}</strong></div>
      ${order.discountAmount > 0 && order.listAmount != null ? `<div class="detail-item"><span>Service price</span><strong>${formatCurrency(order.listAmount)}</strong></div>
      <div class="detail-item"><span>Loyalty discount (${order.discountPercent}%)</span><strong>-${formatCurrency(order.discountAmount)}</strong></div>` : ""}
      <div class="detail-item"><span>${order.discountAmount > 0 ? "Final price" : "Amount"}</span><strong>${formatCurrency(order.amount)}</strong></div>
      <div class="detail-item"><span>Created</span><strong>${formatDateTime(order.createdAt)}</strong></div>
      <div class="detail-item"><span>Last updated</span><strong>${formatDateTime(order.updatedAt)}</strong></div>
    </div>

    <div class="notes-box">
      <h3>Notes</h3>
      <p>${escapeHtml(order.notes || "No notes yet.")}</p>
    </div>

    ${showProgress
      ? `<div class="notes-box" style="margin-top:var(--sp-6)">
      <h3>Delivery Progress</h3>
      <p class="form-error" data-progress-error role="alert"></p>
      <div data-order-progress-panel><div class="skeleton" style="height:110px"></div></div>
    </div>`
      : ""
    }

    ${canPay
      ? `<div class="notes-box" style="margin-top:var(--sp-6)">
      <h3>Pay for this order</h3>
      <p class="form-error" data-wallet-pay-error role="alert"></p>
      <div data-order-wallet-panel></div>
    </div>`
      : ""
    }

    <div class="order-actions" style="display:flex;gap:var(--sp-3);flex-wrap:wrap;margin-top:var(--sp-6)">
      ${order.status === "cancelled"
      ? ""
      : canCancel
        ? `<button type="button" class="btn btn--secondary" data-open-cancel>Cancel Order</button>`
        : latestCancellation
          ? `<span class="form-hint">Cancellation ${REQUEST_STATUS_LABEL[latestCancellation.status].toLowerCase()}${latestCancellation.admin_note ? " — " + escapeHtml(latestCancellation.admin_note) : ""}</span>`
          : ""
    }
      ${canRefund
      ? `<button type="button" class="btn btn--secondary" data-open-refund>Request Refund</button>`
      : latestRefund
        ? `<span class="form-hint">Refund ${REQUEST_STATUS_LABEL[latestRefund.status].toLowerCase()}${latestRefund.admin_note ? " — " + escapeHtml(latestRefund.admin_note) : ""}</span>`
        : ""
    }
    </div>`;

  if (canPay) initOrderWalletPanel(order);
  if (showProgress) initOrderProgressPanel(order);
  wireOrderActionModals(order.id);
}

/**
 * Wallet payment panel for an existing unpaid order. Shows the order total
 * and the current wallet balance; pays from the wallet when it's enough, or
 * offers the M-Pesa top-up card when it isn't. All display — the payment
 * itself is decided by wallet_pay_order() in the database.
 */
function initOrderWalletPanel(order) {
  const panel = document.querySelector("[data-order-wallet-panel]");
  const errorBox = document.querySelector("[data-wallet-pay-error]");
  if (!panel) return;

  let walletBalance = null;
  let loaded = false;
  let paying = false;

  function render() {
    const state = computeWalletState(order.amount, walletBalance);
    const payButtonHtml = `<button type="button" class="btn btn--primary btn--block" data-wallet-pay>Pay ${formatCurrency(order.amount)} from Wallet</button>`;
    panel.innerHTML = loaded ? walletSummaryHtml(state, { payButtonHtml }) : `<div class="skeleton" style="height:150px"></div>`;
    return state;
  }

  async function refresh() {
    walletBalance = await fetchWalletBalance();
    loaded = true;
    return render();
  }

  async function pay() {
    if (paying) return; // double-click guard (the database also guarantees one debit per order)
    paying = true;
    errorBox.textContent = "";
    setButtonLoading(panel.querySelector("[data-wallet-pay]"), true, "Paying…");

    const result = await invokeWalletPay({ action: "pay-order", order_id: order.id });

    if (!result.ok) {
      paying = false;
      errorBox.textContent = result.error || friendlyError("generic");
      await refresh();
      return;
    }
    showToast(
      result.fulfilment === "queued"
        ? "Order paid from your wallet. It's queued and will be submitted shortly."
        : "Order paid from your wallet.",
      "success",
      5000
    );
    window.location.reload();
  }

  panel.addEventListener("click", async (e) => {
    if (e.target.closest("[data-wallet-pay]")) return pay();
    if (e.target.closest("[data-wallet-retry]")) return refresh();
    if (e.target.closest("[data-topup-open]")) {
      const shortage = Math.ceil(computeWalletState(order.amount, walletBalance).shortage);
      openMpesaTopUp({
        amount: shortage || undefined,
        minAmount: shortage || undefined,
        shortage: shortage || undefined,
        doneLabel: "Continue to order",
        onPaid: () => refresh(),
      });
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && !paying) refresh();
  });

  render();
  refresh();
}

const PROGRESS_REFRESH_COOLDOWN_MS = 60000; // matches TRACK_STATUS_MIN_INTERVAL_MS server-side
const PROGRESS_LABEL_TONE = {
  Queued: "pending",
  "In Progress": "processing",
  "Partially Delivered": "processing",
  Completed: "completed",
  "Cancelled by Provider": "cancelled",
  "Delivery Issue": "cancelled",
};

/**
 * Expanded delivery-progress panel for a paid order: friendly status label,
 * a progress bar (units delivered / quantity), and a rate-limited Refresh
 * button. All numbers come from delix-provider's track-status action, which
 * re-checks ownership and enforces the 60s cooldown itself — the countdown
 * shown here is a courtesy so the button doesn't invite a click that would
 * just be answered with cached data.
 */
function initOrderProgressPanel(order) {
  const panel = document.querySelector("[data-order-progress-panel]");
  const errorBox = document.querySelector("[data-progress-error]");
  if (!panel) return;

  let data = null;
  let loading = true;
  let countdownTimer = null;
  let pollTimer = null;

  function secondsUntilNextRefresh() {
    if (!data?.syncedAt) return 0;
    const elapsed = Date.now() - new Date(data.syncedAt).getTime();
    return Math.max(0, Math.ceil((PROGRESS_REFRESH_COOLDOWN_MS - elapsed) / 1000));
  }

  function isTerminal() {
    return data?.orderStatus === "completed" || data?.orderStatus === "cancelled";
  }

  function render() {
    if (loading && !data) {
      panel.innerHTML = `<div class="skeleton" style="height:110px"></div>`;
      return;
    }
    if (!data) {
      panel.innerHTML = `<p class="form-hint">We couldn't load delivery progress right now.</p>
        <button type="button" class="btn btn--secondary btn--sm" data-progress-retry>Try again</button>`;
      return;
    }

    const tone = PROGRESS_LABEL_TONE[data.label] || "pending";
    const wait = secondsUntilNextRefresh();
    const canRefresh = !isTerminal() && wait <= 0 && !loading;

    const countHtml =
      data.submitted && data.remains !== null
        ? `<p class="delivery-progress__count">Delivered <strong>${formatNumber(data.delivered)}</strong> of <strong>${formatNumber(data.quantity)}</strong></p>`
        : data.submitted
          ? `<p class="delivery-progress__count muted">Waiting for the first update from the provider.</p>`
          : `<p class="delivery-progress__count muted">Your order is queued and will be submitted for delivery shortly.</p>`;

    const noteHtml =
      data.label === "Cancelled by Provider"
        ? `<p class="form-hint">This order was cancelled by the delivery provider. Contact support if you have questions.</p>`
        : data.label === "Delivery Issue"
          ? `<p class="form-hint">We're looking into a delivery issue with this order. Our support team has been notified.</p>`
          : "";

    panel.innerHTML = `
      <div class="delivery-progress">
        <div class="delivery-progress__head">
          <span class="badge badge--status badge--${tone}">${escapeHtml(data.label)}</span>
          <span class="delivery-progress__synced muted">${data.syncedAt ? "Updated " + timeAgo(data.syncedAt) : "Not yet checked"}</span>
        </div>
        <div class="delivery-progress__bar" role="progressbar" aria-valuenow="${data.percent}" aria-valuemin="0" aria-valuemax="100" aria-label="Delivery progress: ${data.percent}%">
          <div class="delivery-progress__bar-fill delivery-progress__bar-fill--${tone}" style="width:${data.percent}%"></div>
        </div>
        ${countHtml}
        ${noteHtml}
      </div>
      ${isTerminal()
        ? ""
        : `<button type="button" class="btn btn--secondary btn--sm" data-progress-refresh ${canRefresh ? "" : "disabled"}>
            ${loading ? "Checking…" : canRefresh ? "Refresh Status" : `Refresh available in ${wait}s`}
          </button>`
      }`;
  }

  function startCountdown() {
    clearInterval(countdownTimer);
    if (isTerminal()) return;
    countdownTimer = setInterval(() => {
      if (secondsUntilNextRefresh() <= 0) {
        clearInterval(countdownTimer);
      }
      render();
    }, 1000);
  }

  /** Keeps the header status badge and lifecycle stepper in sync if a refresh moved orders.status, without a full page reload. */
  function patchHeaderIfStatusChanged(newStatus) {
    if (!newStatus || newStatus === order.status) return;
    order.status = newStatus;
    const badges = document.querySelector("[data-status-badges]");
    if (badges) badges.innerHTML = `${statusBadge(order.status)}${paymentBadge(order.paymentStatus)}`;
    const track = document.querySelector("[data-progress-track]");
    if (track) track.innerHTML = stepTrackerHtml(order.status, order.progress);
  }

  async function load({ force = false, silent = false } = {}) {
    if (!silent) {
      loading = true;
      render();
    }
    const result = await fetchOrderProgress(order.id, { force });
    loading = false;
    if (!result.ok) {
      if (!silent) errorBox.textContent = result.error;
      render();
      return;
    }
    errorBox.textContent = "";
    data = result;
    patchHeaderIfStatusChanged(result.orderStatus);
    render();
    startCountdown();
    schedulePoll();
  }

  /** A gentle background check every cooldown period, so the page updates on its own — the server still only performs a live Delix call once the row is actually stale. */
  function schedulePoll() {
    clearTimeout(pollTimer);
    if (isTerminal()) return;
    pollTimer = setTimeout(() => {
      if (!document.hidden) load({ silent: true });
      else schedulePoll();
    }, PROGRESS_REFRESH_COOLDOWN_MS);
  }

  panel.addEventListener("click", (e) => {
    if (e.target.closest("[data-progress-refresh]")) load({ force: true });
    if (e.target.closest("[data-progress-retry]")) load();
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && data && secondsUntilNextRefresh() <= 0 && !isTerminal()) load({ silent: true });
  });

  load();
}

function wireOrderActionModals(orderId) {
  const cancelModal = document.querySelector("[data-cancel-modal]");
  const cancelForm = document.querySelector("[data-cancel-form]");
  document.querySelector("[data-open-cancel]")?.addEventListener("click", () => {
    if (cancelModal) cancelModal.hidden = false;
  });
  document.querySelectorAll("[data-cancel-close]").forEach((b) => b.addEventListener("click", () => (cancelModal.hidden = true)));
  cancelForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const submitBtn = cancelForm.querySelector("[type=submit]");
    const errorBox = cancelForm.querySelector("[data-form-error]");
    errorBox.textContent = "";
    setButtonLoading(submitBtn, true, "Submitting…");
    const reason = cancelForm.querySelector("[name=reason]").value.trim();
    const { error } = await supabase.rpc("request_order_cancellation", { p_order_id: orderId, p_reason: reason });
    setButtonLoading(submitBtn, false);
    if (error) {
      errorBox.textContent = error.message || friendlyError("generic");
      return;
    }
    cancelModal.hidden = true;
    showToast("Cancellation request submitted.", "success");
    window.location.reload();
  });

  const refundModal = document.querySelector("[data-refund-modal]");
  const refundForm = document.querySelector("[data-refund-form]");
  document.querySelector("[data-open-refund]")?.addEventListener("click", () => {
    if (refundModal) refundModal.hidden = false;
  });
  document.querySelectorAll("[data-refund-close]").forEach((b) => b.addEventListener("click", () => (refundModal.hidden = true)));
  refundForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const submitBtn = refundForm.querySelector("[type=submit]");
    const errorBox = refundForm.querySelector("[data-form-error]");
    errorBox.textContent = "";
    const reason = refundForm.querySelector("[name=reason]").value.trim();
    if (reason.length < 5) {
      errorBox.textContent = "Please briefly tell us why you're requesting a refund.";
      return;
    }
    setButtonLoading(submitBtn, true, "Submitting…");
    const { error } = await supabase.rpc("request_order_refund", { p_order_id: orderId, p_reason: reason });
    setButtonLoading(submitBtn, false);
    if (error) {
      errorBox.textContent = error.message || friendlyError("generic");
      return;
    }
    refundModal.hidden = true;
    showToast("Refund request submitted.", "success");
    window.location.reload();
  });
}