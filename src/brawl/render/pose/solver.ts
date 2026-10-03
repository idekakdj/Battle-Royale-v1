/**
 * Forward-kinematics scratch rig per animal: the pose builder (build.ts) evaluates candidate DOF vectors against the
 * REAL rig geometry here (never on the live fighter rigs, whose blend state it would disturb) to fit the striking tip
 * into the move's hitbox. Rigs, compiled profiles and the move cache are shared by every BrawlRig of that animal.
 */

import * as THREE from 'three';
import type { AnimalId } from '../../../core/types';
import { AnimalFactory } from '../../../render/animals/AnimalFactory';
import type { BaseRig } from '../../../render/animals/Animator';
import { DOF_N, type DofVec } from './dof';
import { CompiledProfile, getRegisteredProfile, type AnimalProfile, type TipRole } from './profile';
import { makeAutoProfile } from './animals/generic';
import './animals';

export interface Solver {
  animal: AnimalId;
  rig: BaseRig;
  profile: AnimalProfile;
  cp: CompiledProfile;
}

const solvers = new Map<AnimalId, Solver>();

/** Profile for `animal` bound to a rig: the hand-written one, else the auto-generated generic one. */
export function resolveProfile(animal: AnimalId, rig: BaseRig): AnimalProfile {
  return getRegisteredProfile(animal) ?? makeAutoProfile(animal, rig);
}

export function getSolver(animal: AnimalId): Solver {
  let s = solvers.get(animal);
  if (s === undefined) {
    const rig = AnimalFactory.createRig(animal);
    const profile = resolveProfile(animal, rig);
    s = { animal, rig, profile, cp: new CompiledProfile(profile, rig.brawlJoints()) };
    solvers.set(animal, s);
  }
  return s;
}

/** Free the scratch rigs (tests / hot reload). */
export function disposeSolvers(): void {
  for (const s of solvers.values()) s.rig.dispose();
  solvers.clear();
}

const _tip = new THREE.Vector3();

/** Apply `v` (facing +1) to the scratch rig's joints. */
export function poseSolver(s: Solver, v: DofVec): void {
  for (const j of s.cp.joints.values()) j.reset();
  s.cp.expand(v, 1);
  for (const j of s.cp.touched) j.apply(1);
}

/**
 * Tip position in rig-local metres for the pose `v` (facing +1): `out.x` = lateral, `out.y` = up, `out.z` = forward.
 * Returns false when the role has no tip.
 */
export function tipOf(s: Solver, v: DofVec, role: TipRole, out: THREE.Vector3): boolean {
  const t = s.cp.tips.get(role);
  if (t === undefined) return false;
  poseSolver(s, v);
  t.j.node.updateWorldMatrix(true, false);
  _tip.copy(t.off).applyMatrix4(t.j.node.matrixWorld);
  out.copy(_tip);
  return true;
}

/** Max rotation angle (rad) between two poses over every touched joint (used by the smoothness validator). */
const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
const _ea = new THREE.Euler();

/** Per-joint Euler triples of pose `v`, appended into `out` (3 per touched joint). */
export function jointEulers(s: Solver, v: DofVec, out: Float64Array): void {
  for (const j of s.cp.joints.values()) j.reset();
  s.cp.expand(v, 1);
  let n = 0;
  for (const j of s.cp.touched) {
    out[n++] = j.rx;
    out[n++] = j.ry;
    out[n++] = j.rz;
  }
}

export function eulerStep(a: Float64Array, b: Float64Array, joint: number): number {
  const o = joint * 3;
  _ea.set(a[o], a[o + 1], a[o + 2], 'XYZ');
  _qa.setFromEuler(_ea);
  _ea.set(b[o], b[o + 1], b[o + 2], 'XYZ');
  _qb.setFromEuler(_ea);
  const d = Math.min(1, Math.abs(_qa.dot(_qb)));
  return 2 * Math.acos(d);
}

export const DOF_COUNT = DOF_N;
