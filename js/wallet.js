/**
 * BTECH SMM — Wallet Module (Supabase + M-Pesa Daraja)
 * ----------------------------------------------------------------
 * Reads the wallet row and transaction history that RLS already
 * scopes to the signed-in user. Deposits use the shared M-Pesa card
 * (js/mpesa-card.js), which starts the STK push through the
 * mpesa-daraja Edge Function and waits for the backend to confirm the
 * payment — the wallet is only ever credited server-side
 * (credit_wallet_from_payment(), called from the Safaricom callback);
 * nothing here writes to the balance directly.
 */

import { supabase } from "./supabase.js";
import { formatCurrency, formatDateTime, escapeHtml } from "./utils.js";
import { openMpesaTopUp } from "./mpesa-card.js";
import { renderWalletLoyalty } from "./loyalty.js";

const TYPE_LABEL = { deposit: "Wallet top-up", order: "Order payment", refund: "Refund" };

async function getWallet() {
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return { balance: 0, currency: "KES" };
  const { data: wallet, error: walletError } = await supabase.from("wallets").select("*").eq("user_id", data.user.id).single();
  if (walletError || !wallet) return { balance: 0, currency: "KES" };
  return { balance: Number(wallet.balance), currency: wallet.currency };
}

async function getTransactions() {
  const { data, error } = await supabase.from("transactions").select("*").order("created_at", { ascending: false });
  if (error) return [];
  return data.map((t) => ({ id: t.id, type: t.type, amount: Number(t.amount), status: t.status, date: t.created_at, note: t.note }));
}

async function renderBalance() {
  const wallet = await getWallet();
  document.querySelectorAll("[data-wallet-balance]").forEach((el) => {
    el.textContent = formatCurrency(wallet.balance);
  });
  // Lets navigation.js's top-bar wallet pill refresh itself without this
  // module importing navigation.js directly (avoids a circular import and
  // keeps wallet.js focused on wallet data, not nav UI).
  window.dispatchEvent(new CustomEvent("btech:wallet-updated"));
  return wallet;
}

function txnRowHtml(t) {
  return `
    <div class="txn-row">
      <div class="txn-row__icon txn-row__icon--${t.amount >= 0 ? "in" : "out"}">${t.amount >= 0 ? "+" : "–"}</div>
      <div class="txn-row__body">
        <p class="txn-row__title">${TYPE_LABEL[t.type] || escapeHtml(t.type)}</p>
        <p class="txn-row__note">${escapeHtml(t.note || "")}</p>
        <span class="txn-row__date">${formatDateTime(t.date)}</span>
      </div>
      <div class="txn-row__amount ${t.amount >= 0 ? "txn-row__amount--in" : "txn-row__amount--out"}">
        ${t.amount >= 0 ? "+" : ""}${formatCurrency(t.amount)}
      </div>
    </div>`;
}

// One fetch, one data source. The page shows the same transactions in up to
// three panels: everything, deposits only, and order payments only. A panel
// opts into a subset with data-txn-types="deposit" (empty = all types).
async function renderTransactions() {
  const lists = document.querySelectorAll("[data-transactions-list]");
  if (lists.length === 0) return;
  const txns = await getTransactions();
  lists.forEach((list) => {
    const types = (list.dataset.txnTypes || "").split(",").filter(Boolean);
    const rows = types.length ? txns.filter((t) => types.includes(t.type)) : txns;
    const empty = list.parentElement?.querySelector("[data-transactions-empty]");
    list.hidden = rows.length === 0;
    if (empty) empty.hidden = rows.length !== 0;
    list.innerHTML = rows.map(txnRowHtml).join("");
  });
}

function initDepositForm() {
  document.querySelector("[data-deposit-open]")?.addEventListener("click", () => {
    openMpesaTopUp({
      // Fires once the backend has confirmed the payment as paid.
      onPaid: async () => {
        await renderBalance();
        await renderTransactions();
      },
    });
  });
}

export async function initWalletPage() {
  // Loyalty summary is an add-on: load it alongside, and never let it block or break the wallet.
  renderWalletLoyalty(document.querySelector("[data-wallet-loyalty]")).catch(() => { });
  await renderBalance();
  await renderTransactions();
  initDepositForm();
}

export const WalletService = { getWallet, getTransactions, renderBalance };