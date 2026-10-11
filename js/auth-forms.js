/**
 * BTECH SMM — Auth Forms Module
 * ----------------------------------------------------------------
 * Wires the login, register, forgot-password and reset-password
 * forms to AuthService (Supabase Auth). Kept separate from auth.js so
 * that module stays focused on session logic, not DOM handling.
 */

import { AuthService } from "./auth.js";
import { setButtonLoading, showToast } from "./utils.js";
import { takeAuthRedirectError } from "./shell.js";

function wireForm(formSelector, handler, successRedirect) {
  const form = document.querySelector(formSelector);
  if (!form) return;
  const submitBtn = form.querySelector("[type=submit]");
  const errorBox = form.querySelector("[data-form-error]");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (errorBox) errorBox.textContent = "";
    setButtonLoading(submitBtn, true);

    const data = Object.fromEntries(new FormData(form).entries());
    const result = await handler(data);

    setButtonLoading(submitBtn, false);

    if (!result.ok) {
      if (errorBox) errorBox.textContent = result.error || "Something went wrong. Please try again.";
      return;
    }

    if (typeof successRedirect === "function") {
      successRedirect(result);
    }
  });
}

/* ------------------------------ Google sign-in ------------------------------ */
// Short, safe wording for what Supabase reports when the Google round trip fails or is cancelled.
// The raw error text is never shown to the user.
function googleErrorMessage({ error, code } = {}) {
  // Specific codes first: Supabase reports several different failures under error=access_denied,
  // so that value on its own only means "cancelled" when nothing more specific was given.
  if (code === "signup_disabled") return "New account sign-ups are currently turned off. Please contact support.";
  if (["bad_oauth_state", "bad_oauth_callback", "flow_state_not_found", "flow_state_expired"].includes(code)) return "Your sign-in session expired. Please try again.";
  if (["provider_email_needs_verification", "email_not_confirmed"].includes(code)) return "Google couldn't confirm your email address, so we can't sign you in with it.";
  if (error === "access_denied" || code === "access_denied") return "Google sign-in was cancelled. You can try again, or use your email and password.";
  if (["server_error", "unexpected_failure", "temporarily_unavailable"].includes(code) || ["server_error", "temporarily_unavailable"].includes(error)) return "Google sign-in is temporarily unavailable. Please try again in a moment.";
  return "We couldn't complete Google sign-in. Please try again, or use your email and password.";
}

/**
 * Login/register only. Signed-in visitors go straight to the dashboard (this is also where a successful
 * Google return lands). The destination is a fixed constant, never taken from the URL.
 */
function skipIfSignedIn(showError) {
  if (!AuthService.isAuthenticated()) return false;
  if (AuthService.getCurrentUser()) {
    window.location.replace("dashboard");
    return true;
  }
  // Signed in with Supabase but the profile row couldn't be read: don't bounce around, say what happened.
  document.documentElement.removeAttribute("data-auth-return");
  showError("We couldn't load your account details. Please refresh the page, or contact support if it keeps happening.");
  return false;
}

function initGoogleButton() {
  const btn = document.querySelector("[data-google-btn]");
  const errorBox = document.querySelector("[data-google-error]");
  if (!btn) return;
  const showError = (msg) => {
    if (errorBox) errorBox.textContent = msg || "";
  };

  const returned = takeAuthRedirectError();
  if (returned) {
    console.warn("[auth] Google sign-in returned an error:", returned.code || returned.error || "unknown");
    showError(googleErrorMessage(returned));
  }
  if (skipIfSignedIn(showError)) return;
  document.documentElement.removeAttribute("data-auth-return");

  btn.addEventListener("click", async () => {
    if (btn.disabled) return; // repeated clicks while a request is already under way
    showError("");
    setButtonLoading(btn, true, "Connecting to Google…");
    const result = await AuthService.signInWithGoogle();
    if (!result.ok) {
      setButtonLoading(btn, false);
      if (result.error) showError(result.error);
    }
    // On success the browser is on its way to Google: stay in the loading state so nothing can be clicked twice.
  });

  // Coming back with the Back button can restore this page from the browser's cache, frozen mid-"Connecting".
  window.addEventListener("pageshow", (e) => {
    if (!e.persisted) return;
    AuthService.resetGoogleSignIn();
    setButtonLoading(btn, false);
  });
}

export function initAuthForms(page) {
  if (page === "login" || page === "register") initGoogleButton();
  if (page === "login") {
    wireForm("[data-login-form]", AuthService.login, () => {
      window.location.href = "dashboard";
    });
  }
  if (page === "register") {
    wireForm("[data-register-form]", AuthService.register, (result) => {
      if (result.needsConfirmation) {
        showToast("Account created. Please check your email to confirm before logging in.", "info", 6000);
        window.location.href = "login";
      } else {
        window.location.href = "dashboard";
      }
    });
  }
  if (page === "forgot-password") {
    wireForm("[data-forgot-form]", AuthService.requestPasswordReset, () => {
      const successBox = document.querySelector("[data-form-success]");
      if (successBox) successBox.hidden = false;
      showToast("If that email exists, reset instructions were sent.", "info");
    });
  }
  if (page === "reset-password") {
    wireForm("[data-reset-form]", AuthService.resetPassword, () => {
      showToast("Password reset. Please log in.", "success");
      window.location.href = "login";
    });
  }
}