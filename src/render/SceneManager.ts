/**
 * SceneManager (BLUEPRINT §11.1, upgraded in v1.1 WP-K) — the three.js scene
 * shell for the match.
 *
 * Owns: WebGLRenderer on the existing fullscreen canvas, PerspectiveCamera
 * (positioned by the CameraRig), warm lighting — hemisphere light plus ONE
 * shadowed directional sun (2048 map at medium/high, 1024 at low) — warm fog,
 * a gradient sky dome with drifting soft clouds and a low golden sun, resize
 * handling, the shared `excitement` value (0–1), and the post-processing
 * pipeline with quality tiers:
 *
 *   low    → renderer direct (ACES tone mapping), no composer
 *   medium → RenderPass → Grade (warm grade + vignette) → OutputPass (ACES+sRGB)
 *   high   → RenderPass → Grade → UnrealBloom (high threshold) → OutputPass
 *
 * Objects on layer {@link OVERLAY_LAYER} (damage numbers) are drawn in a final
 * untonemapped overlay pass so they stay crisp and never bloom.
 *
 * Quality API (for the Settings UI): `setQuality('auto'|'low'|'medium'|'high')`,
 * `getQuality()`, `getQualityTier()`; the module-level equivalents in
 * `render/quality.ts` work with no SceneManager alive.
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import {
  autoDowngrade,
  getQualitySetting,
  getQualityTier,
  onQualityChange,
  setQualitySetting,
  tierProfile,
  type QualitySetting,
  type QualityTier,
} from './quality';

/** Layer drawn after post-processing, untonemapped (damage numbers). */
export const OVERLAY_LAYER = 2;

/** World position of the sun light (direction source for sky + light shafts). */
export const SUN_POSITION: Readonly<{ x: number; y: number; z: number }> = { x: 46, y: 34, z: 24 };

const AUTO_FPS_MIN = 45;
const AUTO_SLOW_SECONDS = 3;
const AUTO_WARMUP = 2.5;

const SKY_VERTEX = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const SKY_FRAGMENT = /* glsl */ `
uniform vec3 uTop;
uniform vec3 uHorizon;
uniform vec3 uBottom;
uniform vec3 uSunColor;
uniform vec3 uSunDir;
uniform vec3 uCloudLit;
uniform vec3 uCloudShade;
uniform float uClouds;
uniform float uTime;
varying vec3 vWorld;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float fbm(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    s += a * vnoise(p);
    p = p * 2.03 + vec2(17.1, 9.2);
    a *= 0.5;
  }
  return s;
}

void main() {
  vec3 d = normalize(vWorld);
  float h = d.y;
  vec3 col = mix(uHorizon, uTop, smoothstep(0.0, 0.55, h));
  col = mix(uBottom, col, smoothstep(-0.12, 0.02, h));
  float s = max(dot(d, uSunDir), 0.0);
  // Warm glow toward the sun (wide) + a hot disc that the bloom picks up.
  col += uSunColor * (pow(s, 900.0) * 6.0 + pow(s, 60.0) * 0.35 + pow(s, 6.0) * 0.16);
  if (uClouds > 0.5 && h > 0.0) {
    vec2 p = d.xz / (h + 0.12) * 0.9;
    p += vec2(uTime * 0.012, uTime * 0.004);
    float n = fbm(p);
    float m = smoothstep(0.5, 0.78, n) * smoothstep(0.02, 0.22, h) * (1.0 - smoothstep(0.75, 0.98, h));
    float lit = 0.55 + 0.45 * pow(s, 3.0);
    vec3 cc = mix(uCloudShade, uCloudLit, clamp(lit + (n - 0.6) * 1.4, 0.0, 1.0));
    col = mix(col, cc, m * 0.8);
  }
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** Warm color grade + vignette (runs on linear HDR, before OutputPass). */
const GRADE_SHADER = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uAspect: { value: 16 / 9 },
    uVignette: { value: 0.32 },
    uWarm: { value: 1 },
    uSat: { value: 1.08 },
    uLift: { value: new THREE.Vector3(0.012, 0.007, 0.0) },
  },
  vertexShader: /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`,
  fragmentShader: /* glsl */ `
uniform sampler2D tDiffuse;
uniform float uAspect;
uniform float uVignette;
uniform float uWarm;
uniform float uSat;
uniform vec3 uLift;
varying vec2 vUv;
void main() {
  vec4 c = texture2D(tDiffuse, vUv);
  vec3 col = c.rgb;
  // Sanitize: a single NaN/Inf texel would otherwise be smeared into blocks
  // by the bloom blur chain (min/max return the non-NaN operand on D3D/GL).
  col = min(max(col, vec3(0.0)), vec3(24.0));
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = max(mix(vec3(l), col, uSat), 0.0);
  // Gentle warm grade: warmer mids/highs, a touch of amber lift in shadows.
  col *= mix(vec3(1.0), vec3(1.05, 1.0, 0.91), uWarm);
  col += uLift * (1.0 - smoothstep(0.0, 0.35, l));
  vec2 d = vUv - 0.5;
  d.x *= uAspect;
  float v = smoothstep(0.98, 0.32, length(d));
  col *= mix(1.0 - uVignette, 1.0, v);
  gl_FragColor = vec4(col, c.a);
}
`,
};

export class SceneManager {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;

  /**
   * Crowd/match excitement, 0–1. Match systems (WP-I) raise it on kills/ults
   * and decay it; the stadium crowd bob amplitude and audio follow it.
   */
  excitement = 0;

  private readonly skyMaterial: THREE.ShaderMaterial;
  private readonly skyMesh: THREE.Mesh;
  private readonly handleResize = (): void => {
    this.resize();
  };

  private tier: QualityTier;
  private composer: EffectComposer | null = null;
  private bloomPass: UnrealBloomPass | null = null;
  private gradePass: ShaderPass | null = null;
  private readonly unsubscribe: () => void;

  // Frame timing / auto quality.
  private lastNow = -1;
  private time = 0;
  private warmup = AUTO_WARMUP;
  private bucketT = 0;
  private bucketFrames = 0;
  private slowBuckets = 0;
  private fps = 60;
  private disposed = false;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // Shadows re-render once per frame (not again for the overlay pass).
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.12;
    // Stats cover every pass of a frame (reset manually in render()).
    this.renderer.info.autoReset = false;

    this.camera = new THREE.PerspectiveCamera(55, 1, 0.1, 400);
    this.camera.position.set(0, 14, -26);
    this.camera.lookAt(0, 1, 0);

    // Warm haze: barely touches the arena, softens the far stands.
    this.scene.fog = new THREE.Fog(0xe9c08c, 60, 185);

    // §11.1 lighting: hemisphere + one shadowed directional sun (golden hour).
    const hemi = new THREE.HemisphereLight(0xffe6bf, 0x6e5536, 1.2);
    this.scene.add(hemi);
    this.hemi = hemi;

    const sun = new THREE.DirectionalLight(0xffd9a8, 2.35);
    sun.position.set(SUN_POSITION.x, SUN_POSITION.y, SUN_POSITION.z);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = -34;
    sc.right = 34;
    sc.top = 34;
    sc.bottom = -34;
    sc.near = 10;
    sc.far = 150;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.12;
    this.scene.add(sun);
    this.scene.add(sun.target);
    this.sun = sun;

    // Gradient sky dome with clouds (fog-exempt, drawn first).
    this.skyMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uTop: { value: new THREE.Color(0x4f86c0) },
        uHorizon: { value: new THREE.Color(0xffd7a0) },
        uBottom: { value: new THREE.Color(0xb98e5f) },
        uSunColor: { value: new THREE.Color(0xffe2b0) },
        uSunDir: { value: sun.position.clone().normalize() },
        uCloudLit: { value: new THREE.Color(0xfff1dc) },
        uCloudShade: { value: new THREE.Color(0xc9a58a) },
        uClouds: { value: 1 },
        uTime: { value: 0 },
      },
      vertexShader: SKY_VERTEX,
      fragmentShader: SKY_FRAGMENT,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });
    this.skyMesh = new THREE.Mesh(new THREE.SphereGeometry(190, 32, 16), this.skyMaterial);
    this.skyMesh.renderOrder = -10;
    this.skyMesh.frustumCulled = false;
    this.scene.add(this.skyMesh);

    this.tier = getQualityTier();
    this.applyTier(this.tier, true);
    this.unsubscribe = onQualityChange((t) => {
      if (!this.disposed && t !== this.tier) this.applyTier(t, false);
    });

    this.resize();
    window.addEventListener('resize', this.handleResize);
    // Debug/QA handle (perf readouts from the console): window.__gkSceneManager.getStats()
    (window as unknown as { __gkSceneManager?: SceneManager }).__gkSceneManager = this;
  }

  // ── Quality API ────────────────────────────────────────────────────────────

  /** Change the graphics setting (persists to `localStorage['gk-quality']`). */
  setQuality(q: QualitySetting): void {
    setQualitySetting(q);
  }

  /** The user-facing setting: `'auto'` or a fixed tier. */
  getQuality(): QualitySetting {
    return getQualitySetting();
  }

  /** The tier currently rendered (auto resolves to high/medium/low). */
  getQualityTier(): QualityTier {
    return this.tier;
  }

  /** Smoothed frames per second measured over the last full second. */
  getFps(): number {
    return this.fps;
  }

  // ── Frame ──────────────────────────────────────────────────────────────────

  /** Match the drawing buffer + camera aspect to the current window size. */
  resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const pr = Math.min(window.devicePixelRatio || 1, tierProfile(this.tier).pixelRatioCap);
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
    if (this.composer !== null) {
      this.composer.setPixelRatio(pr);
      this.composer.setSize(w, h);
    }
    if (this.gradePass !== null) {
      (this.gradePass.uniforms.uAspect as THREE.IUniform<number>).value = w / Math.max(1, h);
    }
  }

  render(): void {
    const now = performance.now();
    let dt = 1 / 60;
    if (this.lastNow >= 0) {
      dt = (now - this.lastNow) / 1000;
      if (dt > 0 && dt < 0.5 && !document.hidden) this.sampleFrame(dt);
      if (dt > 0.1) dt = 0.1;
    }
    this.lastNow = now;
    this.time += dt;
    (this.skyMaterial.uniforms.uTime as THREE.IUniform<number>).value = this.time;

    const r = this.renderer;
    r.info.reset();
    r.shadowMap.needsUpdate = true;
    if (this.composer !== null) {
      this.composer.render(dt);
    } else {
      r.render(this.scene, this.camera);
    }
    // Overlay (damage numbers): untonemapped, unbloomed, on top of everything.
    const mask = this.camera.layers.mask;
    this.camera.layers.set(OVERLAY_LAYER);
    const autoClear = r.autoClear;
    r.autoClear = false;
    r.render(this.scene, this.camera);
    r.autoClear = autoClear;
    this.camera.layers.mask = mask;
  }

  /** Last-frame renderer stats (valid after `render()`), for budget checks. */
  getStats(): { drawCalls: number; triangles: number; fps: number; tier: QualityTier } {
    const i = this.renderer.info.render;
    return { drawCalls: i.calls, triangles: i.triangles, fps: this.fps, tier: this.tier };
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe();
    const w = window as unknown as { __gkSceneManager?: SceneManager };
    if (w.__gkSceneManager === this) w.__gkSceneManager = undefined;
    window.removeEventListener('resize', this.handleResize);
    this.disposeComposer();
    this.skyMesh.geometry.dispose();
    this.skyMaterial.dispose();
    this.renderer.dispose();
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private sampleFrame(dt: number): void {
    this.bucketT += dt;
    this.bucketFrames++;
    if (this.bucketT < 1) return;
    this.fps = this.bucketFrames / this.bucketT;
    this.bucketT = 0;
    this.bucketFrames = 0;
    if (this.warmup > 0) {
      this.warmup -= 1;
      this.slowBuckets = 0;
      return;
    }
    if (getQualitySetting() !== 'auto') {
      this.slowBuckets = 0;
      return;
    }
    this.slowBuckets = this.fps < AUTO_FPS_MIN ? this.slowBuckets + 1 : 0;
    if (this.slowBuckets >= AUTO_SLOW_SECONDS) {
      this.slowBuckets = 0;
      this.warmup = AUTO_WARMUP; // let the new tier settle before judging again
      autoDowngrade();
    }
  }

  private applyTier(tier: QualityTier, initial: boolean): void {
    this.tier = tier;
    const prof = tierProfile(tier);
    (this.skyMaterial.uniforms.uClouds as THREE.IUniform<number>).value = prof.skyClouds ? 1 : 0;

    // Shadow map resolution (dispose so it is re-allocated at the new size).
    if (this.sun.shadow.mapSize.x !== prof.shadowMapSize) {
      this.sun.shadow.mapSize.set(prof.shadowMapSize, prof.shadowMapSize);
      if (this.sun.shadow.map !== null) {
        this.sun.shadow.map.dispose();
        this.sun.shadow.map = null;
      }
    }

    this.disposeComposer();
    if (prof.composer) this.buildComposer(prof.msaaSamples, prof.bloom);
    if (!initial) this.resize();
    this.warmup = AUTO_WARMUP;
  }

  private buildComposer(samples: number, bloom: boolean): void {
    const w = Math.max(1, window.innerWidth);
    const h = Math.max(1, window.innerHeight);
    const pr = Math.min(window.devicePixelRatio || 1, tierProfile(this.tier).pixelRatioCap);
    const rt = new THREE.WebGLRenderTarget(Math.floor(w * pr), Math.floor(h * pr), {
      type: THREE.HalfFloatType,
      samples,
    });
    const composer = new EffectComposer(this.renderer, rt);
    composer.setPixelRatio(pr);
    composer.setSize(w, h);
    composer.addPass(new RenderPass(this.scene, this.camera));
    // Grade first: it also sanitizes NaN/Inf texels before the bloom blur.
    this.gradePass = new ShaderPass(GRADE_SHADER);
    (this.gradePass.uniforms.uAspect as THREE.IUniform<number>).value = w / h;
    composer.addPass(this.gradePass);
    if (bloom) {
      // High threshold: only the sun disc, fire, sparks and ult flashes bloom.
      this.bloomPass = new UnrealBloomPass(new THREE.Vector2(w, h), 0.5, 0.5, 0.88);
      composer.addPass(this.bloomPass);
    }
    composer.addPass(new OutputPass());
    this.composer = composer;
  }

  private disposeComposer(): void {
    if (this.composer === null) return;
    for (const p of this.composer.passes) p.dispose();
    this.composer.renderTarget1.dispose();
    this.composer.renderTarget2.dispose();
    this.composer.dispose();
    this.composer = null;
    this.bloomPass = null;
    this.gradePass = null;
  }
}
