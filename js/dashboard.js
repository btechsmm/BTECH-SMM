/**
 * BTECH SMM — Dashboard Module (Supabase — Phase 4)
 * ----------------------------------------------------------------
 * Pulls wallet balance and orders (RLS-scoped to the signed-in
 * user) to render the summary stats and recent-orders preview.
 */

import { supabase } from "./supabase.js";
import { AuthService } from "./auth.js";
import { findService, ServicesService, ServicesData } from "./services.js";
import { formatCurrency, formatDateTime, escapeHtml, setText } from "./utils.js";

const STATUS_LABEL = { pending: "Pending", processing: "Processing", completed: "Completed", cancelled: "Cancelled" };

export async function initDashboard() {
  const user = AuthService.getCurrentUser();
  const welcome = document.querySelector("[data-welcome-name]");
  if (welcome) welcome.textContent = user?.name?.split(" ")[0] || "there";

  await ServicesService.preload();

  const [{ data: wallet }, { data: orders }] = await Promise.all([
    supabase.from("wallets").select("balance").eq("user_id", user.id).single(),
    supabase.from("orders").select("*").order("created_at", { ascending: false }),
  ]);

  const balance = wallet ? Number(wallet.balance) : 0;
  const orderList = orders || [];

  const totalOrders = orderList.length;
  const active = orderList.filter((o) => o.status === "pending" || o.status === "processing").length;
  const completed = orderList.filter((o) => o.status === "completed").length;
  const totalSpent = orderList.reduce((sum, o) => sum + Number(o.amount), 0);

  setText("[data-stat-balance]", formatCurrency(balance));
  setText("[data-stat-total-orders]", String(totalOrders));
  setText("[data-stat-active-orders]", String(active));
  setText("[data-stat-completed-orders]", String(completed));
  setText("[data-stat-total-spent]", formatCurrency(totalSpent));

  const recentContainer = document.querySelector("[data-recent-orders]");
  const emptyState = document.querySelector("[data-recent-orders-empty]");
  if (recentContainer) {
    const recent = orderList.slice(0, 5);
    if (recent.length === 0) {
      recentContainer.hidden = true;
      if (emptyState) emptyState.hidden = false;
    } else {
      recentContainer.hidden = false;
      if (emptyState) emptyState.hidden = true;
      recentContainer.innerHTML = recent
        .map((o) => {
          const service = findService(o.service_id);
          return `
          <a class="recent-order" href="order-details.html?id=${o.id}">
            <div>
              <p class="recent-order__name">${escapeHtml(service?.name || "Order")}</p>
              <p class="recent-order__meta">${o.id} · ${formatDateTime(o.created_at)}</p>
            </div>
            <div class="recent-order__right">
              <span class="badge badge--status badge--${o.status}">${STATUS_LABEL[o.status]}</span>
              <span class="recent-order__amount">${formatCurrency(Number(o.amount))}</span>
            </div>
          </a>`;
        })
        .join("");
    }
  }

  // Popular services: the catalogue's own "featured" services, already loaded
  // by ServicesService.preload() above. Hidden if there are none / on error.
  const popularPanel = document.querySelector("[data-popular-panel]");
  const popularList = document.querySelector("[data-popular-services]");
  if (popularPanel && popularList && !ServicesService.hasError()) {
    const popular = ServicesService.list().filter((s) => s.featured).slice(0, 4);
    if (popular.length > 0) {
      popularPanel.hidden = false;
      popularList.innerHTML = popular
        .map(
          (s) => `
          <a class="recent-order" href="service-order.html?service=${s.id}">
            <div>
              <p class="recent-order__name">${escapeHtml(s.name)}</p>
              <p class="recent-order__meta">${escapeHtml(ServicesData.platformLabel(s.platform))}</p>
            </div>
            <div class="recent-order__right">
              <span class="recent-order__amount">${formatCurrency(s.pricePer1000)}<span class="muted"> / ${s.unit ? escapeHtml(s.unit) : "1,000"}</span></span>
            </div>
          </a>`
        )
        .join("");
    }
  }
}