/**
 * Python COIL SNARE pose driver (v1.3). A pure function of the fighter's state — `ultPhase`,
 * `ultStage` (the sim's `PYTHON_STAGE` beats), `actionT` and `vel` — plus a per-channel exponential
 * follower (and "where did this beat start" bookkeeping derived from `actionT`) so anticipation ->
 * strike -> follow-through -> recovery blend smoothly and never snap. The segment chain is the
 * 4-link neck (`neckJ`): rearing straightens it, the lash spears it forward, the yank arches it back,
 * the squeeze leans it over the victim.
 *
 *   windup   REAR   neck straightens up into a cobra rear, jaws gape, hiss tremor, tongue flicks, sway
 *            COMMIT sway stops, the neck winds back and the chin tucks (aim frozen)
 *   LASH     neck spears forward (eased snap with overshoot), body drives, tail whips, jaws open then close
 *   SNARE    hauls: neck arches back, body recoils, coil compresses, strain tremor
 *   WRAP1-4  leaning over the victim; the coil twists tighter and squeezes harder per beat with a pulse
 *   CRUSH    coil snaps tight then rebounds, head jerks up, jaws open, tail flicks (recovery, stage 8)
 *   recovery settle: slow breathing, sway returning
 *   WHIFF    the tether snaps back: neck recoils
 */

import type { FighterState } from '../../../core/types';
import { PYTHON_STAGE } from '../../../config/ultimates/python';
import type { Joint } from '../Animator';
import { easeOutCubic, smooth01 } from '../Animator';

export interface PythonJoints {
  body: Joint;
  coil: Joint;
  neck: Joint[];
  head: Joint;
  jaw: Joint;
  tailTip: Joint;
  tongue: Joint;
}

// The neck rest curve (mirror of Python.ts NECK_REST) used to straighten / extend the chain.
const REST = [-0.55, 0.2, 0.38, 0.42];

const NK = 0; // 0..3
const HRX = 4;
const JAW = 5;
const COILS = 6; // coil scale - 1
const COILPY = 7;
const BPZ = 8;
const TAIL = 9;
const COILRY = 10;
const N = 11;

/** `neckExtend(k)` of Python.ts expressed as channel targets (k = 1 is a full forward spear). */
function extend(tg: Float32Array, k: number): void {
  tg[NK] = (1.55 - REST[0]) * 0.55 * k;
  for (let i = 1; i < 4; i++) tg[NK + i] = -REST[i] * k;
  tg[HRX] = -0.55 * k;
}

/** A neck held (almost) vertical: the cobra rear. Positive `lean` tips it forward, negative back. */
function rear(tg: Float32Array, lean: number): void {
  tg[NK] = -REST[0] * 0.9 + lean;
  for (let i = 1; i < 4; i++) tg[NK + i] = -REST[i] * 0.9;
}

export class PythonUltPose {
  private readonly cur = new Float32Array(N);
  private readonly tgt = new Float32Array(N);
  private readonly rate = new Float32Array(N);
  private key = -1;
  private t0 = 0;
  private lastT = 0;

  private reset(): void {
    this.cur.fill(0);
    this.key = -1;
  }

  update(state: FighterState, dt: number, j: PythonJoints): void {
    const phase = state.ultPhase === 'recovery' ? 2 : state.ultPhase === 'active' ? 1 : 0;
    const stage = state.ultStage ?? 0;
    const T = state.actionT;
    if (T + 0.03 < this.lastT) this.reset();
    this.lastT = T;
    const key = phase * 16 + stage;
    if (key !== this.key) {
      this.key = key;
      this.t0 = T;
    }
    const ts = Math.max(0, T - this.t0);

    const tg = this.tgt;
    const rt = this.rate;
    tg.fill(0);
    rt.fill(9);
    let sway = 0; // neck lateral sway amplitude
    let tremor = 0; // head pitch hiss tremor
    let jawAdd = 0;
    let tailAdd = 0;
    let bodyRy = 0;
    let headRy = 0;
    let flick = 0; // tongue rate
    let neckAdd = 0; // strain tremor on the chain
    let coilSAdd = 0;
    let coilRyAdd = 0;

    if (phase === 0) {
      // ── Windup: cobra rear, gape, hiss ───────────────────────────────────
      const commit = stage >= PYTHON_STAGE.COMMIT;
      rear(tg, commit ? -0.3 : -0.14);
      tg[HRX] = commit ? 0.3 : 0.05;
      tg[JAW] = commit ? 0.65 : 1.0;
      tg[COILS] = commit ? 0.05 : 0.03;
      tg[COILPY] = 0.07;
      tg[BPZ] = commit ? -0.2 : -0.12;
      tg[TAIL] = commit ? 0.5 : 0;
      rt.fill(6);
      rt[JAW] = 7;
      const gape = smooth01(T / 0.35);
      sway = (commit ? 0.05 : 0.12) * smooth01(T / 0.3);
      tremor = commit ? 0 : Math.sin(T * 40) * 0.035 * gape;
      jawAdd = commit ? 0 : Math.sin(T * 34) * 0.06 * gape;
      tailAdd = Math.sin(T * 30) * 0.45 * (commit ? 0.3 : 1) * gape; // rattle
      flick = commit ? 9 : 13;
      headRy = Math.sin(T * 2.3) * (commit ? 0.05 : 0.18);
      neckAdd = commit ? Math.sin(T * 52) * 0.012 * smooth01(ts / 0.05) : 0;
    } else if (stage === PYTHON_STAGE.LASH) {
      // ── Lash: the neck spears out, tail whips ────────────────────────────
      const ext = easeOutCubic(Math.min(1, ts / 0.1));
      const settle = smooth01((ts - 0.1) / 0.2);
      extend(tg, (1.12 - 0.12 * settle) * ext);
      tg[BPZ] = 0.4 * ext;
      tg[COILS] = -0.05 * ext;
      tg[JAW] = ts < 0.22 ? 1.0 : 0.25;
      tg[COILPY] = -0.02 * ext;
      rt.fill(26);
      rt[JAW] = 30;
      tailAdd = 1.3 * Math.sin(Math.min(1, ts / 0.24) * Math.PI);
      tg[TAIL] = -0.3 * ext;
      neckAdd = Math.sin(ts * 38) * 0.02 * settle;
      flick = 18;
    } else if (stage === PYTHON_STAGE.WHIFF && phase === 1) {
      // ── Missed: the tether snaps back ────────────────────────────────────
      rear(tg, -0.35);
      tg[HRX] = 0.3;
      tg[JAW] = 0.2;
      tg[BPZ] = -0.15;
      tg[COILS] = 0.06;
      rt.fill(16);
      tailAdd = -0.6 * Math.exp(-ts * 5);
      neckAdd = Math.sin(ts * 30) * 0.03 * Math.exp(-ts * 5);
    } else if (stage === PYTHON_STAGE.SNARE) {
      // ── Snare / yank: hauling the victim in ──────────────────────────────
      tg[NK] = 0.05;
      for (let i = 1; i < 4; i++) tg[NK + i] = 0.2;
      tg[HRX] = 0.3;
      tg[BPZ] = -0.3;
      tg[COILS] = -0.08;
      tg[COILPY] = -0.03;
      tg[JAW] = 0.35;
      tg[TAIL] = -0.5;
      rt.fill(16);
      neckAdd = Math.sin(ts * 34) * 0.03 * smooth01(ts / 0.15);
      coilSAdd = Math.sin(ts * 22) * 0.012;
      flick = 10;
    } else if (stage >= PYTHON_STAGE.WRAP1 && stage <= PYTHON_STAGE.WRAP4 && phase === 1) {
      // ── Bind: leaning over the victim, squeezing harder each pulse ───────
      const lvl = stage - PYTHON_STAGE.WRAP1 + 1; // 1..4
      const p = easeOutCubic(Math.min(1, ts / 0.12)) * (1 - 0.4 * smooth01((ts - 0.12) / 0.4));
      extend(tg, 0.6);
      tg[HRX] = 0.25;
      tg[JAW] = 0.12;
      tg[BPZ] = 0.12 + 0.03 * lvl;
      tg[COILPY] = 0.05 + 0.02 * lvl;
      tg[COILS] = -0.03 * lvl;
      tg[COILRY] = 0.12 * lvl;
      rt.fill(12);
      rt[COILS] = 22;
      rt[COILRY] = 14;
      coilSAdd = -(0.035 + 0.015 * lvl) * p;
      coilRyAdd = 0.08 * p;
      jawAdd = Math.sin(T * 24) * 0.05;
      headRy = Math.sin(T * 3.2) * 0.2;
      bodyRy = Math.sin(ts * 26) * 0.02 * p;
      neckAdd = Math.sin(ts * 30) * 0.02 * p;
      flick = 7;
    } else {
      // ── Crush (recovery, stage CRUSH) then settle; whiff recovery ────────
      const crush = stage === PYTHON_STAGE.CRUSH;
      const f = crush ? Math.exp(-ts * 6) : 0;
      const snap = crush ? easeOutCubic(Math.min(1, ts / 0.06)) : 0;
      tg[COILS] = -0.2 * snap * f + 0.05 * f * (1 - snap);
      tg[HRX] = -0.45 * f;
      tg[NK] = 0.1 * f;
      tg[JAW] = 0.85 * f + 0.1;
      tg[TAIL] = 0.8 * f;
      tg[COILRY] = 0.3 * f;
      tg[BPZ] = 0.1 * f;
      rt.fill(crush ? 10 : 4.5);
      if (crush) {
        rt[COILS] = 34;
        rt[HRX] = 24;
        rt[JAW] = 26;
      }
      sway = 0.1 * smooth01(ts / 0.6);
      headRy = Math.sin(ts * 2.4) * 0.12 * smooth01(ts / 0.5);
      coilSAdd = Math.sin(ts * 6.5) * 0.025 * Math.exp(-ts * 1.3) * smooth01(ts / 0.15);
      flick = 10;
    }

    const c = this.cur;
    for (let i = 0; i < N; i++) c[i] += (tg[i] - c[i]) * (1 - Math.exp(-rt[i] * dt));

    for (let i = 0; i < 4; i++) {
      j.neck[i].rx = c[NK + i] + neckAdd * (1 - i * 0.2);
      j.neck[i].ry = Math.sin(T * 2.2 - i * 0.5) * sway;
    }
    j.head.rx = c[HRX] + tremor;
    j.head.ry = headRy;
    j.jaw.rx = Math.max(0, c[JAW] + jawAdd);
    j.coil.s = 1 + c[COILS] + coilSAdd;
    j.coil.py = c[COILPY];
    j.coil.ry = c[COILRY] + coilRyAdd;
    j.body.pz = c[BPZ];
    j.body.ry = bodyRy;
    j.tailTip.ry = c[TAIL] + tailAdd;
    j.tongue.s = flick > 0 ? 0.001 + smooth01(Math.sin(T * flick) * 6 - 3.5) * 1.05 : 0.001;
  }
}
