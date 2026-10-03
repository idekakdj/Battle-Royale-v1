/**
 * Champions League 3D view (plan §5): `createBrawlView(canvas, config, opts?) → BrawlViewApi`.
 *
 * Owns the renderer/pipeline, the stage visual, the camera, the fighter rigs (via the pose layer), soft contact
 * shadows, the pooled VFX and the debug overlay. It reads snapshots only; the simulation is never touched. The FX clock
 * (camera, particles, scenery) may slow down for the KO moment; the rigs always run on the real frame time.
 */

import * as THREE from 'three';
import { getMoveset, getStage } from '../data';
import type { BrawlEvent, BrawlMatchConfig, BrawlSnapshot, BrawlViewApi, PlatformState, StageDef } from '../types';
import { getQualityTier, tierProfile, type QualityTier } from '../../render/quality';
import { BrawlCamera, makeCamTarget, type CamTarget } from './BrawlCamera';
import { BrawlPipeline, type PipelineStats } from './pipeline';
import { DebugBoxes } from './debugBoxes';
import { FighterFx, accentOf } from './fighterFx';
import { createBrawlRig, type BrawlRig } from './pose';
import { buildStageVisual, type StageVisual } from './stages';
import { ResourceBag, softDiscTexture } from './stages/common';
import { Vfx } from './vfx/Vfx';

export interface BrawlViewOpts {
  /** Force a quality tier (default: the `gk-quality` setting). */
  tier?: QualityTier;
  /** Disable camera shake (default: the OS reduce-motion preference). */
  reduceMotion?: boolean;
  /** Start with the debug overlay on. */
  debugBoxes?: boolean;
  /** CSS-pixel size source (default: canvas client size, then the window). */
  getSize?: () => { w: number; h: number };
}

export interface BrawlViewStats extends PipelineStats {
  fighters: number;
  vfxLive: number;
  fps: number;
  stageDrawables: number;
  /** CPU ms of the last frame: scene update (rigs, camera, VFX, stage) and the GL submit (`pipeline.render`). */
  updateMs: number;
  submitMs: number;
}

/** The view contract plus a few additive inspection hooks (QA / demo / tests). */
export interface BrawlView extends BrawlViewApi {
  readonly cam: BrawlCamera;
  readonly stage: StageDef;
  readonly vfx: Vfx;
  readonly scene: THREE.Scene;
  stats(): BrawlViewStats;
  getDebugBoxes(): boolean;
}

interface FighterView {
  rig: BrawlRig;
  fx: FighterFx;
  shadow: THREE.Mesh;
  shadowMat: THREE.MeshBasicMaterial;
  target: CamTarget;
  w: number;
  h: number;
  tipX: number;
  tipY: number;
  tipValid: boolean;
  swoosh: number;
}

const _tip = new THREE.Vector3();

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

class BrawlViewImpl implements BrawlView {
  readonly stage: StageDef;
  readonly cam: BrawlCamera;
  readonly vfx: Vfx;
  readonly scene: THREE.Scene;

  private readonly pipeline: BrawlPipeline;
  private readonly stageVis: StageVisual;
  private readonly fighters: FighterView[] = [];
  private readonly debug: DebugBoxes;
  private readonly bag = new ResourceBag();
  private readonly shadowGeo: THREE.PlaneGeometry;
  private readonly shadowTex: THREE.DataTexture;
  private readonly hemi: THREE.HemisphereLight;
  private readonly key: THREE.DirectionalLight;
  private readonly rim: THREE.DirectionalLight;
  private readonly platBuf: PlatformState[] = [];
  private readonly targets: CamTarget[] = [];
  private tier: QualityTier;
  private time = 0;
  private slow = 0;
  private flashDecay = 0;
  private first = true;
  private updateMs = 0;
  private submitMs = 0;
  private disposed = false;
  private readonly onResize = (): void => this.resize();

  constructor(
    canvas: HTMLCanvasElement,
    config: BrawlMatchConfig,
    opts: BrawlViewOpts,
  ) {
    this.stage = getStage(config.stage);
    this.tier = opts.tier ?? getQualityTier();
    this.cam = new BrawlCamera(this.stage);
    const reduce =
      opts.reduceMotion ??
      (typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)').matches : false);
    this.cam.reduceMotion = reduce;
    this.pipeline = new BrawlPipeline(canvas, this.cam.camera, { getSize: opts.getSize, tier: opts.tier });
    this.scene = this.pipeline.scene;
    this.cam.setAspect(this.pipeline.width / this.pipeline.height);

    // Stage + lighting
    this.stageVis = buildStageVisual(this.stage, this.tier);
    this.scene.add(this.stageVis.group);
    const su = this.stageVis.setup;
    this.scene.fog = new THREE.Fog(su.fog.color, su.fog.near, su.fog.far);
    this.hemi = new THREE.HemisphereLight(su.hemi.sky, su.hemi.ground, su.hemi.intensity);
    this.key = new THREE.DirectionalLight(su.key.color, su.key.intensity);
    this.key.position.set(...su.key.pos);
    this.rim = new THREE.DirectionalLight(su.rim.color, su.rim.intensity);
    this.rim.position.set(...su.rim.pos);
    this.scene.add(this.hemi, this.key, this.rim);
    this.pipeline.renderer.toneMappingExposure = su.exposure;
    this.pipeline.setGrade(su.grade.tint, su.grade.vignette, su.grade.sat);

    // VFX
    this.vfx = new Vfx();
    this.vfx.scale = tierProfile(this.tier).fxScale;
    this.scene.add(this.vfx.root);

    // Shadows (flat soft discs on the platform below each fighter)
    this.shadowGeo = this.bag.geo(new THREE.PlaneGeometry(1, 1));
    this.shadowGeo.rotateX(-Math.PI / 2);
    this.shadowTex = this.bag.tex(softDiscTexture(64, 1.3));

    // Fighters
    config.roster.forEach((r, i) => {
      const stats = getMoveset(r.animal).stats;
      const rig = createBrawlRig(r.animal);
      this.scene.add(rig.root);
      const fx = new FighterFx(rig, r.animal, this.vfx, this.scene, stats.width, stats.height);
      fx.padX = this.stage.respawn.x;
      fx.padY = this.stage.respawn.y;
      const shadowMat = this.bag.mat(
        new THREE.MeshBasicMaterial({
          map: this.shadowTex,
          color: su.shadow,
          transparent: true,
          opacity: 0.5,
          depthWrite: false,
          polygonOffset: true,
          polygonOffsetFactor: -2,
          polygonOffsetUnits: -2,
          fog: false,
        }),
      );
      const shadow = new THREE.Mesh(this.shadowGeo, shadowMat);
      shadow.renderOrder = 5;
      shadow.visible = false;
      this.scene.add(shadow);
      const target = makeCamTarget();
      {
        // Visual height of the rig at rest (the giraffe's neck reaches well above its hurtbox): keeps tall fighters in frame.
        const vb = new THREE.Box3().setFromObject(rig.root);
        target.top = Number.isFinite(vb.max.y) ? Math.min(Math.max(vb.max.y, stats.height), 4.6) : stats.height + 0.6;
      }
      this.targets.push(target);
      this.fighters.push({
        rig,
        fx,
        shadow,
        shadowMat,
        target,
        w: stats.width,
        h: stats.height,
        tipX: 0,
        tipY: 0,
        tipValid: false,
        swoosh: 0,
      });
      void i;
    });

    this.debug = new DebugBoxes(this.stage);
    this.scene.add(this.debug.lines);
    if (opts.debugBoxes === true) this.debug.setEnabled(true);

    this.applyTier(this.tier);
    // Compile every material up front (VFX pools, overlay, pads, debug lines are hidden until first use) so no
    // shader compile ever lands in the middle of a fight.
    try {
      this.pipeline.renderer.compile(this.scene, this.cam.camera);
    } catch {
      /* compile is only an optimisation */
    }
    if (typeof window !== 'undefined') window.addEventListener('resize', this.onResize);
  }

  // ── BrawlViewApi ───────────────────────────────────────────────────────────

  render(prev: BrawlSnapshot, cur: BrawlSnapshot, alpha: number, events: readonly BrawlEvent[], dtRender: number): void {
    if (this.disposed) return;
    const t0 = performance.now();
    const rdt = clamp(dtRender, 0, 0.1);
    const a = clamp(alpha, 0, 1);

    const t = this.pipeline.getTier();
    if (t !== this.tier) this.applyTier(t);

    // FX clock (slow-mo feel at a KO: camera, particles and scenery only).
    let ts = 1;
    if (this.slow > 0) {
      const k = this.slow / 0.3;
      ts = 0.3 + 0.7 * (1 - k * k);
      this.slow = Math.max(0, this.slow - rdt);
    }
    const fdt = rdt * ts;
    this.time += fdt;

    // Interpolated platforms
    this.interpPlatforms(prev, cur, a);

    // Fighters: place + camera targets
    const n = this.fighters.length;
    for (let i = 0; i < n; i++) {
      const fv = this.fighters[i];
      const cf = cur.fighters[i];
      if (cf === undefined) continue;
      const pf = prev.fighters[i] ?? null;
      fv.rig.update(cf, pf, a, rdt);
      let px = cf.pos.x;
      let py = cf.pos.y;
      if (pf !== null && pf.alive && cf.alive) {
        const dx = cf.pos.x - pf.pos.x;
        const dy = cf.pos.y - pf.pos.y;
        if (dx * dx + dy * dy < 9) {
          px = pf.pos.x + dx * a;
          py = pf.pos.y + dy * a;
        }
      }
      const tg = fv.target;
      tg.alive = cf.alive && cf.action !== 'ko';
      tg.x = px;
      tg.y = py;
      tg.vx = cf.vel.x;
      tg.vy = cf.vel.y;
      this.updateShadow(fv, cf.alive && cf.action !== 'ko', px, py);
    }

    // Events (before the per-fighter FX so flashes land on the right frame)
    this.handleEvents(events, cur);

    for (let i = 0; i < n; i++) {
      const cf = cur.fighters[i];
      if (cf === undefined) continue;
      const fv = this.fighters[i];
      fv.fx.update(cf, fv.target.x, fv.target.y, fdt, this.time);
      this.swooshTrail(fv, cf, fv.target.x, fv.target.y);
    }

    // Camera
    if (this.first) {
      this.cam.snap(this.targets, n);
      this.first = false;
    } else {
      this.cam.update(fdt, this.targets, n);
    }

    // Stage + VFX
    this.stageVis.update(this.platBuf, fdt, this.time, this.cam.camera);
    this.vfx.update(fdt);
    this.updateOverlay(cur, rdt);
    this.debug.update(cur);

    const t1 = performance.now();
    this.pipeline.render();
    this.updateMs = t1 - t0;
    this.submitMs = performance.now() - t1;
  }

  resize(): void {
    this.pipeline.resize();
    this.cam.setAspect(this.pipeline.width / this.pipeline.height);
  }

  setDebugBoxes(on: boolean): void {
    this.debug.setEnabled(on);
  }

  getDebugBoxes(): boolean {
    return this.debug.enabled;
  }

  project(x: number, y: number): { x: number; y: number; onScreen: boolean } {
    const out = { x: 0, y: 0, onScreen: false };
    this.cam.project(x, y, this.pipeline.width, this.pipeline.height, out);
    return out;
  }

  stats(): BrawlViewStats {
    const s = this.pipeline.stats();
    return { ...s, fighters: this.fighters.length, vfxLive: this.vfx.live, fps: this.pipeline.getFps(), stageDrawables: this.stageVis.countDrawables(), updateMs: this.updateMs, submitMs: this.submitMs };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (typeof window !== 'undefined') window.removeEventListener('resize', this.onResize);
    for (const fv of this.fighters) {
      fv.fx.dispose();
      // The skinned rigs keep a bone texture per skeleton on the GPU: release it too.
      fv.rig.root.traverse((o) => {
        const sm = o as THREE.SkinnedMesh;
        if (sm.isSkinnedMesh) sm.skeleton.dispose();
      });
      fv.rig.dispose();
      fv.shadow.removeFromParent();
    }
    this.fighters.length = 0;
    this.vfx.dispose();
    this.debug.dispose();
    this.stageVis.dispose();
    this.bag.dispose();
    this.scene.remove(this.hemi, this.key, this.rim);
    this.scene.fog = null;
    this.pipeline.dispose();
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private applyTier(t: QualityTier): void {
    this.tier = t;
    this.vfx.scale = tierProfile(t).fxScale;
    this.stageVis.setTier(t);
    this.pipeline.setTier(t);
  }

  private interpPlatforms(prev: BrawlSnapshot, cur: BrawlSnapshot, a: number): void {
    const cp = cur.platforms;
    while (this.platBuf.length < cp.length) this.platBuf.push({ id: '', x0: 0, x1: 0, y: 0 });
    this.platBuf.length = cp.length;
    for (let i = 0; i < cp.length; i++) {
      const c = cp[i];
      let p: PlatformState | undefined = prev.platforms[i];
      if (p === undefined || p.id !== c.id) p = prev.platforms.find((q) => q.id === c.id);
      const o = this.platBuf[i];
      o.id = c.id;
      if (p === undefined) {
        o.x0 = c.x0;
        o.x1 = c.x1;
        o.y = c.y;
      } else {
        o.x0 = p.x0 + (c.x0 - p.x0) * a;
        o.x1 = p.x1 + (c.x1 - p.x1) * a;
        o.y = p.y + (c.y - p.y) * a;
      }
    }
  }

  /** Soft contact shadow on the highest platform surface at/below the fighter. */
  private updateShadow(fv: FighterView, alive: boolean, x: number, y: number): void {
    if (!alive) {
      fv.shadow.visible = false;
      return;
    }
    let best = -Infinity;
    const pl = this.platBuf;
    for (let i = 0; i < pl.length; i++) {
      const p = pl[i];
      if (x < p.x0 - 0.15 || x > p.x1 + 0.15) continue;
      if (p.y > y + 0.35) continue;
      if (p.y > best) best = p.y;
    }
    if (best === -Infinity) {
      fv.shadow.visible = false;
      return;
    }
    const gap = Math.max(0, y - best);
    const k = 1 / (1 + gap * 0.22);
    fv.shadow.visible = true;
    fv.shadow.position.set(x, best + 0.015, 0);
    const wScale = Math.max(1.5, fv.w * 1.45) * (0.7 + 0.3 * k);
    fv.shadow.scale.set(wScale, 1, Math.min(3.4, 1.4 + fv.w * 0.8));
    fv.shadowMat.opacity = 0.62 * k;
  }

  private swooshTrail(fv: FighterView, cf: BrawlSnapshot['fighters'][number], px: number, py: number): void {
    const active = cf.action === 'attack' && cf.hitlag <= 0 && (cf.movePhase === 'active' || (cf.movePhase === 'startup' && cf.moveFrames > 0));
    if (!active || cf.movePhase !== 'active') {
      fv.tipValid = false;
      return;
    }
    const tip = fv.rig.tipLocal('strike', _tip);
    if (tip === null) {
      fv.tipValid = false;
      return;
    }
    const tx = px + cf.facing * tip.z;
    const ty = py + tip.y;
    if (fv.tipValid) {
      const dx = tx - fv.tipX;
      const dy = ty - fv.tipY;
      const d = Math.hypot(dx, dy);
      if (d > 0.05 && d < 5) {
        const ang = Math.atan2(dy, dx);
        const len = Math.min(3.2, 0.5 + d * 3.2);
        this.vfx.streak(tx - Math.cos(ang) * len * 0.45, ty - Math.sin(ang) * len * 0.45, ang, 0, len, len * 0.7, 0.2, 0.12, 0xffffff, 1.7, 0.75, 0);
        this.vfx.glow(tx, ty, 0.55, 0.2, 0.1, fv.fx.accent, 1.8, 0.55);
      }
    }
    fv.tipX = tx;
    fv.tipY = ty;
    fv.tipValid = true;
  }

  private handleEvents(events: readonly BrawlEvent[], cur: BrawlSnapshot): void {
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      switch (e.type) {
        case 'hit': {
          const atk = this.fighters[e.attackerId];
          const tgt = this.fighters[e.targetId];
          const tint = atk !== undefined ? atk.fx.accent : 0xffd28a;
          if (e.kbSpeed <= 0.5) {
            this.vfx.armor(e.pos.x, e.pos.y, e.damage);
            if (tgt !== undefined) tgt.fx.onArmor();
          } else {
            this.vfx.hit(e.pos.x, e.pos.y, e.angle, e.damage, e.sweetspot, e.kbSpeed, tint);
            if (tgt !== undefined) tgt.fx.onHit();
            this.cam.hit(e.kbSpeed, e.sweetspot);
          }
          break;
        }
        case 'jump': {
          const f = this.fighters[e.fighterId];
          this.vfx.jump(e.pos.x, e.pos.y, e.air, f !== undefined ? f.h : 1.2);
          break;
        }
        case 'land':
          this.vfx.land(e.pos.x, e.pos.y, e.hard);
          break;
        case 'dodge': {
          if (e.kind === 'air') this.vfx.ring(e.pos.x, e.pos.y + 0.6, 0.3, 1.5, 0.3, 0xc8e4ff, 2.0, 0.14, 0.6, 0.8);
          else this.vfx.land(e.pos.x, e.pos.y, false);
          break;
        }
        case 'ledgeGrab':
          this.vfx.ledgeGrab(e.pos.x, e.pos.y);
          break;
        case 'ko': {
          const f = this.fighters[e.fighterId];
          const tint = f !== undefined ? f.fx.accent : 0xffffff;
          // The blast line may be off-screen: burst at the nearest point inside the view, on the same side.
          const r = this.cam.visibleRect();
          const m = 1.6;
          let x = e.pos.x;
          let y = e.pos.y;
          if (x < r.l + m) x = r.l + m;
          else if (x > r.r - m) x = r.r - m;
          if (y < r.b + m) y = r.b + m;
          else if (y > r.t - m) y = r.t - m;
          this.vfx.ko(x, y, e.side, tint);
          this.cam.ko(x, y);
          this.slow = 0.3;
          if (f !== undefined) f.fx.reset();
          break;
        }
        case 'respawn':
          break;
        case 'moveStart':
        case 'matchEnd':
        default:
          break;
      }
    }
    void cur;
  }

  private updateOverlay(cur: BrawlSnapshot, rdt: number): void {
    const u = this.pipeline.overlayUniforms;
    // KO flash decay
    this.flashDecay = this.vfx.flash;
    this.vfx.flash = Math.max(0, this.vfx.flash - rdt * 2.6);
    u.uFlashA.value = this.flashDecay * 0.7;
    u.uFlash.value.setRGB(this.vfx.flashR, this.vfx.flashG, this.vfx.flashB);
    // Danger edges: a local fighter close to a blast line.
    const bl = this.stage.blast;
    let dl = 0;
    let dr = 0;
    let dt = 0;
    let db = 0;
    let any = false;
    for (const f of cur.fighters) if (f.isPlayer && f.alive) any = true;
    for (const f of cur.fighters) {
      if (!f.alive) continue;
      if (any && !f.isPlayer) continue;
      const near = (d: number, outward: number): number => clamp((9 - d) / 7, 0, 1) * (0.55 + 0.45 * clamp(outward / 14, 0, 1));
      dl = Math.max(dl, near(f.pos.x - bl.left, -f.vel.x));
      dr = Math.max(dr, near(bl.right - f.pos.x, f.vel.x));
      dt = Math.max(dt, near(bl.top - f.pos.y, f.vel.y));
      db = Math.max(db, near(f.pos.y - bl.bottom, -f.vel.y));
    }
    const dv = u.uDanger.value;
    // Smooth toward the target so the glow never pops.
    const k = 1 - Math.exp(-rdt * 10);
    dv.x += (dl - dv.x) * k;
    dv.y += (dr - dv.y) * k;
    dv.z += (dt - dv.z) * k;
    dv.w += (db - dv.w) * k;
  }
}

/** Build the Champions League view on `canvas` (the canvas must not be driven by another live renderer). */
export function createBrawlView(canvas: HTMLCanvasElement, config: BrawlMatchConfig, opts: BrawlViewOpts = {}): BrawlView {
  return new BrawlViewImpl(canvas, config, opts);
}

export { accentOf };
