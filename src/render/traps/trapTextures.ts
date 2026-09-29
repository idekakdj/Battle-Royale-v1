/**
 * Procedural canvas textures for the v1.2 arena trap plates (WP-P).
 *
 * Canvas layout convention (shared with the plate / overlay geometry): the
 * canvas is a TOP-DOWN view of the unit disc — canvas pixel (px, py) maps to
 * normalised plate coordinates `nx = 2px/S − 1` (+x right) and
 * `nz = 2py/S − 1` (+z down), so a world point on the plate is
 * `(trap.x + nx·r, 0, trap.z + nz·r)`. The spike holes drawn into the iron
 * plate therefore line up exactly with the instanced spikes that thrust out
 * of them ({@link SPIKE_HOLES}).
 *
 * Built once per TrapRenderer (allocation at construction only).
 */

import * as THREE from 'three';
import { TAU, mulberry32 } from '../../core/math';

/** Normalised spike-hole centres (unit disc, hex grid). */
export interface SpikeHole {
  x: number;
  z: number;
}

const HOLE_SPACING = 0.2;
const HOLE_MAX_R = 0.8;
const HOLE_DRAW_R = 0.036;

function buildHoles(): SpikeHole[] {
  const out: SpikeHole[] = [];
  const dy = HOLE_SPACING * 0.866;
  const rows = Math.ceil(HOLE_MAX_R / dy);
  for (let j = -rows; j <= rows; j++) {
    const off = (j & 1) === 0 ? 0 : HOLE_SPACING * 0.5;
    const cols = Math.ceil(HOLE_MAX_R / HOLE_SPACING) + 1;
    for (let i = -cols; i <= cols; i++) {
      const x = i * HOLE_SPACING + off;
      const z = j * dy;
      if (x * x + z * z <= HOLE_MAX_R * HOLE_MAX_R) out.push({ x, z });
    }
  }
  return out;
}

/** Shared hole pattern (texture + spike instances). */
export const SPIKE_HOLES: readonly SpikeHole[] = buildHoles();

export interface TrapTextures {
  firePlate: THREE.CanvasTexture;
  spikePlate: THREE.CanvasTexture;
  /** R = fire rune ring, G = spike holes + rim, B = fire vents. */
  glowMask: THREE.CanvasTexture;
  dispose(): void;
}

function canvas(size: number): { c: HTMLCanvasElement; g: CanvasRenderingContext2D } {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const g = c.getContext('2d');
  if (g === null) throw new Error('2d canvas unavailable for trap textures');
  return { c, g };
}

function toTexture(c: HTMLCanvasElement, srgb: boolean): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

/** Speckle noise over the disc (stone grain / brushed iron). */
function speckle(
  g: CanvasRenderingContext2D, S: number, rnd: () => number,
  n: number, light: string, dark: string, maxR: number,
): void {
  for (let i = 0; i < n; i++) {
    const a = rnd() * TAU;
    const r = Math.sqrt(rnd()) * maxR * S * 0.5;
    const x = S / 2 + Math.cos(a) * r;
    const y = S / 2 + Math.sin(a) * r;
    g.fillStyle = rnd() < 0.5 ? light : dark;
    g.globalAlpha = 0.1 + rnd() * 0.2;
    const s = 1 + rnd() * 2.5;
    g.fillRect(x, y, s, s);
  }
  g.globalAlpha = 1;
}

/** One procedural rune glyph (2–4 strokes) centred at the origin, height ~h. */
function drawGlyph(g: CanvasRenderingContext2D, rnd: () => number, h: number): void {
  const w = h * 0.55;
  g.beginPath();
  const strokes = 2 + Math.floor(rnd() * 3);
  // Spine.
  g.moveTo(0, -h / 2);
  g.lineTo(0, h / 2);
  for (let k = 0; k < strokes; k++) {
    const kind = Math.floor(rnd() * 5);
    const y0 = (rnd() - 0.5) * h * 0.8;
    const side = rnd() < 0.5 ? -1 : 1;
    if (kind === 0) {
      g.moveTo(0, y0);
      g.lineTo(side * w, y0 - h * 0.25);
    } else if (kind === 1) {
      g.moveTo(-w * 0.8, y0);
      g.lineTo(w * 0.8, y0);
    } else if (kind === 2) {
      g.moveTo(side * w, y0 - h * 0.2);
      g.lineTo(0, y0);
      g.lineTo(side * w, y0 + h * 0.2);
    } else if (kind === 3) {
      g.moveTo(side * w * 0.9 + w * 0.3, y0);
      g.arc(side * w * 0.6, y0, w * 0.3, 0, TAU);
    } else {
      g.moveTo(0, y0);
      g.lineTo(side * w, y0 + h * 0.3);
    }
  }
  g.stroke();
}

function firePlate(S: number, mask: CanvasRenderingContext2D, vents: CanvasRenderingContext2D): HTMLCanvasElement {
  const { c, g } = canvas(S);
  const rnd = mulberry32(0xf17e);
  const C = S / 2;
  const R = S / 2;
  // Transparent outside is never sampled (the disc geometry ends at r = 1),
  // but fill it so mip/linear filtering at the rim does not bleed white.
  g.fillStyle = '#231e1a';
  g.fillRect(0, 0, S, S);
  // Basalt body.
  const body = g.createRadialGradient(C, C, 0, C, C, R);
  body.addColorStop(0, '#2d2723');
  body.addColorStop(0.7, '#241f1c');
  body.addColorStop(1, '#1b1715');
  g.fillStyle = body;
  g.beginPath();
  g.arc(C, C, R, 0, TAU);
  g.fill();
  speckle(g, S, rnd, 2600, '#4a3f37', '#0f0c0b', 0.98);
  // Bronze rim.
  g.lineWidth = R * 0.07;
  g.strokeStyle = '#6a5034';
  g.beginPath();
  g.arc(C, C, R * 0.955, 0, TAU);
  g.stroke();
  g.lineWidth = R * 0.012;
  g.strokeStyle = '#a07a4a';
  g.beginPath();
  g.arc(C, C, R * 0.93, 0, TAU);
  g.stroke();
  g.strokeStyle = '#120e0c';
  g.beginPath();
  g.arc(C, C, R * 0.99, 0, TAU);
  g.stroke();
  // Rune band (recessed).
  g.lineWidth = R * 0.2;
  g.strokeStyle = 'rgba(10,8,7,0.55)';
  g.beginPath();
  g.arc(C, C, R * 0.73, 0, TAU);
  g.stroke();
  // Band edge grooves (also glow).
  for (const rr of [0.625, 0.835]) {
    g.lineWidth = R * 0.014;
    g.strokeStyle = '#0c0908';
    g.beginPath();
    g.arc(C, C, R * rr, 0, TAU);
    g.stroke();
    mask.lineWidth = R * 0.016;
    mask.strokeStyle = '#8a8a8a';
    mask.beginPath();
    mask.arc(C, C, R * rr, 0, TAU);
    mask.stroke();
  }
  // Runes around the band: engraved on the albedo, bright on the mask.
  const GLYPHS = 14;
  for (let i = 0; i < GLYPHS; i++) {
    const a = (i / GLYPHS) * TAU;
    const seed = Math.floor(rnd() * 1e9);
    for (const [ctx, colour, lw] of [
      [g, '#0a0706', R * 0.022],
      [mask, '#ffffff', R * 0.026],
    ] as const) {
      ctx.save();
      ctx.translate(C + Math.cos(a) * R * 0.73, C + Math.sin(a) * R * 0.73);
      ctx.rotate(a + Math.PI / 2);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.lineWidth = lw;
      ctx.strokeStyle = colour;
      drawGlyph(ctx, mulberry32(seed), R * 0.13);
      ctx.restore();
    }
  }
  // Inner grate: ring + radial vent slots + central vent.
  g.lineWidth = R * 0.03;
  g.strokeStyle = '#3d332c';
  g.beginPath();
  g.arc(C, C, R * 0.5, 0, TAU);
  g.stroke();
  const SLOTS = 10;
  for (let i = 0; i < SLOTS; i++) {
    const a = (i / SLOTS) * TAU + 0.3;
    for (const [ctx, colour] of [
      [g, '#070505'],
      [vents, '#ffffff'],
    ] as const) {
      ctx.save();
      ctx.translate(C + Math.cos(a) * R * 0.36, C + Math.sin(a) * R * 0.36);
      ctx.rotate(a);
      ctx.fillStyle = colour;
      ctx.beginPath();
      ctx.roundRect(-R * 0.1, -R * 0.022, R * 0.2, R * 0.044, R * 0.02);
      ctx.fill();
      ctx.restore();
    }
  }
  for (const [ctx, colour] of [
    [g, '#060404'],
    [vents, '#ffffff'],
  ] as const) {
    ctx.fillStyle = colour;
    ctx.beginPath();
    ctx.arc(C, C, R * 0.15, 0, TAU);
    ctx.fill();
  }
  // Iron cross bars over the central vent.
  g.strokeStyle = '#3a302a';
  g.lineWidth = R * 0.028;
  g.beginPath();
  g.moveTo(C - R * 0.16, C);
  g.lineTo(C + R * 0.16, C);
  g.moveTo(C, C - R * 0.16);
  g.lineTo(C, C + R * 0.16);
  g.stroke();
  // Soot staining toward the vents.
  const soot = g.createRadialGradient(C, C, R * 0.1, C, C, R * 0.55);
  soot.addColorStop(0, 'rgba(0,0,0,0.45)');
  soot.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = soot;
  g.beginPath();
  g.arc(C, C, R * 0.55, 0, TAU);
  g.fill();
  return c;
}

function spikePlate(S: number, mask: CanvasRenderingContext2D): HTMLCanvasElement {
  const { c, g } = canvas(S);
  const rnd = mulberry32(0x5b1c);
  const C = S / 2;
  const R = S / 2;
  g.fillStyle = '#3c3e41';
  g.fillRect(0, 0, S, S);
  const body = g.createRadialGradient(C * 0.8, C * 0.8, 0, C, C, R);
  body.addColorStop(0, '#5a5d61');
  body.addColorStop(0.75, '#46494d');
  body.addColorStop(1, '#34363a');
  g.fillStyle = body;
  g.beginPath();
  g.arc(C, C, R, 0, TAU);
  g.fill();
  // Brushed grain.
  g.globalAlpha = 0.07;
  for (let i = 0; i < 180; i++) {
    const y = rnd() * S;
    g.strokeStyle = rnd() < 0.5 ? '#9aa0a6' : '#1d1f22';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(S, y + (rnd() - 0.5) * 6);
    g.stroke();
  }
  g.globalAlpha = 1;
  // Rust blotches.
  for (let i = 0; i < 26; i++) {
    const a = rnd() * TAU;
    const r = Math.sqrt(rnd()) * R * 0.9;
    const x = C + Math.cos(a) * r;
    const y = C + Math.sin(a) * r;
    const s = R * (0.04 + rnd() * 0.1);
    const grad = g.createRadialGradient(x, y, 0, x, y, s);
    grad.addColorStop(0, 'rgba(110,62,30,0.45)');
    grad.addColorStop(1, 'rgba(110,62,30,0)');
    g.fillStyle = grad;
    g.fillRect(x - s, y - s, s * 2, s * 2);
  }
  speckle(g, S, rnd, 1400, '#7d8288', '#1a1b1d', 0.98);
  // Rim + seam.
  g.lineWidth = R * 0.06;
  g.strokeStyle = '#2a2c2f';
  g.beginPath();
  g.arc(C, C, R * 0.965, 0, TAU);
  g.stroke();
  g.lineWidth = R * 0.01;
  g.strokeStyle = '#7b8086';
  g.beginPath();
  g.arc(C, C, R * 0.93, 0, TAU);
  g.stroke();
  mask.lineWidth = R * 0.02;
  mask.strokeStyle = '#707070';
  mask.beginPath();
  mask.arc(C, C, R * 0.93, 0, TAU);
  mask.stroke();
  // Bolt heads around the rim.
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * TAU;
    const x = C + Math.cos(a) * R * 0.88;
    const y = C + Math.sin(a) * R * 0.88;
    g.fillStyle = '#23252a';
    g.beginPath();
    g.arc(x + 1.5, y + 1.5, R * 0.03, 0, TAU);
    g.fill();
    g.fillStyle = '#8c9197';
    g.beginPath();
    g.arc(x, y, R * 0.028, 0, TAU);
    g.fill();
  }
  // Holes (bevelled) + their glow mask.
  const hr = HOLE_DRAW_R * R;
  for (const h of SPIKE_HOLES) {
    const x = C + h.x * R;
    const y = C + h.z * R;
    g.fillStyle = '#8a8f95';
    g.beginPath();
    g.arc(x + hr * 0.25, y + hr * 0.25, hr * 1.25, 0, TAU);
    g.fill();
    g.fillStyle = '#1b1c1f';
    g.beginPath();
    g.arc(x - hr * 0.15, y - hr * 0.15, hr * 1.2, 0, TAU);
    g.fill();
    g.fillStyle = '#050505';
    g.beginPath();
    g.arc(x, y, hr, 0, TAU);
    g.fill();
    mask.fillStyle = '#ffffff';
    mask.beginPath();
    mask.arc(x, y, hr * 0.95, 0, TAU);
    mask.fill();
  }
  return c;
}

/** Merge three greyscale canvases into one RGB mask texture. */
function mergeMask(S: number, r: HTMLCanvasElement, gC: HTMLCanvasElement, b: HTMLCanvasElement): HTMLCanvasElement {
  const { c, g } = canvas(S);
  const out = g.createImageData(S, S);
  const read = (cv: HTMLCanvasElement): Uint8ClampedArray => {
    const ctx = cv.getContext('2d');
    if (ctx === null) throw new Error('2d canvas unavailable for trap mask');
    return ctx.getImageData(0, 0, S, S).data;
  };
  const dr = read(r);
  const dg = read(gC);
  const db = read(b);
  for (let i = 0; i < out.data.length; i += 4) {
    out.data[i] = dr[i];
    out.data[i + 1] = dg[i];
    out.data[i + 2] = db[i];
    out.data[i + 3] = 255;
  }
  g.putImageData(out, 0, 0);
  return c;
}

/** Build all trap textures (512² albedo, 256² glow mask). */
export function makeTrapTextures(): TrapTextures {
  const S = 512;
  const M = S;
  const maskR = canvas(M);
  const maskG = canvas(M);
  const maskB = canvas(M);
  for (const m of [maskR, maskG, maskB]) {
    m.g.fillStyle = '#000';
    m.g.fillRect(0, 0, M, M);
  }
  const fire = firePlate(S, maskR.g, maskB.g);
  const spikes = spikePlate(S, maskG.g);
  // Soften the mask so the glow reads as light, not as a hard stencil.
  const merged = mergeMask(M, maskR.c, maskG.c, maskB.c);
  const blurred = canvas(M);
  blurred.g.filter = 'blur(1.5px)';
  blurred.g.drawImage(merged, 0, 0);
  blurred.g.filter = 'none';
  blurred.g.globalCompositeOperation = 'lighter';
  blurred.g.globalAlpha = 0.6;
  blurred.g.drawImage(merged, 0, 0);
  const firePlateTex = toTexture(fire, true);
  const spikePlateTex = toTexture(spikes, true);
  const glowMask = toTexture(blurred.c, false);
  return {
    firePlate: firePlateTex,
    spikePlate: spikePlateTex,
    glowMask,
    dispose(): void {
      firePlateTex.dispose();
      spikePlateTex.dispose();
      glowMask.dispose();
    },
  };
}
