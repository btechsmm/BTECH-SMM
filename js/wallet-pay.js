/**
 * BTECH SMM — Wallet Pay Helpers
 * ----------------------------------------------------------------
 * Shared by the order form (service-order.html), the order page
 * (order-details.html) and the M-Pesa card.
 *
 * Everything here that involves money is DISPLAY ONLY:
 *  - fetchWalletBalance() reads the wallet row (RLS-scoped to the signed-in
 *    user) so the UI can show a current balance.
 *  - computeWalletState() decides which message/button to show.
 * The actual decision — is there enough money, what does the order cost,
 * may this order be paid — is made again by the database inside
 * wallet_place_order()/wallet_pay_order() (via the wallet-order-pay Edge
 * Function). If the numbers here are stale or tampered with, the worst
 * outcome is that the server rejects the request.
 */

import { supabase } from "./supabase.js";
import { AuthService } from "./auth.js";
import { formatCurrency } from "./utils.js";

/** Current wallet balance as a number, or null if it couldn't be loaded. */
export async function fetchWalletBalance() {
  const user = AuthService.getCurrentUser();
  if (!user) return null;
  const { data, error } = await supabase.from("wallets").select("balance").eq("user_id", user.id).maybeSingle();
  if (error || !data) return null;
  return Number(data.balance);
}

/** Pure display maths: is the wallet enough, what remains, what is missing. */
export function computeWalletState(total, balance) {
  const t = Number(total) || 0;
  if (balance === null || balance === undefined || Number.isNaN(Number(balance))) {
    return { total: t, balance: null, unknown: true, sufficient: false, remaining: 0, shortage: 0 };
  }
  const b = Number(balance);
  const sufficient = t > 0 && b >= t;
  return {
    total: t,
    balance: b,
    unknown: false,
    sufficient,
    remaining: sufficient ? b - t : 0,
    shortage: sufficient ? 0 : Math.max(0, t - b),
  };
}

function row(label, value, modifier = "") {
  return `<div class="wallet-panel__row ${modifier}"><dt>${label}</dt><dd>${value}</dd></div>`;
}

/**
 * Order Total / Wallet Balance / (Remaining | Amount Needed) panel.
 *  - sufficient   -> "Wallet balance is sufficient" + remaining balance
 *  - insufficient -> shortage, explanation and a Top Up Wallet button
 *  - unknown      -> couldn't load the balance, with a retry button
 * `payButtonHtml` (optional) is rendered under the panel when the wallet
 * is sufficient — used on the order page, where the action lives inside the
 * panel. On the order form the submit button plays that role instead.
 */
export function walletSummaryHtml(state, { payButtonHtml = "" } = {}) {
  const rows = [row("Order Total", formatCurrency(state.total), "wallet-panel__row--total")];

  if (state.unknown) {
    rows.push(row("Wallet Balance", "Unavailable"));
    return `
    <div class="wallet-panel">
      <dl class="wallet-panel__rows">${rows.join("")}</dl>
      <p class="wallet-panel__note wallet-panel__note--warn">We couldn't load your wallet balance right now.</p>
      <button type="button" class="btn btn--secondary btn--block" data-wallet-retry>Try again</button>
    </div>`;
  }

  rows.push(row("Wallet Balance", formatCurrency(state.balance)));

  if (state.sufficient) {
    rows.push(row("Remaining Balance", formatCurrency(state.remaining), "wallet-panel__row--remaining"));
    return `
    <div class="wallet-panel">
      <dl class="wallet-panel__rows">${rows.join("")}</dl>
      <p class="wallet-panel__note wallet-panel__note--ok">
        <span class="wallet-panel__icon" aria-hidden="true">✓</span>
        <span><strong>Wallet balance is sufficient.</strong><br />Your wallet will be used to pay for this order.</span>
      </p>
      ${payButtonHtml}
    </div>`;
  }

  rows.push(row("Amount Needed", formatCurrency(state.shortage), "wallet-panel__row--need"));
  return `
  <div class="wallet-panel">
    <dl class="wallet-panel__rows">${rows.join("")}</dl>
    <p class="wallet-panel__note wallet-panel__note--warn">
      <span class="wallet-panel__icon" aria-hidden="true">!</span>
      <span><strong>Your wallet balance is not enough to complete this order.</strong><br />Add <strong>${formatCurrency(state.shortage)}</strong> to your wallet, then place the order.</span>
    </p>
    <button type="button" class="btn btn--primary btn--block" data-topup-open>Top Up Wallet</button>
  </div>`;
}

/**
 * Calls the wallet-order-pay Edge Function.
 *   { action: "place-order", order_id, service_id, target, quantity }
 *   { action: "pay-order", order_id }
 * Always resolves to { ok, ... }. code === "network" means the request may
 * or may not have reached the server, so callers should retry with the SAME
 * order id (the server treats a repeat of an already-paid order as a no-op).
 */
export async function invokeWalletPay(body) {
  try {
    const { data, error } = await supabase.functions.invoke("wallet-order-pay", { body });
    if (data && typeof data === "object") {
      if (data.ok) window.dispatchEvent(new CustomEvent("btech:wallet-updated"));
      return data;
    }
    return { ok: false, code: "network", error: error ? "Could not reach the payment service. Please try again." : "Something went wrong. Please try again." };
  } catch {
    return { ok: false, code: "network", error: "Could not reach the payment service. Please check your connection and try again." };
  }
}