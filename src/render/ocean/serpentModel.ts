/**
 * The SEA SERPENT model (WP-O3): a long segmented body (instanced elongated spheres following a path, finned spine, bioluminescent
 * flank dots) and a horned head with a hinged jaw, teeth, cheek frills and glowing eyes. The head is ~3.5 m wide, the body ~74 m long.
 *
 * The pose is a pure function of the {@link SerpentVisual} (derived from the snapshot's serpent block) plus the scene time (for the
 * body's slither): `update(v, time)` writes instance matrices into pre-allocated buffers - no allocation per frame. Everything is
 * hidden (`root.visible = false`) while no event runs, so an idle match pays nothing for it.
 *
 * Path of the body (distance `u` behind the head centre):
 *   - STRAIGHT (strike / hold / retreat): along the strike line outward, hugging the terrain inside the dome (a cached ground profile
 *     of the line, blurred), then out through the breach into the water where it swings in a slow S-curve.
 *   - COILED (warning): a neck going straight out from the head, then a rising spiral outside the dome.
 *   The two are blended by `v.coil` (1 -> 0 over the first 0.3 s of the strike: the body unfurls as the head shoots in).
 *
 * v1.10: `new SerpentModel(shared, 'high')` is the HIGH serpent: a violet / magenta palette (scales, fins, glowing eyes and flank dots) and
 * a body that flies level at the head's height inside the dome (it skims the tower tops instead of hugging the floor).
 */

import * as THREE from 'three';
import { hash2, mix, rgb, smoothstep, VGeo, composeMat } from '../jungle/vgeo';
import { arenaGroundHeight, type ArenaDef } from '../../config/arenas';
import { addLoft, quadTri, tri } from './life';
import type { SerpentTier } from '../../core/types';
import { patchBasicFog, patchLit, type OceanShared } from './materials';
import { BODY_LENGTH, HEAD_RADIUS, type SerpentVisual } from './serpentState';
import type { QualityTier } from '../quality';

const BODY_MAX = 96;
const PROFILE_STEP = 0.5;
const PROFILE_MAX = 80; // metres of line profile cached (dome radius + margin)

/** Body radius at distance `u` behind the head centre. */
export function bodyRadius(u: number): number {
  const neck = mix(1.3, 1.62, smoothstep(0, 6, u));
  const taper = 1 - smoothstep(6, BODY_LENGTH, u);
  return neck * (0.2 + 0.8 * taper) + 0.12;
}

/** Cumulative arc-length table (u of each body segment): spacing ~ the local radius so neighbouring spheres overlap. */
export function bodySegments(): Float32Array {
  const us: number[] = [];
  let u = 2.2;
  while (u < BODY_LENGTH && us.length < BODY_MAX) {
    us.push(u);
    u += Math.max(0.5, bodyRadius(u) * 1.08);
  }
  return Float32Array.from(us);
}

// ── Geometry ─────────────────────────────────────────────────────────────────

type RGB3 = [number, number, number];
interface Palette {
  scaleDark: RGB3;
  scaleMid: RGB3;
  belly: RGB3;
  horn: RGB3;
  tooth: RGB3;
  fin: RGB3;
  finTip: RGB3;
  mouth: RGB3;
  /** Glowing eye colour (> 1: blooms). */
  eye: RGB3;
  /** The two flank-dot colours and the colour the tail end fades toward. */
  dotA: RGB3;
  dotB: RGB3;
  tail: RGB3;
}

/** The low serpent (teal scales, orange fins) and the high serpent (deep violet scales, magenta fins, magenta eyes). */
export const SERPENT_PALETTE: Record<SerpentTier, Palette> = {
  low: {
    scaleDark: rgb(0x143945),
    scaleMid: rgb(0x1f5967),
    belly: rgb(0x6fb0a6),
    horn: rgb(0xe3c27c),
    tooth: rgb(0xf6efd2),
    fin: rgb(0xe56f3a),
    finTip: rgb(0xffb04a),
    mouth: rgb(0xb03a3c),
    eye: [3.2, 2.9, 0.35],
    dotA: [0.4, 2.4, 2.0],
    dotB: [1.8, 0.9, 2.4],
    tail: [0.7, 0.55, 1.0],
  },
  high: {
    scaleDark: rgb(0x2a1856),
    scaleMid: rgb(0x4d2a96),
    belly: rgb(0xb98fe0),
    horn: rgb(0xf3d9ff),
    tooth: rgb(0xfff4ff),
    fin: rgb(0xd1349f),
    finTip: rgb(0xff8be6),
    mouth: rgb(0x7a1c6e),
    eye: [3.3, 0.55, 2.9],
    dotA: [2.7, 0.5, 2.6],
    dotB: [0.9, 1.1, 3.0],
    tail: [1.0, 0.5, 0.8],
  },
};

function hexAt(x: number, y: number, z: number): number {
  return hash2(Math.floor(x * 3.1 + 40), Math.floor(y * 3.1 + z * 2.3 + 40));
}

/** The head (everything but the jaw), local space: origin = head centre, +z = forward (snout), +y up. */
export function buildHeadGeometry(C: Palette = SERPENT_PALETTE.low): THREE.BufferGeometry {
  const vg = new VGeo();
  const skull = [
    { z: 2.95, rx: 0.06, ry: 0.05, cy: 0.05 },
    { z: 2.7, rx: 0.4, ry: 0.32, cy: 0.1 },
    { z: 1.8, rx: 0.82, ry: 0.6, cy: 0.18 },
    { z: 0.4, rx: 1.3, ry: 0.88, cy: 0.25 },
    { z: -0.9, rx: 1.4, ry: 1.0, cy: 0.28 },
    { z: -1.8, rx: 0.95, ry: 0.75, cy: 0.15 },
    { z: -2.15, rx: 0.2, ry: 0.2, cy: 0.1 },
  ];
  addLoft(vg, skull, 14, (t, a) => {
    const down = smoothstep(0.1, -0.7, Math.sin(a));
    const scale = hexAt(t * 20, Math.cos(a) * 4, Math.sin(a) * 4);
    const base = mix(C.scaleDark[1], C.scaleMid[1], scale);
    return [mix(mix(C.scaleDark[0], C.scaleMid[0], scale), C.belly[0] * 0.7, down), mix(base, C.belly[1] * 0.75, down), mix(mix(C.scaleDark[2], C.scaleMid[2], scale), C.belly[2] * 0.7, down)];
  });
  // palate (the red roof of the mouth, seen when the jaw opens)
  quadTri(vg, [-0.62, -0.58, 0.2], [0.62, -0.58, 0.2], [0.36, -0.42, 2.3], [-0.36, -0.42, 2.3], C.mouth);
  // upper teeth: two rows along the lower edge of the skull
  for (let i = 0; i < 9; i++) {
    const z = 0.5 + i * 0.26;
    const w = 0.55 - i * 0.04;
    for (const sx of [-1, 1]) {
      const len = 0.42 + 0.34 * hash2(i, sx + 3) + (i % 3 === 0 ? 0.25 : 0);
      const cone = new THREE.ConeGeometry(0.075, len, 5, 1);
      cone.rotateX(Math.PI);
      vg.add(cone, composeMat(sx * w, -0.5 - len / 2 + 0.06 + (i * 0.012), z), C.tooth);
      cone.dispose();
    }
  }
  // two big swept-back horns + brow spikes + a crest
  for (const sx of [-1, 1]) {
    const horn = new THREE.ConeGeometry(0.3, 2.7, 6, 3);
    const hp = horn.getAttribute('position');
    for (let i = 0; i < hp.count; i++) {
      const y = hp.getY(i);
      hp.setZ(i, hp.getZ(i) - Math.pow((y + 1.35) / 2.7, 2) * 0.6);
    }
    horn.computeVertexNormals();
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-1.05, 0, -sx * 0.32, 'YXZ'));
    vg.add(horn, new THREE.Matrix4().compose(new THREE.Vector3(sx * 0.82, 1.65, -1.4), q, new THREE.Vector3(1, 1, 1)), (x, y, z, nx, ny, nz, out) => {
      const t = smoothstep(0.8, 2.6, y);
      out[0] = mix(C.horn[0], 1.8, t * 0.5);
      out[1] = mix(C.horn[1], 1.3, t * 0.5);
      out[2] = mix(C.horn[2], 0.6, t * 0.5);
      void x;
      void z;
      void nx;
      void ny;
      void nz;
    });
    horn.dispose();
    for (let i = 0; i < 3; i++) {
      const sp = new THREE.ConeGeometry(0.11, 0.55 - i * 0.08, 5, 1);
      const q2 = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.5, 0, -sx * 0.4, 'YXZ'));
      vg.add(sp, new THREE.Matrix4().compose(new THREE.Vector3(sx * (0.82 - i * 0.05), 0.95 + 0.04 * i, 1.55 - i * 0.55), q2, new THREE.Vector3(1, 1, 1)), C.horn);
      sp.dispose();
    }
    // cheek frills: three fins fanning back from the jaw hinge (these make the head ~3.5 m wide)
    for (let k = 0; k < 3; k++) {
      const y0 = 0.35 - k * 0.45;
      tri(vg, [sx * 1.25, y0, -0.7], [sx * 1.78, y0 + 0.25, -1.9 - k * 0.25], [sx * 1.3, y0 - 0.4, -1.7 - k * 0.15], C.fin, C.finTip);
    }
  }
  for (let i = 0; i < 6; i++) {
    const cr = new THREE.ConeGeometry(0.16, 0.7 - i * 0.07, 4, 1);
    vg.add(cr, composeMat(0, 1.2 - i * 0.04, 0.3 - i * 0.42, -0.25), C.fin);
    cr.dispose();
  }
  // nostrils
  for (const sx of [-1, 1]) {
    const n = new THREE.IcosahedronGeometry(0.07, 0);
    vg.add(n, composeMat(sx * 0.16, 0.22, 2.62), [0.02, 0.04, 0.05]);
    n.dispose();
  }
  return vg.build();
}

/** The lower jaw, local space: origin = the hinge, +z forward. */
export function buildJawGeometry(C: Palette = SERPENT_PALETTE.low): THREE.BufferGeometry {
  const vg = new VGeo();
  const jaw = [
    { z: 3.5, rx: 0.07, ry: 0.06, cy: -0.1 },
    { z: 3.2, rx: 0.3, ry: 0.2, cy: -0.1 },
    { z: 2.2, rx: 0.62, ry: 0.32, cy: -0.1 },
    { z: 0.9, rx: 0.95, ry: 0.42, cy: -0.05 },
    { z: -0.2, rx: 1.15, ry: 0.5, cy: 0.0 },
    { z: -0.7, rx: 0.7, ry: 0.35, cy: 0.0 },
  ];
  addLoft(vg, jaw, 12, (t, a) => {
    const down = smoothstep(0.0, -0.8, Math.sin(a));
    const sc = hexAt(t * 20, Math.cos(a) * 4, Math.sin(a) * 4);
    return [mix(C.scaleDark[0] * 1.2, C.belly[0], down * 0.8 + 0.1 * sc), mix(C.scaleMid[1], C.belly[1], down * 0.8), mix(C.scaleMid[2], C.belly[2], down * 0.8)];
  });
  // tongue
  quadTri(vg, [-0.4, 0.34, 0.2], [0.4, 0.34, 0.2], [0.2, 0.3, 2.6], [-0.2, 0.3, 2.6], C.mouth);
  // lower teeth, pointing up
  for (let i = 0; i < 8; i++) {
    const z = 0.6 + i * 0.3;
    const w = 0.5 - i * 0.04;
    for (const sx of [-1, 1]) {
      const len = 0.32 + 0.3 * hash2(i + 3, sx + 5);
      const cone = new THREE.ConeGeometry(0.07, len, 5, 1);
      vg.add(cone, composeMat(sx * w, 0.3 + len / 2 - 0.04, z), C.tooth);
      cone.dispose();
    }
  }
  return vg.build();
}

/** Eyes: glowing yellow-green globes with dark slit pupils (unlit, colours > 1 so they bloom). */
export function buildEyeGeometry(C: Palette = SERPENT_PALETTE.low): THREE.BufferGeometry {
  const vg = new VGeo();
  for (const sx of [-1, 1]) {
    const eye = new THREE.IcosahedronGeometry(0.26, 1);
    vg.add(eye, composeMat(sx * 0.92, 0.5, 1.15), C.eye);
    eye.dispose();
    const slit = new THREE.IcosahedronGeometry(1, 0);
    vg.add(slit, composeMat(sx * 1.1, 0.5, 1.3, 0, 0.4 * sx, 0, 0.045, 0.2, 0.09), [0.02, 0.03, 0.02]);
    slit.dispose();
  }
  return vg.build();
}

// ── The model ────────────────────────────────────────────────────────────────

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _t = new THREE.Vector3();
const _s = new THREE.Vector3();
const _u = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _c = new THREE.Color();
const _b1 = new THREE.Vector3();
const _b2 = new THREE.Vector3();
const _b3 = new THREE.Vector3();

export class SerpentModel {
  readonly tier: SerpentTier;
  readonly root = new THREE.Group();
  readonly head = new THREE.Group();
  private readonly jaw = new THREE.Group();
  private readonly bodyMesh: THREE.InstancedMesh;
  private readonly finMesh: THREE.InstancedMesh;
  private readonly dotMesh: THREE.InstancedMesh;
  private readonly segU: Float32Array;
  private readonly pos: Float32Array;
  private readonly materials: THREE.Material[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly profile = new Float32Array(Math.ceil(PROFILE_MAX / PROFILE_STEP) + 1);
  private profileAngle = -999;
  private dots: number;

  constructor(shared: OceanShared, tier: SerpentTier = 'low') {
    this.tier = tier;
    const C = SERPENT_PALETTE[tier];
    this.root.visible = false;
    this.segU = bodySegments();
    const n = this.segU.length;
    this.pos = new Float32Array((n + 1) * 3);

    const lit = (key: string): THREE.MeshStandardMaterial => {
      const m = patchLit(new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.55, metalness: 0.08, side: THREE.DoubleSide }), shared, { key: `serpent-${key}`, waterFog: true });
      this.materials.push(m);
      return m;
    };
    const headGeo = buildHeadGeometry(C);
    const jawGeo = buildJawGeometry(C);
    const eyeGeo = buildEyeGeometry(C);
    this.geometries.push(headGeo, jawGeo, eyeGeo);
    const headMesh = new THREE.Mesh(headGeo, lit('head'));
    const jawMesh = new THREE.Mesh(jawGeo, lit('jaw'));
    this.jaw.add(jawMesh);
    this.jaw.position.set(0, -0.55, -1.0);
    const eyeMat = patchBasicFog(new THREE.MeshBasicMaterial({ vertexColors: true }), shared, 'serpent-eye');
    this.materials.push(eyeMat);
    const eyes = new THREE.Mesh(eyeGeo, eyeMat);
    this.head.add(headMesh, this.jaw, eyes);
    for (const o of [headMesh, jawMesh, eyes]) o.frustumCulled = false;
    this.root.add(this.head);

    // Body segments: elongated low-poly spheres with a lighter belly (vertex colours) and banded per-instance tints.
    const seg = new THREE.IcosahedronGeometry(1, 1);
    const sp = seg.getAttribute('position');
    const sc = new Float32Array(sp.count * 3);
    for (let i = 0; i < sp.count; i++) {
      const y = sp.getY(i);
      const belly = smoothstep(0.05, -0.7, y);
      const h = hexAt(sp.getX(i) * 3, sp.getY(i) * 3, sp.getZ(i) * 3);
      sc[i * 3] = mix(C.scaleMid[0] * (0.8 + 0.4 * h), C.belly[0], belly);
      sc[i * 3 + 1] = mix(C.scaleMid[1] * (0.8 + 0.4 * h), C.belly[1], belly);
      sc[i * 3 + 2] = mix(C.scaleMid[2] * (0.8 + 0.4 * h), C.belly[2], belly);
    }
    seg.setAttribute('color', new THREE.BufferAttribute(sc, 3));
    this.geometries.push(seg);
    this.bodyMesh = new THREE.InstancedMesh(seg, lit('body'), n);
    this.bodyMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.bodyMesh.frustumCulled = false;
    for (let i = 0; i < n; i++) {
      _c.setRGB(1, 1, 1).multiplyScalar(i % 2 === 0 ? 0.78 : 1.06);
      if (i > n * 0.6) _c.lerp(new THREE.Color(C.tail[0], C.tail[1], C.tail[2]), (i / n - 0.6) * 0.8);
      this.bodyMesh.setColorAt(i, _c);
    }
    if (this.bodyMesh.instanceColor !== null) this.bodyMesh.instanceColor.needsUpdate = true;
    this.root.add(this.bodyMesh);

    // Dorsal fins (flattened cones) on every segment.
    const fin = new THREE.ConeGeometry(1, 1, 4, 1);
    fin.translate(0, 0.5, 0);
    const fc = new Float32Array(fin.getAttribute('position').count * 3);
    for (let i = 0; i < fin.getAttribute('position').count; i++) {
      const y = fin.getAttribute('position').getY(i);
      const t = smoothstep(0, 1, y);
      fc[i * 3] = mix(C.fin[0], C.finTip[0], t);
      fc[i * 3 + 1] = mix(C.fin[1], C.finTip[1], t);
      fc[i * 3 + 2] = mix(C.fin[2], C.finTip[2], t);
    }
    fin.setAttribute('color', new THREE.BufferAttribute(fc, 3));
    this.geometries.push(fin);
    this.finMesh = new THREE.InstancedMesh(fin, lit('fin'), n);
    this.finMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.finMesh.frustumCulled = false;
    this.root.add(this.finMesh);

    // Bioluminescent flank dots (two per segment, unlit).
    const dot = new THREE.IcosahedronGeometry(1, 0);
    const dc = new Float32Array(dot.getAttribute('position').count * 3).fill(1);
    dot.setAttribute('color', new THREE.BufferAttribute(dc, 3));
    this.geometries.push(dot);
    const dotMat = patchBasicFog(new THREE.MeshBasicMaterial({ vertexColors: true }), shared, 'serpent-dot');
    this.materials.push(dotMat);
    this.dots = n * 2;
    this.dotMesh = new THREE.InstancedMesh(dot, dotMat, this.dots);
    this.dotMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.dotMesh.frustumCulled = false;
    for (let i = 0; i < this.dots; i++) {
      const g = i % 4 < 2 ? new THREE.Color(C.dotA[0], C.dotA[1], C.dotA[2]) : new THREE.Color(C.dotB[0], C.dotB[1], C.dotB[2]);
      this.dotMesh.setColorAt(i, g);
    }
    if (this.dotMesh.instanceColor !== null) this.dotMesh.instanceColor.needsUpdate = true;
    this.root.add(this.dotMesh);
  }

  get segmentCount(): number {
    return this.segU.length;
  }

  setTier(tier: QualityTier): void {
    this.dotMesh.visible = tier !== 'low';
    this.finMesh.visible = true;
  }

  /** Cache the blurred ground height along the strike line (re-computed when the angle changes). */
  private ensureProfile(arena: ArenaDef, v: SerpentVisual): void {
    if (Math.abs(this.profileAngle - v.angleDeg) < 1e-6) return;
    this.profileAngle = v.angleDeg;
    for (let i = 0; i < this.profile.length; i++) {
      const r = i * PROFILE_STEP;
      const x = v.dirX * r;
      const z = v.dirZ * r;
      this.profile[i] = Math.max(arenaGroundHeight(arena, x, z), arenaGroundHeight(arena, x - v.dirZ * 1.2, z + v.dirX * 1.2), arenaGroundHeight(arena, x + v.dirZ * 1.2, z - v.dirX * 1.2));
    }
  }

  private groundAt(r: number, half: number): number {
    let sum = 0;
    let n = 0;
    for (let k = -half; k <= half; k += 1) {
      const i = Math.min(this.profile.length - 1, Math.max(0, Math.round((r + k * 0.8) / PROFILE_STEP)));
      sum += this.profile[i];
      n++;
    }
    return sum / n;
  }

  /** Body point at `u` metres behind the head centre -> out (x,y,z). */
  private bodyPoint(arena: ArenaDef, v: SerpentVisual, u: number, time: number, rad: number, out: THREE.Vector3): void {
    const wall = arena.wallRadius;
    const dx = v.dirX;
    const dz = v.dirZ;
    // ── straight path ──
    const rs = v.rv + u;
    const lat = (7.5 * Math.sin((rs - 34) * 0.085 + 0.6) * smoothstep(33.5, 46, rs) + 0.4 * Math.sin(time * 3 + u * 0.45) * smoothstep(0, 10, u)) * 1;
    let y: number;
    if (this.tier === 'high') {
      // the high serpent flies level at the head's height (sagging a little behind the head), then S-curves outside the glass
      const flight = v.headY - 0.25 - 0.9 * smoothstep(0, 14, u);
      const yOutH = flight + 1.9 * Math.sin((rs - 34) * 0.11 + 1.0) * smoothstep(33, 42, rs);
      y = mix(flight, yOutH, smoothstep(wall + 1, wall + 5, rs));
    } else {
      const gIn = this.groundAt(Math.min(rs, wall + 1), 2) + rad * 0.92 + 0.15;
      const yOut = 1.7 + rad + 1.9 * Math.sin((rs - 34) * 0.11 + 1.0) * smoothstep(33, 42, rs);
      y = mix(gIn, yOut, smoothstep(wall + 1, wall + 5, rs));
      // keep the neck joined to a raised head
      const headLift = v.headY - (this.groundAt(Math.min(v.rv, wall + 1), 2) + HEAD_RADIUS + 0.12);
      y += headLift * (1 - smoothstep(0, 8, u)) * (v.rv < wall + 2 ? 1 : 0.4);
    }
    const sx = dx * rs - dz * lat;
    const sz = dz * rs + dx * lat;
    if (v.coil <= 0.001) {
      out.set(sx, y, sz);
      return;
    }
    // ── coiled path (warning) ──
    const neck = 9;
    const hx = dx * v.rv;
    const hz = dz * v.rv;
    let cx: number;
    let cz: number;
    let cy: number;
    if (u <= neck) {
      cx = hx + dx * u;
      cz = hz + dz * u;
      cy = v.headY - 0.9 * (u / neck) * 0.6 + 0.4 * Math.sin(u * 0.7 + time * 2);
    } else {
      const phi = (u - neck) / 5;
      const Rc = 5 * (1 - 0.04 * Math.min(phi, 9));
      const nx = hx + dx * neck;
      const nz = hz + dz * neck;
      cx = nx - dz * Rc * (1 - Math.cos(phi)) * -1 + dx * Rc * Math.sin(phi);
      cz = nz + dx * Rc * (1 - Math.cos(phi)) * -1 + dz * Rc * Math.sin(phi);
      cy = v.headY - 0.55 + phi * 0.26 + 0.35 * Math.sin(phi * 2 + time * 1.7);
    }
    cy = Math.max(cy, rad + 0.4);
    const k = v.coil;
    out.set(mix(sx, cx, k), mix(y, cy, k), mix(sz, cz, k));
  }

  /** Pose the serpent for `v` at scene time `time`. */
  update(arena: ArenaDef, v: SerpentVisual, time: number): void {
    this.root.visible = v.active && v.alpha > 0.01;
    if (!this.root.visible) return;
    this.ensureProfile(arena, v);
    const n = this.segU.length;
    // Head.
    this.head.position.set(v.dirX * v.rv, v.headY, v.dirZ * v.rv);
    const yaw = Math.atan2(-v.dirX, -v.dirZ);
    this.head.rotation.set(-v.pitch, yaw, 0, 'YXZ');
    this.jaw.rotation.x = v.jaw * 0.66;
    // Body path points (index 0 = the neck root just behind the head).
    const P = this.pos;
    this.bodyPoint(arena, v, 0.6, time, bodyRadius(0.6), _p);
    P[0] = _p.x;
    P[1] = _p.y;
    P[2] = _p.z;
    for (let i = 0; i < n; i++) {
      const u = this.segU[i];
      this.bodyPoint(arena, v, u, time, bodyRadius(u), _p);
      P[(i + 1) * 3] = _p.x;
      P[(i + 1) * 3 + 1] = _p.y;
      P[(i + 1) * 3 + 2] = _p.z;
    }
    const fade = v.alpha < 1 ? 0.5 + 0.5 * v.alpha : 1;
    for (let i = 0; i < n; i++) {
      const a = (i) * 3;
      const b = (i + 2 >= n + 1 ? n : i + 2) * 3;
      _t.set(P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]);
      if (_t.lengthSq() < 1e-8) _t.set(-v.dirX, 0, -v.dirZ);
      _t.normalize();
      _s.crossVectors(_up, _t);
      if (_s.lengthSq() < 1e-6) _s.set(1, 0, 0);
      _s.normalize();
      _u.crossVectors(_t, _s).normalize();
      const r = bodyRadius(this.segU[i]) * fade;
      const px = P[(i + 1) * 3];
      const py = P[(i + 1) * 3 + 1];
      const pz = P[(i + 1) * 3 + 2];
      _m.makeBasis(_b1.copy(_s).multiplyScalar(r), _b2.copy(_u).multiplyScalar(r * 0.96), _b3.copy(_t).multiplyScalar(r * 1.38));
      _m.setPosition(px, py, pz);
      this.bodyMesh.setMatrixAt(i, _m);
      // dorsal fin on top
      const fh = r * (0.75 + 0.35 * Math.sin(i * 0.9)) * (i % 2 === 0 ? 1 : 0.6);
      _m.makeBasis(_b1.copy(_s).multiplyScalar(r * 0.1), _b2.copy(_u).multiplyScalar(fh), _b3.copy(_t).multiplyScalar(r * 0.8));
      _m.setPosition(px + _u.x * r * 0.88, py + _u.y * r * 0.88, pz + _u.z * r * 0.88);
      this.finMesh.setMatrixAt(i, _m);
      // flank dots
      const pulse = 0.55 + 0.45 * Math.sin(time * 4 - i * 0.55);
      const d = 0.09 * (0.8 + 0.8 * pulse) * Math.max(0.5, r) * fade;
      for (let k = 0; k < 2; k++) {
        const side = k === 0 ? 1 : -1;
        _m.makeBasis(_b1.set(d, 0, 0), _b2.set(0, d, 0), _b3.set(0, 0, d));
        _m.setPosition(px + _s.x * side * r * 0.96 + _u.x * r * 0.15, py + _s.y * side * r * 0.96 + _u.y * r * 0.15, pz + _s.z * side * r * 0.96 + _u.z * r * 0.15);
        this.dotMesh.setMatrixAt(i * 2 + k, _m);
      }
    }
    this.bodyMesh.instanceMatrix.needsUpdate = true;
    this.finMesh.instanceMatrix.needsUpdate = true;
    this.dotMesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.bodyMesh.dispose();
    this.finMesh.dispose();
    this.dotMesh.dispose();
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    this.root.removeFromParent();
  }
}
