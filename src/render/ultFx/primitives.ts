/**
 * Ultimate indicator primitives (v1.3 WP-T) — pooled, allocation-free ground /
 * air markers shared by the READY-state preview and every per-animal ult VFX:
 *
 *  - {@link RingHandle}     ring / dashed ring of a given radius + thickness
 *  - {@link RibbonHandle}   ground line / ribbon with width and moving chevrons
 *  - {@link ReticleHandle}  rotating brackets; 'lock' (gold) / 'tracking' / 'committed'
 *  - {@link ArcHandle}      dashed ballistic arc in the air (camera-facing strip)
 *  - {@link ZoneHandle}     filled circle with an animated edge (+ warning fill)
 *
 * Everything hangs off one {@link UltIndicators} manager (constructed with the
 * scene, `update(dt)`-ed every render frame, `dispose()`d on unmount). Handles
 * are pooled: `ind.ring(owner)` reserves one (stealing the oldest if the pool is
 * exhausted), `show(...)` reveals it, `update(...)` moves it every frame and
 * `hide()` fades it out and returns it to the pool. `owner` is a fighter id used
 * by {@link UltIndicators.releaseOwner} so a caster's markers can never leak.
 *
 * Look: gold = friendly (the player's own preview / ult), red = hostile. Ground
 * primitives use normal alpha blending with an HDR boost (so they read on sand
 * and bloom on High); the air arc is additive. Nothing here allocates after
 * construction — `show`/`update` take plain numbers.
 */

import * as THREE from 'three';
import { TAU } from '../../core/math';
import { getQualityTier, type QualityTier } from '../quality';

/** Colour / intensity preset. */
export type IndicatorStyle = 'friendly' | 'hostile' | 'lock' | 'tracking' | 'committed' | 'invalid';

interface StyleDef {
  color: number;
  /** Base opacity 0..1. */
  alpha: number;
  /** Pulse frequency in Hz (0 = steady). */
  pulse: number;
  /** HDR boost on the bright parts (bloom on High). */
  boost: number;
}

const STYLES: Record<IndicatorStyle, StyleDef> = {
  friendly: { color: 0xffd45a, alpha: 0.9, pulse: 0, boost: 0.3 },
  hostile: { color: 0xff3b2f, alpha: 0.9, pulse: 0, boost: 0.3 },
  lock: { color: 0xffd76a, alpha: 1, pulse: 1.1, boost: 0.55 },
  tracking: { color: 0xff4a3a, alpha: 0.85, pulse: 1.6, boost: 0.4 },
  committed: { color: 0xff2a1e, alpha: 1, pulse: 5.5, boost: 0.7 },
  invalid: { color: 0xc04a40, alpha: 0.6, pulse: 0, boost: 0 },
};

const LIFT = 0.045; // ground decals ride just above the sand / trap decals
const MARGIN = 1.14; // quad is this × the ring radius (room for the glow halo)

// ── Shared GLSL ──────────────────────────────────────────────────────────────

const GROUND_VERTEX = /* glsl */ `
varying vec2 vP;
void main() {
  vP = position.xz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const COMMON_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uAlpha;
uniform float uTime;
uniform float uBoost;
uniform float uQ;
varying vec2 vP;
const float MARGIN = ${MARGIN.toFixed(2)};
const float TAU = 6.2831853;
const float FRINGE_M = 0.055;
const vec3 FRINGE_COL = vec3(0.09, 0.05, 0.015);
`;

const RING_FRAGMENT = /* glsl */ `
${COMMON_FRAG}
uniform float uInner;
uniform float uDash;
uniform float uSpin;
uniform float uGlow;
uniform float uFill;
uniform float uR;
void main() {
  float d = length(vP) * MARGIN;
  if (d > MARGIN) discard;
  float aa = fwidth(d) * 1.4 + 0.0015;
  float fr = FRINGE_M / max(uR, 0.3);
  float band = smoothstep(uInner - aa, uInner + aa, d) * (1.0 - smoothstep(1.0 - aa, 1.0 + aa, d));
  float wide = smoothstep(uInner - fr - aa, uInner - fr + aa, d) * (1.0 - smoothstep(1.0 + fr - aa, 1.0 + fr + aa, d));
  float mid = 0.5 * (uInner + 1.0);
  float hw = 0.5 * (1.0 - uInner);
  float e = max(0.0, abs(d - mid) - hw);
  float glow = exp(-e * 20.0) * uGlow * (0.18 + 0.4 * uQ);
  float ang = atan(vP.x, vP.y);
  float f = fract((ang + uSpin) / TAU * max(uDash, 1.0));
  float dm = smoothstep(0.0, 0.07, f) * (1.0 - smoothstep(0.5, 0.57, f));
  float dmk = step(0.5, uDash);
  band *= mix(1.0, dm, dmk);
  wide *= mix(1.0, dm, dmk);
  float fringe = clamp(wide - band, 0.0, 1.0);
  float inside = 1.0 - smoothstep(uInner - aa, uInner + aa, d);
  float fill = uFill * inside * (0.4 + 0.6 * d / max(uInner, 0.05));
  float total = band + fringe * 0.6;
  vec3 col = mix(FRINGE_COL, uColor * (1.0 + uBoost * band), band / max(total, 0.001));
  float a = (total + glow + fill) * uAlpha;
  if (a < 0.004) discard;
  gl_FragColor = vec4(col, clamp(a, 0.0, 0.97));
  #include <colorspace_fragment>
}
`;

const ZONE_FRAGMENT = /* glsl */ `
${COMMON_FRAG}
uniform float uProgress;
uniform float uSpin;
uniform float uR;
void main() {
  float d = length(vP) * MARGIN;
  if (d > MARGIN) discard;
  float aa = fwidth(d) * 1.4 + 0.0015;
  float fr = FRINGE_M / max(uR, 0.3);
  float inside = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, d);
  float ang = atan(vP.x, vP.y);
  // Edge band (~0.14 m) with marching dashes + dark fringe for contrast on sand.
  float eb = max(0.14 / max(uR, 0.3), 0.02);
  float edge = smoothstep(1.0 - eb - aa, 1.0 - eb + aa, d) * inside;
  float f = fract((ang + uSpin) / TAU * 22.0);
  float dm = smoothstep(0.0, 0.08, f) * (1.0 - smoothstep(0.55, 0.62, f));
  edge *= mix(0.55, 1.0, dm);
  float wideEdge = smoothstep(1.0 - eb - fr - aa, 1.0 - eb - fr + aa, d) * (1.0 - smoothstep(1.0 + fr - aa, 1.0 + fr + aa, d));
  float fringe = clamp(wideEdge - edge, 0.0, 1.0);
  // Swirling fill (arms sweep inward on a clock).
  float swirl = 0.5 + 0.5 * sin(ang * 3.0 + d * 8.0 - uTime * 2.2);
  float fill = inside * (0.1 + 0.07 * swirl * uQ) * (0.45 + 0.55 * d);
  // Warning fill growing out to the edge (uProgress 0..1).
  float pr = clamp(uProgress, 0.0, 1.0);
  float prog = (1.0 - smoothstep(pr - aa, pr + aa, d)) * inside * step(0.001, pr);
  float pEdge = exp(-abs(d - pr) * 36.0) * step(0.001, pr) * inside;
  float glow = exp(-max(0.0, d - 1.0) * 18.0) * (0.15 + 0.3 * uQ) * (1.0 - inside);
  float lit = edge * 0.95 + pEdge * 0.5;
  float total = lit + fringe * 0.5;
  vec3 col = mix(FRINGE_COL, uColor * (1.0 + uBoost * (edge + pEdge)), lit / max(total, 0.001));
  float a = (fill + total + prog * 0.22 + glow) * uAlpha;
  if (a < 0.004) discard;
  gl_FragColor = vec4(col, clamp(a, 0.0, 0.97));
  #include <colorspace_fragment>
}
`;

const RETICLE_FRAGMENT = /* glsl */ `
${COMMON_FRAG}
uniform float uInner;
uniform float uSpin;
uniform float uArc;
uniform float uCommit;
uniform float uCross;
uniform float uR;
void main() {
  float d = length(vP) * MARGIN;
  if (d > MARGIN) discard;
  float aa = fwidth(d) * 1.4 + 0.0015;
  float fr = FRINGE_M / max(uR, 0.3);
  float ang = atan(vP.x, vP.y);
  float ring = smoothstep(uInner - aa, uInner + aa, d) * (1.0 - smoothstep(1.0 - aa, 1.0 + aa, d));
  float ringW = smoothstep(uInner - fr - aa, uInner - fr + aa, d) * (1.0 - smoothstep(1.0 + fr - aa, 1.0 + fr + aa, d));
  // Four bracket arcs centred every 90 deg (uArc = lit fraction of each quadrant; ~1 = solid).
  float qa = fract((ang + uSpin) / TAU * 4.0 + 0.5 * uArc);
  float br = smoothstep(0.0, 0.04, qa) * (1.0 - smoothstep(uArc - 0.04, uArc, qa));
  br = mix(br, 1.0, step(0.96, uArc));
  // Faint full hairline just inside the brackets + inward ticks at each bracket centre.
  float hair = (1.0 - smoothstep(0.02, 0.05, abs(d - (uInner - 0.06)))) * 0.28;
  float qk = fract((ang + uSpin) / TAU * 4.0 + 0.5) - 0.5;
  float tick = (1.0 - smoothstep(0.025, 0.055, abs(qk))) * smoothstep(uInner - 0.2 - aa, uInner - 0.2 + aa, d) * (1.0 - smoothstep(uInner - aa, uInner, d));
  tick *= 1.0 - step(0.96, uArc);
  // Cross-hair (lock / committed).
  float cx = (1.0 - smoothstep(0.012, 0.03, abs(vP.x * MARGIN))) + (1.0 - smoothstep(0.012, 0.03, abs(vP.y * MARGIN)));
  cx = clamp(cx, 0.0, 1.0) * (1.0 - smoothstep(uInner * 0.45, uInner * 0.5, d)) * smoothstep(0.08, 0.16, d) * uCross;
  // Warning fill growing to the ring (committed).
  float pr = clamp(uCommit, 0.0, 1.0) * uInner;
  float prog = (1.0 - smoothstep(pr - aa, pr + aa, d)) * step(0.001, uCommit);
  float pEdge = exp(-abs(d - pr) * 40.0) * step(0.001, uCommit);
  float glow = exp(-max(0.0, d - 1.0) * 22.0) * (0.12 + 0.3 * uQ);
  float lit = ring * br + hair + tick * 0.9 + cx * 0.85;
  float fringe = clamp(ringW * br - ring * br, 0.0, 1.0);
  float total = min(lit, 1.0) + fringe * 0.6;
  float hot = ring * br + cx + pEdge;
  vec3 col = mix(FRINGE_COL, uColor * (1.0 + uBoost * hot), min(lit, 1.0) / max(total, 0.001));
  float a = (total + prog * 0.26 + pEdge * 0.5 + glow * br) * uAlpha;
  if (a < 0.004) discard;
  gl_FragColor = vec4(col, clamp(a, 0.0, 0.97));
  #include <colorspace_fragment>
}
`;

const RIBBON_FRAGMENT = /* glsl */ `
${COMMON_FRAG}
uniform float uLen;
uniform float uHalfW;
uniform float uSpeed;
uniform float uPeriod;
uniform float uReveal;
uniform float uHead;
void main() {
  float ax = abs(vP.x);
  float along = vP.y * 0.5 + 0.5;
  float u = along * uLen;
  float aa = fwidth(vP.x) * 1.4 + 0.002;
  float ew = clamp(0.09 / max(uHalfW, 0.05), 0.03, 0.5);
  float fw = clamp(0.05 / max(uHalfW, 0.05), 0.01, 0.3);
  float edge = smoothstep(1.0 - ew - aa, 1.0 - ew + aa, ax) * (1.0 - smoothstep(1.0 - aa, 1.0 + aa, ax));
  float fringe = smoothstep(1.0 - ew - fw - aa, 1.0 - ew - fw + aa, ax) * (1.0 - smoothstep(1.0 - ew - aa, 1.0 - ew + aa, ax));
  // Forward-pointing chevrons marching toward the target.
  float s = fract((u + ax * uHalfW * 0.9 - uTime * uSpeed) / uPeriod);
  float chev = smoothstep(0.0, 0.05, s) * (1.0 - smoothstep(0.2, 0.27, s));
  chev *= 1.0 - smoothstep(0.55, 0.98, ax);
  float body = 0.14 + 0.05 * uQ;
  float fadeIn = smoothstep(0.0, 0.06, along);
  float head = smoothstep(1.0 - 0.06 * uHead, 1.0, along) * uHead;
  float rev = 1.0 - smoothstep(uReveal, uReveal + 0.015, along);
  float lead = exp(-max(0.0, uReveal - along) * 30.0) * step(along, uReveal) * step(uReveal, 0.999);
  float lit = (chev * 0.8 + edge * 0.85 + head * 0.7) * fadeIn * rev + lead * 0.6;
  float total = lit + (body * fadeIn * rev) + fringe * 0.45 * fadeIn * rev;
  vec3 col = mix(FRINGE_COL, uColor * (1.0 + uBoost * (edge + chev + lead)), (lit + body * fadeIn * rev) / max(total, 0.001));
  float a = total * uAlpha;
  if (a < 0.004) discard;
  gl_FragColor = vec4(col, clamp(a, 0.0, 0.97));
  #include <colorspace_fragment>
}
`;

const ARC_VERTEX = /* glsl */ `
attribute vec2 aP;
uniform vec3 uFrom;
uniform vec3 uTo;
uniform float uHeight;
uniform float uWidth;
varying float vT;
varying float vSide;
vec3 arcAt(float t) {
  vec3 p = mix(uFrom, uTo, t);
  p.y += 4.0 * uHeight * t * (1.0 - t);
  return p;
}
void main() {
  float t = aP.x;
  vec3 p = arcAt(t);
  vec3 tang = normalize(arcAt(min(t + 0.02, 1.0)) - arcAt(max(t - 0.02, 0.0)));
  vec3 toCam = normalize(cameraPosition - p);
  vec3 side = cross(tang, toCam);
  float sl = length(side);
  side = sl > 1e-4 ? side / sl : vec3(0.0, 1.0, 0.0);
  p += side * aP.y * uWidth * 0.5;
  vT = t;
  vSide = aP.y;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`;

const ARC_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uAlpha;
uniform float uTime;
uniform float uBoost;
uniform float uDashes;
uniform float uSpeed;
uniform float uReveal;
varying float vT;
varying float vSide;
void main() {
  float f = fract(vT * uDashes - uTime * uSpeed);
  float dm = smoothstep(0.0, 0.1, f) * (1.0 - smoothstep(0.55, 0.65, f));
  float across = 1.0 - smoothstep(0.55, 1.0, abs(vSide));
  float a = dm * across;
  float cap = smoothstep(0.93, 0.985, vT) * across;
  a = max(a, cap);
  a *= smoothstep(0.0, 0.05, vT);
  a *= 1.0 - smoothstep(uReveal, uReveal + 0.02, vT);
  a *= uAlpha;
  if (a < 0.004) discard;
  gl_FragColor = vec4(uColor * (1.0 + uBoost * (dm + cap)), clamp(a, 0.0, 1.0));
  #include <colorspace_fragment>
}
`;

// ── Handles ──────────────────────────────────────────────────────────────────

const _c = new THREE.Color();

type Uniforms = Record<string, THREE.IUniform>;

/** Shared per-frame clock + tier feed. */
interface Clock {
  time: number;
  q: number;
  boostScale: number;
}

/** Base for every pooled marker. */
export abstract class IndicatorHandle {
  /** Fighter id that owns this marker (for {@link UltIndicators.releaseOwner}); -1 = none. */
  owner = -1;
  /** True from reservation until the fade-out completes. */
  active = false;
  /** True between `show()` and `hide()`. */
  shown = false;
  style: IndicatorStyle = 'friendly';

  protected alpha = 0;
  protected target = 0;
  protected mult = 1;
  protected rate = 16;
  /** Reservation order (oldest is stolen first when a pool is exhausted). */
  stamp = 0;
  protected styleAlpha = 1;
  protected pulseHz = 0;
  protected colorOverride = -1;

  constructor(
    readonly mesh: THREE.Mesh,
    protected readonly mat: THREE.ShaderMaterial,
    protected readonly clock: Clock,
  ) {
    mesh.visible = false;
    mesh.frustumCulled = false;
  }

  protected get u(): Uniforms {
    return this.mat.uniforms;
  }

  /**
   * True while this handle is still reserved by `owner`. A pool that runs dry steals its oldest
   * reservation, so long-lived holders should check this before updating / hiding a handle.
   */
  held(owner: number): boolean {
    return this.active && this.owner === owner;
  }

  /** Reserve for `owner` (invisible until `show`). */
  reserve(owner: number, stamp: number): void {
    this.owner = owner;
    this.active = true;
    this.shown = false;
    this.alpha = 0;
    this.target = 0;
    this.mult = 1;
    this.colorOverride = -1;
    this.stamp = stamp;
    this.mesh.visible = false;
  }

  /** Fade in with `style`. */
  protected reveal(style: IndicatorStyle): void {
    this.shown = true;
    this.active = true;
    this.target = 1;
    this.rate = 16;
    this.setStyle(style);
    this.mesh.visible = true;
  }

  /** Change the colour/intensity preset (also applied live, e.g. tracking → committed). */
  setStyle(style: IndicatorStyle): void {
    this.style = style;
    const def = STYLES[style];
    this.styleAlpha = def.alpha;
    this.pulseHz = def.pulse;
    this.applyColor(this.colorOverride >= 0 ? this.colorOverride : def.color);
    this.u.uBoost.value = def.boost * this.clock.boostScale;
    this.onStyle(style);
  }

  /** Override the preset colour (per-animal accent); pass -1 to go back to the preset. */
  setColor(hex: number): void {
    this.colorOverride = hex;
    this.applyColor(hex >= 0 ? hex : STYLES[this.style].color);
  }

  private applyColor(hex: number): void {
    _c.setHex(hex);
    (this.u.uColor.value as THREE.Color).copy(_c);
  }

  /** Extra opacity multiplier (0..1), e.g. to dim a preview. */
  setAlpha(a: number): void {
    this.mult = a;
  }

  /** Fade out over ~`fadeOut` seconds, then return to the pool (0 = immediately). */
  hide(fadeOut = 0.16): void {
    if (!this.active) return;
    if (!this.shown || fadeOut <= 0) {
      this.release();
      return;
    }
    this.shown = false;
    this.target = 0;
    this.rate = 3.2 / fadeOut;
  }

  protected release(): void {
    this.active = false;
    this.shown = false;
    this.alpha = 0;
    this.target = 0;
    this.owner = -1;
    this.mesh.visible = false;
  }

  /** Per-frame fade / pulse (called by the manager). */
  tick(dt: number): void {
    if (!this.active || !this.mesh.visible) return;
    this.alpha += (this.target - this.alpha) * (1 - Math.exp(-dt * this.rate));
    if (this.target === 0 && this.alpha < 0.02) {
      this.release();
      return;
    }
    let a = this.alpha * this.mult * this.styleAlpha;
    if (this.pulseHz > 0) a *= 0.82 + 0.18 * Math.sin(this.clock.time * this.pulseHz * TAU);
    this.u.uAlpha.value = a;
    this.u.uTime.value = this.clock.time;
    this.u.uQ.value = this.clock.q;
    this.onTick(dt);
  }

  protected onStyle(_style: IndicatorStyle): void {
    /* subclasses */
  }

  protected onTick(_dt: number): void {
    /* subclasses */
  }
}

function groundMaterial(fragment: string, extra: Uniforms): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(0xffffff) },
      uAlpha: { value: 0 },
      uTime: { value: 0 },
      uBoost: { value: 0 },
      uQ: { value: 1 },
      ...extra,
    },
    vertexShader: GROUND_VERTEX,
    fragmentShader: fragment,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -8,
    fog: false,
  });
}

/** Ring / dashed ring on the ground. */
export class RingHandle extends IndicatorHandle {
  /**
   * Reveal at (x, y, z) with `radius` (outer, m) and band `thickness` (m).
   * `y` is the ground height under the ring (0 on the sand).
   */
  show(x: number, y: number, z: number, radius: number, thickness = 0.14, style: IndicatorStyle = 'friendly'): void {
    this.reveal(style);
    this.u.uDash.value = 0;
    this.u.uSpin.value = 0;
    this.u.uGlow.value = 1;
    this.u.uFill.value = 0;
    this.spinRate = 0;
    this.place(x, y, z, radius, thickness);
  }

  /** Move / resize (call every frame while it follows something). */
  update(x: number, y: number, z: number, radius: number, thickness = 0.14): void {
    this.place(x, y, z, radius, thickness);
  }

  /** `count` dashes around the ring (0 = solid) rotating at `spinRate` rad/s. */
  setDash(count: number, spinRate = 0): void {
    this.u.uDash.value = count;
    this.spinRate = spinRate;
  }

  /** Faint fill inside the ring (0..1, ~0.1 looks good). */
  setFill(a: number): void {
    this.u.uFill.value = a;
  }

  /** Soft outer halo on/off (0..1). */
  setGlow(g: number): void {
    this.u.uGlow.value = g;
  }

  private spinRate = 0;

  private place(x: number, y: number, z: number, radius: number, thickness: number): void {
    const r = radius < 0.05 ? 0.05 : radius;
    this.mesh.position.set(x, y + LIFT, z);
    const s = r * MARGIN;
    this.mesh.scale.set(s, 1, s);
    this.u.uR.value = r;
    const inner = 1 - thickness / r;
    this.u.uInner.value = inner < 0.02 ? 0.02 : inner > 0.985 ? 0.985 : inner;
  }

  protected override onTick(): void {
    if (this.spinRate !== 0) this.u.uSpin.value = this.clock.time * this.spinRate;
  }
}

/** Filled circle with an animated edge and an optional warning fill (`setProgress`). */
export class ZoneHandle extends IndicatorHandle {
  show(x: number, y: number, z: number, radius: number, style: IndicatorStyle = 'hostile'): void {
    this.reveal(style);
    this.u.uProgress.value = 0;
    this.place(x, y, z, radius);
  }

  update(x: number, y: number, z: number, radius: number): void {
    this.place(x, y, z, radius);
  }

  /** Warning fill 0..1 growing out to the edge (0 = off). */
  setProgress(p: number): void {
    this.u.uProgress.value = p;
  }

  private place(x: number, y: number, z: number, radius: number): void {
    const r = radius < 0.05 ? 0.05 : radius;
    this.mesh.position.set(x, y + LIFT, z);
    const s = r * MARGIN;
    this.mesh.scale.set(s, 1, s);
    this.u.uR.value = r;
  }

  protected override onTick(): void {
    this.u.uSpin.value = this.clock.time * 0.7;
  }
}

/**
 * Rotating bracket reticle. Style 'lock' = tight gold brackets + cross-hair,
 * 'tracking' = wider red brackets swinging round, 'committed' = solid red ring
 * with a warning fill (`setCommit(0..1)`) — dodge by leaving it.
 */
export class ReticleHandle extends IndicatorHandle {
  private spin = 0;
  private spinRate = 0.5;

  show(x: number, y: number, z: number, radius: number, style: IndicatorStyle = 'lock'): void {
    this.reveal(style);
    this.u.uCommit.value = 0;
    this.place(x, y, z, radius);
  }

  update(x: number, y: number, z: number, radius: number): void {
    this.place(x, y, z, radius);
  }

  /** Warning fill 0..1 (only visible in 'committed'; harmless elsewhere). */
  setCommit(p: number): void {
    this.u.uCommit.value = p;
  }

  private place(x: number, y: number, z: number, radius: number): void {
    const r = radius < 0.1 ? 0.1 : radius;
    this.mesh.position.set(x, y + LIFT + 0.01, z);
    const s = r * MARGIN;
    this.mesh.scale.set(s, 1, s);
    this.u.uR.value = r;
    const th = this.style === 'committed' ? 0.22 : 0.2;
    const inner = 1 - th / r;
    this.u.uInner.value = inner < 0.4 ? 0.4 : inner > 0.97 ? 0.97 : inner;
  }

  protected override onStyle(style: IndicatorStyle): void {
    if (style === 'committed') {
      this.u.uArc.value = 1;
      this.spinRate = 0;
      this.u.uCross.value = 1;
    } else if (style === 'tracking') {
      this.u.uArc.value = 0.3;
      this.spinRate = 1.3;
      this.u.uCross.value = 0.6;
    } else {
      this.u.uArc.value = 0.2;
      this.spinRate = 0.45;
      this.u.uCross.value = 1;
    }
  }

  protected override onTick(dt: number): void {
    this.spin += this.spinRate * dt;
    this.u.uSpin.value = this.spin;
  }
}

/** Ground line / ribbon from A to B with `width` and marching chevrons toward B. */
export class RibbonHandle extends IndicatorHandle {
  show(fx: number, fy: number, fz: number, tx: number, ty: number, tz: number, width: number, style: IndicatorStyle = 'friendly'): void {
    this.reveal(style);
    this.u.uReveal.value = 1;
    this.u.uHead.value = 0;
    this.u.uSpeed.value = 4.5;
    this.u.uPeriod.value = 1.1;
    this.place(fx, fy, fz, tx, ty, tz, width);
  }

  update(fx: number, fy: number, fz: number, tx: number, ty: number, tz: number, width: number): void {
    this.place(fx, fy, fz, tx, ty, tz, width);
  }

  /** Reveal progress 0..1 along the path (a tether / tremor crack racing out). */
  setReveal(p: number): void {
    this.u.uReveal.value = p;
  }

  /** Bright end-cap on the far end (0..1). */
  setHead(h: number): void {
    this.u.uHead.value = h;
  }

  /** Chevron scroll speed (m/s) and spacing (m). */
  setFlow(speed: number, period = 1.1): void {
    this.u.uSpeed.value = speed;
    this.u.uPeriod.value = period;
  }

  private place(fx: number, fy: number, fz: number, tx: number, ty: number, tz: number, width: number): void {
    const dx = tx - fx;
    const dz = tz - fz;
    const len = Math.sqrt(dx * dx + dz * dz);
    const l = len < 0.05 ? 0.05 : len;
    this.mesh.position.set((fx + tx) * 0.5, (fy + ty) * 0.5 + LIFT, (fz + tz) * 0.5);
    this.mesh.rotation.y = Math.atan2(dx, dz);
    const hw = (width < 0.05 ? 0.05 : width) * 0.5;
    this.mesh.scale.set(hw, 1, l * 0.5);
    this.u.uLen.value = l;
    this.u.uHalfW.value = hw;
  }
}

const ARC_SEGS = 30;

/** Dashed ballistic arc in the air from A to B, apex `height` above the chord. */
export class ArcHandle extends IndicatorHandle {
  private dashLen = 0.7;

  show(fx: number, fy: number, fz: number, tx: number, ty: number, tz: number, height: number, width = 0.26, style: IndicatorStyle = 'hostile'): void {
    this.reveal(style);
    this.u.uReveal.value = 1;
    this.u.uSpeed.value = 1.6;
    this.mesh.visible = true;
    this.place(fx, fy, fz, tx, ty, tz, height, width);
  }

  update(fx: number, fy: number, fz: number, tx: number, ty: number, tz: number, height: number, width = 0.26): void {
    this.place(fx, fy, fz, tx, ty, tz, height, width);
  }

  /** Reveal progress 0..1 along the arc (drawing itself toward the target). */
  setReveal(p: number): void {
    this.u.uReveal.value = p;
  }

  /** Dash spacing (m) and scroll speed (cycles/s). */
  setDash(lengthM: number, speed = 1.6): void {
    this.dashLen = lengthM < 0.1 ? 0.1 : lengthM;
    this.u.uSpeed.value = speed;
  }

  private place(fx: number, fy: number, fz: number, tx: number, ty: number, tz: number, height: number, width: number): void {
    (this.u.uFrom.value as THREE.Vector3).set(fx, fy, fz);
    (this.u.uTo.value as THREE.Vector3).set(tx, ty, tz);
    this.u.uHeight.value = height;
    this.u.uWidth.value = width;
    const dx = tx - fx;
    const dy = ty - fy;
    const dz = tz - fz;
    const L = Math.max(0.5, Math.sqrt(dx * dx + dy * dy + dz * dz));
    const len = L + (8 * height * height) / (3 * L);
    this.u.uDashes.value = len / this.dashLen;
  }
}

// ── Manager ──────────────────────────────────────────────────────────────────

function groundQuad(): THREE.PlaneGeometry {
  return new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2);
}

function arcGeometry(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  const n = ARC_SEGS + 1;
  const aP = new Float32Array(n * 2 * 2);
  const pos = new Float32Array(n * 2 * 3); // dummy (the vertex shader ignores it)
  const idx: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / ARC_SEGS;
    aP[i * 4] = t;
    aP[i * 4 + 1] = -1;
    aP[i * 4 + 2] = t;
    aP[i * 4 + 3] = 1;
    if (i < ARC_SEGS) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aP', new THREE.BufferAttribute(aP, 2));
  g.setIndex(idx);
  return g;
}

const POOL_RING = 8;
const POOL_RIBBON = 8;
const POOL_RETICLE = 6;
const POOL_ARC = 4;
const POOL_ZONE = 6;

export class UltIndicators {
  private readonly scene: THREE.Scene;
  private readonly clock: Clock = { time: 0, q: 1, boostScale: 1 };
  private readonly group = new THREE.Group();
  private readonly rings: RingHandle[] = [];
  private readonly ribbons: RibbonHandle[] = [];
  private readonly reticles: ReticleHandle[] = [];
  private readonly arcs: ArcHandle[] = [];
  private readonly zones: ZoneHandle[] = [];
  private readonly all: IndicatorHandle[] = [];
  private readonly geos: THREE.BufferGeometry[] = [];
  private readonly mats: THREE.ShaderMaterial[] = [];
  private stampCounter = 0;
  private tier: QualityTier = getQualityTier();

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.group.name = 'ult-indicators';
    this.applyTier();

    const quad = groundQuad();
    this.geos.push(quad);
    const arcGeo = arcGeometry();
    this.geos.push(arcGeo);

    const add = <H extends IndicatorHandle>(list: H[], h: H, order: number): void => {
      h.mesh.renderOrder = order;
      this.group.add(h.mesh);
      list.push(h);
      this.all.push(h);
    };

    for (let i = 0; i < POOL_RING; i++) {
      const mat = groundMaterial(RING_FRAGMENT, {
        uInner: { value: 0.9 },
        uDash: { value: 0 },
        uSpin: { value: 0 },
        uGlow: { value: 1 },
        uFill: { value: 0 },
        uR: { value: 1 },
      });
      this.mats.push(mat);
      add(this.rings, new RingHandle(new THREE.Mesh(quad, mat), mat, this.clock), 4);
    }
    for (let i = 0; i < POOL_ZONE; i++) {
      const mat = groundMaterial(ZONE_FRAGMENT, { uProgress: { value: 0 }, uSpin: { value: 0 }, uR: { value: 1 } });
      this.mats.push(mat);
      add(this.zones, new ZoneHandle(new THREE.Mesh(quad, mat), mat, this.clock), 3);
    }
    for (let i = 0; i < POOL_RIBBON; i++) {
      const mat = groundMaterial(RIBBON_FRAGMENT, {
        uLen: { value: 1 },
        uHalfW: { value: 0.5 },
        uSpeed: { value: 4.5 },
        uPeriod: { value: 1.1 },
        uReveal: { value: 1 },
        uHead: { value: 0 },
      });
      this.mats.push(mat);
      add(this.ribbons, new RibbonHandle(new THREE.Mesh(quad, mat), mat, this.clock), 4);
    }
    for (let i = 0; i < POOL_RETICLE; i++) {
      const mat = groundMaterial(RETICLE_FRAGMENT, {
        uInner: { value: 0.85 },
        uSpin: { value: 0 },
        uArc: { value: 0.2 },
        uCommit: { value: 0 },
        uCross: { value: 1 },
        uR: { value: 1 },
      });
      this.mats.push(mat);
      add(this.reticles, new ReticleHandle(new THREE.Mesh(quad, mat), mat, this.clock), 6);
    }
    for (let i = 0; i < POOL_ARC; i++) {
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          uColor: { value: new THREE.Color(0xffffff) },
          uAlpha: { value: 0 },
          uTime: { value: 0 },
          uBoost: { value: 0 },
          uQ: { value: 1 },
          uFrom: { value: new THREE.Vector3() },
          uTo: { value: new THREE.Vector3() },
          uHeight: { value: 1 },
          uWidth: { value: 0.26 },
          uDashes: { value: 12 },
          uSpeed: { value: 1.6 },
          uReveal: { value: 1 },
        },
        vertexShader: ARC_VERTEX,
        fragmentShader: ARC_FRAGMENT,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        fog: false,
      });
      this.mats.push(mat);
      add(this.arcs, new ArcHandle(new THREE.Mesh(arcGeo, mat), mat, this.clock), 6);
    }
    scene.add(this.group);
  }

  /** Reserve a ring for `owner` (fighter id, or -1). Call `.show(...)` right away. */
  ring(owner = -1): RingHandle {
    return this.acquire(this.rings, owner);
  }

  /** Reserve a ground ribbon / line. */
  ribbon(owner = -1): RibbonHandle {
    return this.acquire(this.ribbons, owner);
  }

  /** Reserve a bracket reticle. */
  reticle(owner = -1): ReticleHandle {
    return this.acquire(this.reticles, owner);
  }

  /** Reserve a dashed air arc. */
  arc(owner = -1): ArcHandle {
    return this.acquire(this.arcs, owner);
  }

  /** Reserve a filled zone. */
  zone(owner = -1): ZoneHandle {
    return this.acquire(this.zones, owner);
  }

  private acquire<H extends IndicatorHandle>(pool: H[], owner: number): H {
    let pick: H | null = null;
    for (let i = 0; i < pool.length; i++) {
      if (!pool[i].active) {
        pick = pool[i];
        break;
      }
    }
    if (pick === null) {
      // Exhausted: steal the oldest reservation.
      pick = pool[0];
      for (let i = 1; i < pool.length; i++) if (pool[i].stamp < pick.stamp) pick = pool[i];
      pick.hide(0);
    }
    pick.reserve(owner, ++this.stampCounter);
    return pick;
  }

  /** Fade out every marker owned by `owner` (a fighter whose ultimate ended / who died). */
  releaseOwner(owner: number, fadeOut = 0.2): void {
    for (let i = 0; i < this.all.length; i++) {
      const h = this.all[i];
      if (h.active && h.owner === owner) h.hide(fadeOut);
    }
  }

  /** Hide everything (pause / death / match end). `fadeOut` 0 = instantly. */
  hideAll(fadeOut = 0): void {
    for (let i = 0; i < this.all.length; i++) if (this.all[i].active) this.all[i].hide(fadeOut);
  }

  /** Number of markers currently reserved (tests / budgets). */
  get activeCount(): number {
    let n = 0;
    for (let i = 0; i < this.all.length; i++) if (this.all[i].active) n++;
    return n;
  }

  /** Per render frame (real seconds). */
  update(dt: number): void {
    this.clock.time += dt;
    const tier = getQualityTier();
    if (tier !== this.tier) {
      this.tier = tier;
      this.applyTier();
      // Re-apply each live style so `boost` picks up the new tier.
      for (const h of this.all) if (h.active) h.setStyle(h.style);
    }
    for (let i = 0; i < this.all.length; i++) this.all[i].tick(dt);
  }

  private applyTier(): void {
    // No bloom on Low/Medium: brighter base + no swirl/halo extras on Low.
    this.clock.q = this.tier === 'low' ? 0 : this.tier === 'medium' ? 0.6 : 1;
    this.clock.boostScale = this.tier === 'high' ? 1.4 : 1;
  }

  dispose(): void {
    this.scene.remove(this.group);
    for (const g of this.geos) g.dispose();
    for (const m of this.mats) m.dispose();
    this.all.length = 0;
    this.rings.length = 0;
    this.ribbons.length = 0;
    this.reticles.length = 0;
    this.arcs.length = 0;
    this.zones.length = 0;
  }
}
