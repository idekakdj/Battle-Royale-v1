/**
 * First-person QA handle (`window.__gkFp`, v1.3 WP-Q). Dev/QA only, inert unless
 * called:
 *  - `joints(animal)` lists a rig's joint names / bounds / pivots (for authoring `hide` / `eye`),
 *  - `sheet(cells, cols)` freezes the demo match and renders a contact sheet of first-person views of the local player's rig
 *    in different actions (`?demo=match` exposes `window.__gkMatch`),
 *  - `coverage(poses?)` the OBJECTIVE metric: for each pose it renders the first-person frame twice (own rig drawn vs not
 *    drawn) and counts the differing pixels inside the central safe zone and over the whole frame,
 *  - `measure()` / `watch(ms)` the same metric on the LIVE frame (real match, real camera director) — used to check the
 *    ultimates, which need the sim + the ultimate camera (`showShots(rows)` lays the worst frames out with the own-rig
 *    pixels painted red / yellow = inside the safe zone),
 *  - `prep()` / `castUlt()` / `ultRun()` / `report()` scripted runs in `?demo=match&animal=<a>&difficulty=1&seed=5`:
 *    `await __gkFp.report(2.5, 8000)` prints the whole table (static poses + every ultimate stage) for the local animal.
 * Acceptance for the clear-view animals (crocodile, hippo, rhino, eagle): 0 own-rig pixels in the safe zone, <= ~12% of
 * the frame, in every pose. Production builds do not contain this file's side effects (`import.meta.env.DEV` guard).
 */

import * as THREE from 'three';
import type { AnimalId, FighterAction, FighterState } from '../../../core/types';
import type { BaseRig } from '../Animator';
import { AnimalFactory } from '../AnimalFactory';
import { clipZoneRect } from './clip';
import type { FpClip } from './types';

export interface SheetCell {
  /** Action to pose. */
  a: FighterAction;
  /** Action progress 0..1. */
  u?: number;
  /** Action duration (s). */
  dur?: number;
  /** Horizontal speed for run poses (m/s). */
  speed?: number;
  /** Vertical velocity / altitude / airborne (glide, jump). */
  vy?: number;
  y?: number;
  airborne?: boolean;
  /** Look pitch (rad, + up) and yaw. */
  pitch?: number;
  yaw?: number;
  /** v1.8: standing in the jungle pool (`FighterState.inWater`): the swim layer sinks the body, the eye drops. */
  inWater?: boolean;
  /** Ultimate phase / stage (state.ultPhase / state.ultStage) for `a: 'ultimate'` cells. */
  ultPhase?: 'windup' | 'active' | 'recovery';
  ultStage?: number;
}

interface MatchLike {
  loop: { stop(): void };
  rigs: BaseRig[];
  snap: { fighters: FighterState[] };
  cameraRig: {
    yaw: number;
    fpPitch: number;
    fpAmount: number;
    update(dt: number): void;
  };
  sceneManager: { renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.PerspectiveCamera };
}

let baseState: FighterState | null = null;

function matchOrThrow(): MatchLike {
  const mc = (window as unknown as { __gkMatch?: MatchLike }).__gkMatch;
  if (mc === undefined) throw new Error('no __gkMatch (open ?demo=match)');
  return mc;
}

export function joints(animal: AnimalId): ReturnType<BaseRig['describeJoints']> {
  const rig = AnimalFactory.createRig(animal);
  const out = rig.describeJoints();
  rig.dispose();
  return out;
}

/** Pose the local rig + camera for one cell (12 x 50 ms of settling), exactly as the sheet does. */
function poseCell(mc: MatchLike, c: SheetCell, u: number, aspect: number): void {
  const rig = mc.rigs[0];
  const cr = mc.cameraRig;
  const cam = mc.sceneManager.camera;
  if (baseState === null) baseState = structuredClone(mc.snap.fighters[0]);
  const base = baseState;
  const dur = c.dur ?? (c.a.startsWith('attack') ? 0.6 : 1.2);
  const st = structuredClone(base);
  st.action = c.a;
  st.actionDur = c.a === 'idle' || c.a === 'run' || c.a === 'block' ? 0 : dur;
  if (c.ultPhase !== undefined) st.ultPhase = c.ultPhase;
  if (c.ultStage !== undefined) st.ultStage = c.ultStage;
  const yaw = c.yaw ?? 0;
  const sp = c.speed ?? (c.a === 'run' ? 8 : 0);
  st.pos = { x: base.pos.x, y: c.y ?? 0, z: base.pos.z };
  st.airborne = c.airborne === true;
  if (c.inWater === true) st.inWater = true;
  else delete st.inWater;
  st.yaw = yaw;
  rig.root.rotation.y = yaw;
  cr.yaw = yaw;
  rig.root.position.set(st.pos.x, st.pos.y, st.pos.z);
  cr.fpPitch = c.pitch ?? 0;
  cam.aspect = aspect;
  for (let k = 0; k < 12; k++) {
    st.vel = { x: Math.sin(yaw) * sp, y: c.vy ?? 0, z: Math.cos(yaw) * sp };
    st.actionT = u * dur;
    rig.fpxLook = c.pitch ?? 0;
    rig.update(st, 0.05);
    cr.update(0.05);
    rig.fpxAnchorPass(cam.position.x, cam.position.y, cam.position.z, cr.yaw, cr.fpPitch, cr.fpAmount);
  }
}

/** Freeze the match and paint `cells` as a grid of first-person views (HUD hidden). */
export function sheet(cells: SheetCell[], cols = 3): { cw: number; ch: number } {
  const mc = matchOrThrow();
  mc.loop.stop();
  const hud = document.querySelector('.gk-hud');
  if (hud instanceof HTMLElement) hud.style.display = 'none';
  const cam = mc.sceneManager.camera;
  const r = mc.sceneManager.renderer;
  const W = window.innerWidth;
  const H = window.innerHeight;
  const rows = Math.ceil(cells.length / cols);
  const cw = Math.floor(W / cols);
  const rowH = Math.floor(H / rows);
  // Every cell keeps the REAL window aspect (the vertical FOV depends on it): a cell is letter-boxed, never stretched.
  const ch = Math.min(rowH, Math.floor((cw * H) / W));
  const oldAspect = cam.aspect;
  r.setViewport(0, 0, W, H);
  r.setScissorTest(false);
  r.setRenderTarget(null);
  r.clear();
  r.setScissorTest(true);
  cells.forEach((c, i) => {
    poseCell(mc, c, c.u ?? 0, cw / ch);
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = col * cw;
    const y = H - (row + 1) * rowH + Math.floor((rowH - ch) / 2);
    r.setViewport(x, y, cw, ch);
    r.setScissor(x, y, cw, ch);
    r.render(mc.sceneManager.scene, cam);
  });
  r.setScissorTest(false);
  r.setViewport(0, 0, W, H);
  cam.aspect = oldAspect;
  cam.updateProjectionMatrix();
  // Freeze the result into an <img> overlay: screenshots then never depend on the WebGL back buffer.
  let img = document.getElementById('gk-fp-sheet') as HTMLImageElement | null;
  if (img === null) {
    img = document.createElement('img');
    img.id = 'gk-fp-sheet';
    img.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;z-index:99999;background:#000';
    document.body.appendChild(img);
  }
  img.src = r.domElement.toDataURL('image/jpeg', 0.88);
  return { cw, ch };
}

// ── Objective own-body coverage metric ──────────────────────────────────────────────────────────────────────────────────

/** The safe zone the acceptance test measures (centre 50% of the width x 60% of the height). */
export const SAFE_ZONE: FpClip = { w: 0.5, h: 0.6 };

export interface Coverage {
  /** Own-rig pixels inside the safe zone / in the whole frame. */
  safePx: number;
  allPx: number;
  /** Percentages of the zone area / of the frame area. */
  safePct: number;
  allPct: number;
}

let rt: THREE.WebGLRenderTarget | null = null;
const RT_W = 800;

function renderFrame(mc: MatchLike, h: number): Uint8Array {
  const r = mc.sceneManager.renderer;
  if (rt === null || rt.height !== h) {
    rt?.dispose();
    rt = new THREE.WebGLRenderTarget(RT_W, h, { colorSpace: THREE.SRGBColorSpace, depthBuffer: true });
  }
  const prev = r.getRenderTarget();
  r.setRenderTarget(rt);
  r.clear();
  r.render(mc.sceneManager.scene, mc.sceneManager.camera);
  const buf = new Uint8Array(RT_W * h * 4);
  r.readRenderTargetPixels(rt, 0, 0, RT_W, h, buf);
  r.setRenderTarget(prev);
  return buf;
}

/** Stop the own rig from painting colour / depth (its shadow caster, a separate depth-only pass, keeps working). Returns a restore fn. */
function hideRigPaint(rig: BaseRig): () => void {
  const saved: { m: THREE.Material; c: boolean; d: boolean }[] = [];
  const seen = new Set<THREE.Material>();
  rig.root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh && !(o as THREE.Points).isPoints && !(o as THREE.Line).isLine) return;
    const ms = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of ms) {
      if (seen.has(m)) continue;
      seen.add(m);
      saved.push({ m, c: m.colorWrite, d: m.depthWrite });
      m.colorWrite = false;
      m.depthWrite = false;
    }
  });
  return () => {
    for (const s of saved) {
      s.m.colorWrite = s.c;
      s.m.depthWrite = s.d;
    }
  };
}

/** Coverage of the CURRENT frame (no re-posing): render with the own rig drawn vs not drawn and diff. */
function measureFrame(mc: MatchLike, mask?: { url: string }): Coverage {
  const cam = mc.sceneManager.camera;
  const h = Math.max(2, Math.round(RT_W / cam.aspect));
  const withRig = renderFrame(mc, h);
  const restore = hideRigPaint(mc.rigs[0]);
  const without = renderFrame(mc, h);
  restore();
  const z = clipZoneRect(SAFE_ZONE, RT_W, h);
  let safe = 0;
  let all = 0;
  let mimg: ImageData | null = null;
  if (mask !== undefined) mimg = new ImageData(RT_W, h);
  for (let y = 0; y < h; y++) {
    const yy = h - 1 - y; // readRenderTargetPixels is bottom-up; the zone is symmetric but keep it exact
    for (let x = 0; x < RT_W; x++) {
      const i = (yy * RT_W + x) * 4;
      const d = Math.max(
        Math.abs(withRig[i] - without[i]),
        Math.abs(withRig[i + 1] - without[i + 1]),
        Math.abs(withRig[i + 2] - without[i + 2]),
      );
      if (d >= 2) {
        all++;
        const inZone = x >= z.x0 && x < z.x1 && y >= z.y0 && y < z.y1;
        if (inZone) safe++;
        if (mimg !== null) {
          const o = (y * RT_W + x) * 4;
          mimg.data[o] = 255;
          mimg.data[o + 1] = inZone ? 255 : 0;
          mimg.data[o + 2] = 0;
          mimg.data[o + 3] = 150;
        }
      }
    }
  }
  if (mimg !== null && mask !== undefined) {
    const cv = document.createElement('canvas');
    cv.width = RT_W;
    cv.height = h;
    cv.getContext('2d')?.putImageData(mimg, 0, 0);
    mask.url = cv.toDataURL('image/png');
  }
  const zoneArea = Math.max(1, (z.x1 - z.x0) * (z.y1 - z.y0));
  return { safePx: safe, allPx: all, safePct: (100 * safe) / zoneArea, allPct: (100 * all) / (RT_W * h) };
}

export interface PoseSpec extends SheetCell {
  name: string;
  /** Action-progress samples (the maximum over them is reported). Default: just `u`. */
  us?: number[];
}

/** The standard pose list of the acceptance metric (+ the eagle's flight poses). */
export function defaultPoses(animal: AnimalId): PoseSpec[] {
  const L: PoseSpec[] = [
    { name: 'idle', a: 'idle' },
    { name: 'run', a: 'run', speed: 9 },
    { name: 'jump-up', a: 'jump', airborne: true, y: 1.0, vy: 6, dur: 1.0, us: [0.2] },
    { name: 'apex', a: 'jump', airborne: true, y: 2.6, vy: 0, dur: 1.0, us: [0.5] },
    { name: 'fall', a: 'jump', airborne: true, y: 1.4, vy: -7, dur: 1.0, us: [0.8] },
    { name: 'attack1', a: 'attack1', us: [0.1, 0.25, 0.4, 0.55, 0.7, 0.9] },
    { name: 'attack2', a: 'attack2', us: [0.1, 0.25, 0.4, 0.55, 0.7, 0.9] },
    { name: 'attack3', a: 'attack3', us: [0.1, 0.25, 0.4, 0.55, 0.7, 0.9] },
    { name: 'block', a: 'block' },
    { name: 'special', a: 'special', dur: 1.2, us: [0.15, 0.3, 0.45, 0.55, 0.7, 0.9] },
    { name: 'knockdown', a: 'knockdown', dur: 1.4, us: [0.2, 0.5, 0.8] },
    { name: 'hit', a: 'hit', dur: 0.4, us: [0.1, 0.5] },
    { name: 'stagger', a: 'stagger', dur: 0.8, us: [0.2, 0.6] },
    { name: 'grab', a: 'grab', dur: 1.0, us: [0.3, 0.7] },
    { name: 'grabbed', a: 'grabbed', dur: 1.0, us: [0.5] },
    { name: 'feared', a: 'feared', dur: 1.0, us: [0.5] },
    { name: 'look-down', a: 'idle', pitch: -0.5 },
    { name: 'look-up', a: 'idle', pitch: 0.4 },
  ];
  // Every ultimate stage of the clear-view animals, posed statically (the live `ultRun` adds the real camera director).
  const ult = (name: string, ultPhase: 'windup' | 'active' | 'recovery', ultStage: number, extra: Partial<SheetCell> = {}): PoseSpec => ({
    name: `ult-${name}`,
    a: 'ultimate',
    dur: 1.0,
    ultPhase,
    ultStage,
    us: [0.2, 0.6, 0.95],
    ...extra,
  });
  if (animal === 'crocodile') {
    for (const [ph, st] of [['windup', 0], ['windup', 1], ['active', 2], ['active', 3], ['active', 4], ['active', 5], ['active', 6], ['active', 7], ['active', 8], ['recovery', 8], ['recovery', 9]] as const) {
      L.push(ult(`${ph}${st}`, ph, st));
    }
  } else if (animal === 'hippo') {
    for (const [ph, st] of [['windup', 0], ['active', 1], ['recovery', 2]] as const) L.push(ult(`${ph}${st}`, ph, st));
  } else if (animal === 'rhino') {
    for (const [ph, st] of [['windup', 0], ['active', 1], ['active', 2], ['active', 3], ['active', 4], ['recovery', 4]] as const) {
      L.push(ult(`${ph}${st}`, ph, st, ph === 'active' ? { speed: 12 } : {}));
    }
  } else if (animal === 'eagle') {
    L.push(
      ult('windup0', 'windup', 0, { airborne: true, y: 2, vy: 4, speed: 4 }),
      ult('circle0', 'active', 0, { airborne: true, y: 9, vy: 0, speed: 6 }),
      ult('commit1', 'active', 1, { airborne: true, y: 9, vy: -2, speed: 6 }),
      ult('stoop1', 'active', 1, { airborne: true, y: 6, vy: -14, speed: 6 }),
      ult('recovery2', 'recovery', 2, {}),
    );
  }
  // v1.8 swimming: the same clear-view rules must hold in the pool (eye lowered with the sink, paddle / attack-swim poses).
  L.push(
    { name: 'idle-water', a: 'idle', inWater: true },
    { name: 'run-water', a: 'run', speed: 3.5, inWater: true },
    { name: 'attack1-water', a: 'attack1', inWater: true, us: [0.1, 0.25, 0.4, 0.55, 0.7, 0.9] },
    { name: 'attack2-water', a: 'attack2', inWater: true, us: [0.1, 0.25, 0.4, 0.55, 0.7, 0.9] },
    { name: 'attack3-water', a: 'attack3', inWater: true, us: [0.1, 0.25, 0.4, 0.55, 0.7, 0.9] },
    { name: 'block-water', a: 'block', inWater: true },
    { name: 'look-down-water', a: 'idle', inWater: true, pitch: -0.5 },
  );
  if (animal === 'eagle') {
    L.push(
      { name: 'glide', a: 'glide', airborne: true, y: 5, vy: 0, speed: 9 },
      { name: 'climb', a: 'glide', airborne: true, y: 4, vy: 4, speed: 8 },
      { name: 'hover', a: 'glide', airborne: true, y: 3, vy: 0, speed: 0 },
      { name: 'stoop', a: 'ultimate', airborne: true, y: 8, vy: -12, speed: 6, dur: 1.5, ultPhase: 'active', ultStage: 1, us: [0.3] },
      { name: 'glide-down', a: 'glide', airborne: true, y: 5, vy: 0, speed: 9, pitch: -0.5 },
    );
  }
  return L;
}

export interface CoverageRow extends Coverage {
  animal: string;
  pose: string;
  /** Worst sample (progress u) of the pose. */
  u: number;
}

/** Run the metric for the local player's rig over `poses` (default: {@link defaultPoses}). Freezes the match. */
export function coverage(poses?: PoseSpec[]): CoverageRow[] {
  const mc = matchOrThrow();
  mc.loop.stop();
  const cam = mc.sceneManager.camera;
  const oldAspect = cam.aspect;
  const aspect = window.innerWidth / window.innerHeight;
  const animal = new URLSearchParams(window.location.search).get('animal') ?? 'lion';
  const out: CoverageRow[] = [];
  for (const p of poses ?? defaultPoses(animal as AnimalId)) {
    let worst: CoverageRow | null = null;
    for (const u of p.us ?? [p.u ?? 0]) {
      poseCell(mc, p, u, aspect);
      cam.updateProjectionMatrix();
      const c = measureFrame(mc);
      if (worst === null) worst = { ...c, animal, pose: p.name, u };
      else {
        // The worst sample of the pose: largest own-body area, and the largest safe-zone intrusion seen in any sample.
        if (c.allPx > worst.allPx) {
          worst.allPx = c.allPx;
          worst.allPct = c.allPct;
          worst.u = u;
        }
        if (c.safePx > worst.safePx) {
          worst.safePx = c.safePx;
          worst.safePct = c.safePct;
        }
      }
    }
    if (worst !== null) out.push(worst);
  }
  cam.aspect = oldAspect;
  cam.updateProjectionMatrix();
  return out;
}

/** Coverage of the live frame right now (real match; the loop may keep running). */
export function measure(): Coverage {
  return measureFrame(matchOrThrow());
}

export interface WatchRow {
  key: string;
  frames: number;
  maxSafePx: number;
  maxAllPct: number;
  /** JPEG data URL of the worst frame of this key + PNG mask of the own-rig pixels (red; yellow = inside the safe zone), only with `shots`. */
  shot?: string;
  mask?: string;
}

/**
 * Sample the live frame every `everyMs` for `ms` and aggregate by `action/ultPhase/ultStage` (the worst frame of each key):
 * cast an ultimate meanwhile to measure each stage with the real ultimate camera director. With `shots`, the worst frame of
 * each key is also captured (`showShots(rows)` lays them out as a contact sheet).
 */
export function watch(ms: number, everyMs = 60, shots = false): Promise<WatchRow[]> {
  const mc = matchOrThrow();
  const rows = new Map<string, WatchRow>();
  return new Promise((resolve) => {
    const t0 = performance.now();
    const tick = (): void => {
      const f = mc.snap.fighters[0];
      const key = `${f.action}/${f.ultPhase ?? '-'}/${f.ultStage ?? '-'}${f.airborne ? '/air' : ''}`;
      const mk = { url: '' };
      const c = measureFrame(mc, shots ? mk : undefined);
      let r = rows.get(key);
      if (r === undefined) {
        r = { key, frames: 0, maxSafePx: 0, maxAllPct: 0 };
        rows.set(key, r);
      }
      r.frames++;
      if (c.safePx > r.maxSafePx) r.maxSafePx = c.safePx;
      if (shots && (r.shot === undefined || c.allPct > r.maxAllPct)) {
        const sm = mc.sceneManager as MatchLike['sceneManager'] & { render?: () => void };
        sm.render?.();
        r.shot = sm.renderer.domElement.toDataURL('image/jpeg', 0.7);
        r.mask = mk.url;
      }
      if (c.allPct > r.maxAllPct) r.maxAllPct = c.allPct;
      if (performance.now() - t0 < ms) setTimeout(tick, everyMs);
      else resolve([...rows.values()]);
    };
    tick();
  });
}

/** Lay out the captured worst frames of {@link watch} as a labelled grid overlay (for screenshots). */
export function showShots(rows: WatchRow[], cols = 3): void {
  let host = document.getElementById('gk-fp-shots');
  if (host === null) {
    host = document.createElement('div');
    host.id = 'gk-fp-shots';
    document.body.appendChild(host);
  }
  host.style.cssText = `position:fixed;inset:0;z-index:99999;background:#000;display:grid;grid-template-columns:repeat(${cols},1fr);gap:2px;align-content:start`;
  host.innerHTML = '';
  for (const r of rows) {
    if (r.shot === undefined) continue;
    const cell = document.createElement('div');
    cell.style.cssText = 'position:relative;aspect-ratio:16/9;overflow:hidden';
    const img = document.createElement('img');
    img.src = r.shot;
    img.style.cssText = 'width:100%;height:100%;object-fit:cover';
    const lab = document.createElement('div');
    lab.textContent = `${r.key} ${r.maxAllPct.toFixed(1)}%`;
    lab.style.cssText = 'position:absolute;left:4px;top:2px;color:#fff;font:11px monospace;text-shadow:0 0 3px #000';
    cell.append(img);
    if (r.mask !== undefined && r.mask !== '') {
      const mk = document.createElement('img');
      mk.src = r.mask;
      mk.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover';
      cell.append(mk);
    }
    cell.append(lab);
    host.appendChild(cell);
  }
}

/** Remove the overlays of {@link sheet} / {@link showShots}. */
export function hideOverlays(): void {
  document.getElementById('gk-fp-shots')?.remove();
  document.getElementById('gk-fp-sheet')?.remove();
}

// ── Scripted QA runs (demo match) ───────────────────────────────────────────────────────────────────────────────────────

interface DemoMatch extends MatchLike {
  loop: { stop(): void; start(): void };
  bots: { update: unknown; getIntent: unknown };
  world: { fighters: { state: FighterState }[] };
  cameraRig: MatchLike['cameraRig'] & { isFirstPerson: boolean };
}

function key(code: string, down: boolean): void {
  window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code, key: code === 'KeyQ' ? 'q' : 'v' }));
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Prepare the demo match for QA: drive the loop with timers (the browser pane throttles rAF to zero), neutralise the bots,
 * switch to first person and let the camera settle.
 */
export async function prep(): Promise<boolean> {
  const mc = matchOrThrow() as DemoMatch;
  window.requestAnimationFrame = (cb) => window.setTimeout(() => cb(performance.now()), 16);
  window.cancelAnimationFrame = (id) => window.clearTimeout(id);
  mc.loop.stop();
  mc.loop.start();
  const neutral = { moveX: 0, moveZ: 0, aimYaw: 0, attack: false, block: false, special: false, ultimate: false, jump: false };
  mc.bots.update = () => undefined;
  mc.bots.getIntent = () => neutral;
  await sleep(800);
  if (!mc.cameraRig.isFirstPerson) {
    key('KeyV', true);
    key('KeyV', false);
  }
  await sleep(1800);
  return mc.cameraRig.isFirstPerson;
}

/** Charge the ultimate, put a victim `dist` m ahead (everyone else far away) and press Q until it fires. Returns the attempt count or -1. */
export async function castUlt(dist = 2.5): Promise<number> {
  const mc = matchOrThrow() as DemoMatch;
  const w = mc.world;
  const me = w.fighters[0].state;
  const place = (window as unknown as { __gkMatchTest?: { place(id: number, x: number, z: number): void } }).__gkMatchTest;
  for (let attempt = 0; attempt < 40; attempt++) {
    me.ultCharge = 100;
    me.hp = me.maxHp;
    const yaw = mc.cameraRig.yaw;
    for (let i = 2; i < w.fighters.length; i++) place?.place(i, me.pos.x + 40, me.pos.z + 40);
    place?.place(1, me.pos.x + Math.sin(yaw) * dist, me.pos.z + Math.cos(yaw) * dist);
    key('KeyQ', true);
    await sleep(50);
    key('KeyQ', false);
    await sleep(100);
    if (me.action === 'ultimate') return attempt;
  }
  return -1;
}

/** Cast the ultimate and measure every stage live for `ms` (real camera director); with `shots` also keep the worst frames. */
export async function ultRun(ms = 7500, dist = 2.5, shots = false): Promise<WatchRow[]> {
  await castUlt(dist);
  return watch(ms, 30, shots);
}

const fmtRows = (rows: WatchRow[]): string => rows.map((r) => `${r.key} n${r.frames} safe${r.maxSafePx} all${r.maxAllPct.toFixed(1)}`).join('; ');

/** One-call report: static pose table + live ultimate stages, as text. */
export async function report(ultDist = 2.5, ultMs = 7500): Promise<string> {
  await prep();
  const st = coverage().map((r) => `${r.pose} ${r.safePx}/${r.allPct.toFixed(1)}`).join(' | ');
  (matchOrThrow() as DemoMatch).loop.start();
  await sleep(300);
  const ult = fmtRows(await ultRun(ultMs, ultDist));
  return `STATIC (safe px / whole %): ${st}
ULT: ${ult}`;
}

/** Install `window.__gkFp` (called once from fp/index.ts). */
export function installFpQa(): void {
  (window as unknown as { __gkFp?: unknown }).__gkFp = { joints, sheet, coverage, measure, watch, showShots, hideOverlays, defaultPoses, prep, castUlt, ultRun, report };
}
