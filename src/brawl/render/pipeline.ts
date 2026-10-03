/**
 * Champions League render pipeline — a sibling of the Battle Royale `SceneManager` with the same
 * look (ACES + warm grade + vignette, UnrealBloom on `high`, `gk-quality` tiers), but sized from the
 * canvas, without the arena sky/shadow rig and with a screen-space overlay quad (KO flash + the
 * "danger" edge vignette) that works on every tier.
 *
 *   low    → renderer direct (ACES), no composer
 *   medium → RenderPass → Grade → OutputPass
 *   high   → RenderPass → Grade → UnrealBloom → OutputPass
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { getQualityTier, onQualityChange, tierProfile, type QualityTier } from '../../render/quality';

const GRADE_SHADER = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uAspect: { value: 16 / 9 },
    uVignette: { value: 0.3 },
    uSat: { value: 1.1 },
    uTint: { value: new THREE.Vector3(1.04, 1.0, 0.94) },
    uLift: { value: new THREE.Vector3(0.012, 0.007, 0.004) },
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
uniform float uSat;
uniform vec3 uTint;
uniform vec3 uLift;
varying vec2 vUv;
void main() {
  vec4 c = texture2D(tDiffuse, vUv);
  vec3 col = min(max(c.rgb, vec3(0.0)), vec3(24.0));
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = max(mix(vec3(l), col, uSat), 0.0);
  col *= uTint;
  col += uLift * (1.0 - smoothstep(0.0, 0.35, l));
  vec2 d = vUv - 0.5;
  d.x *= uAspect;
  float v = smoothstep(0.98, 0.32, length(d));
  col *= mix(1.0 - uVignette, 1.0, v);
  gl_FragColor = vec4(col, c.a);
}
`,
};

const OVERLAY_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const OVERLAY_FRAG = /* glsl */ `
uniform vec3 uFlash;
uniform float uFlashA;
uniform vec3 uDangerCol;
uniform vec4 uDanger; // left, right, top, bottom intensity 0..1
uniform float uAspect;
varying vec2 vUv;
void main() {
  vec2 p = vUv;
  // Danger glow hugging the screen edge nearest the blast zone (only when a fighter is close to it).
  float eL = (1.0 - smoothstep(0.0, 0.22, p.x)) * uDanger.x;
  float eR = (1.0 - smoothstep(0.0, 0.22, 1.0 - p.x)) * uDanger.y;
  float eT = (1.0 - smoothstep(0.0, 0.2 * uAspect, 1.0 - p.y)) * uDanger.z;
  float eB = (1.0 - smoothstep(0.0, 0.2 * uAspect, p.y)) * uDanger.w;
  float e = max(max(eL, eR), max(eT, eB));
  e = e * e;
  vec3 col = uDangerCol * e * 1.2 + uFlash * uFlashA;
  float a = clamp(e * 0.55 + uFlashA, 0.0, 1.0);
  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export interface PipelineStats {
  drawCalls: number;
  triangles: number;
  geometries: number;
  textures: number;
  programs: number;
  tier: QualityTier;
}

export interface PipelineOpts {
  /** CSS-pixel size source; default: the canvas' client size, falling back to the window. */
  getSize?: () => { w: number; h: number };
  /** Force a tier instead of following the `gk-quality` setting. */
  tier?: QualityTier;
}

export class BrawlPipeline {
  readonly scene = new THREE.Scene();
  readonly renderer: THREE.WebGLRenderer;
  readonly camera: THREE.PerspectiveCamera;

  /** Overlay uniforms (KO flash / danger edges), driven by the view. */
  readonly overlayUniforms = {
    uFlash: { value: new THREE.Color(1, 0.95, 0.85) },
    uFlashA: { value: 0 },
    uDangerCol: { value: new THREE.Color(1.0, 0.18, 0.12) },
    uDanger: { value: new THREE.Vector4(0, 0, 0, 0) },
    uAspect: { value: 16 / 9 },
  };

  private tier: QualityTier;
  private readonly forcedTier: QualityTier | null;
  private composer: EffectComposer | null = null;
  private bloom: UnrealBloomPass | null = null;
  private grade: ShaderPass | null = null;
  private readonly overlay: THREE.Mesh;
  private readonly unsubscribe: () => void;
  private readonly getSize: () => { w: number; h: number };
  private w = 1;
  private h = 1;
  private lastNow = -1;
  private fps = 60;
  private bucketT = 0;
  private bucketN = 0;
  private disposed = false;
  private readonly tintCache = new THREE.Vector3(1.04, 1.0, 0.94);

  constructor(
    canvas: HTMLCanvasElement,
    camera: THREE.PerspectiveCamera,
    opts: PipelineOpts = {},
  ) {
    this.camera = camera;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    this.renderer.info.autoReset = false;
    this.renderer.shadowMap.enabled = false;
    this.getSize =
      opts.getSize ??
      ((): { w: number; h: number } => {
        const cw = canvas.clientWidth;
        const ch = canvas.clientHeight;
        if (cw > 0 && ch > 0) return { w: cw, h: ch };
        return { w: window.innerWidth, h: window.innerHeight };
      });
    this.forcedTier = opts.tier ?? null;
    this.tier = this.forcedTier ?? getQualityTier();

    // Screen overlay quad (flash + danger edges), drawn last on top of the scene.
    const og = new THREE.PlaneGeometry(2, 2);
    const om = new THREE.ShaderMaterial({
      uniforms: this.overlayUniforms,
      vertexShader: OVERLAY_VERT,
      fragmentShader: OVERLAY_FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NormalBlending,
    });
    this.overlay = new THREE.Mesh(og, om);
    this.overlay.frustumCulled = false;
    this.overlay.renderOrder = 10_000;
    this.overlay.visible = false;
    this.scene.add(this.overlay);

    this.applyTier(this.tier);
    this.unsubscribe = onQualityChange((t) => {
      if (!this.disposed && this.forcedTier === null && t !== this.tier) this.applyTier(t);
    });
    this.resize();
  }

  getTier(): QualityTier {
    return this.tier;
  }

  setTier(t: QualityTier): void {
    if (t !== this.tier) this.applyTier(t);
  }

  getFps(): number {
    return this.fps;
  }

  /** Per-stage colour grade (tint multiplies the linear image; vignette 0..1). */
  setGrade(tint: readonly [number, number, number], vignette: number, sat = 1.1): void {
    this.tintCache.set(tint[0], tint[1], tint[2]);
    if (this.grade !== null) {
      (this.grade.uniforms.uTint.value as THREE.Vector3).copy(this.tintCache);
      (this.grade.uniforms.uVignette as THREE.IUniform<number>).value = vignette;
      (this.grade.uniforms.uSat as THREE.IUniform<number>).value = sat;
    }
    this.gradeVignette = vignette;
    this.gradeSat = sat;
  }
  private gradeVignette = 0.3;
  private gradeSat = 1.1;

  resize(): void {
    const { w, h } = this.getSize();
    this.w = Math.max(1, Math.floor(w));
    this.h = Math.max(1, Math.floor(h));
    const pr = Math.min(
      typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1,
      tierProfile(this.tier).pixelRatioCap,
    );
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(this.w, this.h, false);
    const aspect = this.w / this.h;
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    this.overlayUniforms.uAspect.value = aspect;
    if (this.composer !== null) {
      this.composer.setPixelRatio(pr);
      this.composer.setSize(this.w, this.h);
    }
    if (this.grade !== null) (this.grade.uniforms.uAspect as THREE.IUniform<number>).value = aspect;
  }

  get width(): number {
    return this.w;
  }
  get height(): number {
    return this.h;
  }

  render(): void {
    const now = performance.now();
    if (this.lastNow >= 0) {
      const dt = (now - this.lastNow) / 1000;
      if (dt > 0 && dt < 0.5) {
        this.bucketT += dt;
        this.bucketN++;
        if (this.bucketT >= 1) {
          this.fps = this.bucketN / this.bucketT;
          this.bucketT = 0;
          this.bucketN = 0;
        }
      }
    }
    this.lastNow = now;
    const u = this.overlayUniforms;
    const d = u.uDanger.value;
    this.overlay.visible = u.uFlashA.value > 0.002 || d.x > 0.01 || d.y > 0.01 || d.z > 0.01 || d.w > 0.01;
    this.renderer.info.reset();
    if (this.composer !== null) this.composer.render(1 / 60);
    else this.renderer.render(this.scene, this.camera);
  }

  stats(): PipelineStats {
    const i = this.renderer.info;
    return {
      drawCalls: i.render.calls,
      triangles: i.render.triangles,
      geometries: i.memory.geometries,
      textures: i.memory.textures,
      programs: i.programs ? i.programs.length : 0,
      tier: this.tier,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    this.disposeComposer();
    (this.overlay.material as THREE.Material).dispose();
    this.overlay.geometry.dispose();
    this.scene.remove(this.overlay);
    this.renderer.dispose();
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private applyTier(tier: QualityTier): void {
    this.tier = tier;
    const prof = tierProfile(tier);
    this.disposeComposer();
    if (prof.composer) this.buildComposer(prof.msaaSamples, prof.bloom);
    this.resize();
  }

  private buildComposer(samples: number, bloom: boolean): void {
    const w = Math.max(1, this.w);
    const h = Math.max(1, this.h);
    const pr = Math.min(
      typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1,
      tierProfile(this.tier).pixelRatioCap,
    );
    const rt = new THREE.WebGLRenderTarget(Math.floor(w * pr), Math.floor(h * pr), {
      type: THREE.HalfFloatType,
      samples,
    });
    const composer = new EffectComposer(this.renderer, rt);
    composer.setPixelRatio(pr);
    composer.setSize(w, h);
    composer.addPass(new RenderPass(this.scene, this.camera));
    this.grade = new ShaderPass(GRADE_SHADER);
    (this.grade.uniforms.uAspect as THREE.IUniform<number>).value = w / h;
    (this.grade.uniforms.uTint.value as THREE.Vector3).copy(this.tintCache);
    (this.grade.uniforms.uVignette as THREE.IUniform<number>).value = this.gradeVignette;
    (this.grade.uniforms.uSat as THREE.IUniform<number>).value = this.gradeSat;
    composer.addPass(this.grade);
    if (bloom) {
      this.bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.46, 0.55, 0.9);
      composer.addPass(this.bloom);
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
    this.bloom = null;
    this.grade = null;
  }
}
