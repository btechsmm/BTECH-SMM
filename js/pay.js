/**
 * BTECH SMM — /pay page controller
 * ----------------------------------------------------------------
 * Presentation only. It starts nothing by itself: a payment begins only when the customer presses the button, through the
 * shared payment card (js/mpesa-card.js -> tuma-payments Edge Function). The page never marks anything paid and never trusts
 * the URL: ?order= is only used to LOOK UP the customer's own order (RLS) and show its server-side amount; ?payment= only
 * re-attaches to an existing payment's server-side status (own payments only).
 *
 * Supported: wallet deposits, and orders (paid from the wallet; a short wallet is topped up through the same card).
 * Direct per-order provider charges are not part of the existing architecture and are not offered here.
 */
import { supabase } from "./supabase.js";
import { AuthService } from "./auth.js";
import { formatCurrency, escapeHtml, formatDateTime } from "./utils.js";
import { fetchWalletBalance, computeWalletState } from "./wallet-pay.js";
import { openMpesaTopUp, resumePayment } from "./mpesa-card.js";

const STATUS_LABEL = {
  paid: ["Paid", "completed"], failed: ["Failed", "cancelled"], cancelled: ["Cancelled", "cancelled"], expired: ["Not confirmed", "pending"],
  pending: ["Awaiting confirmation", "processing"], processing: ["Awaiting confirmation", "processing"],
};
const OPEN = new Set(["pending", "processing"]);
const refOf = (id) => "BTS-" + String(id).slice(0, 8).toUpperCase();
const userId = () => AuthService.getCurrentUser()?.id;

async function minDeposit() {
  try {
    const { data } = await supabase.functions.invoke("tuma-payments", { body: { action: "config" } });
    if (data?.ok && Number(data.min_deposit) >= 1) return Math.floor(Number(data.min_deposit));
  } catch { /* the server enforces the real limit regardless */ }
  return 10;
}

function updateBalance(balance) {
  document.querySelectorAll("[data-wallet-balance]").forEach((el) => { el.textContent = balance === null ? "unavailable" : formatCurrency(balance); });
}

async function renderDeposit() {
  const form = document.querySelector("[data-pay-deposit-form]");
  const input = form.querySelector("[name=amount]");
  const err = form.querySelector("[data-pay-deposit-error]");
  const min = await minDeposit();
  input.min = String(min);
  form.querySelector("[data-pay-min-hint]").textContent = `Minimum ${formatCurrency(min)}, whole shillings only.`;
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const n = Number(input.value);
    if (!Number.isInteger(n) || n < min) { err.textContent = `Enter a whole amount of at least ${formatCurrency(min)}.`; return; }
    err.textContent = "";
    openMpesaTopUp({ amount: n, minAmount: min });
  });
  window.addEventListener("btech:wallet-updated", async () => { updateBalance(await fetchWalletBalance()); renderRecent(); });
}

async function renderOrder(box) {
  const params = new URLSearchParams(window.location.search);
  const orderId = params.get("order");
  if (orderId) {
    const { data: order } = await supabase.from("orders").select("id, amount, status, payment_status").eq("id", orderId).eq("user_id", userId()).maybeSingle();
    if (!order) { box.innerHTML = `<p class="muted">We couldn't find that order on your account.</p><a class="btn btn--secondary btn--block" href="orders">View my orders</a>`; return; }
    const here = `order-details?id=${encodeURIComponent(order.id)}`;
    if (order.payment_status === "paid") { box.innerHTML = `<p>Order <strong>${escapeHtml(order.id)}</strong> is already paid.</p><a class="btn btn--primary btn--block" href="${here}">View order</a>`; return; }
    if (order.payment_status !== "unpaid" || order.status === "cancelled") { box.innerHTML = `<p class="muted">This order can't be paid.</p><a class="btn btn--secondary btn--block" href="${here}">View order</a>`; return; }
    const state = computeWalletState(order.amount, await fetchWalletBalance());
    box.innerHTML = `<dl class="wallet-panel__rows">
        <div class="wallet-panel__row"><dt>Order</dt><dd>${escapeHtml(order.id)}</dd></div>
        <div class="wallet-panel__row"><dt>Order total</dt><dd>${formatCurrency(order.amount)}</dd></div>
        <div class="wallet-panel__row"><dt>Wallet balance</dt><dd>${state.unknown ? "unavailable" : formatCurrency(state.balance)}</dd></div></dl>
      <p class="muted" style="margin:var(--sp-3) 0">Orders are paid from your wallet balance. ${state.sufficient ? "Your balance covers this order." : state.unknown ? "" : `You need ${formatCurrency(Math.ceil(state.shortage))} more.`}</p>
      ${state.sufficient || state.unknown ? `<a class="btn btn--primary btn--block" href="${here}">Pay ${formatCurrency(order.amount)} from wallet</a>`
        : `<button type="button" class="btn btn--primary btn--block" data-pay-topup>Add ${formatCurrency(Math.ceil(state.shortage))} to wallet</button>`}`;
    box.querySelector("[data-pay-topup]")?.addEventListener("click", () => {
      const shortage = Math.ceil(state.shortage);
      openMpesaTopUp({ amount: shortage, minAmount: shortage, shortage, doneLabel: "Continue to order", onPaid: () => { window.location.href = here; } });
    });
    return;
  }
  const { data: orders } = await supabase.from("orders").select("id, amount, created_at").eq("user_id", userId()).eq("payment_status", "unpaid").neq("status", "cancelled").order("created_at", { ascending: false }).limit(5);
  box.innerHTML = orders?.length
    ? `<ul class="pay-order-list">${orders.map((o) => `<li><span><strong>${escapeHtml(o.id)}</strong> · ${formatCurrency(o.amount)}</span><a class="btn btn--secondary btn--sm" href="pay?order=${encodeURIComponent(o.id)}">Pay</a></li>`).join("")}</ul>`
    : `<p class="muted">You have no orders waiting for payment.</p><a class="btn btn--secondary btn--block" href="services">Browse services</a>`;
}

async function renderRecent() {
  const box = document.querySelector("[data-pay-recent]");
  const { data, error } = await supabase.from("payments").select("id, amount, status, payment_type, created_at").eq("user_id", userId()).order("created_at", { ascending: false }).limit(5);
  if (error) { box.innerHTML = `<p class="muted">Recent payments couldn't be loaded. Try again shortly.</p>`; return; }
  if (!data?.length) { box.innerHTML = `<p class="muted">No payments yet.</p>`; return; }
  box.innerHTML = `<ul class="pay-recent">${data.map((p) => {
    const [label, cls] = STATUS_LABEL[p.status] || [p.status, "pending"];
    const recent = Date.now() - new Date(p.created_at).getTime() < 24 * 3600 * 1000;
    return `<li><span><strong>${formatCurrency(p.amount)}</strong> · ${p.payment_type === "wallet_deposit" ? "Wallet deposit" : "Order payment"}<small>${escapeHtml(refOf(p.id))} · ${escapeHtml(formatDateTime(p.created_at))}</small></span>
      <span><span class="badge badge--status badge--${cls}">${label}</span> ${OPEN.has(p.status) && recent ? `<button type="button" class="btn btn--secondary btn--sm" data-pay-check="${escapeHtml(p.id)}">Check status</button>` : ""}</span></li>`;
  }).join("")}</ul>`;
  box.querySelectorAll("[data-pay-check]").forEach((b) => b.addEventListener("click", () => resumePayment(b.dataset.payCheck, {})));
}

export async function initPayPage() {
  updateBalance(await fetchWalletBalance());
  await Promise.all([renderDeposit(), renderOrder(document.querySelector("[data-pay-order]")), renderRecent()]);
  const resume = new URLSearchParams(window.location.search).get("payment");
  if (resume && /^[0-9a-f-]{36}$/i.test(resume)) resumePayment(resume, {});   // read-only re-attach; never starts a payment
}
