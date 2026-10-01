/**
 * Crocodile DEATH ROLL pose driver (v1.3). Pure function of the fighter's state:
 * `ultPhase` (windup / active / recovery), `ultStage` (the sim's `CROC_STAGE` beats), `actionT`
 * (time since the cast) and `vel`. The only thing it keeps between frames is a little "where did
 * this beat start" bookkeeping derived from those same fields (`actionT` at the moment the stage
 * changed) plus a per-channel exponential follower so anticipation -> strike -> follow-through ->
 * recovery blend smoothly and never snap.
 *
 *   windup   CROUCH  body sinks, pulls back, tail curls, jaws gape and hiss (tremor)
 *            COMMIT  the crouch deepens and shudders (line locked)
 *   LUNGE    snap: body drives forward and flat, jaws wide, legs swept back, tail whips straight
 *   CLAMP    jaws slam shut (cubic), head + body shudder and decay
 *   DRAG     walks backwards hauling, head raised, tail sweeping
 *   ROLL1-3  the body rolls about its long axis (crocRollAngle, exactly 3 turns), jaws clamped,
 *            legs flail, tail whips against the roll
 *   TOSS     jaws fling open, head whips up, then the roll angle eases to rest (no spin-back)
 *   recovery exhale: slow breathing heave, mouth panting, legs relaxing
 *   WHIFF    braced slide with a missed-snap head shake
 *
 * Nothing here is added to the camera: the roll is a rig-local `body.rz` only (the FP agent keeps
 * the eye off it).
 */

import type { FighterState } from '../../../core/types';
import { CROC_STAGE, crocRollAngle } from '../../../config/ultimates/crocodile';
import { ANIMALS } from '../../../config/animals';
import type { Joint } from '../Animator';
import { easeInCubic, easeOutCubic, smooth01 } from '../Animator';

export interface CrocJoints {
  body: Joint;
  head: Joint;
  jaw: Joint;
  legs: Joint[];
  tail1: Joint;
  tail2: Joint;
  tail3: Joint;
}

// Channel indices of the follower bank.
const BPY = 0;
const BPZ = 1;
const BRX = 2;
const HRX = 3;
const JAW = 4;
const LEG0 = 5; // 5..8
const LSP = 9; // leg splay (extra rz)
const T1 = 10;
const T2 = 11;
const T3 = 12;
const N = 13;

const GAIT = [0, Math.PI, Math.PI, 0];
const TAU = Math.PI * 2;
const SPEC = ANIMALS.crocodile.ultimate;
const ROLL_DUR = SPEC.duration ?? 2.5;
const ROLL_HITS = SPEC.hits ?? 3;

export class CrocUltPose {
  private readonly cur = new Float32Array(N);
  private readonly tgt = new Float32Array(N);
  private readonly rate = new Float32Array(N);
  private key = -1;
  private t0 = 0;
  private lastT = 0;
  private rz = 0;
  private bodyS = 1;
  private readonly stageT0 = new Float32Array(16).fill(-1);

  /** Forget everything (new cast). */
  private reset(): void {
    this.cur.fill(0);
    this.key = -1;
    this.rz = 0;
    this.bodyS = 1;
    this.stageT0.fill(-1);
  }

  update(state: FighterState, dt: number, j: CrocJoints): void {
    const phase = state.ultPhase === 'recovery' ? 2 : state.ultPhase === 'active' ? 1 : 0;
    const stage = state.ultStage ?? 0;
    const T = state.actionT;
    if (T + 0.03 < this.lastT) this.reset();
    this.lastT = T;
    const key = phase * 16 + stage;
    if (key !== this.key) {
      this.key = key;
      this.t0 = T;
      if (this.stageT0[stage] < 0 || phase === 0) this.stageT0[stage] = T;
    }
    const ts = Math.max(0, T - this.t0);

    // Targets + follow rates (per channel), then additive, unsmoothed oscillation.
    const tg = this.tgt;
    const rt = this.rate;
    tg.fill(0);
    rt.fill(10);
    let headRy = 0;
    let headRz = 0;
    let bodyRz = 0;
    let bodyRy = 0;
    let jawAdd = 0;
    let headRxAdd = 0;
    let bodyPzAdd = 0;
    let bodyPyAdd = 0;
    const leg = [0, 0, 0, 0];
    let t1a = 0;
    let t2a = 0;
    let t3a = 0;
    let bodyS = 1;
    let rolling = false;
    let rollAngle = 0;

    if (phase === 0) {
      // ── Windup: coil, gape, hiss ─────────────────────────────────────────
      const commit = stage >= CROC_STAGE.COMMIT;
      const k = commit ? 1.14 : 1;
      tg[BPY] = -0.15 * k;
      tg[BPZ] = -0.24 * k;
      tg[BRX] = 0.05 * k;
      tg[HRX] = -0.16 * k;
      tg[JAW] = 0.95;
      tg[LSP] = 0.22 * k;
      for (let i = 0; i < 4; i++) tg[LEG0 + i] = (i < 2 ? 0.45 : -0.45) * k;
      tg[T1] = 0.55 * k;
      tg[T2] = 0.75 * k;
      tg[T3] = 0.95 * k;
      rt.fill(7);
      rt[JAW] = 5;
      const gape = smooth01(T / 0.4);
      jawAdd = Math.sin(T * 38) * 0.05 * gape; // hiss tremor
      t1a = Math.sin(T * 3.1) * 0.08;
      t2a = Math.sin(T * 3.1 - 0.9) * 0.1;
      t3a = Math.sin(T * 3.1 - 1.8) * 0.12;
      if (commit) {
        const s = smooth01(ts / 0.06);
        bodyRz = Math.sin(T * 61) * 0.028 * s; // shudder before the strike
        headRy = Math.sin(T * 47) * 0.03 * s;
      }
    } else if (stage === CROC_STAGE.LUNGE) {
      // ── Burst lunge: snap forward, flat, jaws wide ───────────────────────
      const snap = easeOutCubic(Math.min(1, ts / 0.07));
      tg[BPZ] = 0.55;
      tg[BPY] = -0.2;
      tg[BRX] = -0.08;
      tg[HRX] = -0.36;
      tg[JAW] = 1.32;
      tg[LSP] = 0.1;
      for (let i = 0; i < 4; i++) tg[LEG0 + i] = 0.95;
      rt.fill(24);
      rt[JAW] = 34;
      t1a = Math.sin(ts * 34) * 0.16 * snap;
      t2a = Math.sin(ts * 34 - 1) * 0.22 * snap;
      t3a = Math.sin(ts * 34 - 2) * 0.28 * snap;
    } else if (stage === CROC_STAGE.WHIFF && phase === 1) {
      // ── Missed: braced slide ─────────────────────────────────────────────
      tg[BPY] = -0.18;
      tg[BRX] = -0.1;
      tg[HRX] = 0.2;
      tg[JAW] = 0.25;
      for (let i = 0; i < 4; i++) tg[LEG0 + i] = -0.8;
      tg[LSP] = 0.3;
      rt.fill(20);
      headRy = Math.sin(ts * 38) * 0.2 * Math.exp(-ts * 4);
      t1a = Math.sin(ts * 12) * 0.3;
    } else if (stage === CROC_STAGE.CLAMP) {
      // ── Clamp: cubic jaw slam + shudder ──────────────────────────────────
      tg[BPZ] = 0.3;
      tg[BPY] = -0.17;
      tg[HRX] = 0.12;
      tg[JAW] = 0.03;
      tg[LSP] = 0.15;
      for (let i = 0; i < 4; i++) tg[LEG0 + i] = 0.15;
      rt.fill(14);
      rt[JAW] = 46;
      rt[BPZ] = 30;
      const d = Math.exp(-ts * 4.5);
      headRy = Math.sin(ts * 46) * 0.16 * d;
      bodyRz = Math.sin(ts * 40) * 0.07 * Math.exp(-ts * 4);
      headRxAdd = -0.1 * easeInCubic(Math.min(1, ts / 0.06)) * d;
      t1a = Math.sin(ts * 18) * 0.5 * Math.exp(-ts * 2);
      t2a = Math.sin(ts * 18 - 0.8) * 0.6 * Math.exp(-ts * 2);
      t3a = Math.sin(ts * 18 - 1.6) * 0.7 * Math.exp(-ts * 2);
    } else if (stage === CROC_STAGE.DRAG) {
      // ── Drag: backwards walk, head hauled up ─────────────────────────────
      tg[BPY] = -0.13;
      tg[BPZ] = 0.05;
      tg[HRX] = -0.3;
      tg[JAW] = 0.03;
      tg[LSP] = 0.2;
      rt.fill(12);
      rt[JAW] = 40;
      const env = smooth01(ts / 0.1);
      for (let i = 0; i < 4; i++) leg[i] = Math.sin(ts * 15 + GAIT[i]) * 0.6 * env;
      tg[LEG0] = tg[LEG0 + 1] = tg[LEG0 + 2] = tg[LEG0 + 3] = 0.15;
      headRy = Math.sin(ts * 10) * 0.12;
      bodyRz = Math.sin(ts * 13) * 0.05 * env;
      t1a = Math.sin(ts * 8) * 0.55;
      t2a = Math.sin(ts * 8 - 0.9) * 0.7;
      t3a = Math.sin(ts * 8 - 1.8) * 0.85;
    } else if (stage >= CROC_STAGE.ROLL1 && stage <= CROC_STAGE.ROLL3 && phase === 1) {
      // ── Death roll: rig rolls about its long axis ────────────────────────
      const t1 = this.stageT0[CROC_STAGE.ROLL1];
      const rollT = t1 >= 0 ? Math.max(0, T - t1) : 0;
      rolling = true;
      rollAngle = crocRollAngle(rollT / ROLL_DUR, ROLL_HITS);
      tg[BPY] = 0.12;
      tg[BPZ] = 0.1;
      tg[JAW] = 0.04;
      tg[LSP] = 0.3;
      for (let i = 0; i < 4; i++) tg[LEG0 + i] = 0.35;
      rt.fill(12);
      rt[JAW] = 40;
      const a = rollAngle;
      for (let i = 0; i < 4; i++) leg[i] = Math.sin(a * 1.5 + i * 1.7) * 0.35;
      headRy = Math.sin(a * 2) * 0.1;
      headRz = Math.sin(a * 3) * 0.06;
      bodyRy = Math.sin(a * 3) * 0.04;
      bodyPyAdd = 0.035 * Math.abs(Math.sin(a * 2));
      t1a = Math.sin(a * 0.5) * 0.55;
      t2a = Math.sin(a * 0.5 - 0.9) * 0.8;
      t3a = Math.sin(a * 0.5 - 1.8) * 1.0;
    } else {
      // ── Toss (recovery, stage TOSS) then exhale; or whiff recovery ───────
      const toss = stage === CROC_STAGE.TOSS;
      const fling = toss ? Math.exp(-ts * 7) : 0;
      tg[BPY] = -0.05 * smooth01(ts / 0.3);
      tg[BPZ] = 0.2 * fling;
      tg[HRX] = 0.14 * smooth01(ts / 0.4) - 0.6 * fling;
      tg[JAW] = 0.3 * smooth01(ts / 0.3) + 0.7 * fling;
      tg[LSP] = 0.1;
      for (let i = 0; i < 4; i++) tg[LEG0 + i] = 0.1;
      rt.fill(5.5);
      rt[JAW] = toss ? 28 : 8;
      rt[HRX] = toss ? 22 : 6;
      bodyS = 1 + 0.035 * Math.sin(ts * 7.5) * Math.exp(-ts * 1.1) * smooth01(ts / 0.15);
      if (!toss) headRy = Math.sin(ts * 9) * 0.1 * Math.exp(-ts * 1.5);
      else headRy = Math.sin(ts * 26) * 0.18 * fling;
      t1a = Math.sin(ts * 2.2) * 0.12;
      t2a = Math.sin(ts * 2.2 - 0.9) * 0.15;
      t3a = Math.sin(ts * 2.2 - 1.8) * 0.18;
    }

    // Follow the targets.
    const c = this.cur;
    for (let i = 0; i < N; i++) c[i] += (tg[i] - c[i]) * (1 - Math.exp(-rt[i] * dt));

    // Roll angle: exact while rolling; afterwards drop the whole turns and ease to rest (never spin back).
    if (rolling) this.rz = rollAngle;
    else {
      if (this.rz > Math.PI) this.rz -= TAU * Math.round(this.rz / TAU);
      this.rz *= Math.exp(-dt * 11);
      if (Math.abs(this.rz) < 1e-4) this.rz = 0;
    }
    this.bodyS += (bodyS - this.bodyS) * (1 - Math.exp(-dt * 10));

    j.body.py = c[BPY] + bodyPyAdd;
    j.body.pz = c[BPZ] + bodyPzAdd;
    j.body.rx = c[BRX];
    j.body.ry = bodyRy;
    j.body.rz = this.rz + bodyRz;
    j.body.s = this.bodyS;
    j.head.rx = c[HRX] + headRxAdd;
    j.head.ry = headRy;
    j.head.rz = headRz;
    j.jaw.rx = Math.max(0, c[JAW] + jawAdd);
    for (let i = 0; i < 4; i++) {
      j.legs[i].rx = c[LEG0 + i] + leg[i];
      j.legs[i].rz = (i % 2 === 0 ? -1 : 1) * c[LSP];
    }
    j.tail1.ry = c[T1] + t1a;
    j.tail2.ry = c[T2] + t2a;
    j.tail3.ry = c[T3] + t3a;
  }
}
