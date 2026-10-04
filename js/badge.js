/**
 * BTECH SMM — Ambassador Badge
 * ----------------------------------------------------------------
 * Draws the digital ambassador ID card on a canvas at print quality
 * (1600 x 1009 px, the ISO/IEC 7810 ID-1 card ratio) and exports it as PNG or
 * a single-page PDF. Everything shown comes from the ambassador record the
 * database returned; nothing is editable on the client.
 *
 * The QR code points at the public verification page, which shows only safe,
 * limited details (see verify_ambassador() in migration_ambassador.sql).
 */

import { qrMatrix } from "./qr.js";

export const BADGE_W = 1600;
export const BADGE_H = 1009;

const C = {
  navy: "#0b2148",
  navyDeep: "#071a3d",
  blue: "#0a84ff",
  white: "#ffffff",
  ink: "#0f172a",
  muted: "#9fb3d9",
  soft: "#cdd9ee",
  green: "#16a34a",
  amber: "#f59e0b",
  red: "#dc2626",
};

const STATUS = {
  approved: { label: "ACTIVE AMBASSADOR", color: C.green },
  suspended: { label: "SUSPENDED", color: C.amber },
  deactivated: { label: "DEACTIVATED", color: C.red },
};

const FONT = `"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function loadImage(src, cors = false) {
  return new Promise((resolve) => {
    const img = new Image();
    // With CORS requested, an image the server refuses to share fails to load
    // (we fall back to initials) instead of tainting the canvas and breaking export.
    if (cors) img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function fitText(ctx, text, maxWidth, size, weight) {
  let s = size;
  ctx.font = `${weight} ${s}px ${FONT}`;
  while (ctx.measureText(text).width > maxWidth && s > 18) {
    s -= 2;
    ctx.font = `${weight} ${s}px ${FONT}`;
  }
  return s;
}

function initials(name) {
  return (name || "A")
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

function formatIssued(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-KE", { day: "2-digit", month: "short", year: "numeric" });
}

/**
 * data: { displayName, photoUrl?, ambassadorCode, referralCode, status, issuedAt, verifyUrl,
 *         business: { website, email, phone }, logoSrc? }
 */
export async function renderBadge(canvas, data) {
  canvas.width = BADGE_W;
  canvas.height = BADGE_H;
  const ctx = canvas.getContext("2d");
  const st = STATUS[data.status] || STATUS.approved;
  const biz = data.business;
  const logo = await loadImage(data.logoSrc || "assets/brand/btech-smm-logo.png");
  const photo = data.photoUrl ? await loadImage(data.photoUrl, true) : null;

  // Card
  ctx.clearRect(0, 0, BADGE_W, BADGE_H);
  roundRect(ctx, 0, 0, BADGE_W, BADGE_H, 48);
  ctx.save();
  ctx.clip();
  ctx.fillStyle = C.navy;
  ctx.fillRect(0, 0, BADGE_W, BADGE_H);

  // Header band
  ctx.fillStyle = C.white;
  ctx.fillRect(0, 0, BADGE_W, 150);
  ctx.fillStyle = C.blue;
  ctx.fillRect(0, 150, BADGE_W, 10);
  if (logo) {
    const h = 64;
    const w = (logo.width / logo.height) * h;
    ctx.drawImage(logo, 70, 43, w, h);
  } else {
    ctx.fillStyle = C.navy;
    ctx.font = `800 54px ${FONT}`;
    ctx.textBaseline = "alphabetic";
    ctx.fillText("BTECH SMM", 70, 100);
  }
  ctx.textAlign = "right";
  ctx.fillStyle = C.navy;
  ctx.font = `700 30px ${FONT}`;
  ctx.fillText("OFFICIAL AMBASSADOR ID", BADGE_W - 70, 92);
  ctx.textAlign = "left";

  // Title
  ctx.fillStyle = C.white;
  ctx.font = `800 58px ${FONT}`;
  ctx.fillText("BTECH SMM AMBASSADOR", 70, 262);

  // Avatar: the ambassador's photo (initials only if no photo is on file)
  const ax = 70;
  const ay = 320;
  const ar = 120;
  ctx.beginPath();
  ctx.arc(ax + ar, ay + ar, ar, 0, Math.PI * 2);
  ctx.fillStyle = C.blue;
  ctx.fill();
  if (photo) {
    // Cover-fit the photo into the circle, then add a white ring.
    const side = Math.min(photo.width, photo.height);
    ctx.save();
    ctx.beginPath();
    ctx.arc(ax + ar, ay + ar, ar, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(photo, (photo.width - side) / 2, (photo.height - side) / 2, side, side, ax, ay, ar * 2, ar * 2);
    ctx.restore();
    ctx.beginPath();
    ctx.arc(ax + ar, ay + ar, ar, 0, Math.PI * 2);
    ctx.lineWidth = 8;
    ctx.strokeStyle = C.white;
    ctx.stroke();
  } else {
    ctx.fillStyle = C.white;
    ctx.font = `800 96px ${FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(initials(data.displayName), ax + ar, ay + ar + 6);
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
  }

  // Name + status
  const nx = ax + ar * 2 + 50;
  const nameMax = 760 - nx + 330;
  fitText(ctx, data.displayName, nameMax, 64, 800);
  ctx.fillStyle = C.white;
  ctx.fillText(data.displayName, nx, 380);

  ctx.font = `700 26px ${FONT}`;
  const chipW = ctx.measureText(st.label).width + 56;
  roundRect(ctx, nx, 410, chipW, 56, 28);
  ctx.fillStyle = st.color;
  ctx.fill();
  ctx.fillStyle = C.white;
  ctx.fillText(st.label, nx + 28, 448);

  // Identification block
  const fy = 640;
  const field = (label, value, x, y, maxW) => {
    ctx.fillStyle = C.muted;
    ctx.font = `600 24px ${FONT}`;
    ctx.fillText(label, x, y);
    ctx.fillStyle = C.white;
    fitText(ctx, value, maxW, 46, 800);
    ctx.fillText(value, x, y + 54);
  };
  field("AMBASSADOR ID", data.ambassadorCode || "—", 70, fy, 560);
  field("REFERRAL CODE", data.referralCode || "—", 70, fy + 130, 560);
  field("DATE ISSUED", formatIssued(data.issuedAt), 690, fy + 130, 320);

  // QR tile
  const tile = 400;
  const tx = BADGE_W - 70 - tile;
  const ty = 250;
  roundRect(ctx, tx, ty, tile, tile, 28);
  ctx.fillStyle = C.white;
  ctx.fill();
  try {
    const m = qrMatrix(data.verifyUrl);
    const quiet = 3;
    const mod = Math.floor((tile - 40) / (m.length + quiet * 2));
    const qsz = mod * (m.length + quiet * 2);
    const qx = tx + (tile - qsz) / 2 + quiet * mod;
    const qy = ty + (tile - qsz) / 2 + quiet * mod;
    ctx.fillStyle = C.ink;
    m.forEach((row, y) => row.forEach((dark, x) => dark && ctx.fillRect(qx + x * mod, qy + y * mod, mod, mod)));
  } catch {
    ctx.fillStyle = C.ink;
    ctx.font = `600 24px ${FONT}`;
    ctx.textAlign = "center";
    ctx.fillText("QR unavailable", tx + tile / 2, ty + tile / 2);
    ctx.textAlign = "left";
  }
  ctx.textAlign = "center";
  ctx.fillStyle = C.soft;
  ctx.font = `600 24px ${FONT}`;
  ctx.fillText("Scan to verify", tx + tile / 2, ty + tile + 44);
  ctx.fillStyle = C.white;
  ctx.font = `700 26px ${FONT}`;
  ctx.fillText(data.status === "approved" ? "Verified BTECH SMM Ambassador" : "Not currently active", tx + tile / 2, ty + tile + 84);
  ctx.textAlign = "left";

  // Footer
  ctx.fillStyle = C.navyDeep;
  ctx.fillRect(0, BADGE_H - 120, BADGE_W, 120);
  ctx.fillStyle = C.soft;
  ctx.font = `600 28px ${FONT}`;
  const site = biz.website.replace(/^https?:\/\//, "");
  ctx.fillText(site, 70, BADGE_H - 52);
  ctx.textAlign = "center";
  ctx.fillText(biz.email, BADGE_W / 2, BADGE_H - 52);
  ctx.textAlign = "right";
  ctx.fillText(biz.phone, BADGE_W - 70, BADGE_H - 52);
  ctx.textAlign = "left";
  ctx.restore();
  return canvas;
}

/* --------------------------------- export --------------------------------- */
function toBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Could not export the badge."))), type, quality));
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export async function downloadPng(canvas, filename) {
  saveBlob(await toBlob(canvas, "image/png"), filename);
}

/**
 * Minimal single-page A4 PDF with the badge centred at 480pt wide (about 17cm),
 * embedded as a JPEG. Built by hand so no PDF library is needed.
 */
export function buildPdf(jpeg, imgW, imgH) {
  const enc = new TextEncoder();
  const parts = [];
  const offsets = [];
  let size = 0;
  const add = (x) => {
    const b = typeof x === "string" ? enc.encode(x) : x;
    parts.push(b);
    size += b.length;
  };
  const obj = (n, fn) => {
    offsets[n] = size;
    add(`${n} 0 obj\n`);
    fn();
    add("\nendobj\n");
  };

  const pageW = 595;
  const pageH = 842;
  const w = 480;
  const h = (w * imgH) / imgW;
  const x = (pageW - w) / 2;
  const y = pageH - 80 - h;
  const content = `q ${w} 0 0 ${h.toFixed(2)} ${x} ${y.toFixed(2)} cm /Im0 Do Q`;

  add("%PDF-1.4\n");
  obj(1, () => add("<< /Type /Catalog /Pages 2 0 R >>"));
  obj(2, () => add("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"));
  obj(3, () => add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`));
  obj(4, () => {
    add(`<< /Type /XObject /Subtype /Image /Width ${imgW} /Height ${imgH} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`);
    add(jpeg);
    add("\nendstream");
  });
  obj(5, () => add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`));

  const xref = size;
  add("xref\n0 6\n0000000000 65535 f \n");
  for (let i = 1; i <= 5; i++) add(`${String(offsets[i]).padStart(10, "0")} 00000 n \n`);
  add(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  const out = new Uint8Array(size);
  let o = 0;
  parts.forEach((p) => {
    out.set(p, o);
    o += p.length;
  });
  return out;
}

export async function downloadPdf(canvas, filename) {
  // JPEG has no alpha: flatten the rounded corners onto white first.
  const flat = document.createElement("canvas");
  flat.width = canvas.width;
  flat.height = canvas.height;
  const ctx = flat.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, flat.width, flat.height);
  ctx.drawImage(canvas, 0, 0);
  const blob = await toBlob(flat, "image/jpeg", 0.95);
  const jpeg = new Uint8Array(await blob.arrayBuffer());
  saveBlob(new Blob([buildPdf(jpeg, flat.width, flat.height)], { type: "application/pdf" }), filename);
}