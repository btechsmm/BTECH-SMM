/**
 * BTECH SMM — Ambassador application (customer side)
 * ----------------------------------------------------------------
 * The formal "Apply to Become an Ambassador" form and the applicant's status views.
 *
 * Submitting only creates an application record (submit_ambassador_application). It does NOT
 * create an ambassador, an Ambassador ID, a referral code or any earning: those exist only after an
 * administrator approves the application through the existing ambassador activation process.
 *
 * The browser validates for convenience; the database re-validates everything (lengths, phone and
 * email shape, every acknowledgement, the conflict explanation, rate limits, one open application).
 * The profile photo reuses the existing cropper, storage bucket and validator (photo.js).
 */

import { supabase } from "./supabase.js";
import { AuthService } from "./auth.js";
import { BUSINESS } from "./config.js";
import { createCropper, photoUrl, uploadPhoto, removePhoto } from "./photo.js";
import { formatDate, formatDateTime, escapeHtml, isValidEmail, showToast, setButtonLoading } from "./utils.js";

export const SENSITIVE_WARNING = "Do not include passwords, OTPs, M-Pesa PINs, bank details or sensitive identity documents.";

const LIMITS = { why: [30, 1500], exp: 1500, channels: [10, 1000], conflict: [10, 1000] };
const normalisePhone = (v) => String(v || "").replace(/[\s().-]/g, "");

const STATUS_LABEL = { submitted: "Under review", clarification_requested: "More information needed", approved: "Approved", declined: "Not approved" };
const STATUS_BADGE = { submitted: "pending", clarification_requested: "processing", approved: "completed", declined: "cancelled" };

function contactLine() {
  return `Questions? Email <a href="mailto:${BUSINESS.email}" style="color:var(--color-primary)">${BUSINESS.email}</a> or WhatsApp ${BUSINESS.phone}.`;
}

/* ------------------------------ entry point ------------------------------ */
/** The call-to-action shown under "How the Ambassador Program works". */
export function applyEntryHtml(label = "Apply to Become an Ambassador") {
  return `
    <div class="panel apply-cta" style="margin-bottom:var(--sp-6)"><div class="panel__body panel__body--padded">
      <div class="apply-cta__text">
        <h3 style="margin-bottom:var(--sp-1)">Ready to join?</h3>
        <p class="muted" style="margin:0">Submit an application for review. Applying does not guarantee approval or earnings.</p>
      </div>
      <button type="button" class="btn btn--primary" data-apply-open>${escapeHtml(label)}</button>
    </div></div>`;
}

/* ------------------------------- the form -------------------------------- */
function checkbox(name, html) {
  return `<div class="form-field apply-check"><label class="checkbox-row"><input type="checkbox" name="${name}" aria-describedby="err-${name}" /> <span>${html}</span></label><span class="form-error" id="err-${name}" role="alert"></span></div>`;
}

function formHtml(user, existingPhoto) {
  const u = user || {};
  return `
    <div class="panel apply-panel"><div class="panel__head"><h3>Ambassador application</h3></div>
    <div class="panel__body panel__body--padded">
      <div class="apply-warning" role="note"><strong>Keep it safe.</strong> ${escapeHtml(SENSITIVE_WARNING)}</div>
      <form data-apply-form novalidate autocomplete="on">
        <p class="form-error" data-form-error role="alert"></p>

        <fieldset class="apply-set"><legend>About you</legend>
          <div class="form-field"><label for="ap-name">Full name <span class="req" aria-hidden="true">*</span></label>
            <input id="ap-name" name="full_name" type="text" autocomplete="name" maxlength="100" required aria-describedby="err-full_name" value="${escapeHtml(u.name || "")}" />
            <span class="form-error" id="err-full_name" role="alert"></span></div>
          <div class="form-field"><label for="ap-display">Name to show on your badge <span class="muted">(optional)</span></label>
            <input id="ap-display" name="display_name" type="text" maxlength="40" aria-describedby="hint-display err-display_name" />
            <span class="form-hint" id="hint-display">If you leave this blank, your full name is used. 2 to 40 characters.</span>
            <span class="form-error" id="err-display_name" role="alert"></span></div>
          <div class="apply-grid">
            <div class="form-field"><label for="ap-phone">Phone / WhatsApp number <span class="req" aria-hidden="true">*</span></label>
              <input id="ap-phone" name="phone" type="tel" inputmode="tel" autocomplete="tel" maxlength="20" placeholder="07XX XXX XXX" required aria-describedby="err-phone" value="${escapeHtml(u.phone || "")}" />
              <span class="form-error" id="err-phone" role="alert"></span></div>
            <div class="form-field"><label for="ap-email">Email address <span class="req" aria-hidden="true">*</span></label>
              <input id="ap-email" name="email" type="email" autocomplete="email" maxlength="254" required aria-describedby="err-email" value="${escapeHtml(u.email || "")}" />
              <span class="form-error" id="err-email" role="alert"></span></div>
          </div>
          <div class="form-field"><label for="ap-user">BTECH SMM username or user ID <span class="muted">(optional)</span></label>
            <input id="ap-user" name="btech_username" type="text" maxlength="60" autocomplete="username" aria-describedby="err-btech_username" />
            <span class="form-error" id="err-btech_username" role="alert"></span></div>
          <div class="form-field"><label>Profile photo ${existingPhoto ? `<span class="muted">(optional, you already have one)</span>` : `<span class="req" aria-hidden="true">*</span>`}</label>
            ${existingPhoto ? `<img class="amb-avatar amb-avatar--img amb-avatar--lg" src="${escapeHtml(existingPhoto)}" alt="Your current photo" style="margin-bottom:var(--sp-2)" />` : ""}
            <div data-photo-cropper></div>
            <span class="form-hint">Used on your Ambassador badge if you are approved.</span>
            <span class="form-error" id="err-photo" role="alert"></span></div>
        </fieldset>

        <fieldset class="apply-set"><legend>Your application</legend>
          <div class="form-field"><label for="ap-why">Why do you want to join? <span class="req" aria-hidden="true">*</span></label>
            <textarea id="ap-why" name="motivation" rows="5" maxlength="${LIMITS.why[1]}" required aria-describedby="hint-why err-motivation"></textarea>
            <span class="form-hint" id="hint-why"><span data-count-for="motivation">0</span> / ${LIMITS.why[1]} (at least ${LIMITS.why[0]} characters)</span>
            <span class="form-error" id="err-motivation" role="alert"></span></div>
          <div class="form-field"><label for="ap-exp">Relevant experience or skills <span class="muted">(optional)</span></label>
            <textarea id="ap-exp" name="experience" rows="3" maxlength="${LIMITS.exp}" aria-describedby="err-experience"></textarea>
            <span class="form-error" id="err-experience" role="alert"></span></div>
          <div class="form-field"><label for="ap-channels">Where will you promote BTECH SMM? <span class="req" aria-hidden="true">*</span></label>
            <textarea id="ap-channels" name="promotion_channels" rows="3" maxlength="${LIMITS.channels[1]}" required aria-describedby="hint-channels err-promotion_channels" placeholder="Social media pages, WhatsApp or Telegram groups, communities, events…"></textarea>
            <span class="form-hint" id="hint-channels">List the channels and communities you plan to use, with links or names where you can.</span>
            <span class="form-error" id="err-promotion_channels" role="alert"></span></div>
        </fieldset>

        <fieldset class="apply-set" aria-describedby="hint-conflict"><legend>Conflict of interest <span class="req" aria-hidden="true">*</span></legend>
          <p class="form-hint" id="hint-conflict">Declare any relationship that could affect, or appear to affect, your ability to promote BTECH SMM honestly. If you are unsure, declare it and explain.</p>
          <div class="apply-radios" role="radiogroup" aria-describedby="err-conflict_declared">
            <label class="checkbox-row"><input type="radio" name="conflict_declared" value="false" /> <span>I have no conflict of interest to declare.</span></label>
            <label class="checkbox-row"><input type="radio" name="conflict_declared" value="true" /> <span>I have a conflict of interest to declare.</span></label>
          </div>
          <span class="form-error" id="err-conflict_declared" role="alert"></span>
          <div class="form-field" data-conflict-box hidden><label for="ap-conflict">Please explain <span class="req" aria-hidden="true">*</span></label>
            <textarea id="ap-conflict" name="conflict_details" rows="3" maxlength="${LIMITS.conflict[1]}" aria-describedby="err-conflict_details"></textarea>
            <span class="form-error" id="err-conflict_details" role="alert"></span></div>
        </fieldset>

        <fieldset class="apply-set"><legend>Acknowledgements <span class="req" aria-hidden="true">*</span></legend>
          ${checkbox("ack_accuracy", "I confirm that the information in this application is accurate and complete.")}
          ${checkbox("ack_honest_promotion", "I will promote BTECH SMM honestly and will not make false or misleading claims about its services, prices or results.")}
          ${checkbox("ack_privacy", `I understand that BTECH SMM will use the information in this application to review it, in line with the <a href="privacy" target="_blank" rel="noopener">Privacy Policy</a>.`)}
          ${checkbox("ack_no_guarantee", "I understand that applying does not guarantee approval, and that there is no guarantee of any earnings.")}
          ${checkbox("ack_badge_display", "If I am approved, I agree that my photo, name and Ambassador ID may appear on my BTECH SMM badge and its public verification page.")}
        </fieldset>

        <fieldset class="apply-set"><legend>Confirm and submit</legend>
          <div class="form-field"><label for="ap-confirm">Type your full name to confirm <span class="req" aria-hidden="true">*</span></label>
            <input id="ap-confirm" name="confirmation_name" type="text" maxlength="100" autocomplete="off" aria-describedby="hint-confirm err-confirmation_name" />
            <span class="form-hint" id="hint-confirm">Typing your name is your digital confirmation. The date and time of submission are recorded by our server when you submit.</span>
            <span class="form-error" id="err-confirmation_name" role="alert"></span></div>
        </fieldset>

        <!-- Spam trap: hidden from people, visible to simple bots. Leave empty. -->
        <div class="apply-hp" aria-hidden="true"><label>Website<input type="text" name="website" tabindex="-1" autocomplete="off" /></label></div>

        <div class="apply-actions">
          <button type="submit" class="btn btn--primary">Submit application</button>
          <button type="button" class="btn btn--secondary" data-apply-cancel>Cancel</button>
        </div>
      </form></div></div>`;
}

/** Mounts the form into `root`. `onDone()` is called to re-render the page after a successful submission. */
export function mountApplicationForm(root, { existingPhotoPath = null, onCancel, onDone } = {}) {
  const user = AuthService.getCurrentUser();
  const existingPhoto = existingPhotoPath ? photoUrl(existingPhotoPath) : null;
  root.innerHTML = formHtml(user, existingPhoto);
  const form = root.querySelector("[data-apply-form]");
  const cropper = createCropper(form.querySelector("[data-photo-cropper]"));
  const startedAt = Date.now();
  const f = form.elements;

  const setErr = (name, msg) => {
    const el = form.querySelector(`#err-${name}`);
    if (el) el.textContent = msg || "";
    const input = form.querySelector(`[name="${name}"]`);
    if (input) input.setAttribute("aria-invalid", msg ? "true" : "false");
  };
  const clearAll = () => {
    form.querySelectorAll(".form-error").forEach((e) => (e.textContent = ""));
    form.querySelectorAll("[aria-invalid]").forEach((e) => e.removeAttribute("aria-invalid"));
  };

  // live character counter + conflict box
  const why = f.motivation;
  const counter = form.querySelector('[data-count-for="motivation"]');
  why.addEventListener("input", () => (counter.textContent = String(why.value.length)));
  const box = form.querySelector("[data-conflict-box]");
  form.querySelectorAll('[name="conflict_declared"]').forEach((r) =>
    r.addEventListener("change", () => {
      box.hidden = form.querySelector('[name="conflict_declared"]:checked')?.value !== "true";
    })
  );

  form.querySelector("[data-apply-cancel]").addEventListener("click", () => onCancel?.());

  function validate() {
    const errors = {};
    const v = (n) => String(f[n].value || "").trim();
    if (v("full_name").length < 2) errors.full_name = "Please enter your full name.";
    if (v("display_name") && (v("display_name").length < 2 || v("display_name").length > 40)) errors.display_name = "Use 2 to 40 characters, or leave it blank.";
    if (!/^\+?[0-9]{9,15}$/.test(normalisePhone(f.phone.value))) errors.phone = "Enter a valid phone / WhatsApp number, for example 0712 345 678.";
    if (!isValidEmail(v("email"))) errors.email = "Enter a valid email address.";
    if (v("btech_username").length > 60) errors.btech_username = "That is too long (maximum 60 characters).";
    if (!existingPhoto && !cropper.hasImage()) errors.photo = "Please add a profile photo.";
    if (v("motivation").length < LIMITS.why[0]) errors.motivation = `Please write at least ${LIMITS.why[0]} characters about why you want to join.`;
    if (v("promotion_channels").length < LIMITS.channels[0]) errors.promotion_channels = "Tell us where you will promote BTECH SMM.";
    const conflict = form.querySelector('[name="conflict_declared"]:checked');
    if (!conflict) errors.conflict_declared = "Please choose one option.";
    else if (conflict.value === "true" && v("conflict_details").length < LIMITS.conflict[0]) errors.conflict_details = "Please explain your conflict of interest.";
    for (const k of ["ack_accuracy", "ack_honest_promotion", "ack_privacy", "ack_no_guarantee", "ack_badge_display"]) {
      if (!f[k].checked) errors[k] = "Please tick this box to continue.";
    }
    if (v("confirmation_name").length < 2) errors.confirmation_name = "Type your full name to confirm.";
    else if (v("confirmation_name").toLowerCase().replace(/\s+/g, " ") !== v("full_name").toLowerCase().replace(/\s+/g, " ")) errors.confirmation_name = "This should match the full name above.";
    return errors;
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearAll();
    const topError = form.querySelector("[data-form-error]");
    const errors = validate();
    const keys = Object.keys(errors);
    if (keys.length) {
      keys.forEach((k) => setErr(k, errors[k]));
      topError.textContent = "Please fix the highlighted fields and try again.";
      const first = form.querySelector(`[name="${keys[0]}"]`) || form.querySelector(`#err-${keys[0]}`);
      first?.focus?.();
      first?.scrollIntoView?.({ block: "center", behavior: "smooth" });
      return;
    }

    const btn = form.querySelector("[type=submit]");
    setButtonLoading(btn, true, "Submitting…");
    let path = null;
    try {
      if (cropper.hasImage()) path = await uploadPhoto(await cropper.getBlob());
      const payload = {
        full_name: f.full_name.value,
        display_name: f.display_name.value,
        phone: normalisePhone(f.phone.value),
        email: f.email.value,
        btech_username: f.btech_username.value,
        motivation: f.motivation.value,
        experience: f.experience.value,
        promotion_channels: f.promotion_channels.value,
        conflict_declared: form.querySelector('[name="conflict_declared"]:checked').value,
        conflict_details: f.conflict_details.value,
        ack_accuracy: "true",
        ack_honest_promotion: "true",
        ack_privacy: "true",
        ack_no_guarantee: "true",
        ack_badge_display: "true",
        confirmation_name: f.confirmation_name.value,
        photo_path: path || "",
        website: f.website.value, // honeypot
        elapsed_ms: String(Date.now() - startedAt),
      };
      const { data, error } = await supabase.rpc("submit_ambassador_application", { p_payload: payload });
      if (error) throw new Error(error.message || "Couldn't submit your application.");
      setButtonLoading(btn, false);
      showConfirmation(root, data);
      showToast("Application submitted.", "success");
      onDone?.();
    } catch (ex) {
      await removePhoto(path); // never leave an unused upload behind
      setButtonLoading(btn, false);
      topError.textContent = ex.message || "Couldn't submit your application. Please try again.";
      topError.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  });
}

function showConfirmation(root, r) {
  root.innerHTML = `
    <div class="panel apply-done"><div class="panel__body panel__body--padded">
      <h3>Application received</h3>
      <p>Thank you. Your application is now in the review queue.</p>
      <dl class="apply-ref">
        <div><dt>Reference</dt><dd>${escapeHtml(r?.reference || "")}</dd></div>
        <div><dt>Submitted</dt><dd>${r?.submitted_at ? escapeHtml(formatDateTime(r.submitted_at)) : ""}</dd></div>
        <div><dt>Status</dt><dd>Under review</dd></div>
      </dl>
      <p class="form-hint">Keep your reference for any questions. Submitting an application does not activate any ambassador features, and it does not guarantee approval or earnings. ${contactLine()}</p>
      <button type="button" class="btn btn--secondary" data-apply-refresh>Continue</button>
    </div></div>`;
  root.querySelector("[data-apply-refresh]")?.addEventListener("click", () => window.location.reload());
}

/* ---------------------------- applicant status ---------------------------- */
export function applicationStatusHtml(a) {
  const history = (a.history || [])
    .map((h) => {
      const who = { submitted: "You submitted your application", applicant_replied: "You replied", clarification_requested: "BTECH SMM asked for more information", approved: "Approved", declined: "Not approved" }[h.event] || h.event;
      return `<li><span>${escapeHtml(formatDateTime(h.at))} · ${escapeHtml(who)}</span>${h.message ? `<br /><span class="apply-msg">${escapeHtml(h.message)}</span>` : ""}</li>`;
    })
    .join("");
  const ref = `<dl class="apply-ref">
      <div><dt>Reference</dt><dd>${escapeHtml(a.reference)}</dd></div>
      <div><dt>Submitted</dt><dd>${escapeHtml(formatDate(a.submitted_at))}</dd></div>
      <div><dt>Status</dt><dd><span class="badge badge--status badge--${STATUS_BADGE[a.status]}">${STATUS_LABEL[a.status]}</span></dd></div>
    </dl>`;

  if (a.status === "submitted") {
    return `<div class="panel" style="margin-bottom:var(--sp-6)"><div class="panel__body panel__body--padded">
      <h3 style="margin-bottom:var(--sp-2)">Application under review</h3>
      <p>Thanks, ${escapeHtml(a.full_name)}. We will notify you once it has been reviewed. Ambassador features such as your referral link and withdrawals become available only if you are approved.</p>
      ${ref}${history ? `<ul class="amb-mini apply-history">${history}</ul>` : ""}
      <p class="form-hint">${contactLine()}</p></div></div>`;
  }
  if (a.status === "clarification_requested") {
    return `<div class="panel" style="margin-bottom:var(--sp-6)"><div class="panel__body panel__body--padded">
      <h3 style="margin-bottom:var(--sp-2)">We need a little more information</h3>
      ${a.message ? `<blockquote class="apply-quote">${escapeHtml(a.message)}</blockquote>` : ""}
      ${ref}
      <form data-apply-reply novalidate>
        <p class="form-error" data-form-error role="alert"></p>
        <div class="form-field"><label for="ap-reply">Your reply</label>
          <textarea id="ap-reply" name="reply" rows="4" maxlength="1500" required></textarea>
          <span class="form-hint">${escapeHtml(SENSITIVE_WARNING)}</span></div>
        <button type="submit" class="btn btn--primary">Send reply</button>
      </form>
      ${history ? `<ul class="amb-mini apply-history">${history}</ul>` : ""}</div></div>`;
  }
  if (a.status === "declined") {
    return `<div class="panel" style="margin-bottom:var(--sp-6)"><div class="panel__body panel__body--padded">
      <h3 style="margin-bottom:var(--sp-2)">Application not approved</h3>
      <p>Your application wasn't approved this time.${a.message ? "" : " You are welcome to apply again."}</p>
      ${a.message ? `<blockquote class="apply-quote">${escapeHtml(a.message)}</blockquote>` : ""}
      ${ref}${history ? `<ul class="amb-mini apply-history">${history}</ul>` : ""}
      <p class="form-hint">${contactLine()}</p></div></div>`;
  }
  return "";
}

export function wireReplyForm(scope, reload) {
  const form = scope.querySelector("[data-apply-reply]");
  if (!form) return;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = form.querySelector("[data-form-error]");
    err.textContent = "";
    const msg = form.reply.value.trim();
    if (msg.length < 2) return void (err.textContent = "Please write a reply.");
    const btn = form.querySelector("[type=submit]");
    setButtonLoading(btn, true, "Sending…");
    const { error } = await supabase.rpc("respond_to_ambassador_application", { p_message: msg });
    setButtonLoading(btn, false);
    if (error) return void (err.textContent = error.message || "Couldn't send your reply.");
    showToast("Reply sent.", "success");
    reload();
  });
}
