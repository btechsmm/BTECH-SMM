/**
 * BTECH SMM — Delivery Progress Helper
 * ----------------------------------------------------------------
 * Calls delix-provider's customer-facing `track-status` action for a
 * single order. The server re-checks ownership and rate-limits itself
 * (see supabase/functions/delix-provider/index.ts) — this module only
 * shapes the request/response for the UI.
 */

import { supabase } from "./supabase.js";

/**
 * Fetches (or forces a refresh of) delivery progress for one order.
 * Always resolves — never throws — with either the tracking payload or
 * { ok: false, error }.
 */
export async function fetchOrderProgress(orderId, { force = false } = {}) {
  try {
    const { data, error } = await supabase.functions.invoke("delix-provider", {
      body: { action: "track-status", order_id: orderId, force },
    });
    if (data?.ok) return { ok: true, ...data };
    return { ok: false, error: data?.error || (error ? "Could not reach the tracking service. Please try again." : "Something went wrong. Please try again.") };
  } catch {
    return { ok: false, error: "Could not reach the tracking service. Please check your connection and try again." };
  }
}
