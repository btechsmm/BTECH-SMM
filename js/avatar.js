/**
 * BTECH SMM — Avatar helpers
 * ----------------------------------------------------------------
 * The account avatar is the photo the user uploaded for the Ambassador Program
 * (their badge photo). Users without one keep the initials circle.
 *
 * Kept free of other app imports so auth.js, navigation.js and profile.js can
 * all use it without import cycles.
 */

import { supabase } from "./supabase.js";
import { escapeHtml } from "./utils.js";

export const PHOTO_BUCKET = "ambassador-photos";

/** Public URL of a stored photo, or null. */
export function photoUrl(path) {
  if (!path) return null;
  return supabase.storage.from(PHOTO_BUCKET).getPublicUrl(path).data?.publicUrl || null;
}

export function initialsOf(name) {
  return (name || "U")
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

/** Inner HTML for an avatar circle: the user's photo, else their (escaped) initials. */
export function avatarInner(user) {
  const initials = escapeHtml(initialsOf(user?.name));
  const url = photoUrl(user?.avatarPath);
  return url ? `<img class="avatar__img" src="${escapeHtml(url)}" alt="" data-fallback="${initials}" />` : initials;
}

// If a photo can't be loaded, quietly fall back to initials instead of a broken image.
if (typeof document !== "undefined") {
  document.addEventListener(
    "error",
    (e) => {
      const t = e.target;
      if (t instanceof HTMLImageElement && t.classList.contains("avatar__img")) t.replaceWith(document.createTextNode(t.dataset.fallback || ""));
    },
    true
  );
}
