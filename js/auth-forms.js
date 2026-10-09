/**
 * BTECH SMM — Auth Forms Module
 * ----------------------------------------------------------------
 * Wires the login, register, forgot-password and reset-password
 * forms to AuthService (Supabase Auth). Kept separate from auth.js so
 * that module stays focused on session logic, not DOM handling.
 */

import { AuthService } from "./auth.js";
import { setButtonLoading, showToast } from "./utils.js";

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

export function initAuthForms(page) {
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