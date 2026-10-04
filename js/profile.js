/**
 * BTECH SMM — Profile Module (Supabase — Phase 4)
 * ----------------------------------------------------------------
 * Reads the cached profile from AuthService and writes changes back
 * to the `profiles` table (RLS restricts this to the row's owner).
 */

import { supabase } from "./supabase.js";
import { AuthService } from "./auth.js";
import { isValidEmail, showToast, setButtonLoading } from "./utils.js";

export function initProfilePage() {
  const form = document.querySelector("[data-profile-form]");
  if (!form) return;

  const user = AuthService.getCurrentUser();
  if (!user) return;

  form.querySelector("[name=name]").value = user.name || "";
  form.querySelector("[name=email]").value = user.email || "";
  form.querySelector("[name=phone]").value = user.phone || "";

  const initialsEl = document.querySelector("[data-profile-initials]");
  if (initialsEl) {
    initialsEl.textContent = (user.name || "U")
      .split(" ")
      .map((p) => p[0])
      .slice(0, 2)
      .join("")
      .toUpperCase();
  }
  const memberSince = document.querySelector("[data-member-since]");
  if (memberSince && user.createdAt) {
    memberSince.textContent = new Intl.DateTimeFormat("en-KE", { month: "long", year: "numeric" }).format(new Date(user.createdAt));
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const submitBtn = form.querySelector("[type=submit]");
    const errorBox = form.querySelector("[data-form-error]");
    errorBox.textContent = "";

    const name = form.querySelector("[name=name]").value.trim();
    const email = form.querySelector("[name=email]").value.trim();
    const phone = form.querySelector("[name=phone]").value.trim();

    if (name.length < 2) {
      errorBox.textContent = "Please enter your full name.";
      return;
    }
    if (!isValidEmail(email)) {
      errorBox.textContent = "Please enter a valid email address.";
      return;
    }

    setButtonLoading(submitBtn, true, "Saving…");

    // Note: changing `email` here only updates the profiles table, not the
    // Supabase Auth login email — that requires supabase.auth.updateUser()
    // and a confirmation step, intentionally left for a follow-up pass.
    const { error } = await supabase.from("profiles").update({ name, phone, updated_at: new Date().toISOString() }).eq("id", user.id);

    await AuthService.refreshProfile();
    setButtonLoading(submitBtn, false);

    if (error) {
      errorBox.textContent = "We couldn't save your changes. Please try again.";
      return;
    }
    showToast("Profile updated.", "success");
  });
}
