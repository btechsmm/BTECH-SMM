/**
 * BTECH SMM — Ambassador profile photo
 * ----------------------------------------------------------------
 * Pick a photo, frame it (drag to move, slider to zoom), and upload it as a
 * 600x600 JPEG to the "ambassador-photos" Storage bucket.
 *
 * Re-encoding in the browser means: a consistent size, small files, correct
 * orientation, and no camera metadata (GPS location, device model) in the file.
 * The database — not this module — decides which file is the ambassador's photo
 * (see ambassador_photo_valid() in migration_ambassador_photos.sql).
 */

import { supabase } from "./supabase.js";
import { AuthService } from "./auth.js";
import { photoUrl, PHOTO_BUCKET } from "./avatar.js";

export { photoUrl };

const BUCKET = PHOTO_BUCKET;
const VIEW = 260; // on-screen crop size (px)
const OUT = 600; // uploaded size (px)
const MAX_INPUT_BYTES = 12 * 1024 * 1024;

/** Uploads a JPEG blob to the caller's own folder and returns its storage path. */
export async function uploadPhoto(blob) {
  const user = AuthService.getCurrentUser();
  if (!user) throw new Error("Please log in again.");
  const path = `${user.id}/${crypto.randomUUID()}.jpg`;
  const { error } = await supabase.storage.from(BUCKET).upload(path, blob, { contentType: "image/jpeg", upsert: false });
  if (error) throw new Error("We couldn't upload your photo. Please try again.");
  return path;
}

/** Best-effort cleanup of a file that is no longer referenced. Never throws. */
export async function removePhoto(path) {
  if (!path) return;
  try {
    await supabase.storage.from(BUCKET).remove([path]);
  } catch {
    /* an orphaned file is harmless; the next upload uses a new name */
  }
}

async function decode(file) {
  if (window.createImageBitmap) {
    try {
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
      /* fall through to <img> */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("decode"));
      i.src = url;
    });
    return { width: img.naturalWidth, height: img.naturalHeight, draw: img, isEl: true };
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
}

/**
 * Mounts a cropper into `root`. Returns { hasImage(), getBlob() }.
 * `onChange` fires when a photo is chosen or cleared.
 */
export function createCropper(root, { onChange } = {}) {
  const id = `pc-${Math.random().toString(36).slice(2, 8)}`;
  root.innerHTML = `
    <div class="photo-crop">
      <div class="photo-crop__stage" data-pc-stage hidden>
        <canvas width="${VIEW}" height="${VIEW}" data-pc-canvas aria-label="Photo preview. Drag to reposition."></canvas>
      </div>
      <div class="photo-crop__empty" data-pc-empty aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="9" r="3.6"/><path d="M5 20c.8-3.8 3.6-5.8 7-5.8s6.2 2 7 5.8"/></svg>
      </div>
      <div class="photo-crop__controls">
        <label class="btn btn--secondary btn--sm" for="${id}-file">Choose photo</label>
        <input id="${id}-file" type="file" accept="image/*" class="sr-only" data-pc-file />
        <label class="photo-crop__zoom" data-pc-zoomwrap hidden>Zoom <input type="range" min="1" max="3" step="0.01" value="1" data-pc-zoom aria-label="Zoom" /></label>
      </div>
      <p class="form-hint" data-pc-hint>Use a clear, recent photo of your face. It appears on your badge and your public verification page.</p>
      <p class="form-error" data-pc-error role="alert"></p>
    </div>`;

  const $ = (s) => root.querySelector(s);
  const canvas = $("[data-pc-canvas]");
  const ctx = canvas.getContext("2d");
  const s = { bmp: null, zoom: 1, ox: 0, oy: 0 };

  const geometry = (size, zoom, ox, oy) => {
    const base = Math.max(size / s.bmp.width, size / s.bmp.height);
    const scale = base * zoom;
    const dw = s.bmp.width * scale;
    const dh = s.bmp.height * scale;
    const mx = (dw - size) / 2;
    const my = (dh - size) / 2;
    const cx = Math.max(-mx, Math.min(mx, ox * (size / VIEW)));
    const cy = Math.max(-my, Math.min(my, oy * (size / VIEW)));
    return { x: size / 2 - dw / 2 + cx, y: size / 2 - dh / 2 + cy, dw, dh };
  };

  const draw = () => {
    ctx.clearRect(0, 0, VIEW, VIEW);
    if (!s.bmp) return;
    const g = geometry(VIEW, s.zoom, s.ox, s.oy);
    ctx.drawImage(s.bmp.draw || s.bmp, g.x, g.y, g.dw, g.dh);
    // Dim everything outside the circle the badge will show.
    ctx.save();
    ctx.fillStyle = "rgba(7, 26, 61, 0.55)";
    ctx.beginPath();
    ctx.rect(0, 0, VIEW, VIEW);
    ctx.arc(VIEW / 2, VIEW / 2, VIEW / 2 - 4, 0, Math.PI * 2, true);
    ctx.fill("evenodd");
    ctx.restore();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(VIEW / 2, VIEW / 2, VIEW / 2 - 4, 0, Math.PI * 2);
    ctx.stroke();
  };

  const setError = (msg) => ($("[data-pc-error]").textContent = msg || "");

  $("[data-pc-file]").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    setError("");
    if (!file) return;
    if (!file.type.startsWith("image/")) return setError("Please choose an image file (JPG or PNG).");
    if (file.size > MAX_INPUT_BYTES) return setError("That photo is too large. Please choose one under 12 MB.");
    try {
      const bmp = await decode(file);
      if (bmp.width < 200 || bmp.height < 200) return setError("That photo is too small. Please choose one at least 200 × 200 pixels.");
      s.bmp = bmp;
      s.zoom = 1;
      s.ox = 0;
      s.oy = 0;
      $("[data-pc-zoom]").value = "1";
      $("[data-pc-stage]").hidden = false;
      $("[data-pc-empty]").hidden = true;
      $("[data-pc-zoomwrap]").hidden = false;
      $("[data-pc-hint]").textContent = "Drag the photo to centre your face, and use the slider to zoom.";
      $("label[for$='-file']").textContent = "Choose a different photo";
      draw();
      onChange?.(true);
    } catch {
      setError("We couldn't read that photo. Please try a different one.");
    }
  });

  $("[data-pc-zoom]").addEventListener("input", (e) => {
    s.zoom = Number(e.target.value);
    draw();
  });

  let drag = null;
  canvas.addEventListener("pointerdown", (e) => {
    if (!s.bmp) return;
    canvas.setPointerCapture(e.pointerId);
    drag = { x: e.clientX, y: e.clientY, ox: s.ox, oy: s.oy };
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const k = VIEW / canvas.getBoundingClientRect().width;
    s.ox = drag.ox + (e.clientX - drag.x) * k;
    s.oy = drag.oy + (e.clientY - drag.y) * k;
    const g = geometry(VIEW, s.zoom, s.ox, s.oy);
    s.ox = g.x - (VIEW / 2 - g.dw / 2); // store the clamped value so dragging never "sticks" past the edge
    s.oy = g.y - (VIEW / 2 - g.dh / 2);
    draw();
  });
  const end = () => (drag = null);
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);

  return {
    hasImage: () => !!s.bmp,
    /** Square 600x600 JPEG of the framed area, or null if no photo was chosen. */
    async getBlob() {
      if (!s.bmp) return null;
      const out = document.createElement("canvas");
      out.width = OUT;
      out.height = OUT;
      const c = out.getContext("2d");
      c.fillStyle = "#ffffff";
      c.fillRect(0, 0, OUT, OUT);
      const g = geometry(OUT, s.zoom, s.ox, s.oy);
      c.drawImage(s.bmp.draw || s.bmp, g.x, g.y, g.dw, g.dh);
      return await new Promise((resolve) => out.toBlob(resolve, "image/jpeg", 0.88));
    },
  };
}