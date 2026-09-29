/**
 * Power-up pad beacons (v1.2 WP-O, UPGRADE-PLAN-v1.2 §4.2). Replaces the old
 * meat / feather / war-drum props with unmistakable, colour-coded medallions:
 *
 *  - HEAL  — big glowing green cross on a warm gold ring (deep green face);
 *  - SPEED — electric-yellow lightning bolt on a cyan ring + trailing speed streaks;
 *  - POWER — crossed white-hot swords on a red ring crowned with flames.
 *
 * Each medallion floats ≈1.4 m up, bobs, rocks and turns to face the camera
 * (so it is never seen edge-on), pops in with an overshoot when it respawns,
 * and is framed by a spinning dashed ground ring on the pad, a soft light
 * column and rising kind-shaped sparkles (plus / streak / ember). A small
 * billboard label (HEAL / SPEED / POWER) fades in when the player is within
 * ≈10 m.
 *
 * Budget: 3 icon InstancedMeshes (one per kind; hidden when unused) + 1 ring +
 * 1 column + 1 Points = ≤ 6 draw calls for all six pads, plus a label sprite
 * only for pads near the player (usually 0–2). Low tier drops the column and
 * the sparkles. Zero per-frame allocation.
 */

import * as THREE from 'three';
import { GeoAccumulator } from './geo';
import type { QualityTier } from './quality';

/** Kind order matches Stadium's PICKUP_KINDS: heal, speed, rage. */
const KINDS = 3;
const ICON_Y = 1.6;
const ICON_SCALE = 1.2;
const LABEL_Y = 2.72;
const LABEL_NEAR = 6.5; // fully visible inside this
const LABEL_FAR = 10.5; // invisible beyond this
const COLUMN_H = 6.5;
const SPARKS_PER_PAD = 14;
/** Estimated camera→player distance when no explicit focus is given. */
const CAM_TO_PLAYER = 5.5;

const RING_COLORS: readonly THREE.Color[] = [
  new THREE.Color(0.36, 1.0, 0.46),
  new THREE.Color(0.3, 0.88, 1.0),
  new THREE.Color(1.0, 0.26, 0.1),
];
const COLUMN_COLORS: readonly THREE.Color[] = [
  new THREE.Color(0.3, 1.0, 0.42),
  new THREE.Color(0.35, 0.9, 1.0),
  new THREE.Color(1.0, 0.24, 0.08),
];
const LABELS: readonly { text: string; color: string; glow: string }[] = [
  { text: 'HEAL', color: '#7dff9a', glow: '#1fd64f' },
  { text: 'SPEED', color: '#fff27a', glow: '#2fd8ff' },
  { text: 'POWER', color: '#ff8a6a', glow: '#ff2a12' },
];

// Scratch.
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _v2 = new THREE.Vector2();
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

function easeOutBack(t: number): number {
  const c1 = 1.9;
  const c3 = c1 + 1;
  const u = t - 1;
  return 1 + c3 * u * u * u + c1 * u * u;
}

function smooth01(t: number): number {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  return x * x * (3 - 2 * x);
}

export class PickupBeacons {
  readonly root = new THREE.Group();

  private readonly pads: readonly { x: number; z: number }[];
  private readonly icons: THREE.InstancedMesh[] = [];
  private readonly ring: THREE.InstancedMesh;
  private readonly column: THREE.InstancedMesh;
  private readonly sparks: THREE.Points;
  private readonly labels: THREE.Sprite[] = [];
  private readonly labelTex: THREE.Texture[] = [];
  private readonly materials: THREE.Material[] = [];

  private readonly iconMat: THREE.MeshStandardMaterial;
  private readonly ringU = { uTime: { value: 0 } };
  private readonly columnU = { uTime: { value: 0 } };
  private readonly sparkU: {
    uTime: { value: number };
    uPx: { value: number };
    uPad: { value: THREE.Vector4[] };
  };

  /** -1 = empty pad; else kind index currently shown (or shrinking away). */
  private readonly kind: Int8Array;
  private readonly appear: Float32Array;
  private readonly labelA: Float32Array;
  private readonly lastKind: Int8Array;

  private readonly viewer = new THREE.Vector3();
  private readonly camPos = new THREE.Vector3();
  private readonly camDir = new THREE.Vector3(0, 0, -1);
  private camValid = false;
  private focusAge = Infinity;
  private readonly focus = new THREE.Vector2();
  private tier: QualityTier = 'high';

  constructor(pads: readonly { x: number; z: number }[]) {
    this.pads = pads;
    const n = pads.length;
    this.kind = new Int8Array(n).fill(-1);
    this.lastKind = new Int8Array(n).fill(-1);
    this.appear = new Float32Array(n);
    this.labelA = new Float32Array(n);

    // ── Medallion icons: lit + self-glowing vertex colours (HDR >1 blooms) ──
    this.iconMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.15 });
    const glowU = { value: 0.55 };
    this.iconMat.onBeforeCompile = (shader) => {
      shader.uniforms.uGlow = glowU;
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uGlow;')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vColor.rgb * uGlow;');
    };
    this.iconMat.customProgramCacheKey = () => 'gk-pickup-icon';
    this.materials.push(this.iconMat);
    const geos = [buildHealIcon(), buildSpeedIcon(), buildPowerIcon()];
    for (let k = 0; k < KINDS; k++) {
      const im = new THREE.InstancedMesh(geos[k], this.iconMat, n);
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      for (let i = 0; i < n; i++) im.setMatrixAt(i, ZERO);
      im.frustumCulled = false;
      im.castShadow = false;
      im.visible = false;
      im.onBeforeRender = (_r, _s2, cam) => this.captureCamera(cam);
      this.root.add(im);
      this.icons.push(im);
    }

    // ── Ground ring: spinning dashed glow band on the pad ────────────────────
    const ringGeo = new THREE.RingGeometry(0.9, 1.42, 56, 1);
    ringGeo.rotateX(-Math.PI / 2);
    const ringMat = new THREE.ShaderMaterial({
      uniforms: this.ringU,
      vertexShader: INSTANCED_VS,
      fragmentShader: RING_FS,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.materials.push(ringMat);
    this.ring = new THREE.InstancedMesh(ringGeo, ringMat, n);
    this.initInstanced(this.ring);
    this.ring.renderOrder = 2;

    // ── Light column ─────────────────────────────────────────────────────────
    const colGeo = new THREE.CylinderGeometry(0.78, 1.02, COLUMN_H, 24, 1, true);
    colGeo.translate(0, COLUMN_H / 2 + 0.1, 0);
    const colMat = new THREE.ShaderMaterial({
      uniforms: this.columnU,
      vertexShader: INSTANCED_VS,
      fragmentShader: COLUMN_FS,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    this.materials.push(colMat);
    this.column = new THREE.InstancedMesh(colGeo, colMat, n);
    this.initInstanced(this.column);
    this.column.renderOrder = 3;

    // ── Rising kind-shaped sparkles (one Points draw for every pad) ──────────
    const count = n * SPARKS_PER_PAD;
    const sGeo = new THREE.BufferGeometry();
    sGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(count * 3), 3));
    const aPad = new Float32Array(count);
    const aSeed = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      aPad[i] = Math.floor(i / SPARKS_PER_PAD);
      const h = Math.sin((i + 1) * 12.9898) * 43758.5453;
      aSeed[i] = h - Math.floor(h);
    }
    sGeo.setAttribute('aPad', new THREE.Float32BufferAttribute(aPad, 1));
    sGeo.setAttribute('aSeed', new THREE.Float32BufferAttribute(aSeed, 1));
    const padU: THREE.Vector4[] = [];
    for (let i = 0; i < Math.max(1, n); i++) padU.push(new THREE.Vector4(0, 0, 0, 0));
    this.sparkU = { uTime: { value: 0 }, uPx: { value: 600 }, uPad: { value: padU } };
    const sMat = new THREE.ShaderMaterial({
      uniforms: this.sparkU,
      vertexShader: sparkVS(n),
      fragmentShader: SPARK_FS,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.materials.push(sMat);
    this.sparks = new THREE.Points(sGeo, sMat);
    this.sparks.frustumCulled = false;
    this.sparks.visible = false;
    this.sparks.renderOrder = 4;
    this.sparks.onBeforeRender = (renderer, _s2, cam) => {
      renderer.getDrawingBufferSize(_v2);
      const fov = cam instanceof THREE.PerspectiveCamera ? cam.fov : 50;
      this.sparkU.uPx.value = _v2.y / (2 * Math.tan((fov * Math.PI) / 360));
    };
    this.root.add(this.sparks);

    // ── Proximity labels ─────────────────────────────────────────────────────
    for (let k = 0; k < KINDS; k++) this.labelTex.push(makeLabelTexture(LABELS[k].text, LABELS[k].color, LABELS[k].glow));
    for (let i = 0; i < n; i++) {
      const mat = new THREE.SpriteMaterial({ map: this.labelTex[0], transparent: true, depthWrite: false, opacity: 0 });
      this.materials.push(mat);
      const sp = new THREE.Sprite(mat);
      sp.scale.set(1.5, 0.47, 1);
      sp.position.set(pads[i].x, LABEL_Y, pads[i].z);
      sp.visible = false;
      sp.renderOrder = 5;
      this.root.add(sp);
      this.labels.push(sp);
    }
  }

  private initInstanced(im: THREE.InstancedMesh): void {
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < this.pads.length; i++) {
      im.setMatrixAt(i, ZERO);
      im.setColorAt(i, RING_COLORS[0]);
    }
    im.frustumCulled = false;
    im.castShadow = false;
    im.receiveShadow = false;
    im.visible = false;
    this.root.add(im);
  }

  private captureCamera(cam: THREE.Camera): void {
    if (!(cam instanceof THREE.PerspectiveCamera)) return;
    const e = cam.matrixWorld.elements;
    this.camPos.set(e[12], e[13], e[14]);
    this.camDir.set(-e[8], 0, -e[10]);
    if (this.camDir.lengthSq() < 1e-6) this.camDir.set(0, 0, -1);
    this.camDir.normalize();
    this.camValid = true;
  }

  /** Show (or hide) pad `pad`'s icon of kind index `k` (0 heal, 1 speed, 2 rage). */
  setVisible(pad: number, k: number, visible: boolean): void {
    if (pad < 0 || pad >= this.pads.length || k < 0 || k >= KINDS) return;
    if (visible) {
      if (this.kind[pad] !== k) {
        this.appear[pad] = 0;
        this.labelA[pad] = 0;
      }
      this.kind[pad] = k;
      this.lastKind[pad] = k;
      const col = this.ring.instanceColor;
      this.ring.setColorAt(pad, RING_COLORS[k]);
      this.column.setColorAt(pad, COLUMN_COLORS[k]);
      if (col !== null) col.needsUpdate = true;
      if (this.column.instanceColor !== null) this.column.instanceColor.needsUpdate = true;
      this.labels[pad].material.map = this.labelTex[k];
      this.labels[pad].material.needsUpdate = true;
    } else if (this.kind[pad] === k) {
      this.kind[pad] = -1;
    }
  }

  /**
   * Optional exact player position for the proximity labels. When not fed
   * (or stale), the player is estimated ≈5.5 m ahead of the chase camera.
   */
  setFocus(x: number, z: number): void {
    this.focus.set(x, z);
    this.focusAge = 0;
  }

  setTier(tier: QualityTier): void {
    this.tier = tier;
    const n = this.pads.length * SPARKS_PER_PAD;
    this.sparks.geometry.setDrawRange(0, tier === 'high' ? n : Math.floor(n / 2));
  }

  update(dt: number, time: number): void {
    this.ringU.uTime.value = time;
    this.columnU.uTime.value = time;
    this.sparkU.uTime.value = time;
    this.focusAge += dt;

    // Where is the player? Exact focus if fed, else ahead of the camera.
    let haveViewer = false;
    if (this.focusAge < 0.6) {
      this.viewer.set(this.focus.x, 0, this.focus.y);
      haveViewer = true;
    } else if (this.camValid) {
      this.viewer.copy(this.camPos).addScaledVector(this.camDir, CAM_TO_PLAYER);
      haveViewer = true;
    }

    let anyIcon0 = false;
    let anyIcon1 = false;
    let anyIcon2 = false;
    let any = false;
    const pads = this.pads;
    const padU = this.sparkU.uPad.value;
    for (let i = 0; i < pads.length; i++) {
      const k = this.kind[i];
      const lk = this.lastKind[i];
      const pad = pads[i];
      if (k >= 0) this.appear[i] = Math.min(1, this.appear[i] + dt * 2.6);
      else this.appear[i] = Math.max(0, this.appear[i] - dt * 7);
      const a = this.appear[i];
      const live = a > 0 && lk >= 0;

      // Icon: bob + camera-facing yaw with a lazy rock; overshoot pop-in.
      if (live) {
        const bob = Math.sin(time * 2 + i * 1.1) * 0.12;
        let yaw = time * 0.8 + i;
        if (this.camValid) yaw = Math.atan2(this.camPos.x - pad.x, this.camPos.z - pad.z);
        yaw += Math.sin(time * 1.25 + i * 0.7) * 0.42;
        const s = (k >= 0 ? easeOutBack(a) : a) * ICON_SCALE;
        _q.setFromAxisAngle(_up, yaw);
        _p.set(pad.x, ICON_Y + bob, pad.z);
        _s.set(s, s, s);
        _m.compose(_p, _q, _s);
        for (let kk = 0; kk < KINDS; kk++) this.icons[kk].setMatrixAt(i, kk === lk ? _m : ZERO);
        if (lk === 0) anyIcon0 = true;
        else if (lk === 1) anyIcon1 = true;
        else anyIcon2 = true;
        any = true;

        // Ground ring (grows in) + column (rises in).
        const rs = smooth01(a);
        _q.setFromAxisAngle(_up, time * 0.6 + i);
        _p.set(pad.x, 0.118, pad.z);
        _s.set(rs, 1, rs);
        _m.compose(_p, _q, _s);
        this.ring.setMatrixAt(i, _m);
        _q.identity();
        _p.set(pad.x, 0, pad.z);
        _s.set(1, rs, 1);
        _m.compose(_p, _q, _s);
        this.column.setMatrixAt(i, _m);
        padU[i].set(pad.x, pad.z, rs, lk);
        this.labels[i].position.y = LABEL_Y + bob;
      } else {
        for (let kk = 0; kk < KINDS; kk++) this.icons[kk].setMatrixAt(i, ZERO);
        this.ring.setMatrixAt(i, ZERO);
        this.column.setMatrixAt(i, ZERO);
        if (i < padU.length) padU[i].z = 0;
      }

      // Proximity label.
      let target = 0;
      if (k >= 0 && a > 0.6 && haveViewer) {
        const d = Math.hypot(this.viewer.x - pad.x, this.viewer.z - pad.z);
        target = 1 - smooth01((d - LABEL_NEAR) / (LABEL_FAR - LABEL_NEAR));
      }
      this.labelA[i] += (target - this.labelA[i]) * Math.min(1, dt * 7);
      if (this.labelA[i] < 0.01 && target === 0) this.labelA[i] = 0;
      const lab = this.labels[i];
      lab.visible = this.labelA[i] > 0.01;
      lab.material.opacity = this.labelA[i];
    }

    this.icons[0].visible = anyIcon0;
    this.icons[1].visible = anyIcon1;
    this.icons[2].visible = anyIcon2;
    for (let kk = 0; kk < KINDS; kk++) if (this.icons[kk].visible) this.icons[kk].instanceMatrix.needsUpdate = true;
    this.ring.visible = any;
    this.column.visible = any && this.tier !== 'low';
    this.sparks.visible = any && this.tier !== 'low';
    if (any) {
      this.ring.instanceMatrix.needsUpdate = true;
      this.column.instanceMatrix.needsUpdate = true;
    }
  }

  dispose(): void {
    for (const im of this.icons) im.geometry.dispose();
    this.ring.geometry.dispose();
    this.column.geometry.dispose();
    this.sparks.geometry.dispose();
    for (const m of this.materials) m.dispose();
    for (const t of this.labelTex) t.dispose();
    this.root.removeFromParent();
  }
}

// ── Shaders ──────────────────────────────────────────────────────────────────

const INSTANCED_VS = /* glsl */ `
varying vec3 vLocal;
varying vec3 vCol;
void main() {
  vLocal = position;
  vec4 p = vec4(position, 1.0);
  #ifdef USE_INSTANCING
  p = instanceMatrix * p;
  #endif
  #ifdef USE_INSTANCING_COLOR
  vCol = instanceColor;
  #else
  vCol = vec3(1.0);
  #endif
  gl_Position = projectionMatrix * modelViewMatrix * p;
}`;

const RING_FS = /* glsl */ `
uniform float uTime;
varying vec3 vLocal;
varying vec3 vCol;
void main() {
  float r = length(vLocal.xz);
  float a = atan(vLocal.z, vLocal.x);
  float band = smoothstep(0.9, 1.0, r) * (1.0 - smoothstep(1.3, 1.42, r));
  float dash = 0.45 + 0.55 * step(0.38, fract(a * 1.9098593 + uTime * 0.35));
  float edge = smoothstep(1.16, 1.2, r) * (1.0 - smoothstep(1.2, 1.26, r)) * 0.6;
  float pulse = 0.82 + 0.18 * sin(uTime * 3.2);
  float alpha = clamp((band * dash * 0.85 + edge) * pulse, 0.0, 1.0);
  // Normal blend (reads as a colour on bright sand); HDR boost still blooms.
  gl_FragColor = vec4(vCol * (1.1 + 0.5 * edge), alpha * 0.92);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const COLUMN_FS = /* glsl */ `
uniform float uTime;
varying vec3 vLocal;
varying vec3 vCol;
void main() {
  float h = clamp((vLocal.y - 0.1) / ${COLUMN_H.toFixed(1)}, 0.0, 1.0);
  float a = atan(vLocal.z, vLocal.x);
  float fade = pow(1.0 - h, 2.2) * smoothstep(0.0, 0.04, h);
  float streak = 0.55 + 0.45 * sin(a * 7.0 + uTime * 1.6 + h * 5.0);
  float rise = 0.75 + 0.25 * sin(h * 18.0 - uTime * 4.0);
  float alpha = fade * streak * rise * 0.26;
  gl_FragColor = vec4(vCol * alpha, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const sparkVS = (pads: number): string => /* glsl */ `
attribute float aPad;
attribute float aSeed;
uniform float uTime;
uniform float uPx;
uniform vec4 uPad[${Math.max(1, pads)}];
varying vec3 vCol;
varying float vA;
varying float vKind;
void main() {
  vec4 pad = uPad[int(aPad + 0.5)];
  float kind = pad.w;
  float speed = kind < 0.5 ? 0.3 : (kind < 1.5 ? 1.05 : 0.55);
  float h = fract(uTime * speed + aSeed * 7.13);
  float ang = aSeed * 43.7 + uTime * (kind < 1.5 ? 0.5 : 1.3);
  float rad = 0.3 + fract(aSeed * 13.1) * 0.8;
  vec3 p = vec3(pad.x + cos(ang) * rad, 0.25 + h * 3.3, pad.y + sin(ang) * rad);
  if (kind > 1.5) p.x += sin(uTime * 7.0 + aSeed * 20.0) * 0.07;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float size = kind < 0.5 ? 0.24 : (kind < 1.5 ? 0.34 : 0.15);
  gl_PointSize = max(1.0, size * uPx / max(0.5, -mv.z));
  vA = pad.z * sin(h * 3.14159);
  if (kind > 1.5) vA *= 0.65 + 0.35 * sin(uTime * 17.0 + aSeed * 31.0);
  vKind = kind;
  vCol = kind < 0.5 ? vec3(0.45, 1.5, 0.6) : (kind < 1.5 ? vec3(0.55, 1.45, 1.7) : vec3(1.7, 0.55, 0.16));
}`;

const SPARK_FS = /* glsl */ `
varying vec3 vCol;
varying float vA;
varying float vKind;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float m;
  if (vKind < 0.5) {
    vec2 q = abs(c);
    m = (1.0 - smoothstep(0.07, 0.12, min(q.x, q.y))) * (1.0 - smoothstep(0.36, 0.46, max(q.x, q.y)));
  } else if (vKind < 1.5) {
    m = (1.0 - smoothstep(0.03, 0.09, abs(c.x))) * (1.0 - smoothstep(0.18, 0.5, abs(c.y)));
  } else {
    m = 1.0 - smoothstep(0.08, 0.5, length(c));
  }
  float a = m * vA;
  if (a < 0.01) discard;
  gl_FragColor = vec4(vCol * a, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// ── Icon geometry (init-time only) ───────────────────────────────────────────

function hdr(hex: number, k: number): THREE.Color {
  return new THREE.Color(hex).multiplyScalar(k);
}

function extrude(shape: THREE.Shape, depth: number, bevel = 0.016): THREE.BufferGeometry {
  const g = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 1,
    curveSegments: 5,
  });
  g.translate(0, 0, -depth / 2);
  g.deleteAttribute('uv');
  return g;
}

function at(x: number, y: number, z: number, rotZ = 0, s = 1): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), rotZ),
    new THREE.Vector3(s, s, s),
  );
}

/** Shared medallion: coloured ring + dark face disc (faces +z). */
function medallion(acc: GeoAccumulator, ring: THREE.Color, face: number): void {
  acc.add(new THREE.TorusGeometry(0.6, 0.068, 7, 36), ring);
  const disc = new THREE.CylinderGeometry(0.575, 0.575, 0.05, 32);
  disc.rotateX(Math.PI / 2);
  acc.add(disc, face);
}

function crossShape(w: number, l: number): THREE.Shape {
  const s = new THREE.Shape();
  s.moveTo(-w, l);
  s.lineTo(w, l);
  s.lineTo(w, w);
  s.lineTo(l, w);
  s.lineTo(l, -w);
  s.lineTo(w, -w);
  s.lineTo(w, -l);
  s.lineTo(-w, -l);
  s.lineTo(-w, -w);
  s.lineTo(-l, -w);
  s.lineTo(-l, w);
  s.lineTo(-w, w);
  s.closePath();
  return s;
}

/** HEAL: big green cross with a white-hot core on a warm gold ring. */
function buildHealIcon(): THREE.BufferGeometry {
  const acc = new GeoAccumulator();
  medallion(acc, hdr(0xffc24a, 1.25), 0x0c3b1b);
  acc.add(extrude(crossShape(0.15, 0.43), 0.16), hdr(0x39ff6c, 1.7));
  acc.add(extrude(crossShape(0.07, 0.33), 0.2, 0.01), hdr(0xeafff0, 1.5));
  return acc.buildGeometry();
}

/** SPEED: electric-yellow lightning bolt on a cyan ring + speed streaks. */
function buildSpeedIcon(): THREE.BufferGeometry {
  const acc = new GeoAccumulator();
  medallion(acc, hdr(0x3fe6ff, 1.3), 0x082a40);
  const bolt = new THREE.Shape();
  bolt.moveTo(0.06, 0.46);
  bolt.lineTo(0.3, 0.46);
  bolt.lineTo(0.08, 0.09);
  bolt.lineTo(0.25, 0.09);
  bolt.lineTo(-0.18, -0.5);
  bolt.lineTo(-0.02, -0.05);
  bolt.lineTo(-0.22, -0.05);
  bolt.closePath();
  acc.add(extrude(bolt, 0.14), hdr(0x3fe6ff, 1.2), at(0.0, 0.0, 0.0, 0, 1.12));
  acc.add(extrude(bolt, 0.18, 0.01), hdr(0xfff04a, 1.8), at(-0.02, 0.0, 0.0, 0, 0.98));
  // Trailing streaks outside the ring (reads as motion).
  const streaks: readonly [number, number][] = [[0.24, 0.3], [0.02, 0.46], [-0.2, 0.32]];
  for (const [y, len] of streaks) {
    const g = new THREE.CapsuleGeometry(0.035, len, 2, 6);
    g.rotateZ(Math.PI / 2);
    acc.add(g, hdr(0x7af2ff, 1.5), at(-0.74 - len * 0.5 - (y === 0.02 ? 0.02 : 0.06), y, 0));
  }
  return acc.buildGeometry();
}

/** POWER: crossed white-hot swords on a red ring crowned with flames. */
function buildPowerIcon(): THREE.BufferGeometry {
  const acc = new GeoAccumulator();
  medallion(acc, hdr(0xff3a1e, 1.4), 0x2c0707);
  const blade = new THREE.Shape();
  blade.moveTo(-0.05, -0.16);
  blade.lineTo(0.05, -0.16);
  blade.lineTo(0.05, 0.36);
  blade.lineTo(0, 0.47);
  blade.lineTo(-0.05, 0.36);
  blade.closePath();
  for (const rz of [0.72, -0.72]) {
    const rot = (x: number, y: number): THREE.Matrix4 => {
      const c = Math.cos(rz);
      const s = Math.sin(rz);
      return at(x * c - y * s, x * s + y * c, 0, rz);
    };
    acc.add(extrude(blade, 0.07, 0.012), hdr(0xfff1e0, 1.45), rot(0, 0));
    acc.add(new THREE.BoxGeometry(0.3, 0.06, 0.1), hdr(0xffb830, 1.2), rot(0, -0.19));
    acc.add(new THREE.BoxGeometry(0.06, 0.15, 0.07), 0x4a1a10, rot(0, -0.3));
    acc.add(new THREE.SphereGeometry(0.048, 6, 4), hdr(0xffb830, 1.2), rot(0, -0.4));
  }
  // Flame crown above the ring.
  const flame = new THREE.Shape();
  flame.moveTo(-0.12, 0);
  flame.quadraticCurveTo(-0.15, 0.19, 0.02, 0.4);
  flame.quadraticCurveTo(0.0, 0.21, 0.12, 0);
  flame.closePath();
  const tongues: readonly [number, number][] = [[-0.62, 0.78], [0, 1.08], [0.62, 0.78]];
  for (const [ang, s] of tongues) {
    const x = Math.sin(ang) * 0.6;
    const y = Math.cos(ang) * 0.6;
    acc.add(extrude(flame, 0.08, 0.01), hdr(0xff5a18, 1.8), at(x, y - 0.04, -0.01, -ang, s));
    acc.add(extrude(flame, 0.11, 0.0), hdr(0xffd23a, 1.9), at(x, y - 0.02, 0, -ang, s * 0.55));
  }
  return acc.buildGeometry();
}

// ── Label texture ────────────────────────────────────────────────────────────

function makeLabelTexture(text: string, color: string, glow: string): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 80;
  const g = c.getContext('2d');
  if (g !== null) {
    const r = 30;
    g.beginPath();
    g.moveTo(8 + r, 8);
    g.lineTo(248 - r, 8);
    g.arc(248 - r, 40, r + 2, -Math.PI / 2, Math.PI / 2);
    g.lineTo(8 + r, 72);
    g.arc(8 + r, 40, r + 2, Math.PI / 2, (Math.PI * 3) / 2);
    g.closePath();
    g.fillStyle = 'rgba(14, 10, 7, 0.82)';
    g.fill();
    g.lineWidth = 4;
    g.strokeStyle = glow;
    g.stroke();
    g.font = '800 42px system-ui, "Segoe UI", Arial, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const ls = g as unknown as { letterSpacing?: string };
    if (typeof ls.letterSpacing === 'string') ls.letterSpacing = '4px';
    g.shadowColor = glow;
    g.shadowBlur = 14;
    g.fillStyle = color;
    g.fillText(text, 128, 42);
    g.shadowBlur = 0;
    g.fillText(text, 128, 42);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}
