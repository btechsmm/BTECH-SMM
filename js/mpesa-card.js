/**
 * BTECH SMM — M-Pesa Card
 * ----------------------------------------------------------------
 * The single M-Pesa "Deposit Now" card, used by the Wallet page and by the
 * order pages when the wallet needs topping up. It is ONE card whose content
 * changes as the payment progresses — there is no second payment card:
 *
 *   form        "Deposit Now" — phone number + amount
 *   waiting     "Prompt Initiated" — PIN prompt sent, waiting for confirmation
 *   success     "Payment Received Successfully" — amount, receipt, wallet balance
 *   failed      "Payment Failed" — Try Again
 *   cancelled   "Payment Cancelled" — Try Again
 *   unconfirmed "We couldn't confirm your M-Pesa payment."
 *
 * It reuses the existing payment flow unchanged: the mpesa-daraja Edge
 * Function's `initiate-payment` action starts the STK push, and the card then
 * polls `check-status` (pollPaymentStatus in utils.js). The card NEVER decides
 * that a payment succeeded — "Payment Received" is only shown once the
 * backend reports payments.status = 'paid' (set by Safaricom's callback), and
 * the wallet balance shown afterwards is re-read from the database once the
 * matching wallet-credit transaction is visible.
 */

import { supabase } from "./supabase.js";
import { AuthService } from "./auth.js";
import { formatCurrency, escapeHtml, showToast, pollPaymentStatus } from "./utils.js";
import { fetchWalletBalance } from "./wallet-pay.js";

const LOGO_SRC = "assets/brand/btech-mpesa-logo.svg";
const MIN_AMOUNT = 10;

const ICONS = {
  check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`,
  cross: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>`,
  clock: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`,
  close: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18"/></svg>`,
};

// Card state. `runId` identifies the payment attempt currently being tracked,
// so a stale poll can never overwrite the UI of a newer attempt.
const s = {
  phase: "form", // form | waiting | success | failed | cancelled | unconfirmed
  runId: 0,
  paymentId: null,
  requestedAmount: null,
  paid: null, // { amount, receipt }
  balance: undefined, // undefined = still updating, null = couldn't load
  failureReason: "",
  terminal: false, // unconfirmed because the backend said 'expired' (safe to retry) vs. our own timeout
  options: {},
};

let overlay = null;
let bodyEl = null;
let titleEl = null;
let lastFocus = null;

function ensureOverlay() {
  if (overlay) return;
  overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.hidden = true;
  overlay.setAttribute("data-mpesa-card", "");
  overlay.innerHTML = `
    <div class="modal mpesa-card" role="dialog" aria-modal="true" aria-labelledby="mpesa-card-title" tabindex="-1">
      <div class="modal__head">
        <h3 id="mpesa-card-title" data-mc-title>Deposit Now</h3>
        <button class="icon-btn" type="button" data-mc-close aria-label="Close">${ICONS.close}</button>
      </div>
      <div class="payment-partner-logo mpesa-card__logo"><img src="${LOGO_SRC}" alt="BTECH SMM and M-Pesa" /></div>
      <div data-mc-body aria-live="polite"></div>
    </div>`;
  document.body.appendChild(overlay);
  bodyEl = overlay.querySelector("[data-mc-body]");
  titleEl = overlay.querySelector("[data-mc-title]");

  overlay.addEventListener("click", (e) => {
    if (e.target.closest("[data-mc-close]")) return close();
    if (e.target.closest("[data-mc-retry]")) return resetToForm();
    if (e.target.closest("[data-mc-recheck]")) return recheck();
  });
  overlay.addEventListener("submit", (e) => {
    if (e.target.matches("[data-mc-form]")) {
      e.preventDefault();
      submitForm(e.target);
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && overlay && !overlay.hidden) close();
  });
}

function close() {
  if (!overlay) return;
  overlay.hidden = true;
  // A payment that is still waiting keeps being tracked in the background;
  // the card simply reopens on the waiting state (see openMpesaTopUp).
  if (lastFocus && typeof lastFocus.focus === "function") lastFocus.focus();
}

function isOpen() {
  return !!overlay && !overlay.hidden;
}

function formHtml() {
  const opts = s.options;
  const min = Math.max(MIN_AMOUNT, Math.ceil(Number(opts.minAmount) || 0));
  const amountValue = opts.amount ? Math.max(min, Math.ceil(Number(opts.amount))) : "";
  const phone = escapeHtml(AuthService.getCurrentUser()?.phone || "");
  const lead = opts.shortage
    ? `<p class="mpesa-card__lead">You need <strong>${formatCurrency(opts.shortage)}</strong> more in your wallet to pay for this order. Add funds using M-Pesa.</p>`
    : `<p class="mpesa-card__lead">Add funds to your BTECH SMM wallet using M-Pesa.</p>`;
  return `
    ${lead}
    <form data-mc-form novalidate>
      <p class="form-error" data-mc-error role="alert"></p>
      <div class="form-field">
        <label for="mc-phone">M-Pesa phone number</label>
        <input id="mc-phone" name="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="07XX XXX XXX" value="${phone}" required />
      </div>
      <div class="form-field">
        <label for="mc-amount">Amount (KES)</label>
        <input id="mc-amount" name="amount" type="number" inputmode="numeric" min="${min}" step="1" placeholder="e.g. ${Math.max(min, 1000)}" value="${amountValue}" required />
        ${opts.shortage ? `<span class="form-hint">Minimum ${formatCurrency(min)} to cover this order.</span>` : ""}
      </div>
      <button type="submit" class="btn btn--primary btn--block" data-mc-submit>Send M-Pesa Request</button>
    </form>`;
}

function summaryRows(rows) {
  return `<dl class="wallet-panel__rows">${rows
    .map(([label, value]) => `<div class="wallet-panel__row"><dt>${label}</dt><dd>${value}</dd></div>`)
    .join("")}</dl>`;
}

function render() {
  if (!bodyEl) return;

  if (s.phase === "form") {
    titleEl.textContent = "Deposit Now";
    bodyEl.innerHTML = formHtml();
    return;
  }

  titleEl.textContent = "M-Pesa Payment";

  if (s.phase === "waiting") {
    bodyEl.innerHTML = `
      <span class="badge badge--status badge--processing">Prompt Initiated</span>
      <p class="mpesa-card__lead" style="margin-top:var(--sp-3)">A payment prompt has been sent to your phone number.</p>
      <p class="mpesa-card__lead"><strong>Enter your M-Pesa PIN to complete the transaction.</strong></p>
      <div class="mpesa-card__status" role="status">
        <span class="mpesa-card__spinner" aria-hidden="true"></span>
        <span>Waiting for confirmation…</span>
      </div>
      <p class="form-hint">Amount requested: ${formatCurrency(s.requestedAmount)}. This can take up to a minute. You can close this window — your wallet updates automatically once M-Pesa confirms.</p>`;
    return;
  }

  if (s.phase === "success") {
    const rows = [["Amount", formatCurrency(s.paid.amount)]];
    if (s.paid.receipt) rows.push(["M-Pesa Receipt", escapeHtml(s.paid.receipt)]);
    rows.push(["Wallet Balance", s.balance === undefined ? "Updating…" : s.balance === null ? "—" : formatCurrency(s.balance)]);
    bodyEl.innerHTML = `
      <div class="mpesa-card__result">
        <span class="mpesa-card__icon mpesa-card__icon--success">${ICONS.check}</span>
        <h3>Payment Received Successfully</h3>
        <p>Your M-Pesa payment has been confirmed.</p>
      </div>
      <div class="wallet-panel">${summaryRows(rows)}</div>
      <button type="button" class="btn btn--primary btn--block" data-mc-close>${escapeHtml(s.options.doneLabel || "Done")}</button>`;
    return;
  }

  if (s.phase === "failed") {
    bodyEl.innerHTML = `
      <div class="mpesa-card__result">
        <span class="mpesa-card__icon mpesa-card__icon--error">${ICONS.cross}</span>
        <h3>Payment Failed</h3>
        <p>M-Pesa could not complete this payment.${s.failureReason ? ` (${escapeHtml(s.failureReason)})` : ""} No money was added to your wallet.</p>
      </div>
      <div class="mpesa-card__actions">
        <button type="button" class="btn btn--primary btn--block" data-mc-retry>Try Again</button>
        <button type="button" class="btn btn--secondary btn--block" data-mc-close>Close</button>
      </div>`;
    return;
  }

  if (s.phase === "cancelled") {
    bodyEl.innerHTML = `
      <div class="mpesa-card__result">
        <span class="mpesa-card__icon mpesa-card__icon--warn">${ICONS.cross}</span>
        <h3>Payment Cancelled</h3>
        <p>The payment request was cancelled on your phone. No money was added to your wallet.</p>
      </div>
      <div class="mpesa-card__actions">
        <button type="button" class="btn btn--primary btn--block" data-mc-retry>Try Again</button>
        <button type="button" class="btn btn--secondary btn--block" data-mc-close>Close</button>
      </div>`;
    return;
  }

  // unconfirmed
  bodyEl.innerHTML = `
    <div class="mpesa-card__result">
      <span class="mpesa-card__icon mpesa-card__icon--warn">${ICONS.clock}</span>
      <h3>We couldn't confirm your M-Pesa payment.</h3>
      <p>We haven't received a confirmation from M-Pesa yet. If you did complete the payment, your wallet will be updated automatically once it's confirmed.</p>
    </div>
    <div class="mpesa-card__actions">
      ${s.terminal
      ? `<button type="button" class="btn btn--primary btn--block" data-mc-retry>Try Again</button>`
      : `<button type="button" class="btn btn--primary btn--block" data-mc-recheck>Check Again</button>`}
      <button type="button" class="btn btn--secondary btn--block" data-mc-close>Close</button>
    </div>`;
}

function setPhase(phase) {
  s.phase = phase;
  render();
}

function resetToForm() {
  setPhase("form");
  overlay?.querySelector("input")?.focus();
}

/** Opens the card. If a payment is still being confirmed, reopens on that state instead of starting a second one. */
export function openMpesaTopUp(options = {}) {
  ensureOverlay();
  lastFocus = document.activeElement;
  if (s.phase !== "waiting") {
    s.options = options;
    s.phase = "form";
  }
  render();
  overlay.hidden = false;
  const focusTarget = overlay.querySelector("input") || overlay.querySelector(".mpesa-card");
  focusTarget?.focus();
}

async function submitForm(form) {
  const submitBtn = form.querySelector("[data-mc-submit]");
  const errorBox = form.querySelector("[data-mc-error]");
  errorBox.textContent = "";
  if (submitBtn.disabled) return;

  const phone = form.querySelector("[name=phone]").value.trim();
  const amount = Number(form.querySelector("[name=amount]").value);
  const min = Math.max(MIN_AMOUNT, Math.ceil(Number(s.options.minAmount) || 0));

  if (!phone) {
    errorBox.textContent = "Please enter your M-Pesa phone number.";
    return;
  }
  if (!Number.isFinite(amount) || amount < min) {
    errorBox.textContent = `Please enter an amount of at least ${formatCurrency(min)}.`;
    return;
  }

  submitBtn.disabled = true;
  submitBtn.textContent = "Sending request…";

  const { data, error } = await supabase.functions.invoke("mpesa-daraja", {
    body: { action: "initiate-payment", payment_type: "wallet_deposit", amount, phone },
  });

  if (error || !data?.ok) {
    submitBtn.disabled = false;
    submitBtn.textContent = "Send M-Pesa Request";
    errorBox.textContent = data?.error || "Could not reach M-Pesa. Please try again.";
    return;
  }

  // STK push accepted — this only means the prompt reached the phone. Nothing
  // is credited and nothing is marked paid until the backend says so.
  const runId = ++s.runId;
  s.paymentId = data.payment_id;
  s.requestedAmount = Math.round(amount);
  setPhase("waiting");
  track(runId, s.options, await pollPaymentStatus(supabase, data.payment_id));
}

async function recheck() {
  const runId = ++s.runId;
  const opts = s.options;
  setPhase("waiting");
  track(runId, opts, await pollPaymentStatus(supabase, s.paymentId, { timeoutMs: 45000 }));
}

/** Waits for the wallet-credit transaction linked to this payment, then reads the balance. */
async function waitForWalletCredit(paymentId) {
  for (let i = 0; i < 15; i++) {
    const { data } = await supabase.from("transactions").select("id").eq("payment_id", paymentId).maybeSingle();
    if (data) return { credited: true, balance: await fetchWalletBalance() };
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return { credited: false, balance: await fetchWalletBalance() };
}

async function track(runId, opts, result) {
  if (runId !== s.runId) return; // a newer attempt owns the card now

  if (result.status === "paid") {
    const paymentId = s.paymentId;
    const paid = { amount: Number(result.amount) || s.requestedAmount, receipt: result.mpesa_receipt_number || "" };
    s.paid = paid;
    s.balance = undefined;
    setPhase("success");
    if (!isOpen()) showToast("M-Pesa payment received.", "success", 4000);

    // The payment row flips to 'paid' a moment before the wallet-credit RPC
    // runs in the same callback, so wait for the credit before reading the
    // balance instead of showing a stale number.
    const { balance } = await waitForWalletCredit(paymentId);
    if (runId === s.runId) {
      s.balance = balance;
      if (s.phase === "success") render();
    }
    window.dispatchEvent(new CustomEvent("btech:wallet-updated"));
    try {
      await opts.onPaid?.({ amount: paid.amount, receipt: paid.receipt, balance, paymentId });
    } catch (err) {
      console.error("mpesa card onPaid callback failed:", err);
    }
    return;
  }

  if (result.status === "cancelled") {
    setPhase("cancelled");
  } else if (result.status === "failed") {
    s.failureReason = result.result_description || "";
    setPhase("failed");
  } else {
    // 'expired' (backend says the request lapsed) or 'timeout' (we stopped
    // polling — the payment may still resolve). Never claims a charge.
    s.terminal = result.status === "expired";
    setPhase("unconfirmed");
  }
  if (!isOpen()) showToast("The M-Pesa payment was not completed.", "info", 4000);
}