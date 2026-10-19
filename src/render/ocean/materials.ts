/**
 * Ocean Dome materials (v1.9, WP-O3): the shared uniforms and the shader patches every ocean surface uses.
 *
 *  - {@link patchLit}: a vertex-coloured `MeshStandardMaterial` for the INSIDE of the dome (seabed, levels, coral, crates): sand
 *    RIPPLES (albedo + a fake bump on the up-facing faces) and animated CAUSTICS (light patterns refracted through the water above,
 *    added as emissive on up-facing faces inside the dome, faded at the glass), plus the serpent warning's red alarm tint.
 *  - WATER FOG: everything OUTSIDE the glass is seen through water. The patch intersects the camera -> fragment ray with the dome
 *    ellipsoid and fogs only the part of the ray that lies outside it (exponential, blue-green), so the air inside the dome stays
 *    crisp while the far reef, the sharks and the whale sink into the blue. Works for Standard and Basic materials.
 *  - {@link creatureMaterial}: GPU-animated sea life. Instances carry a path (orbit / straight line / drift) in per-instance
 *    attributes and the vertex shader evaluates position, heading (finite difference of the path), tail wag, wing flap and jelly
 *    pulse from the elapsed time uniform alone - deterministic, looping, zero CPU work and zero allocation per frame.
 *
 * Pure three (no DOM): node-safe to construct (the shaders compile lazily on first render).
 */

import * as THREE from 'three';

/** Uniforms shared by every ocean material (one object per scene). */
export interface OceanShared {
  uTime: { value: number };
  uWaterCol: { value: THREE.Color };
  uWaterDens: { value: number };
  /** Dome ellipsoid: x = horizontal radius, y = height. */
  uDome: { value: THREE.Vector2 };
  /** 0..1 red-orange alarm tint on the interior surfaces (serpent warning). */
  uAlarm: { value: number };
  /** 0..1 violet alarm tint (the HIGH serpent's warning, v1.10). */
  uAlarmHigh: { value: number };
}

export function createShared(domeRadius: number, domeHeight: number): OceanShared {
  return {
    uTime: { value: 0 },
    uWaterCol: { value: new THREE.Color(0x0b5470) },
    uWaterDens: { value: 0.017 },
    uDome: { value: new THREE.Vector2(domeRadius, domeHeight) },
    uAlarm: { value: 0 },
    uAlarmHigh: { value: 0 },
  };
}

// ── GLSL building blocks ─────────────────────────────────────────────────────

const FRAG_COMMON = /* glsl */ `
uniform float uTime;
uniform vec3 uWaterCol;
uniform float uWaterDens;
uniform vec2 uDome;
uniform float uAlarm;
uniform float uAlarmHigh;
varying vec3 gkW;
varying vec3 gkWN;
float gkHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float gkVn(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(gkHash(i), gkHash(i + vec2(1.0, 0.0)), f.x), mix(gkHash(i + vec2(0.0, 1.0)), gkHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float gkCaustic(vec2 p, float t) {
  vec2 i = p;
  float c = 1.0;
  for (int n = 0; n < 4; n++) {
    float tt = t * (1.0 - (3.5 / float(n + 1)));
    i = p + vec2(cos(tt - i.x) + sin(tt + i.y), sin(tt - i.y) + cos(tt + i.x));
    c += 1.0 / length(vec2(p.x / (sin(i.x + tt) / 0.005), p.y / (cos(i.y + tt) / 0.005)));
  }
  c /= 4.0;
  c = 1.17 - pow(c, 1.4);
  return clamp(pow(abs(c), 8.0), 0.0, 1.6);
}
`;

const FRAG_WATERFOG = /* glsl */ `
{
  vec3 gkD = gkW - cameraPosition;
  float gkK = uDome.x / uDome.y;
  vec3 gkOs = vec3(cameraPosition.x, cameraPosition.y * gkK, cameraPosition.z);
  vec3 gkDs = vec3(gkD.x, gkD.y * gkK, gkD.z);
  float gkA2 = max(dot(gkDs, gkDs), 1e-4);
  float gkB2 = dot(gkOs, gkDs);
  float gkC2 = dot(gkOs, gkOs) - uDome.x * uDome.x;
  float gkDisc = gkB2 * gkB2 - gkA2 * gkC2;
  float gkIn = 0.0;
  if (gkC2 < 0.0 && gkDisc > 0.0) gkIn = clamp((-gkB2 + sqrt(gkDisc)) / gkA2, 0.0, 1.0);
  float gkLen = (1.0 - gkIn) * length(gkD);
  float gkWf = 1.0 - exp(-uWaterDens * gkLen);
  gl_FragColor.rgb = mix(gl_FragColor.rgb, uWaterCol, gkWf);
}
`;

export interface LitOptions {
  /** Unique key per distinct option set (program cache). */
  key: string;
  ripple?: boolean;
  /** Caustic strength (0 = none). */
  caustic?: number;
  waterFog?: boolean;
}

/** Add the ocean lighting / fog patches to a vertex-coloured `MeshStandardMaterial`. */
export function patchLit(mat: THREE.MeshStandardMaterial, shared: OceanShared, o: LitOptions): THREE.MeshStandardMaterial {
  const caus = o.caustic ?? 0;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = shared.uTime;
    shader.uniforms.uWaterCol = shared.uWaterCol;
    shader.uniforms.uWaterDens = shared.uWaterDens;
    shader.uniforms.uDome = shared.uDome;
    shader.uniforms.uAlarm = shared.uAlarm;
    shader.uniforms.uAlarmHigh = shared.uAlarmHigh;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 gkW;\nvarying vec3 gkWN;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
  {
    vec4 gkP4 = vec4(transformed, 1.0);
    #ifdef USE_INSTANCING
    gkP4 = instanceMatrix * gkP4;
    #endif
    gkW = (modelMatrix * gkP4).xyz;
    gkWN = normalize(mat3(modelMatrix) * objectNormal);
  }`,
      );
    let frag = shader.fragmentShader.replace('#include <common>', `#include <common>\n${FRAG_COMMON}`);
    if (o.ripple === true) {
      frag = frag
        .replace(
          '#include <map_fragment>',
          `#include <map_fragment>
float gkUp = smoothstep(0.55, 0.92, gkWN.y);
float gkRA = dot(gkW.xz, vec2(0.83, 0.56)) * 2.7 + gkVn(gkW.xz * 0.31) * 3.6;
diffuseColor.rgb *= 1.0 + gkUp * 0.075 * sin(gkRA);`,
        )
        .replace(
          '#include <normal_fragment_maps>',
          `#include <normal_fragment_maps>
{
  float gkG = cos(gkRA) * 0.17;
  vec3 gkN = normalize(vec3(-gkG * 0.83, 1.0, -gkG * 0.56));
  vec3 gkNv = normalize((viewMatrix * vec4(gkN, 0.0)).xyz);
  normal = normalize(mix(normal, gkNv, gkUp * 0.8));
}`,
        );
    }
    if (caus > 0) {
      frag = frag.replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
{
  float gkInside = 1.0 - smoothstep(uDome.x - 4.0, uDome.x + 0.6, length(gkW.xz));
  float gkTop = smoothstep(0.35, 0.9, gkWN.y);
  float gkC = gkCaustic(gkW.xz * 0.42, uTime * 0.55 + 4.0);
  float gkMask = (gkTop + (1.0 - gkTop) * 0.3) * gkInside;
  totalEmissiveRadiance += diffuseColor.rgb * vec3(0.5, 0.95, 0.9) * gkC * gkMask * ${caus.toFixed(2)};
  totalEmissiveRadiance += diffuseColor.rgb * vec3(1.0, 0.22, 0.08) * uAlarm * 0.2 * gkInside;
  totalEmissiveRadiance += diffuseColor.rgb * vec3(0.75, 0.2, 1.0) * uAlarmHigh * 0.2 * gkInside;
}`,
      );
    }
    if (o.waterFog === true) frag = frag.replace('#include <fog_fragment>', `#include <fog_fragment>\n${FRAG_WATERFOG}`);
    shader.fragmentShader = frag;
  };
  mat.customProgramCacheKey = () => `gk-ocean-lit-${o.key}`;
  return mat;
}

/** Water-fog (and nothing else) for an unlit `MeshBasicMaterial` / `PointsMaterial`-like surface seen from inside the dome. */
export function patchBasicFog(mat: THREE.MeshBasicMaterial, shared: OceanShared, key: string): THREE.MeshBasicMaterial {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uWaterCol = shared.uWaterCol;
    shader.uniforms.uWaterDens = shared.uWaterDens;
    shader.uniforms.uDome = shared.uDome;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 gkW;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
  {
    vec4 gkP4 = vec4(transformed, 1.0);
    #ifdef USE_INSTANCING
    gkP4 = instanceMatrix * gkP4;
    #endif
    gkW = (modelMatrix * gkP4).xyz;
  }`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uWaterCol;\nuniform float uWaterDens;\nuniform vec2 uDome;\nvarying vec3 gkW;')
      .replace('#include <fog_fragment>', `#include <fog_fragment>\n${FRAG_WATERFOG}`);
  };
  mat.customProgramCacheKey = () => `gk-ocean-basic-${key}`;
  return mat;
}

// ── Creatures (GPU-animated sea life) ────────────────────────────────────────

export type CreatureMode = 'orbit' | 'line' | 'drift';

export interface CreatureOptions {
  key: string;
  mode: CreatureMode;
  /** Body length (m) used for tail wag, wingspan half-width (m) for flap. */
  len: number;
  span: number;
  /** Tail wag amplitude (fraction of length) and frequency (rad/s). */
  wag?: [number, number];
  /** Wing / flipper flap amplitude (fraction of span) and frequency (rad/s). */
  flap?: [number, number];
  /** Vertical bob of the orbit (m). */
  bob?: number;
  /** Fish school: instance offsets are in the school frame and wobble. */
  school?: boolean;
  /** Unlit glowing material (jellyfish): MeshBasicMaterial. */
  basic?: boolean;
  /** Line mode: half-length of the straight pass (m). */
  lineHalf?: number;
  /** Jelly: pulse frequency (rad/s). */
  pulse?: number;
  transparent?: boolean;
  opacity?: number;
}

const CREATURE_VERT_COMMON = /* glsl */ `
attribute vec4 aPath;
attribute vec4 aOff;
attribute vec4 aTint;
uniform float uTime;
uniform vec4 uBody;
uniform vec4 uAnim;
varying vec3 gkW;
mat3 gkBasis(vec3 f) {
  f = normalize(f);
  vec3 r = normalize(vec3(f.z, 0.0, -f.x) + vec3(1e-5, 0.0, 0.0));
  vec3 u = cross(f, r);
  return mat3(r, u, f);
}
`;

function creatureVertex(o: CreatureOptions): { common: string; normal: string; vertex: string } {
  let pos: string;
  if (o.mode === 'orbit') {
    pos = `vec3 gkPos(float t) {
  float th = aPath.w + aPath.z * t;
  float rr = aPath.x * (1.0 + 0.05 * sin(t * 0.23 + aPath.w * 3.0));
  float hh = aPath.y + uBody.z * sin(t * 0.31 + aPath.w * 5.0);
  return vec3(cos(th) * rr, hh, sin(th) * rr);
}`;
  } else if (o.mode === 'line') {
    pos = `vec3 gkPos(float t) {
  float p = fract(t / abs(aPath.z) + aPath.w);
  float sgn = aPath.z < 0.0 ? -1.0 : 1.0;
  float x = mix(-${(o.lineHalf ?? 200).toFixed(1)}, ${(o.lineHalf ?? 200).toFixed(1)}, p) * sgn;
  return vec3(x, aPath.y + uBody.z * sin(p * 18.85 + aPath.w * 6.0), aPath.x);
}`;
  } else {
    pos = `vec3 gkPos(float t) {
  float s = aOff.w * 31.0;
  vec3 base = vec3(cos(aPath.w) * aPath.x, aPath.y, sin(aPath.w) * aPath.x);
  return base + vec3(sin(t * 0.11 + s) * 3.0 + sin(t * 0.23 + s * 2.0), sin(t * aPath.z + s) * 2.6, cos(t * 0.13 + s * 1.3) * 3.0);
}`;
  }
  const upright = o.mode === 'drift';
  const normal = upright
    ? `vec3 gkP0 = gkPos(uTime);
  float gkTiltA = sin(uTime * 0.37 + aOff.w * 17.0) * 0.12;
  float gkTiltB = cos(uTime * 0.29 + aOff.w * 23.0) * 0.12;
  mat3 gkMM = mat3(1.0, 0.0, 0.0, 0.0, cos(gkTiltA), sin(gkTiltA), 0.0, -sin(gkTiltA), cos(gkTiltA)) * mat3(cos(gkTiltB), sin(gkTiltB), 0.0, -sin(gkTiltB), cos(gkTiltB), 0.0, 0.0, 0.0, 1.0);
  mat3 gkM = mat3(1.0);
  objectNormal = gkMM * objectNormal;`
    : `vec3 gkP0 = gkPos(uTime);
  vec3 gkF = gkPos(uTime + 0.1) - gkP0;
  mat3 gkM = gkBasis(gkF);
  float gkJ = ${o.school === true ? '(sin(uTime * 0.9 + aOff.w * 19.0) * 0.2)' : '0.0'};
  float gkCj = cos(gkJ);
  float gkSj = sin(gkJ);
  mat3 gkMM = gkM * mat3(gkCj, 0.0, -gkSj, 0.0, 1.0, 0.0, gkSj, 0.0, gkCj);
  objectNormal = gkMM * objectNormal;`;
  const wag = o.wag !== undefined
    ? `{
    float gkTail = smoothstep(0.1 * uBody.x, -0.5 * uBody.x, transformed.z);
    transformed.x += sin(uTime * uAnim.y + aOff.w * 37.0 - transformed.z * 6.0 / uBody.x) * uAnim.x * uBody.x * gkTail;
  }`
    : '';
  const flap = o.flap !== undefined
    ? `{
    float gkFk = abs(transformed.x) / uBody.y;
    transformed.y += sin(uTime * uAnim.w + aOff.w * 11.0 - gkFk * 1.6) * uAnim.z * uBody.y * gkFk * gkFk;
  }`
    : '';
  const pulse = o.mode === 'drift'
    ? `{
    float gkPu = sin(uTime * uAnim.y + aOff.w * 29.0);
    float gkBell = smoothstep(-0.12, 0.2, transformed.y);
    transformed.xz *= 1.0 + 0.2 * gkPu * gkBell;
    transformed.y *= 1.0 - 0.14 * gkPu * gkBell;
    float gkTen = smoothstep(0.0, -1.0, transformed.y);
    transformed.x += sin(uTime * 1.3 + transformed.y * 3.0 + aOff.w * 40.0) * 0.1 * gkTen;
    transformed.z += cos(uTime * 1.1 + transformed.y * 2.6 + aOff.w * 33.0) * 0.1 * gkTen;
  }`
    : '';
  const off = o.school === true
    ? `vec3 gkOff = aOff.xyz + vec3(sin(uTime * 0.8 + aOff.w * 13.0) * 0.35, sin(uTime * 1.1 + aOff.w * 7.0) * 0.25, sin(uTime * 0.6 + aOff.w * 5.0) * 0.45);`
    : 'vec3 gkOff = vec3(0.0);';
  const vertex = `vec3 transformed = vec3(position) * aTint.w;
  ${wag}
  ${flap}
  ${pulse}
  transformed = gkMM * transformed;
  ${off}
  transformed += gkP0 + gkM * gkOff;
  gkW = transformed;`;
  return { common: `${CREATURE_VERT_COMMON}\n${pos}`, normal, vertex };
}

/**
 * A sea-life material. Required per-instance attributes on the geometry: `aPath` (vec4), `aOff` (vec4: school offset xyz + seed),
 * `aTint` (vec4: rgb tint + scale). Path meaning per mode: orbit = (radius, height, angular speed rad/s, phase angle);
 * line = (lateral z, height, signed period s, phase 0..1); drift = (radius, height, bob speed, angle).
 */
export function creatureMaterial(shared: OceanShared, o: CreatureOptions): THREE.MeshStandardMaterial | THREE.MeshBasicMaterial {
  const mat: THREE.MeshStandardMaterial | THREE.MeshBasicMaterial = o.basic === true
    ? new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, transparent: o.transparent ?? false, opacity: o.opacity ?? 1, depthWrite: !(o.transparent ?? false) })
    : new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.62, metalness: 0.05, side: THREE.DoubleSide });
  const v = creatureVertex(o);
  const body = new THREE.Vector4(o.len, o.span, o.bob ?? 0, 0);
  const anim = new THREE.Vector4(o.wag?.[0] ?? 0, o.wag?.[1] ?? 0, o.flap?.[0] ?? 0, o.flap?.[1] ?? 0);
  if (o.mode === 'drift') anim.y = o.pulse ?? 2.2;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = shared.uTime;
    shader.uniforms.uBody = { value: body };
    shader.uniforms.uAnim = { value: anim };
    shader.uniforms.uWaterCol = shared.uWaterCol;
    shader.uniforms.uWaterDens = shared.uWaterDens;
    shader.uniforms.uDome = shared.uDome;
    let vs = shader.vertexShader.replace('#include <common>', `#include <common>\n${v.common}`);
    if (o.basic === true) {
      // MeshBasicMaterial has no objectNormal: compute the path state at the position stage instead.
      vs = vs.replace('#include <begin_vertex>', `${v.normal.replace('objectNormal = gkMM * objectNormal;', '')}\n  ${v.vertex}`);
    } else {
      vs = vs.replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>\n  ${v.normal}`);
      vs = vs.replace('#include <begin_vertex>', v.vertex);
    }
    vs = vs.replace('#include <color_vertex>', '#include <color_vertex>\n  #ifdef USE_COLOR\n  vColor.rgb *= aTint.rgb;\n  #endif');
    shader.vertexShader = vs;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uWaterCol;\nuniform float uWaterDens;\nuniform vec2 uDome;\nvarying vec3 gkW;')
      .replace('#include <fog_fragment>', `#include <fog_fragment>\n${FRAG_WATERFOG}`);
  };
  mat.customProgramCacheKey = () => `gk-ocean-creature-${o.key}`;
  return mat;
}

/**
 * Per-instance attribute buffers for an instanced creature geometry.
 */
export interface CreatureInstances {
  path: THREE.InstancedBufferAttribute;
  off: THREE.InstancedBufferAttribute;
  tint: THREE.InstancedBufferAttribute;
  count: number;
}

/** Turn a base geometry into an instanced one carrying `rows` (path, off, tint) per instance. */
export function makeInstanced(
  base: THREE.BufferGeometry,
  rows: readonly { path: [number, number, number, number]; off?: [number, number, number, number]; tint?: [number, number, number, number] }[],
): { geometry: THREE.InstancedBufferGeometry; inst: CreatureInstances } {
  const g = new THREE.InstancedBufferGeometry();
  g.index = base.index;
  for (const name of Object.keys(base.attributes)) g.setAttribute(name, base.getAttribute(name));
  const n = Math.max(1, rows.length);
  const path = new Float32Array(n * 4);
  const off = new Float32Array(n * 4);
  const tint = new Float32Array(n * 4);
  rows.forEach((r, i) => {
    path.set(r.path, i * 4);
    off.set(r.off ?? [0, 0, 0, i * 0.137], i * 4);
    tint.set(r.tint ?? [1, 1, 1, 1], i * 4);
  });
  const inst: CreatureInstances = {
    path: new THREE.InstancedBufferAttribute(path, 4),
    off: new THREE.InstancedBufferAttribute(off, 4),
    tint: new THREE.InstancedBufferAttribute(tint, 4),
    count: rows.length,
  };
  g.setAttribute('aPath', inst.path);
  g.setAttribute('aOff', inst.off);
  g.setAttribute('aTint', inst.tint);
  g.instanceCount = rows.length;
  // The geometry's own bounding sphere is meaningless for GPU-placed instances: callers set frustumCulled = false.
  return { geometry: g, inst };
}
