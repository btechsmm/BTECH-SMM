/**
 * BTECH SMM — QR code encoder (byte mode, error correction M, versions 1–10)
 * ----------------------------------------------------------------
 * Self-contained so the ambassador badge works with no CDN and offline.
 * qrMatrix(text) -> array of rows of booleans (true = dark module).
 * Capacity at level M for version 10 is 213 bytes, far above a badge URL.
 */

const ECC_PER_BLOCK = [10, 16, 26, 18, 24, 16, 18, 22, 22, 26]; // level M, versions 1..10
const NUM_BLOCKS = [1, 1, 1, 2, 2, 4, 4, 4, 5, 5];

function rawModules(v) {
  let r = (16 * v + 128) * v + 64;
  if (v >= 2) {
    const n = Math.floor(v / 7) + 2;
    r -= (25 * n - 10) * n - 55;
    if (v >= 7) r -= 36;
  }
  return r;
}

function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function rsDivisor(deg) {
  const r = new Array(deg).fill(0);
  r[deg - 1] = 1;
  let root = 1;
  for (let i = 0; i < deg; i++) {
    for (let j = 0; j < deg; j++) {
      r[j] = gfMul(r[j], root);
      if (j + 1 < deg) r[j] ^= r[j + 1];
    }
    root = gfMul(root, 2);
  }
  return r;
}

function rsRemainder(data, divisor) {
  const r = new Array(divisor.length).fill(0);
  for (const b of data) {
    const f = b ^ r.shift();
    r.push(0);
    divisor.forEach((c, i) => (r[i] ^= gfMul(c, f)));
  }
  return r;
}

function alignPositions(v) {
  if (v === 1) return [];
  const size = v * 4 + 17;
  const n = Math.floor(v / 7) + 2;
  const step = Math.ceil((v * 4 + 4) / (n * 2 - 2)) * 2;
  const r = [];
  for (let i = 0, pos = size - 7; i < n - 1; i++, pos -= step) r.unshift(pos);
  r.unshift(6);
  return r;
}

function buildCodewords(bytes, v) {
  const eccLen = ECC_PER_BLOCK[v - 1];
  const numBlocks = NUM_BLOCKS[v - 1];
  const rawCw = Math.floor(rawModules(v) / 8);
  const dataCw = rawCw - eccLen * numBlocks;

  const bits = [];
  const push = (val, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };
  push(0x4, 4);
  push(bytes.length, v < 10 ? 8 : 16);
  bytes.forEach((b) => push(b, 8));
  const cap = dataCw * 8;
  push(0, Math.min(4, cap - bits.length));
  while (bits.length % 8) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(""), 2));
  for (let pad = 0xec; data.length < dataCw; pad ^= 0xec ^ 0x11) data.push(pad);

  const numShort = numBlocks - (rawCw % numBlocks);
  const shortLen = Math.floor(rawCw / numBlocks);
  const div = rsDivisor(eccLen);
  const blocks = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < numShort ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, div);
    if (i < numShort) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  const out = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((b, j) => {
      if (i !== shortLen - eccLen || j >= numShort) out.push(b[i]);
    });
  }
  return out;
}

export function qrMatrix(text) {
  const bytes = Array.from(new TextEncoder().encode(String(text)));
  let v = 1;
  for (; v <= 10; v++) {
    const cap = (Math.floor(rawModules(v) / 8) - ECC_PER_BLOCK[v - 1] * NUM_BLOCKS[v - 1]) * 8;
    if (4 + (v < 10 ? 8 : 16) + bytes.length * 8 <= cap) break;
  }
  if (v > 10) throw new Error("Text is too long for the QR code.");

  const size = v * 4 + 17;
  const m = Array.from({ length: size }, () => new Array(size).fill(false));
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const setFn = (x, y, dark) => {
    m[y][x] = dark;
    fn[y][x] = true;
  };

  for (let i = 0; i < size; i++) {
    setFn(6, i, i % 2 === 0);
    setFn(i, 6, i % 2 === 0);
  }
  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) setFn(x, y, d !== 2 && d !== 4);
      }
    }
  };
  finder(3, 3);
  finder(size - 4, 3);
  finder(3, size - 4);
  const ap = alignPositions(v);
  ap.forEach((ax, i) =>
    ap.forEach((ay, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === ap.length - 1) || (i === ap.length - 1 && j === 0)) return;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) setFn(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    })
  );

  const drawFormat = (mask) => {
    const data = mask; // error correction level M = 0b00
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const bit = (i) => ((bits >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i++) setFn(8, i, bit(i));
    setFn(8, 7, bit(6));
    setFn(8, 8, bit(7));
    setFn(7, 8, bit(8));
    for (let i = 9; i < 15; i++) setFn(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) setFn(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) setFn(8, size - 15 + i, bit(i));
    setFn(8, size - 8, true);
  };
  drawFormat(0);
  if (v >= 7) {
    let rem = v;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (v << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) !== 0;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFn(a, b, dark);
      setFn(b, a, dark);
    }
  }

  const cw = buildCodewords(bytes, v);
  let idx = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const up = ((right + 1) & 2) === 0;
        const y = up ? size - 1 - vert : vert;
        if (!fn[y][x] && idx < cw.length * 8) {
          m[y][x] = ((cw[idx >>> 3] >>> (7 - (idx & 7))) & 1) !== 0;
          idx++;
        }
      }
    }
  }

  const MASKS = [
    (x, y) => (x + y) % 2 === 0,
    (x, y) => y % 2 === 0,
    (x, y) => x % 3 === 0,
    (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
    (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
    (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ];
  const applyMask = (k) => {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && MASKS[k](x, y)) m[y][x] = !m[y][x];
  };

  const penalty = () => {
    let p = 0;
    const lines = [];
    for (let i = 0; i < size; i++) {
      lines.push(m[i].slice());
      lines.push(m.map((row) => row[i]));
    }
    for (const line of lines) {
      let run = 1;
      for (let i = 1; i <= size; i++) {
        if (i < size && line[i] === line[i - 1]) run++;
        else {
          if (run >= 5) p += 3 + (run - 5);
          run = 1;
        }
      }
      const s = line.map((d) => (d ? 1 : 0)).join("");
      for (const pat of ["10111010000", "00001011101"]) {
        let at = s.indexOf(pat);
        while (at !== -1) {
          p += 40;
          at = s.indexOf(pat, at + 1);
        }
      }
    }
    for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) if (m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) p += 3;
    let dark = 0;
    m.forEach((row) => row.forEach((d) => d && dark++));
    p += Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
    return p;
  };

  let best = 0;
  let bestScore = Infinity;
  for (let k = 0; k < 8; k++) {
    applyMask(k);
    drawFormat(k);
    const score = penalty();
    if (score < bestScore) {
      best = k;
      bestScore = score;
    }
    applyMask(k); // undo
  }
  applyMask(best);
  drawFormat(best);
  return m;
}
