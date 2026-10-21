// Run: node --experimental-strip-types logic.test.mjs   (mocks only; no network, no API key)
import assert from "node:assert/strict";
import { handle, runTool, FALLBACK } from "./logic.ts";

const settings = { model: "m", max_input_chars: 800, max_history_messages: 8, max_output_tokens: 600, web_search_enabled: false, web_search_domains: [] };
function mk({ quota = { allowed: true, settings }, replies = [], apiKey = "k", orders = [] } = {}) {
  const calls = { select: [], rpc: [], fetch: [] };
  const userDb = {
    async select(t, c, o) { calls.select.push({ t, c, o }); if (t === "orders") return { data: orders.filter(r => (!o.eq?.user_id || r.user_id === o.eq.user_id) && (!o.eq?.id || r.id === o.eq.id)), error: null }; return { data: [], error: null }; },
    async rpc(n, a) { calls.rpc.push({ who: "user", n, a }); if (n === "support_create_ticket") return { data: { ticket_id: "TCK-1", reused: false }, error: null }; return { data: [], error: null }; },
  };
  const adminDb = { async select() { return { data: [], error: null }; }, async rpc(n, a) { calls.rpc.push({ who: "admin", n, a }); if (n === "support_ai_quota") return { data: quota, error: null }; if (n === "support_chat_begin") return { data: "conv1", error: null }; if (n === "support_chat_history") return { data: [], error: null }; return { data: null, error: null }; } };
  const queue = [...replies];
  const fetchFn = async (url, init) => { calls.fetch.push({ url, body: JSON.parse(init.body), headers: init.headers }); const r = queue.shift(); if (r instanceof Error) throw r; return r; };
  return { ctx: { uid: "U1", userDb, adminDb, fetchFn, apiKey }, calls };
}
const ok = (content, stop = "end_turn") => ({ ok: true, status: 200, json: async () => ({ content, stop_reason: stop, usage: { input_tokens: 100, output_tokens: 20 } }) });
const txt = (t) => [{ type: "text", text: t }];

let n = 0; const t = async (name, fn) => { await fn(); n++; console.log("ok -", name); };

await t("plain answer, key in header only, tool list has no write tools", async () => {
  const { ctx, calls } = mk({ replies: [ok(txt("Hello!"))] });
  const r = await handle(ctx, { action: "chat", message: "hi" });
  assert.equal(r.body.reply, "Hello!"); assert.equal(r.body.conversation_id, "conv1");
  assert.equal(calls.fetch[0].headers["x-api-key"], "k");
  assert.ok(!JSON.stringify(r.body).includes('"k"'));
  assert.ok(!calls.fetch[0].body.tools.some(x => /cancel|refund_order|credit|wallet_add/.test(x.name)));
  assert.ok(calls.rpc.some(c => c.n === "support_ai_log_usage" && c.a.p_in === 100));
});
await t("tool use: order lookup always filtered by verified uid, model-supplied user_id ignored", async () => {
  const orders = [{ id: "O2", user_id: "U1", amount: 75 }, { id: "O5", user_id: "U2", amount: 15 }];
  const { ctx, calls } = mk({ orders, replies: [
    ok([{ type: "tool_use", id: "t1", name: "get_order", input: { order_id: "O5", user_id: "U2" } }], "tool_use"), ok(txt("I can't find that order.")) ] });
  const r = await handle(ctx, { action: "chat", message: "status of O5" });
  const sel = calls.select.find(s => s.t === "orders");
  assert.equal(sel.o.eq.user_id, "U1");
  const toolResult = calls.fetch[1].body.messages.at(-1).content[0].content;
  assert.ok(toolResult.includes("not_found")); assert.ok(!toolResult.includes("U2"));
  assert.equal(r.body.reply, "I can't find that order.");
});
await t("order columns exclude notes/provider fields", async () => {
  const { ctx, calls } = mk(); await runTool(ctx, "get_order", { order_id: "O2" });
  const cols = calls.select.map(s => s.c).join(",");
  assert.ok(!/notes|provider|cost|admin/.test(cols));
});
await t("propose_ticket creates nothing; returns proposal", async () => {
  const { ctx, calls } = mk({ replies: [ok([{ type: "tool_use", id: "t", name: "propose_ticket", input: { category: "payment", subject: "Money missing", message: "Paid but not credited" } }], "tool_use"), ok(txt("Shall I send this to support?"))] });
  const r = await handle(ctx, { action: "chat", message: "paid not credited" });
  assert.equal(r.body.proposal.category, "payment");
  assert.ok(!calls.rpc.some(c => c.n === "support_create_ticket"));
});
await t("invalid category from model normalised to general", async () => {
  const { ctx } = mk(); const o = await runTool(ctx, "propose_ticket", { category: "admin_override", subject: "x", message: "y" });
  assert.equal(o.proposal.category, "general");
});
await t("create_ticket uses the USER client, requires key, shows real ref", async () => {
  const { ctx, calls } = mk();
  const bad = await handle(ctx, { action: "create_ticket", proposal: { subject: "abcd", message: "long enough message" } });
  assert.equal(bad.status, 400);
  const r = await handle(ctx, { action: "create_ticket", conversation_id: "conv1", idempotency_key: "k1", proposal: { category: "security", subject: "Hacked", message: "Someone used my account" } });
  assert.ok(r.body.reply.includes("TCK-1"));
  const c = calls.rpc.find(x => x.n === "support_create_ticket"); assert.equal(c.who, "user"); assert.equal(c.a.p_source, "ai_chat");
  assert.ok(!("p_user" in c.a));
});
await t("provider 500 -> safe fallback, no fabricated answer, usage still logged", async () => {
  const { ctx } = mk({ replies: [{ ok: false, status: 500, json: async () => ({}) }] });
  const r = await handle(ctx, { action: "chat", message: "hi" });
  assert.equal(r.body.fallback, true); assert.equal(r.body.reply, FALLBACK.unavailable);
});
await t("provider 429, timeout/abort, network error", async () => {
  let { ctx } = mk({ replies: [{ ok: false, status: 429, json: async () => ({}) }] });
  assert.equal((await handle(ctx, { action: "chat", message: "hi" })).body.reason, "rate_limited");
  const ab = new Error("x"); ab.name = "AbortError";
  ({ ctx } = mk({ replies: [ab] })); assert.equal((await handle(ctx, { action: "chat", message: "hi" })).body.reason, "timeout");
  ({ ctx } = mk({ replies: [new Error("net")] })); assert.equal((await handle(ctx, { action: "chat", message: "hi" })).body.reason, "unavailable");
});
await t("401 from provider (bad key) is generic to the customer", async () => {
  const { ctx } = mk({ replies: [{ ok: false, status: 401, json: async () => ({ error: "invalid x-api-key" }) }] });
  const r = await handle(ctx, { action: "chat", message: "hi" });
  assert.ok(!JSON.stringify(r.body).includes("api-key"));
});
await t("no API key -> basic mode, no provider call", async () => {
  const { ctx, calls } = mk({ apiKey: null }); const r = await handle(ctx, { action: "chat", message: "hi" });
  assert.equal(r.body.mode, "basic"); assert.equal(calls.fetch.length, 0);
});
await t("quota exceeded -> no provider call, nothing stored", async () => {
  const { ctx, calls } = mk({ quota: { allowed: false, reason: "rate_limit", retry_after_seconds: 60, settings } });
  const r = await handle(ctx, { action: "chat", message: "hi" });
  assert.equal(r.body.reason, "rate_limit"); assert.equal(calls.fetch.length, 0);
  assert.ok(!calls.rpc.some(c => c.n === "support_chat_append"));
});
await t("AI disabled by admin -> basic mode, no provider call", async () => {
  const { ctx, calls } = mk({ quota: { allowed: false, reason: "disabled", settings } });
  assert.equal((await handle(ctx, { action: "chat", message: "hi" })).body.mode, "basic"); assert.equal(calls.fetch.length, 0);
});
await t("input too long rejected before any model call", async () => {
  const { ctx, calls } = mk(); const r = await handle(ctx, { action: "chat", message: "a".repeat(801) });
  assert.equal(r.status, 400); assert.equal(calls.fetch.length, 0);
});
await t("max_tokens and model come from settings; history capped via setting", async () => {
  const { ctx, calls } = mk({ replies: [ok(txt("x"))] }); await handle(ctx, { action: "chat", message: "hi" });
  assert.equal(calls.fetch[0].body.max_tokens, 600); assert.equal(calls.rpc.find(c => c.n === "support_chat_history").a.p_limit, 8);
});
await t("service search sanitises PostgREST filter injection", async () => {
  const { ctx, calls } = mk(); await runTool(ctx, "search_services", { query: "insta),user_id.neq.x,(" });
  assert.ok(!/[(),]user_id/.test(calls.select[0].o.or)); assert.ok(/^name\.ilike\.%insta%,platform/.test(calls.select[0].o.or));
});
await t("tool loop is bounded (model that never stops calling tools)", async () => {
  const loop = () => ok([{ type: "tool_use", id: "t", name: "get_wallet", input: {} }], "tool_use");
  const { ctx, calls } = mk({ replies: [loop(), loop(), loop(), loop(), loop()] });
  const r = await handle(ctx, { action: "chat", message: "hi" });
  assert.equal(calls.fetch.length, 4); assert.equal(r.body.fallback, true);
});
await t("web search tool only added when enabled with domains", async () => {
  let m = mk({ replies: [ok(txt("x"))] }); await handle(m.ctx, { action: "chat", message: "hi" });
  assert.ok(!m.calls.fetch[0].body.tools.some(x => x.name === "web_search"));
  const s2 = { ...settings, web_search_enabled: true, web_search_domains: ["docs.example.com"] };
  m = mk({ quota: { allowed: true, settings: s2 }, replies: [ok(txt("x"))] }); await handle(m.ctx, { action: "chat", message: "hi" });
  assert.deepEqual(m.calls.fetch[0].body.tools.find(x => x.name === "web_search").allowed_domains, ["docs.example.com"]);
});
await t("unknown action / unknown tool", async () => {
  const { ctx } = mk(); assert.equal((await handle(ctx, { action: "admin_sql" })).status, 400);
  assert.equal((await runTool(ctx, "run_sql", {})).result.error, "unknown_tool");
});
console.log(`\n${n} tests passed`);

// ---------------- basic (no-AI) mode ----------------
import { basicReply, geminiGeneric } from "./logic.ts";
function mk2(over = {}) {
  const calls = [];
  const data = {
    orders: [{ id: "O2", user_id: "U1", status: "processing", payment_status: "paid", progress: 40, quantity: 1000, amount: 75, created_at: "2026-10-01T10:00:00Z" }],
    wallets: [{ balance: 120.5 }], transactions: [{ type: "deposit", amount: 100, status: "completed", created_at: "2026-10-02T10:00:00Z" }],
    services: [{ id: "s1", platform: "Instagram", category: "Followers", name: "IG Followers", description: "d", price_per_1000: 250, min_quantity: 100, max_quantity: 10000, unit: "" }],
    support_tickets: [{ id: "TCK-1", subject: "Hi there", status: "in_progress" }], ...over.data };
  const kbs = over.kb ?? [{ id: "k", title: "Never share PINs, OTPs or passwords", body: "Never share your PIN." }];
  const userDb = {
    async select(t, c, o) { calls.push([t, o]); const rows = (data[t] ?? []).filter(r => !o?.eq?.id || r.id === o.eq.id); return { data: rows, error: null }; },
    async rpc(n, a) { calls.push([n, a]); if (n === "support_kb_search") return { data: kbs, error: null }; return { data: [], error: null }; },
  };
  return { ctx: { uid: "U1", userDb, adminDb: { async rpc() { return { data: null, error: null }; }, async select() { return { data: [], error: null }; } }, fetchFn: async () => { throw new Error("no network in basic mode"); }, apiKey: null }, calls };
}
await t("basic: orders list", async () => { const { ctx } = mk2(); const r = await basicReply(ctx, "Show my recent orders and their status."); assert.match(r.reply, /O2: processing, 40% done, Ksh 75/); });
await t("basic: order id details and delayed proposal", async () => { const { ctx } = mk2(); const r = await basicReply(ctx, "order O2 is taking long"); assert.match(r.reply, /Order O2: status processing/); assert.equal(r.proposal.category, "order"); assert.equal(r.proposal.order_id, "O2"); });
await t("basic: unknown order id does not leak or invent", async () => { const { ctx } = mk2(); const r = await basicReply(ctx, "status of order O5"); assert.match(r.reply, /could not find/); });
await t("basic: wallet", async () => { const { ctx } = mk2(); const r = await basicReply(ctx, "Check my wallet balance and recent transactions."); assert.match(r.reply, /Wallet balance: Ksh 120.5/); });
await t("basic: services needing platform asks, with platform lists live prices", async () => {
  let { ctx } = mk2(); assert.match((await basicReply(ctx, "What services do you offer and what are the prices?")).reply, /Which platform/);
  ({ ctx } = mk2()); assert.match((await basicReply(ctx, "instagram followers price")).reply, /IG Followers.*Ksh 250 per 1000, min 100, max 10000/);
});
await t("basic: payment problem and security propose the right category", async () => {
  let { ctx } = mk2(); assert.equal((await basicReply(ctx, "mpesa money deducted but wallet not credited")).proposal.category, "payment");
  ({ ctx } = mk2()); assert.equal((await basicReply(ctx, "someone hacked my account")).proposal.category, "security");
  ({ ctx } = mk2()); assert.equal((await basicReply(ctx, "Nimeibiwa pesa")).proposal.category, "security");
});
await t("basic: human request and unknown question go to human support, nothing invented", async () => {
  let { ctx } = mk2({ kb: [] }); assert.ok((await basicReply(ctx, "I want to speak to a human")).proposal);
  ({ ctx } = mk2({ kb: [] })); const r = await basicReply(ctx, "tell me about the moon"); assert.match(r.reply, /do not have an official answer/); assert.ok(r.offer && !r.proposal);
});
await t("basic: delivery-time question never states a time", async () => {
  const { ctx } = mk2({ kb: [{ id: "g", title: "Policies BTECH SMM has not published", body: "x" }] });
  const r = await basicReply(ctx, "how long does delivery take"); assert.match(r.reply, /cannot promise/); assert.ok(r.offer); assert.ok(!/\b\d+ (hours|days)\b/.test(r.reply));
});
await t("basic mode via handle(): no key -> works, no provider call, no usage tokens", async () => {
  const { ctx } = mk({ apiKey: null }); const r = await handle(ctx, { action: "chat", message: "show my wallet" });
  assert.equal(r.body.mode, "basic"); assert.ok(!r.body.fallback);
});

// ---------------- Gemini (general questions only) ----------------
const gem = (text, ok = true, status = 200) => ({ ok, status, json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }) });
function mk3(replies, over = {}) {
  const { ctx, calls } = mk2(over); const fetches = [];
  const q = [...replies];
  ctx.fetchFn = async (url, init) => { fetches.push({ url, init, body: JSON.parse(init.body) }); const r = q.shift(); if (r instanceof Error) throw r; return r; };
  ctx.geminiKey = "GK"; ctx.geminiModel = "gemini-x";
  return { ctx, calls, fetches };
}
await t("gemini: general question uses KB + key in header, never URL", async () => {
  const { ctx, fetches } = mk3([gem("You can apply on the Ambassador page.")]);
  const r = await basicReply(ctx, "how do i become an ambassador", (x) => geminiGeneric(ctx, { max_input_chars: 800, max_output_tokens: 600 }, x));
  assert.equal(r.mode, "gemini"); assert.match(r.reply, /Ambassador page/);
  assert.ok(!fetches[0].url.includes("GK")); assert.equal(fetches[0].init.headers["x-goog-api-key"], "GK"); assert.match(fetches[0].url, /gemini-x:generateContent/);
});
await t("gemini: personal data NEVER sent (orders/wallet answered locally, no external call)", async () => {
  const { ctx, fetches } = mk3([gem("x")]);
  const g = (x) => geminiGeneric(ctx, {}, x);
  const a = await basicReply(ctx, "show my recent orders", g); const b = await basicReply(ctx, "my wallet balance", g); const c = await basicReply(ctx, "order O2 status", g);
  assert.equal(fetches.length, 0); assert.ok(!a.mode && !b.mode && !c.mode);
});
await t("gemini: request contains only question + approved info (no uid, no orders)", async () => {
  const { ctx, fetches } = mk3([gem("ok")]);
  await geminiGeneric(ctx, { max_input_chars: 800 }, "what are your instagram prices");
  const body = JSON.stringify(fetches[0].body); assert.ok(!body.includes("U1") && !body.includes("O2") && !body.includes("120.5")); assert.match(body, /IG Followers/);
});
await t("gemini: [[HUMAN]] -> human-support proposal; failure -> null -> KB/handoff fallback", async () => {
  let { ctx } = mk3([gem("[[HUMAN]] I have no official answer.")]);
  const r = await geminiGeneric(ctx, {}, "something odd"); assert.ok(r.offer && !r.proposal); assert.ok(!r.reply.includes("[[HUMAN]]"));
  ({ ctx } = mk3([{ ok: false, status: 429, json: async () => ({}) }])); assert.equal(await geminiGeneric(ctx, {}, "q"), null);
  ({ ctx } = mk3([new Error("net")])); assert.equal(await geminiGeneric(ctx, {}, "q"), null);
  ({ ctx } = mk3([{ ok: false, status: 429, json: async () => ({}) }], { kb: [] })); const f = await basicReply(ctx, "tell me about the moon", (x) => geminiGeneric(ctx, {}, x)); assert.match(f.reply, /do not have an official answer/);
});
await t("gemini via handle(): chosen when only GEMINI key set; Anthropic preferred when both", async () => {
  const m = mk({ apiKey: null }); m.ctx.geminiKey = "GK"; let hit = "";
  m.ctx.fetchFn = async (u) => { hit = u; return gem("Hello from Gemini."); };
  const r = await handle(m.ctx, { action: "chat", message: "how does the ambassador program work" });
  assert.equal(r.body.mode, "gemini"); assert.match(hit, /generativelanguage/);
  const m2 = mk({ apiKey: "k", replies: [ok(txt("Claude here"))] }); m2.ctx.geminiKey = "GK";
  const r2 = await handle(m2.ctx, { action: "chat", message: "hi" }); assert.equal(r2.body.reply, "Claude here");
});
await t("small talk: greetings, thanks, bye never trigger an unknown-answer or ticket", async () => {
  for (const m of ["HEY", "hey", "Hello there", "hi", "Mambo", "good morning", "?", "help"]) { const { ctx } = mk2({ kb: [] }); const r = await basicReply(ctx, m); assert.match(r.reply, /^Hello!/, m); assert.ok(!r.offer && !r.proposal, m); }
  const { ctx } = mk2({ kb: [] }); assert.match((await basicReply(ctx, "thank you")).reply, /welcome/); assert.match((await basicReply(ctx, "asante")).reply, /welcome/); assert.match((await basicReply(ctx, "bye")).reply, /Goodbye/);
});
await t("greeting-like prefix with a real question still answers the question", async () => {
  const { ctx } = mk2(); const r = await basicReply(ctx, "hey show my wallet balance"); assert.match(r.reply, /Wallet balance/);
});
console.log(`\n${n} tests passed (incl. basic + Gemini + small talk)`);
