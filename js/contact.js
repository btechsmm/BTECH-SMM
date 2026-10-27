/* Single source of truth for CUSTOMER SUPPORT contacts. Owner/admin/security/payment-provider contacts live elsewhere
   and are intentionally not touched here. */
export const SUPPORT = Object.freeze({
  email: "support.btechsmm@gmail.com",
  phoneDisplay: "+254 184 425 902",
  phoneE164: "+254184425902",
  whatsappNumber: "254184425902",
  whatsappUrl: "https://wa.me/254184425902",
  telUrl: "tel:+254184425902",
  mailUrl: "mailto:support.btechsmm@gmail.com",
});

// Earlier customer-facing values that may still be baked into files this module does not own (navigation, footer).
const OLD_EMAILS = ["btech.smm1@gmail.com"];
const OLD_DIGITS = ["254112887428", "0112887428", "112887428"];

const ICONS = {
  phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M5 4h4l2 5-2.5 1.500a11 11 0 005 5L15 13l5 2v4a2 2 0 01-2 2A16 16 0 013 6a2 2 0 012-2z"/></svg>',
  mail: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></svg>',
  wa: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M4 20l1.3-4.200A8 8 0 1112 20a8 8 0 01-3.8-1z"/><path d="M9 9c0 3 3 6 6 6l1-2-2-1-1 .8c-.8-.3-1.6-1.1-2-2l.8-1-1-2z"/></svg>',
};

export function supportContactCard() {
  return `
  <section class="contact-card" aria-labelledby="contact-card-title" data-support-contacts>
    <h2 id="contact-card-title">Contact support</h2>
    <p>Our team replies as quickly as possible. Choose whichever channel suits you.</p>
    <ul class="contact-card__list">
      <li><a class="contact-card__item" href="${SUPPORT.whatsappUrl}" target="_blank" rel="noopener noreferrer">${ICONS.wa}<span>WhatsApp<strong>${SUPPORT.phoneDisplay}</strong></span></a></li>
      <li><a class="contact-card__item" href="${SUPPORT.telUrl}">${ICONS.phone}<span>Call us<strong>${SUPPORT.phoneDisplay}</strong></span></a></li>
      <li><a class="contact-card__item" href="${SUPPORT.mailUrl}">${ICONS.mail}<span>Email<strong>${SUPPORT.email}</strong></span></a></li>
    </ul>
  </section>`;
}

function swapOld(str) {
  let out = str;
  OLD_EMAILS.forEach((e) => { out = out.split(e).join(SUPPORT.email); });
  return out;
}

function patchLinks(root) {
  root.querySelectorAll('a[href*="wa.me"], a[href*="api.whatsapp.com"], a.whatsapp-fab').forEach((a) => {
    const h = a.getAttribute("href") || "";
    if (a.classList.contains("whatsapp-fab") || OLD_DIGITS.some((d) => h.includes(d)) || /wa\.me\/\d+/.test(h)) {
      a.setAttribute("href", SUPPORT.whatsappUrl);
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noopener noreferrer");
      if (a.classList.contains("whatsapp-fab") && !a.getAttribute("aria-label")) a.setAttribute("aria-label", "Chat with BTECH SMM support on WhatsApp");
    }
  });
  root.querySelectorAll('a[href^="mailto:"], a[href^="tel:"]').forEach((a) => {
    const h = a.getAttribute("href");
    if (OLD_EMAILS.some((e) => h.includes(e))) {
      a.setAttribute("href", SUPPORT.mailUrl);
      if (a.textContent.includes("@")) a.textContent = SUPPORT.email;
    } else if (h.startsWith("tel:") && OLD_DIGITS.some((d) => h.includes(d))) {
      a.setAttribute("href", SUPPORT.telUrl);
      a.textContent = SUPPORT.phoneDisplay;
    }
  });
  root.querySelectorAll(".site-footer, .site-footer *").forEach((el) => {
    if (el.children.length === 0 && el.textContent) {
      let t = swapOld(el.textContent);
      if (OLD_DIGITS.some((d) => t.replace(/[\s-]/g, "").includes(d))) t = t.replace(/\+?\s*254[\s-]*11[\s-]*288[\s-]*7428|0112\s?887\s?428/g, SUPPORT.phoneDisplay);
      if (t !== el.textContent) el.textContent = t;
    }
  });
}

function ensureCallButton() {
  const fab = document.querySelector("a.whatsapp-fab");
  if (!fab || document.querySelector(".call-fab")) return;
  const call = document.createElement("a");
  call.className = "call-fab";
  call.href = SUPPORT.telUrl;
  call.setAttribute("aria-label", "Call BTECH SMM support");
  call.innerHTML = ICONS.phone;
  fab.insertAdjacentElement("beforebegin", call);
  // follow the WhatsApp button when other code hides it (e.g. while a chat panel is open)
  new MutationObserver(() => call.classList.toggle("whatsapp-fab--hidden", fab.classList.contains("whatsapp-fab--hidden")))
    .observe(fab, { attributes: true, attributeFilter: ["class"] });
}

/** Applies the support contacts to UI rendered by shared files (floating button, footer). Safe to call repeatedly. */
export function initSupportContacts() {
  if (document.body?.dataset.page === "admin") return; // never touch administrator pages
  // Pages not linking the catalogue stylesheet (e.g. legal pages) still need the Call button / contact styles.
  if (!document.querySelector('link[href*="catalogue.css"]')) {
    const l = document.createElement("link"); l.rel = "stylesheet"; l.href = "css/catalogue.css"; document.head.appendChild(l);
  }
  const run = () => { patchLinks(document); ensureCallButton(); };
  run();
  let t = 0;
  new MutationObserver(() => { clearTimeout(t); t = setTimeout(run, 60); })
    .observe(document.body, { childList: true, subtree: true });
}
