/**
 * Low-poly primitive & palette helpers for the animal rigs (BLUEPRINT §11.1/§11.3,
 * v1.1 WP-K overhaul).
 *
 * Builders assemble a rig from ordinary meshes under articulated pivots; at the
 * end of construction {@link BaseRig.finalize} BAKES every part into ONE
 * skinned, vertex-coloured mesh (one bone per joint, rigid weights), adds
 * countershading, per-part paint patterns and an inverted-hull outline. So the
 * materials made here are only colour carriers — per-part look is steered by
 * `userData` flags set with the helpers below:
 *
 *  - {@link noTone}    skip countershading (eyes, teeth, claws …)
 *  - {@link noOutline} leave the part out of the outline hull (tiny parts)
 *  - {@link glow}      unlit + bloom-bright (panther eyes, ult glows)
 *  - {@link paint}     per-triangle colour pattern (patches, bands, stripes)
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

/** Flat-shaded standard material (colour carrier; baked into vertex colours). */
export function makeMat(color: number, opts?: { rough?: number; metal?: number }): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: opts?.rough ?? 0.92,
    metalness: opts?.metal ?? 0.0,
    flatShading: true,
  });
}

// ── Part flags (read by the bake) ─────────────────────────────────────────────

/** Per-triangle paint hook: body-space centroid `p`, face normal `n`, colour to edit. */
export type PaintFn = (p: THREE.Vector3, n: THREE.Vector3, c: THREE.Color) => void;

export function noTone<T extends THREE.Object3D>(o: T): T {
  o.userData.noTone = true;
  return o;
}

export function noOutline<T extends THREE.Object3D>(o: T): T {
  o.userData.noOutline = true;
  return o;
}

/** Unlit, HDR-bright part (bloom picks it up). `boost` multiplies the colour. */
export function glow<T extends THREE.Object3D>(o: T, boost = 2.6): T {
  o.userData.glow = boost;
  o.userData.noOutline = true;
  return o;
}

export function paint<T extends THREE.Object3D>(o: T, fn: PaintFn): T {
  o.userData.paint = fn;
  return o;
}

// ── Geometry factories ───────────────────────────────────────────────────────

export function boxGeo(w: number, h: number, d: number): THREE.BoxGeometry {
  return new THREE.BoxGeometry(w, h, d);
}

export function cylGeo(rTop: number, rBot: number, h: number, seg = 8): THREE.CylinderGeometry {
  return new THREE.CylinderGeometry(rTop, rBot, h, seg, 1);
}

/** Open-ended tapered tube (limb segments whose ends are hidden by blobs). */
export function openCyl(rTop: number, rBot: number, h: number, seg = 7): THREE.CylinderGeometry {
  return new THREE.CylinderGeometry(rTop, rBot, h, seg, 1, true);
}

export function sphGeo(r: number, wseg = 10, hseg = 7): THREE.SphereGeometry {
  return new THREE.SphereGeometry(r, wseg, hseg);
}

export function coneGeo(r: number, h: number, seg = 7): THREE.ConeGeometry {
  return new THREE.ConeGeometry(r, h, seg, 1);
}

export function capGeo(r: number, len: number, radial = 8): THREE.CapsuleGeometry {
  return new THREE.CapsuleGeometry(r, len, 2, radial);
}

/** Ring (in the XY plane, axis +Z) — manes, collars, nostril rims. */
export function torusGeo(r: number, tube: number, radial = 5, tubular = 12): THREE.TorusGeometry {
  return new THREE.TorusGeometry(r, tube, radial, tubular);
}

/** Dodecahedron-ish lump (manes, tufts, rocks). */
export function lumpGeo(r: number, detail = 0): THREE.BufferGeometry {
  return new THREE.IcosahedronGeometry(r, detail);
}

/**
 * Create a mesh from a geometry + material and place it. Convenience so builders
 * read as a flat list of parts.
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

/** Mesh with scale + euler rotation in one call. */
export function part(
  geo: THREE.BufferGeometry,
  mat: THREE.Material,
  x: number,
  y: number,
  z: number,
  sx = 1,
  sy = sx,
  sz = sx,
  rx = 0,
  ry = 0,
  rz = 0,
): THREE.Mesh {
  const m = mesh(geo, mat, x, y, z);
  m.scale.set(sx, sy, sz);
  m.rotation.set(rx, ry, rz);
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
 * length `len`, with an optional foot blob at the end.
 */
export function leg(
  mat: THREE.Material,
  rTop: number,
  rBot: number,
  len: number,
  footMat?: THREE.Material,
): THREE.Group {
  const g = new THREE.Group();
  g.add(mesh(cylGeo(rTop, rBot, len, 7), mat, 0, -len / 2, 0));
  if (footMat !== undefined) {
    const foot = mesh(sphGeo(rBot * 1.4, 7, 5), footMat, 0, -len, rBot * 0.5);
    foot.scale.set(1, 0.7, 1.25);
    g.add(foot);
  }
  return g;
}

export interface SolidLegOpts {
  /** Upper (thigh/forearm) material. */
  mat: THREE.Material;
  /** Lower-leg / foot material (defaults to `mat`). */
  lowMat?: THREE.Material;
  /** Claw / hoof material; omitted → no claws. */
  clawMat?: THREE.Material;
  /** Hip-to-ground length. */
  len: number;
  /** Thigh radius at the hip. */
  rTop: number;
  /** Ankle radius. */
  rBot: number;
  /** Paw style. */
  foot: 'paw' | 'hoof' | 'pad' | 'none';
  /** Number of claws/toes on a paw (default 3). */
  toes?: number;
  /** Forward knee bend of the shin (radians, cosmetic). */
  bend?: number;
  /** Foot pad / hoof material (defaults to the lower-leg material). */
  footMat?: THREE.Material;
}

/**
 * A SOLID articulated-looking leg for quadrupeds: a muscular thigh blob that
 * merges into the body, a tapered shin, and a paw (with claws) or hoof. The
 * whole thing hangs from the returned group's origin (the hip pivot) and ends
 * at y = −len.
 */
export function solidLeg(o: SolidLegOpts): THREE.Group {
  const g = new THREE.Group();
  const low = o.lowMat ?? o.mat;
  const footM = o.footMat ?? low;
  const L = o.len;
  const bend = o.bend ?? 0.12;
  if (o.foot === 'pad') {
    // Pillar leg (hippo/rhino): one continuous tapered column on a wide pad.
    g.add(part(sphGeo(o.rTop, 7, 5), o.mat, 0, -L * 0.12, 0, 1, Math.max(1, (L * 0.3) / o.rTop), 1.05));
    g.add(part(openCyl(o.rTop * 0.92, o.rBot * 1.25, L * 0.9, 8), o.mat, 0, -L * 0.52, 0));
    const pr = o.rBot * 1.45;
    g.add(part(cylGeo(pr, pr * 1.06, pr * 0.5, 9), footM, 0, -L + pr * 0.25, pr * 0.12, 1, 1, 1.1));
    if (o.clawMat !== undefined) {
      const n = o.toes ?? 3;
      for (let i = 0; i < n; i++) {
        const x = (i - (n - 1) / 2) * pr * 0.6;
        g.add(noOutline(noTone(part(sphGeo(pr * 0.24, 5, 3), o.clawMat, x, -L + pr * 0.2, pr * 0.95, 1, 0.65, 1))));
      }
    }
    return g;
  }
  // Thigh: a big teardrop that reads as muscle, overlapping the body.
  const thigh = part(sphGeo(o.rTop, 7, 5), o.mat, 0, -L * 0.2, 0, 1, (L * 0.36) / o.rTop, 1.08);
  g.add(thigh);
  // Upper segment (open tube: ends are covered by the thigh + knee blobs).
  const upLen = L * 0.48;
  const up = part(openCyl(o.rTop * 0.86, o.rBot * 1.2, upLen, 7), o.mat, 0, -L * 0.28, 0);
  g.add(up);
  // Lower segment with a slight knee bend.
  const loLen = L * 0.46;
  const lo = part(openCyl(o.rBot * 1.18, o.rBot, loLen, 6), low, 0, -L * 0.72, loLen * 0.12, 1, 1, 1, bend);
  g.add(lo);
  // Knee/ankle joint bulge.
  g.add(part(sphGeo(o.rBot * 1.22, 5, 4), low, 0, -L * 0.52, 0.01));
  if (o.foot === 'paw') {
    const pr = o.rBot * 1.45;
    g.add(part(sphGeo(pr, 6, 4), low, 0, -L + pr * 0.45, pr * 0.35, 1.05, 0.6, 1.3));
    if (o.clawMat !== undefined) {
      const n = o.toes ?? 3;
      for (let i = 0; i < n; i++) {
        const x = (i - (n - 1) / 2) * pr * 0.55;
        const claw = part(coneGeo(pr * 0.16, pr * 0.5, 4), o.clawMat, x, -L + pr * 0.15, pr * 1.55, 1, 1, 1, Math.PI / 2 + 0.35);
        g.add(noOutline(noTone(claw)));
      }
    }
  } else if (o.foot === 'hoof') {
    const hr = o.rBot * 1.15;
    g.add(part(cylGeo(hr, hr * 1.18, hr * 1.1, 8), o.clawMat ?? footM, 0, -L + hr * 0.55, 0.01));
  }
  return g;
}

export interface EyeOpts {
  /** Eyeball radius. */
  r: number;
  /** Sclera / iris colour (animals mostly show iris colour). */
  iris: number;
  /** Pupil colour (default near-black). */
  pupil?: number;
  /** Vertical slit pupil (cats, crocs, snakes). */
  slit?: boolean;
  /** Glowing eyes (unlit + bloom). */
  glowing?: boolean;
  /** Side the eye sits on: −1 left, +1 right (turns the look outward). */
  side: number;
  /** How much the eye looks sideways (0 = straight ahead, 1 = fully lateral). */
  lateral?: number;
}

/**
 * A readable cartoon eye: iris ball, dark pupil (round or slit) and a white
 * glint, all facing forward/outward. Returns the eye group; add it to a head.
 */
export function eye(o: EyeOpts): THREE.Group {
  const g = new THREE.Group();
  const lat = o.lateral ?? 0.35;
  const irisM = makeMat(o.iris);
  const pupilM = makeMat(o.pupil ?? 0x0c0a09);
  const glintM = makeMat(0xffffff);
  const ball = mesh(sphGeo(o.r, 7, 4), irisM);
  g.add(noOutline(noTone(o.glowing === true ? glow(ball, 3.2) : ball)));
  // Look direction (forward +Z, bent outward by `lat`).
  const dx = o.side * lat;
  const dz = 1;
  const inv = 1 / Math.hypot(dx, dz);
  const nx = dx * inv;
  const nz = dz * inv;
  const pr = o.r * (o.slit === true ? 0.5 : 0.56);
  const pupil = mesh(sphGeo(pr, 5, 3), pupilM, nx * o.r * 0.72, 0, nz * o.r * 0.72);
  pupil.scale.set(o.slit === true ? 0.32 : 1, o.slit === true ? 1.5 : 1, 0.55);
  pupil.rotation.y = Math.atan2(nx, nz);
  g.add(noOutline(noTone(o.glowing === true ? glow(pupil, 1) : pupil)));
  const glint = mesh(sphGeo(o.r * 0.2, 4, 2), glintM, nx * o.r * 0.78 + o.r * 0.22, o.r * 0.34, nz * o.r * 0.78);
  g.add(noOutline(glow(glint, 1.6)));
  return g;
}

/** Row of small cone teeth along X (pointing −Y by default, flip for lower jaw). */
export function teeth(
  mat: THREE.Material,
  count: number,
  width: number,
  size: number,
  x: number,
  y: number,
  z: number,
  up = false,
): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  for (let i = 0; i < count; i++) {
    const tx = count === 1 ? 0 : -width / 2 + (width * i) / (count - 1);
    const t = mesh(coneGeo(size * 0.45, size, 4), mat, tx, 0, 0);
    t.rotation.x = up ? 0 : Math.PI;
    g.add(noOutline(noTone(t)));
  }
  return g;
}

// ── Pattern helpers for paint() ──────────────────────────────────────────────

/** A THREE.Color from a packed hex (for paint() lerps; init-time only). */
export function col(hex: number): THREE.Color {
  return new THREE.Color(hex);
}

/** Deterministic 3D hash → [0,1). */
export function hash3(x: number, y: number, z: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return s - Math.floor(s);
}

/**
 * Cellular (Voronoi) distance pattern: returns [f1, f2] distance to the
 * nearest two feature points of a jittered grid with `cell` spacing.
 */
export function cellular(x: number, y: number, z: number, cell: number, out: [number, number]): [number, number] {
  const gx = Math.floor(x / cell);
  const gy = Math.floor(y / cell);
  const gz = Math.floor(z / cell);
  let f1 = 1e9;
  let f2 = 1e9;
  for (let i = -1; i <= 1; i++) {
    for (let j = -1; j <= 1; j++) {
      for (let k = -1; k <= 1; k++) {
        const cx = gx + i;
        const cy = gy + j;
        const cz = gz + k;
        const px = (cx + hash3(cx, cy, cz)) * cell;
        const py = (cy + hash3(cy, cz, cx)) * cell;
        const pz = (cz + hash3(cz, cx, cy)) * cell;
        const d = Math.hypot(x - px, y - py, z - pz);
        if (d < f1) {
          f2 = f1;
          f1 = d;
        } else if (d < f2) f2 = d;
      }
    }
  }
  out[0] = f1;
  out[1] = f2;
  return out;
}
