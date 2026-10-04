/**
 * BTECH SMM — Delix Gains Provider Edge Function
 * ----------------------------------------------------------------
 * This is the ONLY place the Delix API key is ever read or used. It
 * lives in Deno.env (a Supabase Edge Function secret), never in
 * frontend code, never in the database, never returned to a client.
 *
 * Deploy with the Supabase CLI:
 *   supabase functions deploy delix-provider
 *   supabase secrets set DELIX_API_KEY=your-real-key
 *   (optional) supabase secrets set DELIX_API_BASE_URL=https://delixgainske.com/api/v2
 *
 * SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically by
 * Supabase into every Edge Function — nothing to configure for those.
 *
 * Every action below is invoked from the frontend as:
 *   supabase.functions.invoke('delix-provider', { body: { action: '...', ...params } })
 * The caller's session JWT is forwarded automatically by supabase-js, which
 * is how admin-only actions are verified (via the existing public.is_admin()
 * Postgres function — no second role system introduced here).
 *
 * Actions implemented:
 *   test-connection   (admin) — auth + service list + balance, no order created
 *   check-balance     (admin)
 *   sync-services     (admin) — refresh cached metadata for EXISTING mappings only
 *   map-service       (admin) — create a new BTECH service <-> Delix service mapping
 *   unmap-service     (admin) — remove a mapping
 *   create-order      (admin) — see the hard payment_status='paid' gate below;
 *                     nothing in this phase's frontend calls this yet
 *   order-status      (admin)
 *   multiple-status    (admin)
 *   refill            (admin)
 *   cancel-order      (admin)
 *
 * Everything is admin-gated. There is no path from an ordinary customer
 * request to this function that does anything privileged.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const DELIX_BASE_URL = Deno.env.get("DELIX_API_BASE_URL") ?? "https://delixgainske.com/api/v2";
const DELIX_API_KEY = Deno.env.get("DELIX_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS_HEADERS = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200) {
        return new Response(JSON.stringify(body), {
                status,
                headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });
}

/** Safe, generic messages for customers/admins — never raw provider/API detail. */
const SAFE_MESSAGES: Record<string, string> = {
        no_key: "Service provider is not configured yet.",
        unavailable: "Service provider temporarily unavailable. Please try again later.",
        timeout: "Service provider took too long to respond. Please try again later.",
        malformed: "Service provider returned an unexpected response. Please try again later.",
        not_admin: "Admin access required.",
        bad_request: "Invalid request.",
        duplicate: "This order has already been submitted to the provider.",
        not_paid: "This order is not eligible for provider fulfilment yet — payment has not been confirmed.",
        provider_error: "Service provider rejected the request. Please check the order details.",
};

class ProviderError extends Error {
        code: string;
        detail?: unknown;
        constructor(code: keyof typeof SAFE_MESSAGES, detail?: unknown) {
                super(SAFE_MESSAGES[code]);
                this.code = code;
                this.detail = detail;
                if (detail !== undefined) console.error(`[delix-provider] ${code}:`, detail);
        }
}

/**
 * Classifies a caught error into one of the named connection states the
 * admin UI shows. Distinguishing "invalid credentials" from a generic
 * provider error is a best-effort text match on Delix's own error string
 * (SMM-panel APIs like this one return { error: "Invalid API key" } as a
 * 200 JSON body, not a distinct HTTP status) — the raw text is only ever
 * inspected server-side, never returned to the client.
 */
function classifyConnectionError(err: unknown): { status: string; message: string } {
        if (err instanceof ProviderError) {
                if (err.code === "no_key") return { status: "config_missing", message: err.message };
                if (err.code === "timeout") return { status: "timeout", message: err.message };
                if (err.code === "provider_error") {
                        const raw = String(err.detail ?? "").toLowerCase();
                        if (raw.includes("key") || raw.includes("auth") || raw.includes("invalid")) {
                                return { status: "invalid_credentials", message: "Invalid provider credentials." };
                        }
                        return { status: "unavailable", message: err.message };
                }
                return { status: "unavailable", message: err.message };
        }
        return { status: "unavailable", message: SAFE_MESSAGES.unavailable };
}

async function logProviderAction(
        action: string,
        opts: { orderId?: string; providerOrderId?: string; success: boolean; errorCode?: string }
) {
        try {
                const db = serviceRoleClient();
                await db.from("provider_logs").insert({
                        action,
                        order_id: opts.orderId ?? null,
                        provider_order_id: opts.providerOrderId ?? null,
                        success: opts.success,
                        error_code: opts.errorCode ?? null,
                });
        } catch (err) {
                // Logging must never break the actual operation.
                console.error("[delix-provider] failed to write provider_logs:", err);
        }
}

// ---------------------------------------------------------------------------
// Delix API client — the ONLY function that ever touches the network to
// delixgainske.com, and the only place DELIX_API_KEY is read.
// ---------------------------------------------------------------------------
async function delixRequest(params: Record<string, string>): Promise<unknown> {
        if (!DELIX_API_KEY) throw new ProviderError("no_key");

        const url = new URL(DELIX_BASE_URL);
        for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
        url.searchParams.set("key", DELIX_API_KEY);

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);

        let res: Response;
        try {
                res = await fetch(url.toString(), { method: "GET", signal: controller.signal });
        } catch (err) {
                if ((err as Error).name === "AbortError") throw new ProviderError("timeout", err);
                throw new ProviderError("unavailable", err);
        } finally {
                clearTimeout(timeout);
        }

        if (!res.ok) throw new ProviderError("unavailable", `HTTP ${res.status}`);

        let data: unknown;
        const raw = await res.text();
        try {
                data = JSON.parse(raw);
        } catch (err) {
                throw new ProviderError("malformed", { raw, err });
        }

        // Delix (like most SMM-panel APIs) returns { error: "..." } on failure
        // rather than a non-2xx HTTP status.
        if (data && typeof data === "object" && "error" in (data as Record<string, unknown>)) {
                throw new ProviderError("provider_error", (data as Record<string, unknown>).error);
        }

        return data;
}

async function getProviderServices() {
        const data = await delixRequest({ action: "services" });
        if (!Array.isArray(data)) throw new ProviderError("malformed", data);
        return data;
}

async function getProviderBalance() {
        const data = await delixRequest({ action: "balance" });
        if (!data || typeof data !== "object" || !("balance" in (data as Record<string, unknown>))) {
                throw new ProviderError("malformed", data);
        }
        const d = data as { balance: string; currency?: string };
        return { balance: Number(d.balance), currency: d.currency ?? "USD" };
}

async function createProviderOrder(serviceRef: string, link: string, quantity: number) {
        const data = await delixRequest({ action: "add", service: serviceRef, link, quantity: String(quantity) });
        if (!data || typeof data !== "object" || !("order" in (data as Record<string, unknown>))) {
                throw new ProviderError("malformed", data);
        }
        return String((data as { order: unknown }).order);
}

async function getProviderOrderStatus(providerOrderId: string) {
        return await delixRequest({ action: "status", order: providerOrderId });
}

async function getMultipleProviderOrderStatuses(providerOrderIds: string[]) {
        const data = await delixRequest({ action: "status", orders: providerOrderIds.join(",") });
        // Delix returns a map keyed by order id; entries for bad ids come back as
        // { error: "Incorrect order ID" } INSIDE that entry, not as a top-level
        // error — don't let one bad id fail the whole batch.
        return data as Record<string, unknown>;
}

async function requestProviderRefill(providerOrderId: string) {
        const data = await delixRequest({ action: "refill", order: providerOrderId });
        return data;
}

async function cancelProviderOrder(providerOrderId: string) {
        const data = await delixRequest({ action: "cancel", order: providerOrderId });
        return data;
}

// ---------------------------------------------------------------------------
// Provider status -> BTECH status mapping (BTECH's existing lifecycle only —
// no new statuses invented; "Partial" stays under 'processing' with the raw
// provider string preserved separately for anyone who needs the detail).
// ---------------------------------------------------------------------------
function mapProviderStatusToBtech(providerStatus: string): string | null {
        const s = providerStatus.toLowerCase();
        if (s.includes("progress") || s.includes("partial")) return "processing";
        if (s.includes("complet")) return "completed";
        if (s.includes("cancel")) return "cancelled";
        if (s.includes("await") || s.includes("pending")) return "pending";
        // "Fail" and anything unrecognized: don't guess — leave BTECH status
        // untouched and let an admin look at provider_status directly.
        return null;
}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------
function getCallerClient(req: Request) {
        const authHeader = req.headers.get("Authorization") ?? "";
        return createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
                global: { headers: { Authorization: authHeader } },
        });
}

/** Constant-time string comparison so the service-role key can't be probed by timing. */
function safeEqual(a: string, b: string): boolean {
        if (a.length !== b.length) return false;
        let diff = 0;
        for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
        return diff === 0;
}

async function requireAdmin(req: Request) {
        // Trusted internal caller: mpesa-daraja (order paid by M-Pesa) and
        // wallet-order-pay (order paid from the wallet) invoke this function
        // server-to-server with the service-role key as the bearer token.
        // Such a token has no user, so auth.uid() is null and is_admin() below
        // is always false for it — without this branch, provider fulfilment
        // after a customer payment was always rejected as "not_admin".
        // Possessing the service-role key already grants full database
        // access, so accepting it here grants nothing extra. Everything else
        // — including the payment_status = 'paid' gate inside create-order —
        // still applies unchanged.
        const bearer = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
        if (SUPABASE_SERVICE_ROLE_KEY && bearer && safeEqual(bearer, SUPABASE_SERVICE_ROLE_KEY)) {
                return serviceRoleClient();
        }

        const caller = getCallerClient(req);
        const { data, error } = await caller.rpc("is_admin");
        if (error || data !== true) throw new ProviderError("not_admin", error);
        return caller;
}

function serviceRoleClient() {
        return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
}

// ---------------------------------------------------------------------------
// Action handlers
// ---------------------------------------------------------------------------
async function handleTestConnection(req: Request) {
        await requireAdmin(req);
        const db = serviceRoleClient();

        let servicesOk = false;
        let servicesCount = 0;
        let balance: { balance: number; currency: string } | null = null;
        let connected = true;
        let status = "connected";
        let errorMessage: string | null = null;

        try {
                const services = await getProviderServices();
                servicesOk = true;
                servicesCount = services.length;
                balance = await getProviderBalance();
        } catch (err) {
                connected = false;
                const classified = classifyConnectionError(err);
                status = classified.status;
                errorMessage = classified.message;
        }

        const checkedAt = new Date().toISOString();

        await db.from("providers").update({ active: connected }).eq("name", "Delix Gains");
        await db.from("site_settings").upsert({
                key: "delix_connection_status",
                value: { connected, status, services_ok: servicesOk, services_count: servicesCount, balance, checked_at: checkedAt, error: errorMessage },
                updated_at: checkedAt,
        });
        await logProviderAction("test-connection", { success: connected, errorCode: connected ? undefined : status });

        return { connected, status, servicesOk, servicesCount, balance, checkedAt, error: errorMessage };
}

async function handleCheckBalance(req: Request) {
        await requireAdmin(req);
        const db = serviceRoleClient();
        const balance = await getProviderBalance();
        const checkedAt = new Date().toISOString();
        await db.from("site_settings").upsert({
                key: "delix_balance",
                value: { ...balance, checked_at: checkedAt },
                updated_at: checkedAt,
        });
        return { balance, checkedAt };
}

async function handleSyncServices(req: Request) {
        await requireAdmin(req);
        const db = serviceRoleClient();

        let providerList: any[];
        try {
                providerList = await getProviderServices();
        } catch (err) {
                await logProviderAction("sync-services", { success: false, errorCode: err instanceof ProviderError ? err.code : "unavailable" });
                throw err;
        }
        const providerById = new Map(providerList.map((p: any) => [String(p.service), p]));

        const { data: provider } = await db.from("providers").select("id").eq("name", "Delix Gains").single();
        if (!provider) throw new ProviderError("bad_request", "Delix Gains provider row missing — run migration_delix_provider.sql");

        const { data: mappings } = await db.from("provider_services").select("*").eq("provider_id", provider.id);

        let updated = 0;
        const notFoundOnProvider: string[] = [];
        const now = new Date().toISOString();

        for (const mapping of mappings ?? []) {
                const p = providerById.get(mapping.provider_service_ref);
                if (!p) {
                        notFoundOnProvider.push(mapping.provider_service_ref);
                        await db.from("provider_services").update({ provider_sync_ok: false, last_provider_sync: now }).eq("id", mapping.id);
                        continue;
                }
                await db
                        .from("provider_services")
                        .update({
                                provider_name: p.name,
                                provider_type: p.type,
                                provider_category: p.category,
                                provider_rate: Number(p.rate),
                                provider_currency: "USD",
                                provider_min: Number(p.min),
                                provider_max: Number(p.max),
                                provider_refill: !!p.refill,
                                provider_cancel: !!p.cancel,
                                provider_sync_ok: true,
                                last_provider_sync: now,
                        })
                        .eq("id", mapping.id);
                updated++;
        }

        await logProviderAction("sync-services", { success: true });

        return {
                updated,
                totalMapped: (mappings ?? []).length,
                notFoundOnProvider,
                providerCatalogueSize: providerList.length,
                syncedAt: now,
        };
}

async function handleMapService(req: Request, body: any) {
        await requireAdmin(req);
        const { service_id, provider_service_ref } = body;
        if (!service_id || !provider_service_ref) throw new ProviderError("bad_request");

        const db = serviceRoleClient();
        const { data: provider } = await db.from("providers").select("id").eq("name", "Delix Gains").single();
        if (!provider) throw new ProviderError("bad_request", "Delix Gains provider row missing");

        const { data: service } = await db.from("services").select("id").eq("id", service_id).single();
        if (!service) throw new ProviderError("bad_request", "Unknown BTECH service");

        const { error } = await db.from("provider_services").insert({
                provider_id: provider.id,
                service_id,
                provider_service_ref: String(provider_service_ref),
        });
        if (error) throw new ProviderError("bad_request", error);

        return { mapped: true };
}

async function handleUnmapService(req: Request, body: any) {
        await requireAdmin(req);
        const { mapping_id } = body;
        if (!mapping_id) throw new ProviderError("bad_request");
        const db = serviceRoleClient();
        await db.from("provider_services").delete().eq("id", mapping_id);
        return { unmapped: true };
}

async function handleUpdateMapping(req: Request, body: any) {
        await requireAdmin(req);
        const { mapping_id, provider_service_ref } = body;
        if (!mapping_id || !provider_service_ref) throw new ProviderError("bad_request");
        const db = serviceRoleClient();
        const { error } = await db
                .from("provider_services")
                .update({ provider_service_ref: String(provider_service_ref), provider_sync_ok: null, last_provider_sync: null })
                .eq("id", mapping_id);
        if (error) throw new ProviderError("bad_request", error);
        return { updated: true };
}

/**
 * Prepared for later — deliberately NOT wired to any customer-facing action
 * in this phase. Hard-gated on payment_status = 'paid', which currently no
 * order can ever reach (Phase 5/M-Pesa doesn't exist yet), so calling this
 * today always fails safely with "not_paid" rather than silently no-op'ing.
 */
async function handleCreateOrder(req: Request, body: any) {
        await requireAdmin(req);
        const { order_id } = body;
        if (!order_id) throw new ProviderError("bad_request");

        const db = serviceRoleClient();
        const { data: order } = await db.from("orders").select("*").eq("id", order_id).single();
        if (!order) throw new ProviderError("bad_request", "Order not found");
        if (order.payment_status !== "paid") throw new ProviderError("not_paid");
        if (order.provider_order_id) throw new ProviderError("duplicate");

        const { data: mapping } = await db
                .from("provider_services")
                .select("*, providers(name)")
                .eq("service_id", order.service_id)
                .single();
        if (!mapping) throw new ProviderError("bad_request", "No provider mapping for this service");

        const providerOrderId = await createProviderOrder(mapping.provider_service_ref, order.target, order.quantity);

        await db
                .from("orders")
                .update({
                        provider: "Delix Gains",
                        provider_order_id: providerOrderId,
                        provider_status: "Awaiting",
                        provider_synced_at: new Date().toISOString(),
                        updated_at: new Date().toISOString(),
                })
                .eq("id", order_id);

        await logProviderAction("create-order", { orderId: order_id, providerOrderId, success: true });

        return { providerOrderId };
}

async function handleOrderStatus(req: Request, body: any) {
        await requireAdmin(req);
        const { order_id } = body;
        const db = serviceRoleClient();
        const { data: order } = await db.from("orders").select("*").eq("id", order_id).single();
        if (!order?.provider_order_id) throw new ProviderError("bad_request", "Order has no provider order id");

        const status = (await getProviderOrderStatus(order.provider_order_id)) as { status?: string };
        const mapped = status.status ? mapProviderStatusToBtech(status.status) : null;

        const update: Record<string, unknown> = { provider_status: status.status ?? null, provider_synced_at: new Date().toISOString() };
        if (mapped) update.status = mapped;
        await db.from("orders").update(update).eq("id", order_id);

        return { providerStatus: status, mappedStatus: mapped };
}

async function handleMultipleStatus(req: Request, body: any) {
        await requireAdmin(req);
        const { order_ids } = body;
        if (!Array.isArray(order_ids) || order_ids.length === 0) throw new ProviderError("bad_request");

        const db = serviceRoleClient();
        const { data: orders } = await db.from("orders").select("*").in("id", order_ids).not("provider_order_id", "is", null);
        if (!orders || orders.length === 0) return { updated: [] };

        const providerIds = orders.map((o: any) => o.provider_order_id);
        const statuses = await getMultipleProviderOrderStatuses(providerIds);

        const updated: string[] = [];
        for (const order of orders) {
                const entry = (statuses as Record<string, any>)[order.provider_order_id];
                if (!entry || entry.error) continue; // "Incorrect order ID" etc. — skip, don't fail the batch
                const mapped = entry.status ? mapProviderStatusToBtech(entry.status) : null;
                const update: Record<string, unknown> = { provider_status: entry.status ?? null, provider_synced_at: new Date().toISOString() };
                if (mapped) update.status = mapped;
                await db.from("orders").update(update).eq("id", order.id);
                updated.push(order.id);
        }
        return { updated };
}

async function handleRefill(req: Request, body: any) {
        await requireAdmin(req);
        const { order_id } = body;
        const db = serviceRoleClient();
        const { data: order } = await db.from("orders").select("*").eq("id", order_id).single();
        if (!order?.provider_order_id) throw new ProviderError("bad_request", "Order has no provider order id");

        const { data: mapping } = await db.from("provider_services").select("provider_refill").eq("service_id", order.service_id).single();
        if (!mapping?.provider_refill) throw new ProviderError("bad_request", "This service does not support refills.");

        const result = await requestProviderRefill(order.provider_order_id);
        return { result };
}

async function handleCancelProviderOrder(req: Request, body: any) {
        await requireAdmin(req);
        const { order_id } = body;
        const db = serviceRoleClient();
        const { data: order } = await db.from("orders").select("*").eq("id", order_id).single();
        if (!order?.provider_order_id) throw new ProviderError("bad_request", "Order has no provider order id to cancel");

        const result = await cancelProviderOrder(order.provider_order_id);
        await db
                .from("orders")
                .update({ provider_status: "Canceled", provider_synced_at: new Date().toISOString() })
                .eq("id", order_id);
        return { result };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
// IMPORTANT: every response here is HTTP 200 with an { ok, ... } envelope,
// even for "expected" failures (bad request, not admin, provider error).
// This is deliberate, not an oversight: relying on non-2xx statuses meant
// the frontend had to parse `error.context` off the supabase-js error
// object, whose Response body can only be read once and may already be
// consumed internally depending on the exact @supabase/supabase-js version
// — a well-known source of exactly the symptom this was built to avoid
// ("Something went wrong talking to the provider function" with no real
// detail). A non-2xx status is now reserved for genuine crashes/network
// issues, which is what should actually be rare and worth investigating.
Deno.serve(async (req: Request) => {
        if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

        try {
                const body = await req.json().catch(() => ({}));
                const action = body.action;

                const handlers: Record<string, () => Promise<unknown>> = {
                        "test-connection": () => handleTestConnection(req),
                        "check-balance": () => handleCheckBalance(req),
                        "sync-services": () => handleSyncServices(req),
                        "map-service": () => handleMapService(req, body),
                        "unmap-service": () => handleUnmapService(req, body),
                        "update-mapping": () => handleUpdateMapping(req, body),
                        "create-order": () => handleCreateOrder(req, body),
                        "order-status": () => handleOrderStatus(req, body),
                        "multiple-status": () => handleMultipleStatus(req, body),
                        refill: () => handleRefill(req, body),
                        "cancel-order": () => handleCancelProviderOrder(req, body),
                };

                const handler = handlers[action];
                if (!handler) return jsonResponse({ ok: false, error: SAFE_MESSAGES.bad_request, code: "bad_request" });

                const result = await handler();
                return jsonResponse({ ok: true, ...result });
        } catch (err) {
                if (err instanceof ProviderError) {
                        return jsonResponse({ ok: false, error: err.message, code: err.code });
                }
                console.error("[delix-provider] unexpected error:", err);
                return jsonResponse({ ok: false, error: SAFE_MESSAGES.unavailable, code: "unavailable" });
        }
});