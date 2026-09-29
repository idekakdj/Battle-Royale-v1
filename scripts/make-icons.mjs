#!/usr/bin/env node
/**
 * Procedural app icon generator (WP-L, UPGRADE-PLAN §5.6). No external assets,
 * no dependencies: a tiny supersampled software rasterizer draws the lobby
 * logo motif — crossed gold-trimmed swords inside a golden laurel wreath on a
 * dark stone tile with a gold border — and writes:
 *
 *   build/icon.png   512×512 RGBA (Electron window icon in dev, Linux/mac base)
 *   build/icon.ico   16/24/32/48/64/128/256 (exe, installer, uninstaller)
 *
 * Small sizes (≤ 32 px) drop the wreath and enlarge the swords so the glyph
 * stays legible in the taskbar. Deterministic: same code → same bytes.
 *
 * Usage: npm run icons   (outputs are committed; rerun only to change the art)
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'build');

// ── Palette (mirrors src/styles/base.css) ────────────────────────────────────
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const C = {
  stone900: hex('#14110d'),
  stone800: hex('#1d1913'),
  stone700: hex('#2a241b'),
  stone600: hex('#3a3225'),
  stone500: hex('#4d4432'),
  gold: hex('#d9a441'),
  goldBright: hex('#f0c368'),
  goldDeep: hex('#a87a26'),
  steel: hex('#c8bda2'),
  steelLight: hex('#ece3d0'),
  steelDim: hex('#9a8c6e'),
  leather: hex('#4a2f1a'),
  leatherLight: hex('#6b4526'),
  blood: hex('#8f2118'),
  bloodBright: hex('#c8402f'),
  black: [0, 0, 0],
};

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - hw + r;
  const qy = Math.abs(py - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

// ── Sword (local coords: u along the blade toward the tip, v across) ────────
const BLADE_BASE = -0.1;
const BLADE_TAPER = 0.215;
const BLADE_TIP = 0.3;
const BLADE_HW = 0.034;
const OUTLINE = 0.013;

function bladeHalfWidth(u, hw, tip) {
  if (u < BLADE_BASE || u > tip) return -1;
  return u < BLADE_TAPER ? hw : (hw * (tip - u)) / (tip - BLADE_TAPER);
}

/** Color of the sword at (u, v), or null when outside it. */
function swordColor(u, v) {
  const av = Math.abs(v);
  // Pommel
  const dp = Math.hypot(u + 0.262, v);
  if (dp <= 0.034) {
    if (dp > 0.026) return C.goldDeep;
    return Math.hypot(u + 0.27, v + 0.009) < 0.011 ? C.goldBright : C.gold;
  }
  // Cross-guard
  const dg = sdRoundRect(u, v, -0.115, 0, 0.02, 0.105, 0.016);
  if (dg <= 0) {
    if (dg > -0.0075) return C.goldDeep;
    return u > -0.115 ? C.goldBright : C.gold;
  }
  // Grip with leather wraps
  if (u >= -0.236 && u <= -0.13 && av <= 0.022) {
    if (av > 0.016) return C.stone900;
    return Math.floor((u + 1) / 0.021) % 2 === 0 ? C.leather : C.leatherLight;
  }
  // Blade (steel, lit edge, fuller)
  const hw = bladeHalfWidth(u, BLADE_HW, BLADE_TIP);
  if (hw >= 0 && av <= hw) {
    if (av < 0.0065 && u < 0.19) return C.steelDim;
    return v < 0 ? mix(C.steelLight, C.steel, clamp01(av / hw)) : mix(C.steel, C.steelDim, clamp01(av / hw) * 0.7);
  }
  // Gold blade trim (like the lobby logo's stroke)
  const ho = bladeHalfWidth(u, BLADE_HW + OUTLINE, BLADE_TIP + OUTLINE * 1.4);
  if (ho >= 0 && av <= ho) return C.gold;
  return null;
}

const S2 = Math.SQRT1_2;
/** Sword A points up-right, sword B up-left (y grows downward). */
const SWORDS = [
  { dx: -S2, dy: -S2 }, // B (under)
  { dx: S2, dy: -S2 }, // A (over)
];

function swordsAt(x, y, scale) {
  const px = (x - 0.5) / scale;
  const py = (y - 0.5) / scale;
  let hit = null;
  for (const s of SWORDS) {
    const u = px * s.dx + py * s.dy;
    const v = -px * s.dy + py * s.dx;
    const c = swordColor(u, v);
    if (c !== null) hit = c; // later swords draw on top
  }
  return hit;
}

// ── Laurel wreath (left branch; right side is mirrored) ──────────────────────
const WREATH_R = 0.355;
const DEG = Math.PI / 180;
const LEAVES = (() => {
  const leaves = [];
  const add = (theta, tilt, a, b) => {
    const t = [-Math.sin(theta), Math.cos(theta)]; // tangent toward the branch tip
    const n = [Math.cos(theta), Math.sin(theta)]; // outward normal
    let dx = t[0] * Math.cos(tilt) + n[0] * Math.sin(tilt);
    let dy = t[1] * Math.cos(tilt) + n[1] * Math.sin(tilt);
    const len = Math.hypot(dx, dy);
    dx /= len;
    dy /= len;
    const bx = 0.5 + n[0] * WREATH_R;
    const by = 0.5 + n[1] * WREATH_R;
    leaves.push({ cx: bx + dx * a * 0.92, cy: by + dy * a * 0.92, dx, dy, a, b, reach: a + 0.01 });
  };
  for (let i = 0; i < 12; i++) {
    const theta = (108 + i * 11.5) * DEG;
    const s = 1 - i * 0.028;
    add(theta, 38 * DEG, 0.047 * s, 0.018 * s); // outer leaf
    add(theta + 5 * DEG, -34 * DEG, 0.042 * s, 0.016 * s); // inner leaf
  }
  add(246 * DEG, 0, 0.04, 0.015); // tip leaf
  return leaves;
})();

function laurelAt(x, y) {
  const mx = x > 0.5 ? 1 - x : x;
  const dx = mx - 0.5;
  const dy = y - 0.5;
  const r = Math.hypot(dx, dy);
  if (r < 0.27 || r > 0.43) return null;
  let hit = null;
  let theta = Math.atan2(dy, dx) / DEG;
  if (theta < 0) theta += 360;
  if (theta >= 92 && theta <= 246 && Math.abs(r - WREATH_R) <= 0.0085) hit = C.goldDeep;
  for (const l of LEAVES) {
    const ox = mx - l.cx;
    const oy = y - l.cy;
    if (Math.abs(ox) > l.reach || Math.abs(oy) > l.reach) continue;
    const lu = ox * l.dx + oy * l.dy;
    const lv = -ox * l.dy + oy * l.dx;
    const outer = (lu / (l.a + 0.006)) ** 2 + (lv / (l.b + 0.006)) ** 2;
    if (outer > 1) continue;
    const inner = (lu / l.a) ** 2 + (lv / l.b) ** 2;
    if (inner > 1) hit = C.goldDeep;
    else if (Math.abs(lv) < 0.0028 && lu < l.a * 0.7) hit = C.goldDeep;
    else hit = lv < 0 ? C.goldBright : C.gold;
  }
  return hit;
}

// ── Whole icon, one sample ───────────────────────────────────────────────────
const TILE = { hw: 0.47, r: 0.19 };

/** Returns [r, g, b, a] (a in 0..1) for the point (x, y) in 0..1 icon space. */
function sample(x, y, detail) {
  const d = sdRoundRect(x, y, 0.5, 0.5, TILE.hw, TILE.hw, TILE.r);
  if (d > 0) return null;

  // Stone tile with a warm torch-lit center and vignette.
  let col = mix(C.stone500, C.stone900, clamp01(Math.hypot(x - 0.5, y - 0.42) / 0.62) ** 1.15);
  if (detail) {
    // Staggered stone blocks: faint mortar lines.
    const row = Math.floor(y / 0.125);
    const fy = y / 0.125 - row;
    const fx = (x + (row % 2) * 0.125) / 0.25 - Math.floor((x + (row % 2) * 0.125) / 0.25);
    if (fy < 0.05 || fx < 0.025) col = mix(col, C.black, 0.22);
  }

  // Gold border ring (thicker at small sizes) with a dark inner bevel.
  const ring = detail ? 0.034 : 0.06;
  if (d > -ring) return [...mix(C.goldBright, C.goldDeep, clamp01(y * 1.1)), 1];
  if (d > -ring - 0.008) col = mix(col, C.black, 0.55);

  if (detail) {
    const leaf = laurelAt(x, y);
    if (leaf !== null) col = leaf;
    // Ribbon knot binding the two branches.
    const dk = Math.hypot(x - 0.5, y - 0.858);
    if (dk <= 0.032) col = dk > 0.024 ? C.goldDeep : dk < 0.012 ? C.bloodBright : C.blood;
  }

  const scale = detail ? 1 : 1.13;
  if (detail && swordsAt(x - 0.011, y - 0.016, scale) !== null) col = mix(col, C.black, 0.45); // drop shadow
  const sword = swordsAt(x, y, scale);
  if (sword !== null) col = sword;
  return [col[0], col[1], col[2], 1];
}

/** Render a size×size RGBA buffer with ss×ss supersampling. */
function render(size) {
  const detail = size >= 48;
  const ss = size <= 32 ? 8 : size <= 128 ? 5 : 3;
  const buf = Buffer.alloc(size * size * 4);
  const inv = 1 / (size * ss);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const c = sample((px * ss + sx + 0.5) * inv, (py * ss + sy + 0.5) * inv, detail);
          if (c === null) continue;
          r += c[0] * c[3];
          g += c[1] * c[3];
          b += c[2] * c[3];
          a += c[3];
        }
      }
      const o = (py * size + px) * 4;
      if (a > 0) {
        buf[o] = Math.round(r / a);
        buf[o + 1] = Math.round(g / a);
        buf[o + 2] = Math.round(b / a);
      }
      buf[o + 3] = Math.round((a / (ss * ss)) * 255);
    }
  }
  return buf;
}

// ── PNG / ICO encoders ───────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function encodePng(size, rgba) {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Classic 32-bpp DIB icon image (BGRA bottom-up + empty AND mask). */
function encodeDib(size, rgba) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // XOR + AND masks
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(size * size * 4, 20);
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const src = (size - 1 - y) * size * 4;
    for (let x = 0; x < size; x++) {
      const i = src + x * 4;
      const o = (y * size + x) * 4;
      pixels[o] = rgba[i + 2];
      pixels[o + 1] = rgba[i + 1];
      pixels[o + 2] = rgba[i];
      pixels[o + 3] = rgba[i + 3];
    }
  }
  const mask = Buffer.alloc(Math.ceil(size / 32) * 4 * size);
  return Buffer.concat([header, pixels, mask]);
}

function encodeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // icon
  header.writeUInt16LE(images.length, 4);
  const dir = Buffer.alloc(16 * images.length);
  let offset = 6 + dir.length;
  images.forEach(({ size, data }, i) => {
    const o = i * 16;
    dir[o] = size >= 256 ? 0 : size;
    dir[o + 1] = size >= 256 ? 0 : size;
    dir.writeUInt16LE(1, o + 4); // planes
    dir.writeUInt16LE(32, o + 6); // bpp
    dir.writeUInt32LE(data.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += data.length;
  });
  return Buffer.concat([header, dir, ...images.map((im) => im.data)]);
}

// ── Main ─────────────────────────────────────────────────────────────────────
mkdirSync(OUT_DIR, { recursive: true });
const started = Date.now();

const png512 = encodePng(512, render(512));
writeFileSync(join(OUT_DIR, 'icon.png'), png512);

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const icoImages = ICO_SIZES.map((size) => {
  const rgba = render(size);
  // 256 px as PNG (Vista+ format, keeps the file small); smaller sizes as DIB
  // for maximum compatibility (NSIS, rcedit, Explorer).
  return { size, data: size >= 256 ? encodePng(size, rgba) : encodeDib(size, rgba) };
});
const ico = encodeIco(icoImages);
writeFileSync(join(OUT_DIR, 'icon.ico'), ico);

console.log(
  `icons: build/icon.png (512px, ${(png512.length / 1024).toFixed(1)} KiB), ` +
    `build/icon.ico (${ICO_SIZES.join('/')}px, ${(ico.length / 1024).toFixed(1)} KiB) in ${Date.now() - started} ms`,
);
