/**
 * Low-poly primitive & palette helpers for the animal rigs (BLUEPRINT §11.1/§11.3).
 *
 * Everything here is flat-shaded, accent-tinted, and deliberately coarse
 * (low segment counts) so each articulated animal lands in the 300–900 tri
 * budget. Builders create fresh geometries/materials per rig instance so a rig
 * owns everything it disposes (see {@link BaseRig.dispose}); nothing is shared
 * across rigs.
 */

import * as THREE from 'three';

/** Parse a `#rrggbb` string to a THREE-friendly 0xRRGGBB number. */
export function hexToNum(hex: string): number {
  return parseInt(hex.replace('#', ''), 16) >>> 0;
}

/**
 * Shade a colour. `amt < 0` darkens (multiply toward black), `amt > 0` lightens
 * (mix toward white). `amt` is a fraction in [-1, 1].
 */
export function shade(color: number, amt: number): number {
  const r = (color >> 16) & 0xff;
  const g = (color >> 8) & 0xff;
  const b = color & 0xff;
  let nr: number;
  let ng: number;
  let nb: number;
  if (amt < 0) {
    const f = 1 + amt;
    nr = r * f;
    ng = g * f;
    nb = b * f;
  } else {
    nr = r + (255 - r) * amt;
    ng = g + (255 - g) * amt;
    nb = b + (255 - b) * amt;
  }
  const c = (x: number): number => Math.max(0, Math.min(255, Math.round(x)));
  return (c(nr) << 16) | (c(ng) << 8) | c(nb);
}

/** Mix two packed colours by `t` (0 = a, 1 = b). */
export function mixColor(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 0xff;
  const ag = (a >> 8) & 0xff;
  const ab = a & 0xff;
  const br = (b >> 16) & 0xff;
  const bg = (b >> 8) & 0xff;
  const bb = b & 0xff;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bl;
}

/** A small shared set of tones derived from an animal's accent colour. */
export interface Palette {
  accent: number;
  light: number;
  dark: number;
  darker: number;
  belly: number;
  bone: number;
  claw: number;
  eye: number;
  black: number;
}

/** Build a coherent low-poly palette around an accent hex string. */
export function makePalette(accentHex: string): Palette {
  const accent = hexToNum(accentHex);
  return {
    accent,
    light: shade(accent, 0.22),
    dark: shade(accent, -0.28),
    darker: shade(accent, -0.5),
    belly: mixColor(shade(accent, 0.35), 0xdec9a8, 0.4),
    bone: 0xece3cf,
    claw: 0x2b2b2b,
    eye: 0x1a1414,
    black: 0x201d1a,
  };
}

/** Flat-shaded standard material (BLUEPRINT §11.1: roughness≈0.9, matte). */
export function makeMat(color: number, opts?: { rough?: number; metal?: number }): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: opts?.rough ?? 0.92,
    metalness: opts?.metal ?? 0.0,
    flatShading: true,
  });
}

// ── Geometry factories (low segment counts for the tri budget) ───────────────

export function boxGeo(w: number, h: number, d: number): THREE.BoxGeometry {
  return new THREE.BoxGeometry(w, h, d);
}

export function cylGeo(rTop: number, rBot: number, h: number, seg = 7): THREE.CylinderGeometry {
  return new THREE.CylinderGeometry(rTop, rBot, h, seg, 1);
}

export function sphGeo(r: number, wseg = 8, hseg = 6): THREE.SphereGeometry {
  return new THREE.SphereGeometry(r, wseg, hseg);
}

export function coneGeo(r: number, h: number, seg = 7): THREE.ConeGeometry {
  return new THREE.ConeGeometry(r, h, seg, 1);
}

export function capGeo(r: number, len: number, radial = 6): THREE.CapsuleGeometry {
  return new THREE.CapsuleGeometry(r, len, 2, radial);
}

/**
 * Create a mesh from a geometry + material and place it. Convenience so builders
 * read as a flat list of parts. The geometry/material are owned by the rig and
 * disposed when the rig is disposed.
 */
export function mesh(
  geo: THREE.BufferGeometry,
  mat: THREE.Material,
  x = 0,
  y = 0,
  z = 0,
): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = false;
  m.receiveShadow = false;
  return m;
}

/** Create an empty pivot group at a local position (used as an articulated joint node). */
export function pivot(x = 0, y = 0, z = 0): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  return g;
}

/**
 * A simple limb hanging straight down (−Y) from its pivot: tapered cylinder of
 * length `len`, with an optional foot blob at the end. Rotate the returned
 * group's pivot to swing the limb.
 */
export function leg(
  mat: THREE.Material,
  rTop: number,
  rBot: number,
  len: number,
  footMat?: THREE.Material,
): THREE.Group {
  const g = new THREE.Group();
  g.add(mesh(cylGeo(rTop, rBot, len, 6), mat, 0, -len / 2, 0));
  if (footMat !== undefined) {
    const foot = mesh(sphGeo(rBot * 1.4, 6, 4), footMat, 0, -len, rBot * 0.5);
    foot.scale.set(1, 0.7, 1.25);
    g.add(foot);
  }
  return g;
}
