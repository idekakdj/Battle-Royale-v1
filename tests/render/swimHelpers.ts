/**
 * Shared helpers of the v1.8 swim-animation tests (WP-J4): scripted FighterState sequences driven through a real rig and
 * a bit-exact transform hash over EVERY node of the rig (so "poses are identical when inWater is false" is checked on the
 * rendered result, not on a proxy).
 */

import * as THREE from 'three';
import { ANIMALS } from '../../src/config/animals';
import type { AnimalId, FighterAction, FighterState } from '../../src/core/types';
import { AnimalFactory } from '../../src/render/animals/AnimalFactory';
import { makeMockState, type BaseRig } from '../../src/render/animals/Animator';

export interface Scenario {
  name: string;
  action: FighterAction;
  /** Action length (s) — 0 = open-ended (idle / run / block). */
  dur: number;
  /** Horizontal speed (m/s); `null` = the animal's top speed. */
  speed: number | null;
  /** Frames to run (1/60 s each). */
  frames: number;
  airborne?: boolean;
  vy?: number;
  y?: number;
  ultPhase?: 'windup' | 'active' | 'recovery';
  ultStage?: number;
}

export const SCENARIOS: Scenario[] = [
  { name: 'idle', action: 'idle', dur: 0, speed: 0, frames: 100 },
  { name: 'walk', action: 'run', dur: 0, speed: 2, frames: 80 },
  { name: 'run', action: 'run', dur: 0, speed: null, frames: 100 },
  { name: 'attack1', action: 'attack1', dur: 0.6, speed: 0, frames: 40 },
  { name: 'attack2', action: 'attack2', dur: 0.6, speed: 0, frames: 40 },
  { name: 'attack3', action: 'attack3', dur: 0.7, speed: 0, frames: 46 },
  { name: 'block', action: 'block', dur: 0, speed: 0, frames: 60 },
  { name: 'special', action: 'special', dur: 1.0, speed: 0, frames: 66 },
  { name: 'ultimate-w', action: 'ultimate', dur: 1.4, speed: 0, frames: 86, ultPhase: 'windup', ultStage: 0 },
  { name: 'ultimate-a', action: 'ultimate', dur: 1.4, speed: 0, frames: 86, ultPhase: 'active', ultStage: 1 },
  { name: 'hit', action: 'hit', dur: 0.2, speed: 0, frames: 14 },
  { name: 'stagger', action: 'stagger', dur: 0.5, speed: 0, frames: 34 },
  { name: 'knockdown', action: 'knockdown', dur: 1.2, speed: 0, frames: 76 },
  { name: 'feared', action: 'feared', dur: 1.2, speed: null, frames: 76 },
  { name: 'jump', action: 'jump', dur: 0.7, speed: 3, frames: 40, airborne: true, vy: 3, y: 1.2 },
  { name: 'dead', action: 'dead', dur: 0, speed: 0, frames: 100 },
  { name: 'grab', action: 'grab', dur: 1.2, speed: 0, frames: 76 },
  { name: 'grabbed', action: 'grabbed', dur: 1.2, speed: 0, frames: 76 },
];

export const DT = 1 / 60;

/** A mock fighter set up for a scenario (frame 0). */
export function stateFor(id: AnimalId, sc: Scenario, inWater?: boolean): FighterState {
  const s = makeMockState(id);
  const def = ANIMALS[id];
  s.action = sc.action;
  s.actionT = 0;
  s.actionDur = sc.dur;
  const sp = sc.speed === null ? def.speed : sc.speed;
  s.vel.x = 0;
  s.vel.z = sp;
  s.vel.y = sc.vy ?? 0;
  s.pos.y = sc.y ?? 0;
  s.airborne = sc.airborne === true;
  s.glideT = 0;
  if (sc.ultPhase !== undefined) s.ultPhase = sc.ultPhase;
  if (sc.ultStage !== undefined) s.ultStage = sc.ultStage;
  if (inWater !== undefined) s.inWater = inWater;
  return s;
}

/** Advance the scenario state by one frame (action time + the action's own end). */
export function stepState(s: FighterState, sc: Scenario, dt = DT): void {
  s.actionT += dt;
  if (sc.dur > 0 && s.actionT > sc.dur) s.actionT = sc.dur;
}

/** FNV-1a over the bit patterns of every node's local transform below `rig.root` (+ visibility). */
export function transformHash(rig: BaseRig, acc: number): number {
  const f = new Float64Array(1);
  const u = new Uint32Array(f.buffer);
  let h = acc >>> 0;
  const mix = (v: number): void => {
    f[0] = v;
    h = Math.imul(h ^ u[0], 16777619) >>> 0;
    h = Math.imul(h ^ u[1], 16777619) >>> 0;
  };
  rig.root.traverse((o: THREE.Object3D) => {
    mix(o.position.x);
    mix(o.position.y);
    mix(o.position.z);
    mix(o.quaternion.x);
    mix(o.quaternion.y);
    mix(o.quaternion.z);
    mix(o.quaternion.w);
    mix(o.scale.x);
    mix(o.scale.y);
    mix(o.scale.z);
    h = Math.imul(h ^ (o.visible ? 1 : 2), 16777619) >>> 0;
  });
  return h;
}

/** Run one scenario on a fresh rig and hash every frame's pose. `inWater` is written to the state only when defined. */
export function scenarioHash(id: AnimalId, sc: Scenario, inWater?: boolean): string {
  const rig = AnimalFactory.createRig(id);
  const s = stateFor(id, sc, inWater);
  let h = 2166136261;
  for (let i = 0; i < sc.frames; i++) {
    rig.root.position.set(s.pos.x, s.pos.y, s.pos.z);
    rig.update(s, DT);
    h = transformHash(rig, h);
    stepState(s, sc);
  }
  rig.dispose();
  return h.toString(16);
}
