/**
 * BTECH SMM — Notifications Module (Supabase — Phase 4)
 * ----------------------------------------------------------------
 * Renders the notification bell dropdown from the `notifications`
 * table (RLS-scoped to the signed-in user). Not yet using Supabase
 * Realtime — the list refreshes on page load / panel open rather
 * than live-pushing, which is a reasonable next enhancement once
 * the rest of Phase 4 is stable.
 */

import { supabase } from "./supabase.js";
import { timeAgo, escapeHtml } from "./utils.js";

const ICONS = {
  order: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h16M4 12h16M4 17h10"/></svg>`,
  payment: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/></svg>`,
  support: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 19c-4.4 0-8-3.1-8-7s3.6-7 8-7 8 3.1 8 7c0 1.5-.5 2.9-1.3 4l1.3 3-3.5-1.2c-1.4.8-3 1.2-4.5 1.2z"/></svg>`,
  system: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 8v5M12 16h.01"/><circle cx="12" cy="12" r="9"/></svg>`,
};

let _cache = [];

async function fetchNotifications() {
  const { data, error } = await supabase.from("notifications").select("*").order("created_at", { ascending: false }).limit(30);
  if (error) return [];
  _cache = data.map((n) => ({ id: n.id, type: n.type, title: n.title, text: n.text, date: n.created_at, read: n.read }));
  return _cache;
}

function unreadCountFromCache() {
  return _cache.filter((n) => !n.read).length;
}

async function markAllRead() {
  const unreadIds = _cache.filter((n) => !n.read).map((n) => n.id);
  if (unreadIds.length === 0) return;
  await supabase.from("notifications").update({ read: true }).in("id", unreadIds);
  _cache = _cache.map((n) => ({ ...n, read: true }));
}

async function renderBadge() {
  const badge = document.querySelector("[data-notif-badge]");
  if (!badge) return;
  const count = unreadCountFromCache();
  badge.textContent = String(count);
  badge.hidden = count === 0;
}

function renderList(container) {
  if (!container) return;
  if (_cache.length === 0) {
    container.innerHTML = `<div class="empty-state empty-state--compact"><p>No notifications yet.</p></div>`;
    return;
  }
  container.innerHTML = _cache
    .map(
      (n) => `
      <div class="notif-item ${n.read ? "" : "notif-item--unread"}" data-id="${n.id}">
        <span class="notif-item__icon">${ICONS[n.type] || ICONS.system}</span>
        <div class="notif-item__body">
          <p class="notif-item__title">${escapeHtml(n.title)}</p>
          <p class="notif-item__text">${escapeHtml(n.text)}</p>
          <span class="notif-item__time">${timeAgo(n.date)}</span>
        </div>
      </div>`
    )
    .join("");
}

async function initAndRender(root = document) {
  await fetchNotifications();
  renderList(root.querySelector("[data-notif-list]"));
  await renderBadge();
}

export const NotificationsService = {
  fetchNotifications,
  markAllRead,
  renderBadge,
  renderList,
  initAndRender,
};
