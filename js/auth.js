/**
 * BTECH SMM — Auth Module (Supabase Auth — Phase 4)
 * ----------------------------------------------------------------
 * Wraps supabase.auth so the rest of the app can keep using the
 * same AuthService.* interface it used in demo mode. A profile row
 * (name/email/phone/role) is created automatically by a database
 * trigger the moment someone signs up — see supabase/schema.sql.
 *
 * Supabase's own calls are async, but many pages (navigation, page
 * guards) want a synchronous "is this person logged in right now?"
 * check. To bridge that, AuthService.init() is awaited once during
 * app bootstrap (see app.js) — it loads the current session and
 * profile into memory, and isAuthenticated()/getCurrentUser() then
 * read from that cache. onAuthStateChange keeps the cache correct
 * if the session changes later (sign-out in another tab, etc.).
 */

import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from "./supabase.js";
import { isValidEmail } from "./utils.js";
import { getPendingReferral } from "./referral.js";

let _session = null;
let _profile = null;
let _initialized = false;

// The account avatar is the user's Ambassador Program photo. It is read from their own
// ambassadors row (RLS: own row only), so it is exactly what the database validated.
// Rejected/deactivated accounts fall back to initials. Any failure just means "no photo".
const AVATAR_STATUSES = ["applicant", "approved", "suspended"];
async function loadAvatarPath(userId) {
  try {
    const { data } = await supabase.from("ambassadors").select("photo_path,status").eq("user_id", userId).maybeSingle();
    return data && AVATAR_STATUSES.includes(data.status) ? data.photo_path || null : null;
  } catch {
    return null;
  }
}

async function loadProfile(userId) {
  const [{ data, error }, avatarPath] = await Promise.all([
    supabase.from("profiles").select("*").eq("id", userId).single(),
    loadAvatarPath(userId),
  ]);
  if (error) {
    console.error("Failed to load profile:", error);
    return null;
  }
  return {
    id: data.id,
    name: data.name,
    email: data.email,
    phone: data.phone,
    role: data.role,
    createdAt: data.created_at,
    avatarPath,
  };
}

async function init() {
  if (_initialized) return;
  _initialized = true;

  const { data } = await supabase.auth.getSession();
  _session = data.session;
  if (_session) {
    _profile = await loadProfile(_session.user.id);
  }

  supabase.auth.onAuthStateChange(async (_event, session) => {
    _session = session;
    _profile = session ? await loadProfile(session.user.id) : null;
  });
}

function isAuthenticated() {
  return !!_session;
}

function getCurrentUser() {
  return _profile;
}

/** Re-fetches the current user's profile row and updates the cache — call after editing the profile. */
async function refreshProfile() {
  if (!_session) return null;
  _profile = await loadProfile(_session.user.id);
  return _profile;
}

async function login({ email, password }) {
  if (!isValidEmail(email)) {
    return { ok: false, error: "Please enter a valid email address." };
  }
  if (!password || password.length < 6) {
    return { ok: false, error: "Password must be at least 6 characters." };
  }

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    return { ok: false, error: error.message || "Unable to log in. Please check your details and try again." };
  }

  _session = data.session;
  _profile = await loadProfile(data.user.id);
  return { ok: true, user: _profile };
}

async function register({ name, email, password }) {
  if (!name || name.trim().length < 2) {
    return { ok: false, error: "Please enter your full name." };
  }
  if (!isValidEmail(email)) {
    return { ok: false, error: "Please enter a valid email address." };
  }
  if (!password || password.length < 6) {
    return { ok: false, error: "Password must be at least 6 characters." };
  }

  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { name: name.trim(), ...(getPendingReferral() ? { referral_code: getPendingReferral() } : {}) } },
  });

  if (error) {
    return { ok: false, error: error.message || "Unable to create your account. Please try again." };
  }

  if (data.session) {
    // Email confirmation is disabled on this project — the user is signed in immediately.
    _session = data.session;
    _profile = await loadProfile(data.user.id);
    return { ok: true, user: _profile, needsConfirmation: false };
  }

  // Email confirmation is required before a session is issued.
  return { ok: true, user: null, needsConfirmation: true };
}

async function requestPasswordReset({ email }) {
  if (!isValidEmail(email)) {
    return { ok: false, error: "Please enter a valid email address." };
  }
  // Deliberately still "reset-password.html": Supabase only honours redirect URLs on its dashboard
  // allow-list, so changing this before "/reset-password" is added there would break reset emails.
  // The page itself still shows the clean /reset-password URL (see cleanAddressBar() in shell.js).
  const redirectTo = new URL("reset-password.html", window.location.href).toString();
  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });
  if (error) {
    // Don't reveal whether the email exists — respond ok either way.
    console.warn("resetPasswordForEmail:", error.message);
  }
  return { ok: true };
}

async function resetPassword({ password }) {
  if (!password || password.length < 6) {
    return { ok: false, error: "Password must be at least 6 characters." };
  }
  const { error } = await supabase.auth.updateUser({ password });
  if (error) {
    return { ok: false, error: error.message || "Unable to reset your password. Please request a new reset link." };
  }
  return { ok: true };
}

async function logout() {
  await supabase.auth.signOut();
  _session = null;
  _profile = null;
}

/* ------------------------------ Google sign-in ------------------------------ */
// One OAuth request at a time: the page is about to be replaced by Google, so this stays set on success.
let _googleInFlight = false;

/**
 * Asks Supabase which providers are switched on. Returns false ONLY when Supabase positively says Google is
 * disabled. A network/CORS hiccup returns true (try anyway): this check exists purely so a project that
 * isn't configured yet shows a clear message here, instead of sending people to a raw JSON error page.
 */
async function isGoogleEnabled() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/settings`, { headers: { apikey: SUPABASE_ANON_KEY }, signal: ctrl.signal });
    if (!res.ok) return true;
    const settings = await res.json();
    return settings?.external?.google !== false;
  } catch {
    return true;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Starts "Continue with Google". On success the browser is sent to Google and this page unloads, so the
 * caller should leave its button in the loading state. Supabase returns the user to /login (which must be on
 * the project's Redirect URLs list) with a session, or with an error that shell.js captures.
 * The destination is always this site's own /login: no user-supplied redirect is accepted anywhere.
 */
async function signInWithGoogle() {
  if (_googleInFlight) return { ok: false, busy: true };
  _googleInFlight = true;
  try {
    if (!(await isGoogleEnabled())) {
      console.warn("[auth] Google provider is disabled in Supabase (Authentication > Providers).");
      _googleInFlight = false;
      return { ok: false, error: "Google sign-in isn't available right now. Please use your email and password, or try again later." };
    }
    const redirectTo = `${window.location.origin}/login`;
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo, queryParams: { prompt: "select_account" } },
    });
    if (error) {
      console.warn("[auth] signInWithOAuth failed:", error.code || error.status || error.name);
      _googleInFlight = false;
      return { ok: false, error: "We couldn't start Google sign-in. Please try again." };
    }
    return { ok: true };
  } catch (err) {
    console.warn("[auth] Google sign-in request failed:", err?.name || err);
    _googleInFlight = false;
    return { ok: false, error: "Couldn't reach the sign-in service. Please check your connection and try again." };
  }
}

/** Re-arms the button when the browser restores this page from its back/forward cache. */
function resetGoogleSignIn() {
  _googleInFlight = false;
}

/** Call AFTER AuthService.init() has resolved (see app.js bootstrap). */
function requireAuth(redirectTo = "login") {
  if (!isAuthenticated()) {
    window.location.href = redirectTo;
    return false;
  }
  return true;
}

export const AuthService = {
  init,
  login,
  register,
  requestPasswordReset,
  resetPassword,
  signInWithGoogle,
  resetGoogleSignIn,
  logout,
  isAuthenticated,
  getCurrentUser,
  refreshProfile,
  requireAuth,
};