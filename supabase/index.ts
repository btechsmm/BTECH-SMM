/**
 * BTECH CUSTOMER SUPPORT — support-assistant Edge Function
 * ----------------------------------------------------------------
 * Deploy (JWT verification stays ON):
 *   supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
 *   supabase functions deploy support-assistant
 * SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY are injected automatically.
 * The model, token caps, rate limits and web search switch live in the support_settings table
 * (Admin Portal -> Customer Service & Support -> Settings). The API key exists only here.
 *
 * Actions: { action: "chat", conversation_id?, message }
 *          { action: "create_ticket", conversation_id?, idempotency_key, proposal }
 * See logic.ts for the trust model.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { handle, type Db } from "./logic.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });

function adapter(client: any): Db {
  return {
    async select(table, columns, o = {}) {
      let q = client.from(table).select(columns);
      for (const [k, v] of Object.entries(o.eq ?? {})) q = q.eq(k, v);
      if (o.or) q = q.or(o.or);
      if (o.order) q = q.order(o.order[0], { ascending: o.order[1] });
      if (o.limit) q = q.limit(o.limit);
      const { data, error } = await q;
      return { data, error };
    },
    async rpc(name, args) { const { data, error } = await client.rpc(name, args ?? {}); return { data, error }; },
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "bad_request", message: "Invalid request." }, 405);
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const auth = req.headers.get("Authorization") ?? "";
    const userClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
    const { data: u, error } = await userClient.auth.getUser();
    if (error || !u?.user) return json({ ok: false, error: "not_authenticated", message: "Please log in and try again." }, 401);
    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
    const body = await req.json().catch(() => null);
    const r = await handle({
      uid: u.user.id, userDb: adapter(userClient), adminDb: adapter(admin),
      fetchFn: (x, init) => fetch(x, init), apiKey: Deno.env.get("ANTHROPIC_API_KEY") ?? null,
      log: (m, e) => console.log("[support-assistant]", m, JSON.stringify(e ?? {})), // never logs message text or PII
    }, body);
    return json(r.body, r.status);
  } catch (_e) {
    console.log("[support-assistant] unhandled error");
    return json({ ok: false, error: "server_error", message: "Something went wrong. Please try again." }, 500);
  }
});
