/**
 * First-person QA handle (`window.__gkFp`, v1.3 WP-Q). Dev/QA only, inert unless
 * called: `joints(animal)` lists a rig's joint names / bounds / pivots (for
 * authoring `hide` / `eye`), `sheet(cells, cols)` freezes the demo match and
 * renders a contact sheet of first-person views of the local player's rig in
 * different actions (`?demo=match` exposes `window.__gkMatch`).
 */

import * as THREE from 'three';
import type { AnimalId, FighterAction, FighterState } from '../../../core/types';
import type { BaseRig } from '../Animator';
import { AnimalFactory } from '../AnimalFactory';

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

export function joints(animal: AnimalId): ReturnType<BaseRig['describeJoints']> {
  const rig = AnimalFactory.createRig(animal);
  const out = rig.describeJoints();
  rig.dispose();
  return out;
}

/** Freeze the match and paint `cells` as a grid of first-person views (HUD hidden). */
export function sheet(cells: SheetCell[], cols = 3): { cw: number; ch: number } {
  const mc = (window as unknown as { __gkMatch?: MatchLike }).__gkMatch;
  if (mc === undefined) throw new Error('no __gkMatch (open ?demo=match)');
  mc.loop.stop();
  const hud = document.querySelector('.gk-hud');
  if (hud instanceof HTMLElement) hud.style.display = 'none';
  const rig = mc.rigs[0];
  const cr = mc.cameraRig;
  const sm = mc.sceneManager;
  const r = sm.renderer;
  const cam = sm.camera;
  const W = window.innerWidth;
  const H = window.innerHeight;
  const rows = Math.ceil(cells.length / cols);
  const cw = Math.floor(W / cols);
  const ch = Math.floor(H / rows);
  if (baseState === null) baseState = structuredClone(mc.snap.fighters[0]);
  const base = baseState;
  const oldAspect = cam.aspect;
  r.setScissorTest(true);
  cells.forEach((c, i) => {
    const dur = c.dur ?? (c.a.startsWith('attack') ? 0.6 : 1.2);
    const st = structuredClone(base);
    st.action = c.a;
    st.actionDur = c.a === 'idle' || c.a === 'run' || c.a === 'block' ? 0 : dur;
    const yaw = c.yaw ?? 0;
    const sp = c.speed ?? (c.a === 'run' ? 8 : 0);
    st.pos = { x: base.pos.x, y: c.y ?? 0, z: base.pos.z };
    st.airborne = c.airborne === true;
    st.yaw = yaw;
    rig.root.rotation.y = yaw;
    cr.yaw = yaw;
    rig.root.position.set(st.pos.x, st.pos.y, st.pos.z);
    cr.fpPitch = c.pitch ?? 0;
    cam.aspect = cw / ch;
    for (let k = 0; k < 12; k++) {
      st.vel = { x: Math.sin(yaw) * sp, y: c.vy ?? 0, z: Math.cos(yaw) * sp };
      st.actionT = (c.u ?? 0) * dur;
      rig.fpxLook = c.pitch ?? 0;
      rig.update(st, 0.05);
      cr.update(0.05);
      rig.fpxAnchorPass(cam.position.x, cam.position.y, cam.position.z, cr.yaw, cr.fpPitch, cr.fpAmount);
    }
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = col * cw;
    const y = H - (row + 1) * ch;
    r.setViewport(x, y, cw, ch);
    r.setScissor(x, y, cw, ch);
    r.render(sm.scene, cam);
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

/** Install `window.__gkFp` (called once from fp/index.ts). */
export function installFpQa(): void {
  (window as unknown as { __gkFp?: unknown }).__gkFp = { joints, sheet };
}
