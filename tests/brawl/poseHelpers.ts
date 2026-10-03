/**
 * Shared helpers for the pose-layer tests: synthetic fighter snapshots, a frame driver for one BrawlRig and
 * per-frame measurements on the REAL joint nodes (rotation steps, tip positions, NaN checks).
 */

import * as THREE from 'three';
import type { AnimalId } from '../../src/core/types';
import type { BrawlAction, BrawlFighterState, MoveBody, MoveId } from '../../src/brawl/types';
import type { BrawlRig } from '../../src/brawl/render/pose/BrawlRig';
import { getMoveBody } from '../../src/brawl/data';
import { distToHitbox } from '../../src/brawl/render/pose/build';

export function mkState(animal: AnimalId, o: Partial<BrawlFighterState> = {}): BrawlFighterState {
  const base: BrawlFighterState = {
    id: 0,
    animal,
    isPlayer: true,
    alive: true,
    pos: { x: 0, y: 0 },
    vel: { x: 0, y: 0 },
    facing: 1,
    grounded: true,
    platformId: 'main',
    action: 'idle',
    actionFrame: 0,
    actionFrames: 0,
    moveId: null,
    moveChain: 0,
    moveAir: false,
    moveFrame: 0,
    moveFrames: 0,
    movePhase: null,
    dodgeCd: 0,
    hitstunTotal: 0,
    lastHitBy: -1,
    percent: 0,
    stocks: 3,
    jumpsLeft: 2,
    hitstun: 0,
    hitlag: 0,
    invuln: 0,
    lastLaunch: null,
    kos: 0,
    falls: 0,
    damageDealt: 0,
  };
  return { ...base, ...o, pos: { ...base.pos, ...(o.pos ?? {}) }, vel: { ...base.vel, ...(o.vel ?? {}) } };
}

export interface FrameLog {
  /** Move frame of this display frame (−1 outside the move). */
  k: number;
  /** Largest rotation step (rad) of any joint node since the previous frame. */
  step: number;
  tip: { x: number; y: number } | null;
}

/** Joint nodes of a rig (unique). */
export function nodesOf(rig: BrawlRig): THREE.Object3D[] {
  const set = new Set<THREE.Object3D>();
  for (const j of rig.rig.brawlJoints().values()) set.add(j.node);
  return [...set];
}

export class Recorder {
  private readonly nodes: THREE.Object3D[];
  private prevQ: THREE.Quaternion[] | null = null;
  readonly log: FrameLog[] = [];
  constructor(readonly rig: BrawlRig) {
    this.nodes = nodesOf(rig);
  }
  /** Sample after an `update`: records the largest joint rotation step since the last sample. */
  sample(k: number, withTip: boolean): FrameLog {
    let step = 0;
    if (this.prevQ === null) this.prevQ = this.nodes.map((n) => n.quaternion.clone());
    else {
      for (let i = 0; i < this.nodes.length; i++) {
        const q = this.nodes[i].quaternion;
        const d = Math.min(1, Math.abs(q.dot(this.prevQ[i])));
        step = Math.max(step, 2 * Math.acos(d));
        this.prevQ[i].copy(q);
      }
    }
    const e: FrameLog = { k, step, tip: withTip ? this.rig.tipFighterLocal('strike') : null };
    this.log.push(e);
    return e;
  }
}

export function hasNaN(rig: BrawlRig): boolean {
  rig.root.updateMatrixWorld(true);
  for (const n of nodesOf(rig)) {
    const q = n.quaternion;
    const p = n.position;
    const s = n.scale;
    if (![q.x, q.y, q.z, q.w, p.x, p.y, p.z, s.x, s.y, s.z].every(Number.isFinite)) return true;
  }
  const rp = rig.root.position;
  return ![rp.x, rp.y, rp.z].every(Number.isFinite);
}

export interface RunOpts {
  facing?: 1 | -1;
  pre?: number;
  post?: number;
  /** State after the move (default: idle on the ground, fall in the air). */
  postAction?: BrawlAction;
  /** State before the move (default: idle on the ground, fall in the air); `run` runs at `preVx` m/s. */
  preAction?: BrawlAction;
  preVx?: number;
  /** Display sub-steps per sim frame (2 = 120 Hz: alpha 0.5 then 1). */
  substeps?: number;
}

export interface RunResult {
  rec: Recorder;
  body: MoveBody;
  /** Index into rec.log of move frame 0. */
  moveStart: number;
  nan: boolean;
}

/** Idle (or fall) for `pre` frames → the whole move frame by frame → idle (or fall) for `post` frames. */
export function runMove(rig: BrawlRig, animal: AnimalId, moveId: MoveId, air: boolean, chain: number, opts: RunOpts = {}): RunResult {
  const facing = opts.facing ?? 1;
  const pre = opts.pre ?? 12;
  const post = opts.post ?? 14;
  const body = getMoveBody(animal, moveId, air, chain);
  const total = body.startup + body.active + body.recovery;
  const rec = new Recorder(rig);
  let prev: BrawlFighterState | null = null;
  let nan = false;
  const baseAction: BrawlAction = air ? 'fall' : 'idle';
  const y = air ? 3 : 0;
  const sub = opts.substeps ?? 1;
  const push = (cur: BrawlFighterState, k: number, withTip: boolean): void => {
    for (let i = 1; i <= sub; i++) {
      rig.update(cur, prev, i / sub, 1 / 60 / sub);
      if (hasNaN(rig)) nan = true;
      if (i === sub) rec.sample(k, withTip);
    }
    prev = cur;
  };
  const preAction = opts.preAction ?? baseAction;
  for (let i = 0; i < pre; i++) {
    push(
      mkState(animal, { facing, action: preAction, actionFrame: i, grounded: !air, pos: { x: 0, y }, vel: { x: preAction === 'run' ? (opts.preVx ?? 8) * facing : 0, y: air ? -2 : 0 } }),
      -1,
      false,
    );
  }
  const moveStart = rec.log.length;
  for (let k = 0; k < total; k++) {
    push(
      mkState(animal, {
        facing,
        action: 'attack',
        moveId,
        moveAir: air,
        moveChain: chain,
        moveFrame: k,
        moveFrames: total,
        actionFrame: k,
        actionFrames: total,
        grounded: !air,
        pos: { x: 0, y },
        vel: { x: 0, y: air ? -1 : 0 },
      }),
      k,
      true,
    );
  }
  const postAction = opts.postAction ?? baseAction;
  for (let i = 0; i < post; i++) {
    push(mkState(animal, { facing, action: postAction, actionFrame: i, grounded: !air, pos: { x: 0, y }, vel: { x: 0, y: air ? -2 : 0 } }), -1, false);
  }
  return { rec, body, moveStart, nan };
}

/** Minimum distance from the tip to the hitboxes active at move frame k (Infinity when none). */
export function tipToHitbox(body: MoveBody, k: number, tip: { x: number; y: number }): number {
  let best = Infinity;
  for (const h of body.hitboxes) if (k >= h.from && k < h.to) best = Math.min(best, distToHitbox(h, k, tip.x, tip.y));
  return best;
}
