/**
 * BTECH SMM — Wallet Order Payment Edge Function
 * ----------------------------------------------------------------
 * Pays for an order from the customer's wallet balance.
 *
 * Deploy (JWT verification stays ON — this is a normal user-facing function,
 * unlike mpesa-daraja which needs --no-verify-jwt for Safaricom's callback):
 *   supabase functions deploy wallet-order-pay
 *
 * No secrets to set. SUPABASE_URL / SUPABASE_ANON_KEY /
 * SUPABASE_SERVICE_ROLE_KEY are injected automatically by Supabase.
 *
 * Actions (invoked as supabase.functions.invoke('wallet-order-pay', {body:{action,...}})):
 *   place-order   { order_id, service_id, target, quantity }
 *                 Creates the order AND pays it from the wallet in one
 *                 database transaction (public.wallet_place_order).
 *   pay-order     { order_id }
 *                 Pays an existing unpaid order from the wallet
 *                 (public.wallet_pay_order).
 *
 * Trust model:
 *   1. The caller's JWT is verified here (auth.getUser) — that verified id,
 *      never anything in the request body, is the only user identity used.
 *   2. The wallet debit itself happens inside the Postgres functions, which
 *      re-read the wallet balance, the authoritative order amount, the order
 *      and payment status, the service and the quantity from the database
 *      under row locks. The browser's idea of the balance/price is ignored.
 *   3. Those Postgres functions are executable by service_role only, so the
 *      browser cannot pay an order from the wallet without going through
 *      this function (and therefore without provider fulfilment following).
 *
 * Provider fulfilment: after a wallet payment that actually took money
 * (newly_paid = true) this calls the existing delix-provider `create-order`
 * action, which itself refuses anything whose payment_status isn't 'paid'.
 * If the provider call fails, the wallet payment is NOT reversed — the order
 * stays paid and awaiting provider submission (an admin can retry it), which
 * is exactly the "payment succeeded, provider failed" state the brief wants.
 * Only the call that really debited the wallet attempts fulfilment, so a
 * double-click / second tab can never submit the same order to Delix twice.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
}

const SAFE_MESSAGES: Record<string, string> = {
  not_authenticated: "Please log in and try again.",
  bad_request: "Invalid request.",
  unavailable: "Wallet payment is temporarily unavailable. Please try again shortly.",
  rejected: "This order could not be paid. Please try again.",
};

class WalletPayError extends Error {
  code: string;
  constructor(code: string, message?: string, detail?: unknown) {
    super(message ?? SAFE_MESSAGES[code] ?? SAFE_MESSAGES.unavailable);
    this.code = code;
    if (detail !== undefined) console.error(`[wallet-order-pay] ${code}:`, detail);
  }
}

function serviceRoleClient() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
}

async function requireUser(req: Request) {
  const authHeader = req.headers.get("Authorization") ?? "";
  const caller = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authHeader } } });
  const { data, error } = await caller.auth.getUser();
  if (error || !data?.user) throw new WalletPayError("not_authenticated", undefined, error);
  return data.user;
}

/**
 * The SQL functions raise plain exceptions (SQLSTATE P0001) whose text is
 * written to be shown to customers ("Your wallet balance is not enough…").
 * Anything else — constraint violations, connection errors — is an internal
 * detail and is replaced with a generic message.
 */
function mapRpcError(error: { code?: string; message?: string; hint?: string }): WalletPayError {
  if (error.code === "P0001" && error.message) {
    const code = error.hint === "insufficient_balance" ? "insufficient_balance" : "rejected";
    return new WalletPayError(code, error.message);
  }
  return new WalletPayError("unavailable", undefined, error);
}

type RpcResult = {
  order: { id: string; amount: number; status: string; payment_status: string; provider_order_id: string | null };
  balance: number;
  newly_paid: boolean;
};

async function attemptProviderFulfillment(orderId: string): Promise<"submitted" | "queued"> {
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/delix-provider`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "create-order", order_id: orderId }),
    });
    const data = await res.json().catch(() => null);
    if (data?.ok) return "submitted";
    // Deliberately does NOT touch the order's payment_status: the customer's
    // wallet payment already succeeded and stays successful.
    console.error("[wallet-order-pay] provider fulfilment failed for order", orderId, data?.code ?? "no response");
  } catch (err) {
    console.error("[wallet-order-pay] provider fulfilment request errored for order", orderId, err);
  }
  return "queued";
}

async function finish(result: RpcResult) {
  let fulfilment: "submitted" | "queued" | "skipped" = "skipped";
  if (result.newly_paid && !result.order.provider_order_id) {
    fulfilment = await attemptProviderFulfillment(result.order.id);
  }
  return {
    // Only fields the customer UI needs — no provider details.
    order: {
      id: result.order.id,
      amount: Number(result.order.amount),
      status: result.order.status,
      payment_status: result.order.payment_status,
    },
    balance: Number(result.balance),
    newlyPaid: result.newly_paid,
    fulfilment,
  };
}

async function handlePlaceOrder(req: Request, body: any) {
  const user = await requireUser(req);
  const { order_id, service_id, target, quantity } = body ?? {};
  if (
    typeof order_id !== "string" || !order_id.trim() || order_id.length > 80 ||
    typeof service_id !== "string" || !service_id.trim() ||
    typeof target !== "string" || !target.trim() || target.length > 2048 ||
    !Number.isInteger(quantity)
  ) {
    throw new WalletPayError("bad_request");
  }

  const { data, error } = await serviceRoleClient().rpc("wallet_place_order", {
    p_user_id: user.id,
    p_order_id: order_id.trim(),
    p_service_id: service_id,
    p_target: target,
    p_quantity: quantity,
  });
  if (error) throw mapRpcError(error);
  return await finish(data as RpcResult);
}

async function handlePayOrder(req: Request, body: any) {
  const user = await requireUser(req);
  const orderId = body?.order_id;
  if (typeof orderId !== "string" || !orderId.trim() || orderId.length > 80) throw new WalletPayError("bad_request");

  const { data, error } = await serviceRoleClient().rpc("wallet_pay_order", {
    p_user_id: user.id,
    p_order_id: orderId.trim(),
  });
  if (error) throw mapRpcError(error);
  return await finish(data as RpcResult);
}

// Every response is HTTP 200 with an { ok, ... } envelope (same convention as
// delix-provider and mpesa-daraja) so the frontend never has to dig a message
// out of a non-2xx supabase-js error object.
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    const body = await req.json().catch(() => ({}));
    switch (body.action) {
      case "place-order":
        return jsonResponse({ ok: true, ...(await handlePlaceOrder(req, body)) });
      case "pay-order":
        return jsonResponse({ ok: true, ...(await handlePayOrder(req, body)) });
      default:
        return jsonResponse({ ok: false, error: SAFE_MESSAGES.bad_request, code: "bad_request" });
    }
  } catch (err) {
    if (err instanceof WalletPayError) return jsonResponse({ ok: false, error: err.message, code: err.code });
    console.error("[wallet-order-pay] unexpected error:", err);
    return jsonResponse({ ok: false, error: SAFE_MESSAGES.unavailable, code: "unavailable" });
  }
});
