/**
 * BTECH CUSTOMER SUPPORT — chat widget
 * ----------------------------------------------------------------
 * One component, two placements: inline on the Support page and as a floating launcher on
 * other customer pages. Talks only to the `support-assistant` Edge Function (JWT attached by
 * supabase-js) and to RLS-protected tables for the customer's own history. No AI key or
 * customer id is ever sent from here; all text is inserted with textContent (no HTML injection).
 */
import { supabase } from "./supabase.js";
import { AuthService } from "./auth.js";
import { BUSINESS } from "./config.js";

const WELCOME =
  "Hello! Welcome to BTECH SMM Support. I'm here to help with your orders, payments, wallet, services, account and other BTECH SMM questions. What can I help you with today?";

const CHIPS = [
  { label: "My Orders", text: "Show my recent orders and their status." },
  { label: "Wallet & Payments", text: "Check my wallet balance and recent transactions." },
  { label: "Services", text: "What services do you offer and what are the prices?" },
  { label: "Delayed Order", text: "My order is taking long. Can you check it?" },
  { label: "My Account", text: "I need help with my account." },
  { label: "Rewards & Loyalty", text: "What are my loyalty points and level?" },
  { label: "Ambassador Program", text: "How does the ambassador program work?" },
  { label: "Contact Human Support", human: true },
];
const CATEGORY_LABEL = { general: "General", account: "Account", service: "Service", order: "Order", payment: "Payment", refund: "Refund", cancellation: "Cancellation", security: "Security", other: "Other" };
const SESSION_KEY = "btechsmm:support-conv";

const store = {
  get() { try { return sessionStorage.getItem(SESSION_KEY); } catch { return null; } },
  set(v) { try { v ? sessionStorage.setItem(SESSION_KEY, v) : sessionStorage.removeItem(SESSION_KEY); } catch { /* optional */ } },
};

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
const time = (iso) => new Date(iso || Date.now()).toLocaleTimeString("en-KE", { hour: "2-digit", minute: "2-digit" });
const key = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));

async function callAssistant(body) {
  const { data, error } = await supabase.functions.invoke("support-assistant", { body });
  if (error) {
    // Non-2xx responses carry our JSON body in error.context
    try { const j = await error.context.json(); if (j && (j.message || j.error)) return j; } catch { /* fall through */ }
    throw error;
  }
  return data;
}

export function mountSupportChat(root, { floating = false, onClose = null } = {}) {
  root.classList.add("sc");
  if (floating) root.classList.add("sc--floating");
  const guest = !AuthService.isAuthenticated();
  let conversationId = null;
  let busy = false;
  let assistantTurns = 0;
  let feedbackShown = false;
  let aiOnline = true;
  let basicMode = false;

  root.innerHTML = "";
  root.setAttribute("role", floating ? "dialog" : "region");
  root.setAttribute("aria-label", "BTECH CUSTOMER SUPPORT chat");

  // ---- Header
  const head = el("div", "sc__head");
  const logo = el("img", "sc__logo"); logo.src = "assets/brand/icon-32.png"; logo.alt = ""; logo.width = 32; logo.height = 32;
  const titles = el("div", "sc__titles");
  titles.append(el("div", "sc__title", "BTECH CUSTOMER SUPPORT"), el("div", "sc__sub", "Your BTECH SMM assistant"));
  const status = el("div", "sc__status");
  const dot = el("span", "sc__dot"); dot.setAttribute("aria-hidden", "true");
  const statusText = el("span", "", "Checking…");
  status.append(dot, statusText);
  titles.append(status);
  const actions = el("div", "sc__actions");
  const btnHistory = el("button", "sc__icon", "History"); btnHistory.type = "button";
  const btnNew = el("button", "sc__icon", "New"); btnNew.type = "button"; btnNew.title = "Start a new conversation"; btnNew.setAttribute("aria-label", "Start a new conversation");
  actions.append(btnHistory, btnNew);
  if (floating) {
    const close = el("button", "sc__icon sc__icon--close", "Close"); close.type = "button"; close.setAttribute("aria-label", "Close chat");
    close.addEventListener("click", () => onClose && onClose());
    actions.append(close);
  }
  head.append(logo, titles, actions);

  // ---- Body
  const log = el("div", "sc__log"); log.setAttribute("role", "log"); log.setAttribute("aria-live", "polite"); log.tabIndex = 0;
  const chips = el("div", "sc__chips");
  const historyPane = el("div", "sc__history"); historyPane.hidden = true;

  // ---- Composer
  const form = el("form", "sc__composer");
  const input = el("textarea", "sc__input"); input.rows = 1; input.placeholder = "Type your message…"; input.maxLength = 800;
  input.setAttribute("aria-label", "Message to BTECH Support"); input.enterKeyHint = "send";
  const send = el("button", "sc__send", "Send"); send.type = "submit";
  const counter = el("span", "sc__count", ""); counter.setAttribute("aria-hidden", "true");
  form.append(input, send, counter);

  root.append(head, log, chips, historyPane, form);

  function scrollDown() { log.scrollTop = log.scrollHeight; }

  function addMessage(role, text, iso, extra) {
    const row = el("div", `sc__msg sc__msg--${role}`);
    const bubble = el("div", "sc__bubble");
    bubble.textContent = text;
    const meta = el("div", "sc__time", `${role === "user" ? "You" : "BTECH Support"} · ${time(iso)}`);
    row.append(bubble, meta);
    if (extra && extra.sources && extra.sources.length) {
      const src = el("div", "sc__sources", "Sources: ");
      extra.sources.forEach((s, i) => {
        if (!/^https:\/\//i.test(s.url)) return;
        const a = el("a", "", s.title || s.url); a.href = s.url; a.target = "_blank"; a.rel = "noopener noreferrer";
        if (i) src.append(", ");
        src.append(a);
      });
      row.append(src);
    }
    log.append(row);
    scrollDown();
    return row;
  }

  function addNotice(text, isError) {
    const n = el("div", `sc__notice${isError ? " sc__notice--error" : ""}`, text);
    n.setAttribute("role", isError ? "alert" : "status");
    log.append(n); scrollDown();
    return n;
  }

  function showTyping() {
    const t = el("div", "sc__msg sc__msg--assistant sc__typing");
    t.setAttribute("aria-label", "BTECH Support is typing");
    const b = el("div", "sc__bubble"); b.append(el("span"), el("span"), el("span"));
    t.append(b); log.append(t); scrollDown();
    return t;
  }

  function setBusy(v) { busy = v; send.disabled = v; input.disabled = v; if (!v) input.focus({ preventScroll: true }); }

  // ---- Ticket proposal / manual request card
  function showTicketCard(proposal, { manual = false } = {}) {
    const card = el("form", "sc__ticket");
    card.append(el("div", "sc__ticket-title", manual ? "Contact human support" : "Send this to human support?"));
    const cat = el("select", "sc__field"); cat.setAttribute("aria-label", "Category");
    Object.entries(CATEGORY_LABEL).forEach(([v, l]) => { const o = el("option", "", l); o.value = v; cat.append(o); });
    cat.value = proposal.category || "general";
    const subj = el("input", "sc__field"); subj.type = "text"; subj.maxLength = 120; subj.placeholder = "Subject"; subj.value = proposal.subject || ""; subj.setAttribute("aria-label", "Subject");
    const msg = el("textarea", "sc__field"); msg.rows = 4; msg.maxLength = 1500; msg.placeholder = "Describe the problem"; msg.value = proposal.message || ""; msg.setAttribute("aria-label", "Message");
    const err = el("div", "sc__ticket-error"); err.setAttribute("role", "alert");
    const row = el("div", "sc__ticket-actions");
    const ok = el("button", "btn btn--primary btn--sm", "Send to support"); ok.type = "submit";
    const no = el("button", "btn btn--ghost btn--sm", "Not now"); no.type = "button";
    row.append(ok, no);
    card.append(cat, subj, msg);
    if (proposal.order_id) card.append(el("div", "sc__ticket-note", `Linked order: ${proposal.order_id}`));
    card.append(el("div", "sc__ticket-note", "Never include your M-Pesa PIN, codes or password."), err, row);
    const reqKey = key();
    no.addEventListener("click", () => card.remove());
    card.addEventListener("submit", async (e) => {
      e.preventDefault();
      err.textContent = "";
      if (subj.value.trim().length < 4 || msg.value.trim().length < 10) { err.textContent = "Add a short subject and a few details."; return; }
      ok.disabled = true; ok.textContent = "Sending…";
      const body = {
        action: "create_ticket", conversation_id: conversationId, idempotency_key: reqKey,
        proposal: { category: cat.value, subject: subj.value.trim(), message: msg.value.trim(), order_id: proposal.order_id || null, summary: proposal.summary || "" },
      };
      try {
        let res;
        try { res = await callAssistant(body); } catch {
          // Function unreachable: tickets must still work, so use the same RPC directly (RLS + auth.uid()).
          const r = await supabase.rpc("support_create_ticket", {
            p_subject: body.proposal.subject, p_message: body.proposal.message, p_category: body.proposal.category, p_order_id: body.proposal.order_id,
            p_conversation_id: conversationId, p_ai_summary: body.proposal.summary || null, p_idempotency_key: reqKey, p_source: conversationId ? "ai_chat" : "form",
          });
          if (r.error) throw r.error;
          res = { ok: true, ticket_id: r.data.ticket_id, reply: `Done. Your support request has been created. Reference: ${r.data.ticket_id}. You can follow replies on the Support page.` };
        }
        if (!res || !res.ok || !res.ticket_id) { err.textContent = (res && res.message) || "We could not create the request. Please try again."; ok.disabled = false; ok.textContent = "Send to support"; return; }
        card.remove();
        addMessage("assistant", res.reply);
        document.dispatchEvent(new CustomEvent("support:ticket-created", { detail: { id: res.ticket_id } }));
        maybeFeedback(true);
      } catch (ex) {
        err.textContent = "We could not create the request. Please check your connection and try again.";
        ok.disabled = false; ok.textContent = "Send to support";
      }
    });
    log.append(card); scrollDown(); subj.focus({ preventScroll: true });
  }

  function maybeFeedback(force) {
    if (feedbackShown || !conversationId || (!force && assistantTurns < 3)) return;
    feedbackShown = true;
    const box = el("div", "sc__feedback");
    box.append(el("span", "", "Was this conversation helpful?"));
    [["Helpful", 5], ["Not helpful", 1]].forEach(([label, rating]) => {
      const b = el("button", "btn btn--ghost btn--sm", label); b.type = "button";
      b.addEventListener("click", async () => {
        const { error } = await supabase.rpc("support_conversation_feedback", { p_conversation: conversationId, p_rating: rating, p_comment: null });
        box.textContent = error ? "Thanks. We could not save your feedback." : "Thanks for your feedback.";
      });
      box.append(b);
    });
    log.append(box); scrollDown();
  }

  // ---- Sending
  async function sendMessage(text) {
    text = text.trim();
    if (!text || busy) return;
    chips.hidden = true;
    addMessage("user", text);
    input.value = ""; autoGrow();
    setBusy(true);
    const typing = showTyping();
    try {
      const res = await callAssistant({ action: "chat", conversation_id: conversationId, message: text });
      typing.remove();
      if (!res || res.ok === false) {
        addNotice((res && res.message) || "Something went wrong. Please try again.", true);
        if (res && res.error === "conversation_not_found") { conversationId = null; store.set(null); }
      } else {
        if (res.conversation_id) { conversationId = res.conversation_id; store.set(conversationId); }
        addMessage("assistant", res.reply, null, { sources: res.sources });
        if (res.mode === "basic" && !basicMode) { basicMode = true; setStatus(); } else if (res.mode === "gemini" && basicMode) { basicMode = false; setStatus(); }
        if (res.fallback) { aiOnline = res.reason !== "disabled"; setStatus(); addFallbackActions(); } else assistantTurns++;
        if (res.proposal) showTicketCard(res.proposal);
        else if (res.offer) addFallbackActions(res.offer);
        else if (!res.fallback) maybeFeedback(false);
      }
    } catch (err) {
      console.error("[support-chat] could not call the support-assistant function:", err && (err.name || ""), err && err.message, err && err.context && err.context.status);
      typing.remove();
      addNotice("We could not reach support right now. Check your connection, or contact us directly.", true);
      addFallbackActions();
    }
    setBusy(false);
  }

  function addFallbackActions(prefill) {
    const box = el("div", "sc__fallback");
    const human = el("button", "btn btn--primary btn--sm", "Contact human support"); human.type = "button";
    human.addEventListener("click", () => { box.remove(); showTicketCard(prefill || { category: "general", subject: "", message: "" }, { manual: !prefill }); });
    const faq = el("a", "btn btn--ghost btn--sm", "Open WhatsApp"); faq.href = `https://wa.me/${BUSINESS.whatsappNumber}`; faq.target = "_blank"; faq.rel = "noopener noreferrer";
    box.append(human, faq);
    log.append(box); scrollDown();
  }

  // ---- History
  async function showHistory() {
    historyPane.hidden = !historyPane.hidden;
    if (historyPane.hidden) return;
    historyPane.innerHTML = "";
    historyPane.append(el("div", "sc__history-title", "Recent conversations"));
    const { data, error } = await supabase.from("support_conversations").select("id,title,updated_at").order("updated_at", { ascending: false }).limit(10);
    if (error || !data || !data.length) { historyPane.append(el("p", "sc__muted", error ? "Could not load history." : "No earlier conversations yet.")); return; }
    data.forEach((c) => {
      const b = el("button", "sc__history-item"); b.type = "button";
      b.append(el("span", "sc__history-name", c.title), el("span", "sc__muted", new Date(c.updated_at).toLocaleDateString("en-KE", { day: "numeric", month: "short" })));
      b.addEventListener("click", () => { historyPane.hidden = true; loadConversation(c.id); });
      historyPane.append(b);
    });
  }

  async function loadConversation(id) {
    const { data, error } = await supabase.from("support_chat_messages").select("role,content,created_at").eq("conversation_id", id).order("created_at", { ascending: true }).limit(60);
    if (error || !data) { addNotice("Could not load that conversation.", true); return; }
    conversationId = id; store.set(id); log.innerHTML = ""; chips.hidden = true; feedbackShown = true;
    data.forEach((m) => addMessage(m.role === "user" ? "user" : "assistant", m.content, m.created_at));
    assistantTurns = data.filter((m) => m.role === "assistant").length;
  }

  function startNew() {
    conversationId = null; store.set(null); assistantTurns = 0; feedbackShown = false;
    log.innerHTML = ""; historyPane.hidden = true; chips.hidden = false;
    addMessage("assistant", WELCOME);
    input.focus({ preventScroll: true });
  }

  function setStatus() {
    const smart = aiOnline && !basicMode;
    dot.className = `sc__dot ${smart ? "sc__dot--on" : "sc__dot--off"}`;
    statusText.textContent = smart ? "Assistant online" : "Basic assistant · human support available";
  }

  function autoGrow() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 120) + "px";
    counter.textContent = input.value.length > 600 ? `${input.value.length}/800` : "";
  }

  // ---- Wire up
  CHIPS.forEach((c) => {
    const b = el("button", "sc__chip", c.label); b.type = "button";
    b.addEventListener("click", () => {
      if (c.human) { chips.hidden = true; showTicketCard({ category: "general", subject: "", message: "" }, { manual: true }); }
      else sendMessage(c.text);
    });
    chips.append(b);
  });
  btnHistory.addEventListener("click", showHistory);
  btnNew.addEventListener("click", startNew);
  input.addEventListener("input", autoGrow);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });
  form.addEventListener("submit", (e) => { e.preventDefault(); sendMessage(input.value); });

  addMessage("assistant", WELCOME);
  if (guest) {
    chips.hidden = true; form.hidden = true; btnHistory.hidden = true; btnNew.hidden = true;
    aiOnline = true; dot.className = "sc__dot sc__dot--on"; statusText.textContent = "Log in to chat";
    const n = el("div", "sc__notice");
    n.append("Please log in to chat about your orders, wallet and account. ");
    const a = el("a", "btn btn--primary btn--sm", "Log in"); a.href = "login";
    n.append(a, document.createTextNode(` Or contact us: ${BUSINESS.email}, WhatsApp +${BUSINESS.whatsappNumber}.`));
    log.append(n);
    return { startNew };
  }

  // Availability from settings (public status RPC); resume this tab's last conversation.
  supabase.rpc("support_public_status").then(({ data }) => {
    aiOnline = !(data && data.ai_enabled === false);
    if (data && data.max_input_chars) input.maxLength = data.max_input_chars;
    setStatus();
  }).catch(() => { aiOnline = true; setStatus(); });
  const last = store.get();
  if (last) loadConversation(last).catch(() => { });
  return { startNew };
}

/** Floating launcher for customer pages (not shown on the Support page, which embeds the chat). */
export function mountLauncher() {
  if (document.querySelector("[data-support-launcher]")) return;
  if (!document.querySelector('link[href$="support-chat.css"]')) {
    const css = document.createElement("link"); css.rel = "stylesheet"; css.href = "css/support-chat.css"; document.head.append(css);
  }
  const btn = el("button", "sc-launcher"); btn.type = "button"; btn.setAttribute("data-support-launcher", "");
  btn.setAttribute("aria-label", "Chat with us: open BTECH Customer Support"); btn.setAttribute("aria-expanded", "false");
  const icon = el("img", "sc-launcher__icon"); icon.src = "assets/brand/chat-launcher.png"; icon.alt = ""; icon.width = 56; icon.height = 56;
  btn.append(icon, el("span", "sc-launcher__label", "Chat with us"));
  const panel = el("div"); panel.hidden = true;
  document.body.append(panel, btn);
  let mounted = false;
  const open = () => {
    if (!mounted) { mountSupportChat(panel, { floating: true, onClose: close }); mounted = true; }
    panel.hidden = false; btn.setAttribute("aria-expanded", "true"); btn.hidden = true;
    document.body.classList.add("sc-open");
    const i = panel.querySelector("textarea"); if (i) i.focus();
  };
  function close() { panel.hidden = true; btn.hidden = false; btn.setAttribute("aria-expanded", "false"); document.body.classList.remove("sc-open"); btn.focus(); }
  btn.addEventListener("click", open);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !panel.hidden) close(); });
}