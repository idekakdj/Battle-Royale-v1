/**
 * The glass dome of the Ocean Dome arena (WP-O3): the fresnel-glass hemisphere (a half-ellipsoid, radius = wall + 2, height 22) with
 * panel seams, shudder, a shatter-crack/hole shader driven by the sea-serpent breach, the metal base ring with running lights and the
 * rib structure (24 meridian ribs + latitude hoops + an apex hub); plus the light from the surface above: moving GOD-RAY shafts, a
 * shimmering surface plane overhead and the drifting MARINE SNOW outside.
 *
 * v1.10: TWO independent breaches (the low and the high serpent): uBreach/uCrack/uHole/uShudder/uFlash and the same set suffixed 2
 * (violet-tinted cracks / flash / alarm), so both serpents can shatter the glass at different angles and heights at the same time.
 *
 * The glass NEVER blocks the third-person camera: the camera rig keeps the eye inside `wall - 0.95` of the centre (see CameraRig's
 * wall pull-in), the dome starts 3 m beyond that, is single-sided (we only ever see its inside), transparent and does not write depth.
 *
 * Node-safe construction (pure three).
 */

import * as THREE from 'three';
import { mulberry32, TAU } from '../../core/math';
import { VGeo } from '../jungle/vgeo';
import { rgb } from '../jungle/vgeo';
import { GLOW } from './terrain';
import type { OceanShared } from './materials';

// ── Glass ────────────────────────────────────────────────────────────────────

const GLASS_VERT = /* glsl */ `
uniform float uTime;
uniform vec3 uBreach;
uniform float uShudder;
uniform vec3 uBreach2;
uniform float uShudder2;
uniform vec2 uDome;
varying vec3 vP;
varying vec3 vWN;
varying vec3 vWPos;
void main() {
  vP = position;
  vec3 p = position;
  // Shudder: the dome flexes (a standing wave that is strongest near the breach side).
  vec3 pn0 = normalize(position + vec3(0.0001));
  float near = max(dot(pn0, uBreach), 0.0);
  float near2 = max(dot(pn0, uBreach2), 0.0);
  float wob = sin(uTime * 46.0 + position.y * 17.0 + position.x * 11.0);
  p *= 1.0 + uShudder * 0.0035 * wob * (0.35 + near) + uShudder2 * 0.0035 * wob * (0.35 + near2);
  vec4 w = modelMatrix * vec4(p * vec3(uDome.x, uDome.y, uDome.x), 1.0);
  vWPos = w.xyz;
  vWN = normalize(vec3(position.x / uDome.x, position.y / uDome.y, position.z / uDome.x));
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const GLASS_FRAG = /* glsl */ `
uniform float uTime;
uniform vec3 uBreach;
uniform float uCrack;
uniform float uHole;
uniform float uShudder;
uniform float uFlash;
uniform vec2 uDome;
uniform vec3 uSun;
uniform float uAlarm;
uniform vec3 uBreach2;
uniform float uCrack2;
uniform float uHole2;
uniform float uShudder2;
uniform float uFlash2;
uniform float uAlarm2;
varying vec3 vP;
varying vec3 vWN;
varying vec3 vWPos;

const float PI = 3.14159265;
vec2 h22(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return fract(sin(p) * 43758.5453);
}
// IQ voronoi edge distance
float vEdge(vec2 x) {
  vec2 n = floor(x);
  vec2 f = fract(x);
  vec2 mg; vec2 mr;
  float md = 8.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 g = vec2(float(i), float(j));
    vec2 o = h22(n + g);
    vec2 r = g + o - f;
    float d = dot(r, r);
    if (d < md) { md = d; mr = r; mg = g; }
  }
  md = 8.0;
  for (int j = -2; j <= 2; j++) for (int i = -2; i <= 2; i++) {
    vec2 g = mg + vec2(float(i), float(j));
    vec2 o = h22(n + g);
    vec2 r = g + o - f;
    if (dot(mr - r, mr - r) > 0.00001) md = min(md, dot(0.5 * (mr + r), normalize(r - mr)));
  }
  return md;
}

// One breach: shatter cracks + a hole where a head passed (B = the breach direction on the unit dome, tint = crack glow colour).
void breachFx(vec3 B, float crack, float hole, vec3 tint, inout float alpha, inout vec3 col) {
  float nearB = dot(normalize(vP), B);
  if ((crack > 0.001 || hole > 0.001) && nearB > 0.2) {
    vec3 e1 = normalize(cross(vec3(0.0, 1.0, 0.0), B));
    vec3 e2 = cross(B, e1);
    vec3 pn = normalize(vP);
    vec2 xy = vec2(dot(pn, e1), dot(pn, e2)) * uDome.x;
    float dist = length(xy);
    float ang = atan(xy.y, xy.x);
    float jag = 0.82 + 0.3 * h22(vec2(floor(ang * 5.0), 3.0)).x + 0.12 * sin(ang * 23.0);
    float holeR = 2.9 * hole * jag;
    if (dist < holeR) discard;
    float crackR = 13.0 * (0.35 + 0.65 * crack);
    if (dist < crackR) {
      vec2 q = vec2(log(dist + 0.6) * 2.6, ang * 2.3);
      float ed = vEdge(q);
      float line = 1.0 - smoothstep(0.0, 0.07, ed);
      float fade = (1.0 - dist / crackR);
      float rim = (1.0 - smoothstep(holeR, holeR + 0.55, dist)) * hole;
      float strength = crack * (line * fade * 1.0 + rim * 0.9);
      alpha = max(alpha, strength * 0.95);
      col += tint * strength * 1.3;
      // faint milky fracture tint in the cell interiors
      alpha += crack * fade * 0.08;
    }
  }
}

void main() {
  vec3 n = normalize(vWN);
  vec3 v = normalize(cameraPosition - vWPos);
  float ndv = abs(dot(n, v));
  float fres = pow(1.0 - ndv, 3.0);

  float phi = atan(vP.z, vP.x);
  float lat = asin(clamp(vP.y, 0.0, 1.0));
  float cl = cos(lat);

  // Panel seams: a meridian between every pair of ribs (24 ribs -> seams at the 12 half-way lines handled by 48 divisions) and latitude rings.
  float mer = abs(fract(phi / ${(2 * Math.PI).toFixed(5)} * 48.0) - 0.5);
  float merLine = (1.0 - smoothstep(0.0, 0.035 / max(cl, 0.2), mer)) * smoothstep(0.02, 0.3, cl);
  float rng = abs(fract(lat / ${(Math.PI / 2).toFixed(5)} * 8.0) - 0.5);
  float rngLine = 1.0 - smoothstep(0.0, 0.03, rng);
  float lines = max(merLine * 0.8, rngLine * 0.9);

  float sunG = pow(max(dot(reflect(-v, n), normalize(uSun)), 0.0), 60.0);
  float alpha = 0.025 + fres * 0.55 + lines * (0.14 + fres * 0.3) + sunG * 0.5;
  vec3 col = mix(vec3(0.55, 0.88, 1.0), vec3(0.85, 1.0, 1.0), fres) * (0.55 + 0.7 * fres);
  col += vec3(0.9, 1.0, 1.0) * sunG * 2.0;
  col += vec3(1.2, 0.25, 0.1) * uAlarm * (0.05 + 0.25 * fres);
  col += vec3(0.85, 0.2, 1.3) * uAlarm2 * (0.05 + 0.25 * fres);
  // shudder shimmer
  vec3 pnv = normalize(vP);
  float shim = 0.5 + 0.5 * sin(vP.y * 55.0 - uTime * 40.0);
  alpha += uShudder * 0.06 * shim * (0.3 + max(dot(pnv, uBreach), 0.0));
  alpha += uShudder2 * 0.06 * shim * (0.3 + max(dot(pnv, uBreach2), 0.0));

  // Breaches: shatter cracks + a hole where a head passed (the low serpent's, then the high one's).
  breachFx(uBreach, uCrack, uHole, vec3(0.9, 1.2, 1.3), alpha, col);
  breachFx(uBreach2, uCrack2, uHole2, vec3(1.15, 0.85, 1.6), alpha, col);
  alpha += uFlash * 0.22;
  col += vec3(1.0) * uFlash * 0.6;
  alpha += uFlash2 * 0.22;
  col += vec3(0.85, 0.6, 1.0) * uFlash2 * 0.6;
  gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export interface DomeUniforms {
  uTime: { value: number };
  uBreach: { value: THREE.Vector3 };
  uCrack: { value: number };
  uHole: { value: number };
  uShudder: { value: number };
  uFlash: { value: number };
  uDome: { value: THREE.Vector2 };
  uSun: { value: THREE.Vector3 };
  uAlarm: { value: number };
  /** The HIGH serpent's breach (same meaning as the unsuffixed set). */
  uBreach2: { value: THREE.Vector3 };
  uCrack2: { value: number };
  uHole2: { value: number };
  uShudder2: { value: number };
  uFlash2: { value: number };
  uAlarm2: { value: number };
}

export class DomeGlass {
  readonly mesh: THREE.Mesh;
  readonly uniforms: DomeUniforms;
  private readonly mat: THREE.ShaderMaterial;

  constructor(shared: OceanShared, sun: THREE.Vector3) {
    this.uniforms = {
      uTime: shared.uTime,
      uBreach: { value: new THREE.Vector3(1, 0.1, 0).normalize() },
      uCrack: { value: 0 },
      uHole: { value: 0 },
      uShudder: { value: 0 },
      uFlash: { value: 0 },
      uDome: shared.uDome,
      uSun: { value: sun.clone().normalize() },
      uAlarm: shared.uAlarm,
      uBreach2: { value: new THREE.Vector3(-1, 0.3, 0).normalize() },
      uCrack2: { value: 0 },
      uHole2: { value: 0 },
      uShudder2: { value: 0 },
      uFlash2: { value: 0 },
      uAlarm2: shared.uAlarmHigh,
    };
    this.mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms as unknown as { [k: string]: THREE.IUniform },
      vertexShader: GLASS_VERT,
      fragmentShader: GLASS_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.BackSide,
      fog: false,
    });
    const g = new THREE.SphereGeometry(1, 72, 22, 0, TAU, 0, Math.PI / 2);
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.renderOrder = 1;
    this.mesh.frustumCulled = false;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mat.dispose();
  }
}

// ── Frame: base ring, ribs, hoops, apex ──────────────────────────────────────

/** Sweep a square cross-section of half-size `s(t)` along an elliptical meridian (angle t: 0 at the base .. pi/2 at the apex). */
function addRib(vg: VGeo, R: number, H: number, phi: number, baseS: number, topS: number, col: [number, number, number]): void {
  const steps = 15;
  const rows: number[][] = [];
  const pos: number[] = [];
  const colr: number[] = [];
  const idx: number[] = [];
  const cp = Math.cos(phi);
  const sp = Math.sin(phi);
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * (Math.PI / 2) * 0.985;
    const x = R * Math.cos(t);
    const y = H * Math.sin(t);
    // tangent / inward normal in the meridian plane
    const tx = -R * Math.sin(t);
    const ty = H * Math.cos(t);
    const tl = Math.hypot(tx, ty);
    const nx = ty / tl; // outward normal (radial part)
    const ny = -tx / tl;
    const s = baseS + (topS - baseS) * (i / steps);
    const row: number[] = [];
    // 4 corners: inner/outer x lateral
    const corners: Array<[number, number, number]> = [
      [-s, -s * 0.6, 0],
      [s, -s * 0.6, 0],
      [s, s * 0.6, 0],
      [-s, s * 0.6, 0],
    ];
    for (const cn of corners) {
      // lateral = tangent direction around the dome (perpendicular to the meridian plane); depth = along the normal
      const lat = cn[0];
      const dep = cn[1];
      const rad = x + nx * dep;
      const hy = y + ny * dep;
      const px = cp * rad + -sp * lat;
      const pz = sp * rad + cp * lat;
      pos.push(px, hy, pz);
      const k = 0.85 + 0.15 * ((i % 2) as number);
      colr.push(col[0] * k, col[1] * k, col[2] * k);
      row.push(pos.length / 3 - 1);
    }
    rows.push(row);
  }
  for (let i = 0; i < steps; i++) {
    for (let k = 0; k < 4; k++) {
      const a = rows[i][k];
      const b = rows[i][(k + 1) % 4];
      const c = rows[i + 1][(k + 1) % 4];
      const d = rows[i + 1][k];
      idx.push(a, b, c, a, c, d);
    }
  }
  vg.addRaw(pos, idx, colr);
}

function addHoop(vg: VGeo, radius: number, y: number, s: number, col: [number, number, number]): void {
  const n = 72;
  const pos: number[] = [];
  const colr: number[] = [];
  const idx: number[] = [];
  const rows: number[][] = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * TAU;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const row: number[] = [];
    const corners: Array<[number, number]> = [
      [-s, -s * 0.6],
      [s, -s * 0.6],
      [s, s * 0.6],
      [-s, s * 0.6],
    ];
    for (const [dy, dr] of corners) {
      pos.push(ca * (radius - 0.12 + dr), y + dy, sa * (radius - 0.12 + dr));
      colr.push(col[0], col[1], col[2]);
      row.push(pos.length / 3 - 1);
    }
    rows.push(row);
  }
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 4; k++) {
      const a = rows[i][k];
      const b = rows[i][(k + 1) % 4];
      const c = rows[i + 1][(k + 1) % 4];
      const d = rows[i + 1][k];
      idx.push(a, b, c, a, c, d);
    }
  }
  vg.addRaw(pos, idx, colr);
}

export interface DomeFrameGeometry {
  frame: THREE.BufferGeometry;
  glow: THREE.BufferGeometry;
}

/** The ribs / hoops / base ring / apex (lit metal) and the running lights on the ring (unlit glow). */
export function buildDomeFrame(R: number, H: number): DomeFrameGeometry {
  const vg = new VGeo();
  const glow = new VGeo();
  const metal = rgb(0x7f9ea8);
  const dark = rgb(0x4d6670);
  const ribs = 24;
  for (let i = 0; i < ribs; i++) {
    addRib(vg, R - 0.1, H - 0.1, (i / ribs) * TAU, 0.34, 0.17, metal);
  }
  for (const lat of [14, 30, 46, 62, 76]) {
    const t = (lat * Math.PI) / 180;
    addHoop(vg, (R - 0.1) * Math.cos(t), (H - 0.1) * Math.sin(t), 0.19 - lat * 0.0006, dark);
  }
  // Base ring: a thick collar around the foot of the glass (r from R - 0.7 to R + 1.5, y 0 .. 1.5), with a lighter cap.
  {
    const n = 128;
    const pos: number[] = [];
    const colr: number[] = [];
    const idx: number[] = [];
    // profile (r offset, y): trapezoid
    const prof: Array<[number, number, [number, number, number]]> = [
      [-0.7, 0.0, dark],
      [-0.7, 1.05, metal],
      [-0.35, 1.5, rgb(0xa9c2c9)],
      [0.55, 1.5, rgb(0xa9c2c9)],
      [1.5, 0.6, metal],
      [1.5, 0.0, dark],
    ];
    const rows: number[][] = [];
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * TAU;
      const row: number[] = [];
      for (const [dr, y, c] of prof) {
        pos.push(Math.cos(a) * (R + dr), y, Math.sin(a) * (R + dr));
        const k = 0.9 + 0.1 * ((i % 2) as number);
        colr.push(c[0] * k, c[1] * k, c[2] * k);
        row.push(pos.length / 3 - 1);
      }
      rows.push(row);
    }
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < prof.length; k++) {
        const a = rows[i][k];
        const b = rows[i][(k + 1) % prof.length];
        const c = rows[i + 1][(k + 1) % prof.length];
        const d = rows[i + 1][k];
        idx.push(a, b, c, a, c, d);
      }
    }
    vg.addRaw(pos, idx, colr);
  }
  // Apex hub.
  {
    const hub = new THREE.CylinderGeometry(2.2, 2.8, 0.7, 24, 1);
    vg.add(hub, new THREE.Matrix4().makeTranslation(0, H - 0.4, 0), metal);
    hub.dispose();
    const cap = new THREE.CylinderGeometry(1.1, 1.1, 0.3, 16, 1);
    vg.add(cap, new THREE.Matrix4().makeTranslation(0, H - 0.05, 0), dark);
    cap.dispose();
  }
  // Running lights on the base collar: a bulb every 7.5 degrees, alternating teal / pink, plus a thin light line.
  {
    const bulb = new THREE.IcosahedronGeometry(0.12, 0);
    const n = 48;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU;
      glow.add(bulb, new THREE.Matrix4().makeTranslation(Math.cos(a) * (R - 0.74), 0.78, Math.sin(a) * (R - 0.74)), i % 3 === 0 ? GLOW.amber : GLOW.teal);
    }
    bulb.dispose();
  }
  return { frame: vg.build(), glow: glow.build() };
}

// ── God rays from the surface ────────────────────────────────────────────────

const RAY_VERT = /* glsl */ `
uniform float uTime;
varying float vAlong;
varying float vFacing;
varying float vAng;
varying vec3 vW;
attribute float aSeed;
void main() {
  vAlong = uv.y;
  vAng = uv.x;
  vec3 p = position;
  // shafts sway slowly (the surface waves move the light)
  float top = uv.y;
  p.x += sin(uTime * 0.21 + aSeed * 40.0) * 2.2 * top;
  p.z += cos(uTime * 0.17 + aSeed * 31.0) * 2.2 * top;
  vec4 w = modelMatrix * vec4(p, 1.0);
  vW = w.xyz;
  vec4 mv = viewMatrix * w;
  vec3 n = normalize(normalMatrix * normal);
  vFacing = abs(dot(n, normalize(-mv.xyz)));
  gl_Position = projectionMatrix * mv;
}
`;

const RAY_FRAG = /* glsl */ `
uniform float uTime;
uniform float uIntensity;
uniform vec3 uColor;
uniform vec2 uDome;
varying float vAlong;
varying float vFacing;
varying float vAng;
varying vec3 vW;
void main() {
  float a = pow(vFacing, 1.6);
  a *= smoothstep(0.0, 0.1, vAlong) * (1.0 - smoothstep(0.55, 1.0, vAlong));
  float streak = 0.55 + 0.45 * sin(vAng * 31.0 + uTime * 0.35 + vAlong * 5.0) * sin(vAng * 11.0 - uTime * 0.23);
  a *= (0.65 + 0.35 * sin(uTime * 0.45 + vAlong * 9.0)) * streak;
  // the air inside the dome is clear: the shafts are visible mainly in the water outside the glass
  float inside = 1.0 - smoothstep(uDome.x - 2.0, uDome.x + 2.0, length(vW.xz));
  a *= uIntensity * mix(1.0, 0.16, inside);
  if (a < 0.002) discard;
  gl_FragColor = vec4(uColor, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class OceanRays {
  readonly mesh: THREE.Mesh;
  private readonly mat: THREE.ShaderMaterial;

  constructor(shared: OceanShared, sunDir: THREE.Vector3, count: number) {
    const rng = mulberry32(0x0ce4);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), sunDir.clone().normalize());
    const parts: THREE.BufferGeometry[] = [];
    const L = 96;
    for (let i = 0; i < count; i++) {
      const r = 1.6 + rng() * 3.2;
      const g = new THREE.CylinderGeometry(r * 1.5, r, L, 10, 1, true);
      g.translate(0, L / 2, 0);
      g.applyQuaternion(q);
      const a = rng() * TAU;
      const d = (i < count * 0.2 ? 6 + rng() * 20 : 34 + rng() * 52);
      g.translate(Math.cos(a) * d, -1, Math.sin(a) * d);
      const seed = new Float32Array(g.getAttribute('position').count).fill(rng());
      g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
      parts.push(g);
    }
    const merged = mergeParts(parts);
    for (const p of parts) p.dispose();
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: shared.uTime,
        uIntensity: { value: 0.15 },
        uColor: { value: new THREE.Color(0xb9f4ff) },
        uDome: shared.uDome,
      },
      vertexShader: RAY_VERT,
      fragmentShader: RAY_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      fog: false,
    });
    this.mesh = new THREE.Mesh(merged, this.mat);
    this.mesh.renderOrder = 3;
    this.mesh.frustumCulled = false;
  }

  setIntensity(v: number): void {
    (this.mat.uniforms.uIntensity as THREE.IUniform<number>).value = v;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mat.dispose();
  }
}

/** Merge position / normal / uv / aSeed parts (no external helper import so the module stays tiny). */
function mergeParts(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let nv = 0;
  let ni = 0;
  for (const p of parts) {
    nv += p.getAttribute('position').count;
    ni += (p.index?.count ?? 0);
  }
  const pos = new Float32Array(nv * 3);
  const nor = new Float32Array(nv * 3);
  const uv = new Float32Array(nv * 2);
  const sd = new Float32Array(nv);
  const idx = new Uint32Array(ni);
  let vo = 0;
  let io = 0;
  for (const p of parts) {
    const pa = p.getAttribute('position');
    const na = p.getAttribute('normal');
    const ua = p.getAttribute('uv');
    const sa = p.getAttribute('aSeed');
    for (let i = 0; i < pa.count; i++) {
      pos.set([pa.getX(i), pa.getY(i), pa.getZ(i)], (vo + i) * 3);
      nor.set([na.getX(i), na.getY(i), na.getZ(i)], (vo + i) * 3);
      uv.set([ua.getX(i), ua.getY(i)], (vo + i) * 2);
      sd[vo + i] = sa.getX(i);
    }
    const ix = p.index;
    if (ix !== null) for (let k = 0; k < ix.count; k++) idx[io + k] = ix.getX(k) + vo;
    io += ix?.count ?? 0;
    vo += pa.count;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('aSeed', new THREE.BufferAttribute(sd, 1));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  return g;
}

// ── Surface plane overhead ───────────────────────────────────────────────────

const SURF_VERT = /* glsl */ `
varying vec3 vW;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;
const SURF_FRAG = /* glsl */ `
uniform float uTime;
varying vec3 vW;
float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vn(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), f.x), mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), f.x), f.y);
}
void main() {
  vec2 p = vW.xz * 0.045;
  float n = vn(p * 3.0 + vec2(uTime * 0.05, uTime * 0.03)) * 0.55 + vn(p * 7.3 - vec2(uTime * 0.07, uTime * 0.02)) * 0.45;
  float ridge = 1.0 - abs(n * 2.0 - 1.0);
  float glint = pow(ridge, 5.0);
  vec3 dir = normalize(vW - cameraPosition);
  float up = clamp(dir.y, 0.0, 1.0);
  float central = pow(up, 0.9);
  vec3 col = vec3(0.30, 0.78, 0.92) * (0.35 + 0.65 * central) + vec3(0.7, 1.0, 1.0) * glint * 0.55 * central;
  float alpha = smoothstep(0.08, 0.5, up) * 0.85;
  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class SurfacePlane {
  readonly mesh: THREE.Mesh;
  private readonly mat: THREE.ShaderMaterial;
  constructor(shared: OceanShared) {
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uTime: shared.uTime },
      vertexShader: SURF_VERT,
      fragmentShader: SURF_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    const g = new THREE.CircleGeometry(300, 40);
    g.rotateX(Math.PI / 2);
    g.translate(0, 85, 0);
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.renderOrder = -9;
    this.mesh.frustumCulled = false;
  }
  dispose(): void {
    this.mesh.geometry.dispose();
    this.mat.dispose();
  }
}

// ── Marine snow ──────────────────────────────────────────────────────────────

const SNOW_VERT = /* glsl */ `
attribute vec4 aSeed;
uniform float uTime;
uniform float uPx;
uniform vec2 uDome;
varying float vA;
void main() {
  vec3 p = position;
  p.y = mod(p.y + uTime * (0.25 + aSeed.x * 0.5) + aSeed.y * 60.0, 56.0);
  p.x += sin(uTime * (0.2 + aSeed.z * 0.3) + aSeed.w * 40.0) * 1.4;
  p.z += cos(uTime * (0.17 + aSeed.x * 0.3) + aSeed.y * 40.0) * 1.4;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float d = -mv.z;
  gl_PointSize = max(1.0, (0.09 + aSeed.w * 0.1) * uPx / max(0.5, d));
  float r = length(p.xz);
  float outside = smoothstep(uDome.x + 0.5, uDome.x + 4.0, r);
  vA = outside * exp(-d * 0.016) * (0.35 + 0.65 * aSeed.z);
  gl_Position = projectionMatrix * mv;
}
`;
const SNOW_FRAG = /* glsl */ `
varying float vA;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float a = vA * (1.0 - smoothstep(0.1, 1.0, d));
  if (a < 0.01) discard;
  gl_FragColor = vec4(0.75, 0.95, 1.0, a * 0.7);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class MarineSnow {
  readonly points: THREE.Points;
  readonly max: number;
  private readonly mat: THREE.ShaderMaterial;
  private readonly px = { value: 600 };

  constructor(shared: OceanShared, max: number, domeR: number) {
    this.max = max;
    const rng = mulberry32(0x5a0f);
    const pos = new Float32Array(max * 3);
    const sd = new Float32Array(max * 4);
    for (let i = 0; i < max; i++) {
      const a = rng() * TAU;
      const r = domeR + 1 + Math.sqrt(rng()) * 70;
      pos[i * 3] = Math.cos(a) * r;
      pos[i * 3 + 1] = rng() * 56;
      pos[i * 3 + 2] = Math.sin(a) * r;
      sd.set([rng(), rng(), rng(), rng()], i * 4);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aSeed', new THREE.BufferAttribute(sd, 4));
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uTime: shared.uTime, uPx: this.px, uDome: shared.uDome },
      vertexShader: SNOW_VERT,
      fragmentShader: SNOW_FRAG,
      transparent: true,
      depthWrite: false,
      fog: false,
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 2;
  }

  setCount(n: number): void {
    this.points.geometry.setDrawRange(0, Math.min(this.max, Math.max(0, n)));
    this.points.visible = n > 0;
  }

  update(): void {
    if (typeof window !== 'undefined') this.px.value = (window.innerHeight * Math.min(2, window.devicePixelRatio || 1)) / 1.04;
  }

  dispose(): void {
    this.points.geometry.dispose();
    this.mat.dispose();
  }
}

/** Metal material for the frame (two-sided: the swept tube faces are not wound consistently). */
export function frameMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.5, metalness: 0.45, side: THREE.DoubleSide });
}
