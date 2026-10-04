/**
 * BTECH SMM — M-Pesa Daraja Edge Function
 * ----------------------------------------------------------------
 * The ONLY place Daraja credentials are ever read. Deploy with:
 *   supabase functions deploy mpesa-daraja --no-verify-jwt
 *
 * IMPORTANT — --no-verify-jwt is REQUIRED for this specific function,
 * unlike delix-provider. Safaricom's callback is a plain server-to-server
 * POST with no Supabase session/JWT at all — if JWT verification is left
 * on (the default), Supabase's own gateway rejects the callback before
 * this code ever runs, and every payment silently gets stuck in
 * "processing" forever. This function does its OWN auth internally for
 * the user-facing actions (requireUser below); it does not rely on the
 * platform-level JWT gate the way admin-only functions can.
 *
 * Secrets to set (supabase secrets set ..., never through chat):
 *   DARAJA_CONSUMER_KEY
 *   DARAJA_CONSUMER_SECRET
 *   DARAJA_SHORTCODE
 *   DARAJA_PASSKEY
 *   DARAJA_ENVIRONMENT   ("sandbox" or "production" — defaults to sandbox)
 * SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY are injected
 * automatically by Supabase.
 *
 * Actions (invoked as supabase.functions.invoke('mpesa-daraja', {body:{action,...}})):
 *   initiate-payment  (any authenticated user)
 *   check-status      (any authenticated user, own payments only)
 * Safaricom's callback is detected by payload shape (Body.stkCallback),
 * not by an `action` field, since Safaricom doesn't know about our
 * convention — it just POSTs its own fixed JSON structure.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const DARAJA_ENVIRONMENT = Deno.env.get("DARAJA_ENVIRONMENT") || "sandbox";
const DARAJA_BASE_URL = DARAJA_ENVIRONMENT === "production" ? "https://api.safaricom.co.ke" : "https://sandbox.safaricom.co.ke";
const CONSUMER_KEY = Deno.env.get("DARAJA_CONSUMER_KEY");
const CONSUMER_SECRET = Deno.env.get("DARAJA_CONSUMER_SECRET");
const SHORTCODE = Deno.env.get("DARAJA_SHORTCODE");
const PASSKEY = Deno.env.get("DARAJA_PASSKEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
}

// Safaricom expects exactly this shape acknowledging receipt — returning
// anything else (or a non-2xx status) makes it retry the callback
// repeatedly. This is intentionally NOT the {ok:...} envelope used for our
// own frontend calls, because this response goes to Safaricom, not to us.
function safaricomAck() {
  return jsonResponse({ ResultCode: 0, ResultDesc: "Accepted" });
}

const SAFE_MESSAGES: Record<string, string> = {
  config_missing: "Payments are not configured yet.",
  unavailable: "M-Pesa is temporarily unavailable. Please try again shortly.",
  invalid_phone: "Please enter a valid Safaricom M-Pesa number (e.g. 07XXXXXXXX).",
  invalid_amount: "Please enter a valid amount (minimum KES 10).",
  bad_request: "Invalid request.",
  already_paid: "This order has already been paid for.",
  payment_in_progress: "A payment is already in progress for this order. Please check your phone, or wait a moment before trying again.",
  stk_failed: "Could not send the M-Pesa payment request. Please try again.",
  not_authenticated: "Please log in and try again.",
};

class PaymentError extends Error {
  code: string;
  constructor(code: keyof typeof SAFE_MESSAGES, detail?: unknown) {
    super(SAFE_MESSAGES[code]);
    this.code = code;
    if (detail !== undefined) console.error(`[mpesa-daraja] ${code}:`, detail);
  }
}

// ---------------------------------------------------------------------------
// Phone normalization — Safaricom numbers only, converted to Daraja's
// required 2547XXXXXXXX / 2541XXXXXXXX format. Rejects anything else rather
// than guessing.
// ---------------------------------------------------------------------------
function normalizePhone(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const p = input.replace(/[\s-]/g, "");
  if (/^0[71]\d{8}$/.test(p)) return "254" + p.slice(1);
  if (/^254[71]\d{8}$/.test(p)) return p;
  if (/^\+254[71]\d{8}$/.test(p)) return p.slice(1);
  return null;
}

function darajaTimestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

async function getAccessToken(): Promise<string> {
  if (!CONSUMER_KEY || !CONSUMER_SECRET || !SHORTCODE || !PASSKEY) throw new PaymentError("config_missing");
  const auth = btoa(`${CONSUMER_KEY}:${CONSUMER_SECRET}`);
  let res: Response;
  try {
    res = await fetch(`${DARAJA_BASE_URL}/oauth/v1/generate?grant_type=client_credentials`, {
      headers: { Authorization: `Basic ${auth}` },
    });
  } catch (err) {
    throw new PaymentError("unavailable", err);
  }
  if (!res.ok) throw new PaymentError("unavailable", await res.text().catch(() => res.status));
  const data = await res.json().catch(() => null);
  if (!data?.access_token) throw new PaymentError("unavailable", data);
  return data.access_token;
}

async function sendStkPush(opts: { phone: string; amount: number; accountRef: string; description: string; callbackUrl: string }) {
  const token = await getAccessToken();
  const timestamp = darajaTimestamp();
  const password = btoa(`${SHORTCODE}${PASSKEY}${timestamp}`);
  const body = {
    BusinessShortCode: SHORTCODE,
    Password: password,
    Timestamp: timestamp,
    TransactionType: "CustomerPayBillOnline",
    Amount: Math.max(1, Math.round(opts.amount)),
    PartyA: opts.phone,
    PartyB: SHORTCODE,
    PhoneNumber: opts.phone,
    CallBackURL: opts.callbackUrl,
    AccountReference: opts.accountRef.slice(0, 12),
    TransactionDesc: opts.description.slice(0, 13),
  };

  let res: Response;
  try {
    res = await fetch(`${DARAJA_BASE_URL}/mpesa/stkpush/v1/processrequest`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new PaymentError("unavailable", err);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || String(data.ResponseCode) !== "0") throw new PaymentError("stk_failed", data);
  return data as { MerchantRequestID: string; CheckoutRequestID: string };
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
function getCallerClient(req: Request) {
  const authHeader = req.headers.get("Authorization") ?? "";
  return createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: authHeader } } });
}

async function requireUser(req: Request) {
  const caller = getCallerClient(req);
  const { data, error } = await caller.auth.getUser();
  if (error || !data?.user) throw new PaymentError("not_authenticated", error);
  return data.user;
}

function serviceRoleClient() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
}

// ---------------------------------------------------------------------------
// initiate-payment
// ---------------------------------------------------------------------------
async function handleInitiate(req: Request, body: any) {
  const user = await requireUser(req);
  const phone = normalizePhone(body.phone);
  if (!phone) throw new PaymentError("invalid_phone");

  const db = serviceRoleClient();
  let amount: number;
  let accountRef: string;
  let description: string;
  let orderIdForRow: string | null = null;

  if (body.payment_type === "order") {
    const orderId = body.order_id;
    if (!orderId) throw new PaymentError("bad_request");
    const { data: order } = await db.from("orders").select("*").eq("id", orderId).eq("user_id", user.id).single();
    if (!order) throw new PaymentError("bad_request", "Order not found");
    if (order.payment_status === "paid") throw new PaymentError("already_paid");

    const { data: pending } = await db
      .from("payments")
      .select("id")
      .eq("order_id", orderId)
      .in("status", ["pending", "processing"])
      .maybeSingle();
    if (pending) throw new PaymentError("payment_in_progress");

    // order.amount was computed and locked in server-side by place_order()
    // at creation time — that snapshot, not the service's current live
    // price, is the authoritative amount for THIS order (an existing order
    // must never change price just because the catalogue price changed
    // since it was placed).
    amount = Number(order.amount);
    accountRef = order.id;
    description = "BTECH SMM Order";
    orderIdForRow = order.id;
  } else if (body.payment_type === "wallet_deposit") {
    const requested = Number(body.amount);
    if (!Number.isFinite(requested) || requested < 10) throw new PaymentError("invalid_amount");
    amount = Math.round(requested);
    accountRef = "BTECH-WALLET";
    description = "Wallet top-up";
  } else {
    throw new PaymentError("bad_request");
  }

  const { data: paymentRow, error: insertError } = await db
    .from("payments")
    .insert({ user_id: user.id, order_id: orderIdForRow, payment_type: body.payment_type, amount, phone_number: phone, status: "pending" })
    .select()
    .single();
  if (insertError) throw new PaymentError("bad_request", insertError);

  const callbackUrl = `${SUPABASE_URL}/functions/v1/mpesa-daraja`;
  console.log("[mpesa-daraja] initiating payment. type:", body.payment_type, "amount:", amount, "phone (masked):", phone.slice(0, 6) + "XXX" + phone.slice(-1), "callbackUrl:", callbackUrl);

  let stk;
  try {
    stk = await sendStkPush({ phone, amount, accountRef, description, callbackUrl });
  } catch (err) {
    await db.from("payments").update({ status: "failed", result_description: "Failed to reach M-Pesa." }).eq("id", paymentRow.id);
    throw err;
  }

  await db
    .from("payments")
    .update({ merchant_request_id: stk.MerchantRequestID, checkout_request_id: stk.CheckoutRequestID, status: "processing", updated_at: new Date().toISOString() })
    .eq("id", paymentRow.id);
  console.log("[mpesa-daraja] STK push accepted. payment_id:", paymentRow.id, "CheckoutRequestID:", stk.CheckoutRequestID);

  return { payment_id: paymentRow.id, checkout_request_id: stk.CheckoutRequestID, status: "processing" };
}

// ---------------------------------------------------------------------------
// check-status
// ---------------------------------------------------------------------------
async function handleCheckStatus(req: Request, body: any) {
  const user = await requireUser(req);
  const db = serviceRoleClient();
  const { data: payment } = await db
    .from("payments")
    .select("id, status, amount, payment_type, order_id, mpesa_receipt_number, result_description")
    .eq("id", body.payment_id)
    .eq("user_id", user.id)
    .single();
  if (!payment) throw new PaymentError("bad_request", "Payment not found");
  return { payment };
}

// ---------------------------------------------------------------------------
// Safaricom callback
// ---------------------------------------------------------------------------
async function attemptProviderFulfillment(orderId: string) {
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/delix-provider`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "create-order", order_id: orderId }),
    });
    const data = await res.json().catch(() => null);
    if (!data?.ok) {
      // Deliberately does NOT touch payment/order payment_status — the
      // customer's money was already received. This is exactly the
      // "payment succeeded, provider submission failed" state the brief
      // requires: order stays paid, awaiting a retry (manual, for now).
      console.error("[mpesa-daraja] provider fulfillment failed for order", orderId, data);
    }
  } catch (err) {
    console.error("[mpesa-daraja] provider fulfillment request errored:", err);
  }
}

async function handleCallback(body: any) {
  const db = serviceRoleClient();
  const cb = body.Body?.stkCallback;
  console.log("[mpesa-daraja] callback received. MerchantRequestID:", cb?.MerchantRequestID, "CheckoutRequestID:", cb?.CheckoutRequestID, "ResultCode:", cb?.ResultCode);
  if (!cb?.CheckoutRequestID) {
    console.error("[mpesa-daraja] malformed callback payload (no CheckoutRequestID found):", JSON.stringify(body));
    return safaricomAck();
  }

  const { data: payment, error: lookupError } = await db.from("payments").select("*").eq("checkout_request_id", cb.CheckoutRequestID).maybeSingle();
  if (lookupError) console.error("[mpesa-daraja] payment lookup errored:", lookupError);
  console.log("[mpesa-daraja] matched payment:", payment?.id ?? "NONE FOUND", "current status:", payment?.status ?? "n/a");
  if (!payment) {
    console.error("[mpesa-daraja] callback for unknown CheckoutRequestID:", cb.CheckoutRequestID);
    return safaricomAck();
  }
  if (payment.status === "paid" || payment.status === "failed" || payment.status === "cancelled") {
    // Already processed — Safaricom callbacks can and do repeat. This is
    // the idempotency check that matters most: a second identical callback
    // must never re-credit a wallet or re-submit a provider order.
    return safaricomAck();
  }

  const resultCode = Number(cb.ResultCode);

  if (resultCode === 0) {
    const items: Array<{ Name: string; Value: unknown }> = cb.CallbackMetadata?.Item || [];
    const get = (name: string) => items.find((i) => i.Name === name)?.Value;
    const receipt = get("MpesaReceiptNumber") as string | undefined;
    const txnDateRaw = String(get("TransactionDate") ?? "");
    let txnDate: string | null = null;
    if (txnDateRaw.length === 14) {
      const y = txnDateRaw.slice(0, 4), mo = txnDateRaw.slice(4, 6), d = txnDateRaw.slice(6, 8);
      const h = txnDateRaw.slice(8, 10), mi = txnDateRaw.slice(10, 12), s = txnDateRaw.slice(12, 14);
      txnDate = `${y}-${mo}-${d}T${h}:${mi}:${s}Z`;
    }

    // .neq("status","paid") is a belt-and-suspenders idempotency guard at
    // the query level itself, on top of the check above and the unique
    // index on transactions.payment_id.
    const { error: updateError, data: updatedRows } = await db
      .from("payments")
      .update({
        status: "paid",
        mpesa_receipt_number: receipt ?? null,
        transaction_date: txnDate,
        result_code: resultCode,
        result_description: cb.ResultDesc ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", payment.id)
      .neq("status", "paid")
      .select();
    if (updateError) console.error("[mpesa-daraja] payments update (paid) failed:", updateError);
    console.log("[mpesa-daraja] payments update (paid) affected rows:", updatedRows?.length ?? 0);

    if (payment.payment_type === "wallet_deposit") {
      const { data: creditResult, error } = await db.rpc("credit_wallet_from_payment", { p_payment_id: payment.id });
      if (error) console.error("[mpesa-daraja] credit_wallet_from_payment failed:", error);
      else console.log("[mpesa-daraja] credit_wallet_from_payment succeeded, transaction id:", creditResult?.id);
    } else if (payment.payment_type === "order" && payment.order_id) {
      const { data: orderResult, error } = await db.rpc("mark_order_paid_from_payment", { p_payment_id: payment.id });
      if (error) console.error("[mpesa-daraja] mark_order_paid_from_payment failed:", error);
      else console.log("[mpesa-daraja] mark_order_paid_from_payment succeeded, order status:", orderResult?.payment_status);
      await attemptProviderFulfillment(payment.order_id);
    }
  } else {
    // 1032 is Safaricom's code for "request cancelled by user" on the STK
    // prompt itself; everything else is treated as a generic failure.
    const status = resultCode === 1032 ? "cancelled" : "failed";
    await db
      .from("payments")
      .update({ status, result_code: resultCode, result_description: cb.ResultDesc ?? null, updated_at: new Date().toISOString() })
      .eq("id", payment.id)
      .neq("status", "paid");
  }

  return safaricomAck();
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    const body = await req.json().catch(() => ({}));
    const isCallback = !!body?.Body?.stkCallback;
    console.log("[mpesa-daraja] request received. method:", req.method, "isCallback:", isCallback, "action:", isCallback ? "(safaricom callback)" : body.action ?? "(none)");

    // Safaricom's own payload shape, detected structurally — it never sends
    // our `action` field.
    if (isCallback) return await handleCallback(body);

    switch (body.action) {
      case "initiate-payment":
        return jsonResponse({ ok: true, ...(await handleInitiate(req, body)) });
      case "check-status":
        return jsonResponse({ ok: true, ...(await handleCheckStatus(req, body)) });
      default:
        return jsonResponse({ ok: false, error: SAFE_MESSAGES.bad_request, code: "bad_request" });
    }
  } catch (err) {
    if (err instanceof PaymentError) return jsonResponse({ ok: false, error: err.message, code: err.code });
    console.error("[mpesa-daraja] unexpected error:", err);
    return jsonResponse({ ok: false, error: SAFE_MESSAGES.unavailable, code: "unavailable" });
  }
});