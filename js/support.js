/**
 * BTECH CUSTOMER SUPPORT — Support page
 * ----------------------------------------------------------------
 * Chat opens from the floating "Chat with us" button (js/support-chat.js, mounted by main.js) + FAQ from the approved knowledge base + tickets.
 * Tickets are created and answered only through SECURITY DEFINER RPCs (identity = auth.uid()),
 * and customers only ever see customer-visible messages (internal notes are blocked by RLS).
 */

import { supabase } from "./supabase.js";
import { AuthService } from "./auth.js";
import { SUPPORT } from "./contact.js";
import { formatDateTime, escapeHtml, showToast, setButtonLoading } from "./utils.js";

const STATUS = {
  open: ["Open", "processing"], in_progress: ["In progress", "processing"], awaiting_customer: ["Waiting for your reply", "pending"],
  resolved: ["Resolved", "completed"], closed: ["Closed", "completed"],
};
const CATEGORY = { general: "General", account: "Account", service: "Service", order: "Order", payment: "Payment", refund: "Refund", cancellation: "Cancellation", security: "Security", other: "Other" };

async function renderFaqs() {
  const container = document.querySelector("[data-faq-list]");
  if (!container) return;
  let items = [];
  if (AuthService.isAuthenticated()) {
    const { data } = await supabase.from("support_kb").select("title,body").eq("active", true).order("topic").order("title").limit(30);
    items = (data || []).filter((k) => !/^Policies BTECH SMM has not published/.test(k.title)).map((k) => ({ q: k.title, a: k.body }));
  }
  if (!items.length) {
    items = [{ q: "How can I contact BTECH SMM?", a: `Email ${SUPPORT.email}, WhatsApp ${SUPPORT.phoneDisplay} or call ${SUPPORT.phoneDisplay}. Log in to chat with the assistant or send a support request.` }];
  }
  container.innerHTML = items.map((f, i) => `
    <details class="faq-item" ${i === 0 ? "open" : ""}>
      <summary>${escapeHtml(f.q)}</summary>
      <p>${escapeHtml(f.a)}</p>
    </details>`).join("");
}

function ticketCardHtml(t) {
  const [label, tone] = STATUS[t.status] || [t.status, "completed"];
  return `
    <div class="ticket-card" data-ticket="${escapeHtml(t.id)}" tabindex="0" role="button" aria-expanded="false">
      <div class="ticket-card__head">
        <span class="order-id">${escapeHtml(t.id)}</span>
        <span class="badge badge--status badge--${tone}">${escapeHtml(label)}</span>
      </div>
      <p class="ticket-card__subject">${escapeHtml(t.subject)}</p>
      <div class="ticket-meta"><span>${escapeHtml(CATEGORY[t.category] || "General")}</span><span>Opened ${formatDateTime(t.created_at)}</span><span>Updated ${formatDateTime(t.updated_at || t.created_at)}</span></div>
      <div data-thread hidden></div>
    </div>`;
}

async function loadThread(card, ticket) {
  const box = card.querySelector("[data-thread]");
  box.innerHTML = '<p class="muted">Loading…</p>';
  const { data, error } = await supabase.from("support_messages").select("sender,message,created_at").eq("ticket_id", ticket.id).order("created_at", { ascending: true });
  if (error) { box.innerHTML = '<p class="form-error">Could not load messages.</p>'; return; }
  const canReply = ticket.status !== "closed";
  box.innerHTML = `<div class="tk-thread">${(data || []).map((m) => `
      <div class="tk-msg tk-msg--${m.sender}"><small>${m.sender === "support" ? "BTECH Support" : "You"} · ${formatDateTime(m.created_at)}</small>${escapeHtml(m.message)}</div>`).join("")}
    ${canReply ? `<form class="tk-reply" data-reply><textarea class="sc__field" rows="2" maxlength="2000" placeholder="Write a reply" aria-label="Reply"></textarea><button class="btn btn--primary btn--sm" type="submit">Send</button></form><p class="form-error" data-reply-error role="alert"></p>` : ""}</div>`;
  const form = box.querySelector("[data-reply]");
  if (form) {
    form.addEventListener("click", (e) => e.stopPropagation());
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const ta = form.querySelector("textarea"); const btn = form.querySelector("button"); const err = box.querySelector("[data-reply-error]");
      err.textContent = "";
      if (ta.value.trim().length < 2) return;
      setButtonLoading(btn, true, "Sending…");
      const { error: e2 } = await supabase.rpc("support_ticket_reply", { p_ticket_id: ticket.id, p_message: ta.value.trim() });
      setButtonLoading(btn, false);
      if (e2) { err.textContent = e2.message || "Could not send your reply."; return; }
      showToast("Reply sent.", "success");
      await renderTickets();
    });
  }
}

let openTicket = null;
async function renderTickets() {
  const list = document.querySelector("[data-tickets-list]");
  const empty = document.querySelector("[data-tickets-empty]");
  if (!list) return;

  if (!AuthService.isAuthenticated()) {
    list.hidden = true;
    if (empty) {
      empty.hidden = false;
      empty.innerHTML = `<p>Log in to view or create support tickets.</p><a href="login" class="btn btn--primary btn--sm">Log in</a>`;
    }
    return;
  }

  const { data, error } = await supabase.from("support_tickets")
    .select("id,subject,status,category,created_at,updated_at").order("updated_at", { ascending: false }).limit(50);
  if (error || !data || data.length === 0) {
    list.hidden = true;
    if (empty) empty.hidden = false;
    return;
  }
  list.hidden = false;
  if (empty) empty.hidden = true;
  list.innerHTML = data.map(ticketCardHtml).join("");
  const toggle = async (card) => {
    const t = data.find((x) => x.id === card.dataset.ticket);
    const thread = card.querySelector("[data-thread]");
    const willOpen = thread.hidden;
    list.querySelectorAll("[data-thread]").forEach((n) => { n.hidden = true; n.parentElement.setAttribute("aria-expanded", "false"); });
    if (willOpen) { thread.hidden = false; card.setAttribute("aria-expanded", "true"); openTicket = t.id; await loadThread(card, t); } else openTicket = null;
  };
  list.querySelectorAll("[data-ticket]").forEach((card) => {
    card.addEventListener("click", (e) => { if (!e.target.closest("[data-thread]")) toggle(card); });
    card.addEventListener("keydown", (e) => { if ((e.key === "Enter" || e.key === " ") && e.target === card) { e.preventDefault(); toggle(card); } });
  });
  if (openTicket) { const c = list.querySelector(`[data-ticket="${CSS.escape(openTicket)}"]`); if (c) toggle(c); }
}

function initTicketForm() {
  const form = document.querySelector("[data-ticket-form]");
  if (!form) return;
  let reqKey = crypto.randomUUID ? crypto.randomUUID() : String(Date.now());

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const submitBtn = form.querySelector("[type=submit]");
    const errorBox = form.querySelector("[data-form-error]");
    const subject = form.querySelector("[name=subject]").value.trim();
    const message = form.querySelector("[name=message]").value.trim();
    const category = (form.querySelector("[name=category]") || {}).value || "general";
    errorBox.textContent = "";

    if (!AuthService.isAuthenticated()) { errorBox.textContent = "Please log in to submit a support request."; return; }
    if (subject.length < 4) { errorBox.textContent = "Please enter a short subject for your request."; return; }
    if (message.length < 10) { errorBox.textContent = "Please describe your issue in a little more detail."; return; }

    setButtonLoading(submitBtn, true, "Sending…");
    const { data, error } = await supabase.rpc("support_create_ticket", {
      p_subject: subject, p_message: message, p_category: category, p_idempotency_key: reqKey, p_source: "form",
    });
    setButtonLoading(submitBtn, false);

    if (error) { errorBox.textContent = error.message || "We couldn't submit your request. Please try again."; return; }
    reqKey = crypto.randomUUID ? crypto.randomUUID() : String(Date.now());
    await renderTickets();
    form.reset();
    showToast(`Support request submitted. Reference ${data.ticket_id}.`, "success");
  });
}

export async function initSupportPage() {
  document.addEventListener("support:ticket-created", () => renderTickets());
  await Promise.all([renderFaqs(), renderTickets()]);
  initTicketForm();
}