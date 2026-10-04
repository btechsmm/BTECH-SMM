/**
 * BTECH SMM — Utilities
 * ----------------------------------------------------------------
 * Shared formatting, validation and small UI helpers used across
 * every page. Keeping these in one place avoids duplicate logic
 * scattered through individual scripts.
 */

export function formatCurrency(amount, currency = "KES") {
  const value = Number(amount) || 0;
  return new Intl.NumberFormat("en-KE", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

export function formatNumber(n) {
  return new Intl.NumberFormat("en-KE").format(Number(n) || 0);
}

export function formatDate(iso, opts = {}) {
  try {
    const d = new Date(iso);
    return new Intl.DateTimeFormat("en-KE", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      ...opts,
    }).format(d);
  } catch {
    return iso;
  }
}

export function formatDateTime(iso) {
  return formatDate(iso, { hour: "2-digit", minute: "2-digit" });
}

export function timeAgo(iso) {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  const steps = [
    ["year", 31536000],
    ["month", 2592000],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ];
  for (const [label, secs] of steps) {
    const value = Math.floor(seconds / secs);
    if (value >= 1) return `${value} ${label}${value > 1 ? "s" : ""} ago`;
  }
  return "just now";
}

export function isValidUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    // A social-media target can never be a page on this site itself — this
    // guards against accidentally (or manually, during testing) submitting
    // the app's own URL as the "target," which is a real issue seen in
    // production data: orders where `target` was a service-order.html link
    // instead of an actual TikTok/Instagram/etc. URL.
    if (typeof window !== "undefined" && url.origin === window.location.origin) return false;
    return true;
  } catch {
    return false;
  }
}

export function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value).trim());
}

export function generateId(prefix = "id") {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function debounce(fn, delay = 250) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

export function setText(selector, value, scope = document) {
  const el = scope.querySelector(selector);
  if (el) el.textContent = value;
}

export function qs(selector, scope = document) {
  return scope.querySelector(selector);
}

export function qsa(selector, scope = document) {
  return Array.from(scope.querySelectorAll(selector));
}

export function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

/** Generic, user-safe error message. Never surface raw JS errors. */
export function friendlyError(context = "") {
  const messages = {
    network: "Please check your internet connection and try again.",
    load: "Unable to load this content right now. Please try again.",
    validation: "Please check the highlighted fields and try again.",
    generic: "Something went wrong. Please try again.",
  };
  return messages[context] || messages.generic;
}

let toastContainer = null;
export function showToast(message, type = "info", duration = 3500) {
  if (!toastContainer) {
    toastContainer = document.createElement("div");
    toastContainer.className = "toast-stack";
    toastContainer.setAttribute("aria-live", "polite");
    document.body.appendChild(toastContainer);
  }
  const toast = document.createElement("div");
  toast.className = `toast toast--${type}`;
  toast.textContent = message;
  toastContainer.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("toast--visible"));
  setTimeout(() => {
    toast.classList.remove("toast--visible");
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

export function setButtonLoading(button, isLoading, loadingText = "Please wait…") {
  if (!button) return;
  if (isLoading) {
    button.dataset.originalText = button.dataset.originalText || button.innerHTML;
    button.disabled = true;
    button.classList.add("is-loading");
    button.innerHTML = `<span class="spinner" aria-hidden="true"></span> ${loadingText}`;
  } else {
    button.disabled = false;
    button.classList.remove("is-loading");
    if (button.dataset.originalText) button.innerHTML = button.dataset.originalText;
  }
}

/**
 * Lightweight, reusable scroll-reveal: fades/slides matching elements in
 * once as they enter the viewport, then stops watching them. Respects
 * prefers-reduced-motion (skips entirely) and no-ops safely if
 * IntersectionObserver isn't available. Call after the matching elements
 * exist in the DOM (e.g. right after setting innerHTML).
 */
export function initScrollReveal(selector = "[data-reveal]") {
  const elements = document.querySelectorAll(selector);
  if (elements.length === 0) return;

  // If we're not going to animate (reduced-motion, or no IntersectionObserver
  // support), reveal everything immediately instead of leaving it stuck at
  // opacity:0 forever — the CSS hides [data-reveal] by default regardless of
  // whether JS ends up animating it in.
  const shouldSkip = (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) || !("IntersectionObserver" in window);
  if (shouldSkip) {
    elements.forEach((el) => el.classList.add("reveal-visible"));
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("reveal-visible");
          observer.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.1, rootMargin: "0px 0px -40px 0px" }
  );
  elements.forEach((el) => observer.observe(el));
}

/**
 * Polls the mpesa-daraja check-status action until the payment reaches a
 * terminal state (paid/failed/cancelled) or the timeout elapses. Read-only
 * on every poll — cannot itself cause a duplicate credit or double-submit
 * anything, since it never writes.
 */
export async function pollPaymentStatus(supabase, paymentId, { intervalMs = 3000, timeoutMs = 90000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const { data, error } = await supabase.functions.invoke("mpesa-daraja", { body: { action: "check-status", payment_id: paymentId } });
      if (!error && data?.ok) {
        const status = data.payment.status;
        if (["paid", "failed", "cancelled", "expired"].includes(status)) return data.payment;
      }
    } catch {
      /* transient network hiccup — keep polling until the timeout */
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  // Client-side give-up only — the real payment may still resolve later via
  // the callback; this just stops the UI from polling forever.
  return { status: "timeout" };
}