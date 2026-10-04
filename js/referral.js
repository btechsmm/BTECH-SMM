/**
 * BTECH SMM — Referral capture
 * ----------------------------------------------------------------
 * Remembers an ambassador's ?ref=CODE long enough to survive registration and
 * email confirmation, then asks the database to attribute the customer.
 *
 * The browser only SUPPLIES a code. claim_referral() decides, in the database,
 * whether it is valid: the ambassador must be approved, the code must exist, it
 * can't be your own, you must be a new account with no orders, and a customer
 * can only ever have one referrer. Nothing stored here confers any commission.
 */

import { supabase } from "./supabase.js";

const KEY = "btechsmm:ref";
const DONE = "btechsmm:ref-done"; // user id whose referral has been settled, so we stop calling the server
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const CODE_RE = /^[A-Za-z0-9_-]{3,24}$/;
// Reasons that will never succeed on retry, so the stored code is dropped.
const FINAL = new Set(["invalid", "self", "already_attributed", "expired", "has_orders"]);

export function captureReferral(search = window.location.search) {
  const code = new URLSearchParams(search).get("ref");
  if (!code || !CODE_RE.test(code)) return null;
  try {
    localStorage.setItem(KEY, JSON.stringify({ code: code.toUpperCase(), at: Date.now() }));
  } catch {
    /* storage unavailable (private mode): the signup metadata path below still works */
  }
  return code.toUpperCase();
}

export function getPendingReferral() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "null");
    if (!raw || !CODE_RE.test(raw.code || "") || Date.now() - raw.at > MAX_AGE_MS) {
      localStorage.removeItem(KEY);
      return null;
    }
    return raw.code;
  } catch {
    return null;
  }
}

function clearPending() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/** Call once the session is known. Safe to call on every page load. */
export async function claimPendingReferral() {
  const { data: sess } = await supabase.auth.getSession();
  const user = sess?.session?.user;
  if (!user) return;
  try {
    if (localStorage.getItem(DONE) === user.id) return;
  } catch {
    /* ignore */
  }

  // Prefer what this browser captured; fall back to the code stored with the account at signup
  // (covers confirming the email on a different device).
  const code = getPendingReferral() || (CODE_RE.test(user.user_metadata?.referral_code || "") ? user.user_metadata.referral_code : null);
  if (!code) return;

  const { data, error } = await supabase.rpc("claim_referral", { p_code: code });
  if (error) return; // transient: keep the code and retry next page load
  if (data?.ok || FINAL.has(data?.reason)) {
    clearPending();
    try {
      localStorage.setItem(DONE, user.id);
    } catch {
      /* ignore */
    }
  }
}
