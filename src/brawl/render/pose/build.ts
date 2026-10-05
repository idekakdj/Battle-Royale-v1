/**
 * Move builder: MoveBody (+ animal profile) → {@link BuiltMove}, a DOF-space {@link Timeline} that is a pure function of
 * the continuous move frame.
 *
 *  1. the archetype generator names a strike template + free DOFs;
 *  2. the free DOFs are solved (pattern search over real forward kinematics) so the striking tip sits inside the
 *     move's hitbox on the first active frame and follows it across the active window;
 *  3. keys: rest → anticipation (ease out) → [pre-strike keys] → strike (ease in, peak EXACTLY on the first active frame)
 *     → hold through the active window → follow-through overshoot → settle (ease in-out) → rest;
 *  4. a smoothness repair loop shortens the anticipation until the per-frame angular steps fit the budget.
 *
 * Built moves are cached per (MoveBody, animal, air).
 */

import * as THREE from 'three';
import type { AnimalId } from '../../../core/types';
import type { HitboxDef, MoveBody } from '../../types';
import { AIR_TUCK, ARCHETYPES, makeCtx } from './archetypes';
import { DOF, DOF_N, copyVec, newVec, swapSides, vecOf, type DofName, type DofVec } from './dof';
import type { ArchSpec, FreeVar, TipRole } from './profile';
import { eulerStep, getSolver, jointEulers, tipOf, type Solver } from './solver';
import { Timeline, type Key } from './timeline';
import { applyWindup, moveWeight, windupAmp } from './windup';

/** Per-frame angular budgets (rad): normal frames and strike frames (the step into the peak + the active window). */
/** Largest root squash a grounded crouch may turn into. */
const MAX_SQUASH = 0.22;
export const STEP_NORMAL = 0.5;
export const STEP_STRIKE = 0.9;
/** WP-P: per-frame budget (m) of the body translation DOFs (`bodyFwd` / `bodyUp`): normal frames and strike frames. */
export const POS_NORMAL = 0.26;
export const POS_STRIKE = 0.34;

/** Frames over which a move that starts from the idle pose blends in (shorter for very fast moves). */
export function entryBlendFrames(strikeFrame: number): number {
  return strikeFrame >= 6 ? 3 : strikeFrame >= 4 ? 2 : 1;
}

/** Blend weight of the move pose at move frame `k` (0 = first frame) for an entry blend of `bf` frames (matches `BaseRig.brawlApply`). */
export function entryBlend(k: number, bf: number): number {
  if (bf <= 0) return 1;
  const t = (k + 1) / bf;
  if (t >= 1) return 1;
  return 0.5 * t + 0.5 * t * t * (3 - 2 * t);
}

export interface FitSample {
  frame: number;
  /** Distance (m) from the tip to the target point after the fit. */
  err: number;
  /** Target point (fighter-local forward, up). */
  tx: number;
  ty: number;
}

export interface BuiltMove {
  animal: AnimalId;
  body: MoveBody;
  air: boolean;
  archetype: MoveBody['archetype'];
  /** Frame of the strike peak = the first active frame. */
  strikeFrame: number;
  /** First frame AFTER the active window. */
  activeEnd: number;
  total: number;
  /** The tip that has to reach the hitbox (camera-relative role, facing +1 naming). */
  tip: TipRole;
  timeline: Timeline;
  /** The peak (strike) pose. */
  peak: DofVec;
  fit: FitSample[];
  /** Largest per-frame joint step of the finished timeline outside / inside the strike window (rad). */
  maxStep: number;
  maxStrikeStep: number;
  /** Frames over which the entry blend may run before the anticipation is reached (≥ 2 on every move). */
  anticipationEnd: number;
  /** WP-P: move weight (0 light … 1 heavy) and the strength of the generic wind-up layer derived from it. */
  weight: number;
  windupAmp: number;
}

// ── Target geometry ────────────────────────────────────────────────────────────

function pathOffset(h: HitboxDef, g: number, out: { x: number; y: number }): void {
  const p = h.path;
  if (p === undefined || p.length === 0) {
    out.x = 0;
    out.y = 0;
    return;
  }
  if (g <= p[0].frame) {
    out.x = p[0].x;
    out.y = p[0].y;
    return;
  }
  const last = p[p.length - 1];
  if (g >= last.frame) {
    out.x = last.x;
    out.y = last.y;
    return;
  }
  for (let i = 0; i < p.length - 1; i++) {
    const a = p[i];
    const b = p[i + 1];
    if (g >= a.frame && g <= b.frame) {
      const t = b.frame > a.frame ? (g - a.frame) / (b.frame - a.frame) : 0;
      out.x = a.x + (b.x - a.x) * t;
      out.y = a.y + (b.y - a.y) * t;
      return;
    }
  }
}

const _po = { x: 0, y: 0 };

export function hitboxCentre(h: HitboxDef, g: number, out: { x: number; y: number }): void {
  pathOffset(h, g, _po);
  out.x = h.x + _po.x;
  out.y = h.y + _po.y;
}

/** Distance from (px, py) to the hitbox shape at frame g (0 inside). */
export function distToHitbox(h: HitboxDef, g: number, px: number, py: number): number {
  hitboxCentre(h, g, _c);
  if (h.shape === 'circle') return Math.max(0, Math.hypot(px - _c.x, py - _c.y) - h.r);
  const dx = Math.max(0, Math.abs(px - _c.x) - h.w / 2);
  const dy = Math.max(0, Math.abs(py - _c.y) - h.h / 2);
  return Math.hypot(dx, dy);
}

const _c = { x: 0, y: 0 };

/** Nearest point of the hitbox's CORE (shape shrunk to ~60 %) to (px, py) at frame g. */
function coreTarget(h: HitboxDef, g: number, px: number, py: number, out: { x: number; y: number }): void {
  hitboxCentre(h, g, _c);
  if (h.shape === 'circle') {
    const rc = h.r * 0.6;
    const dx = px - _c.x;
    const dy = py - _c.y;
    const d = Math.hypot(dx, dy);
    if (d <= rc || d < 1e-9) {
      out.x = px;
      out.y = py;
    } else {
      out.x = _c.x + (dx / d) * rc;
      out.y = _c.y + (dy / d) * rc;
    }
    return;
  }
  const hx = (h.w / 2) * 0.6;
  const hy = (h.h / 2) * 0.6;
  out.x = Math.min(_c.x + hx, Math.max(_c.x - hx, px));
  out.y = Math.min(_c.y + hy, Math.max(_c.y - hy, py));
}

function activeAt(body: MoveBody, g: number): HitboxDef[] {
  return body.hitboxes.filter((h) => g >= h.from && g < h.to);
}

// ── Pattern-search fit ─────────────────────────────────────────────────────────

interface Bounded extends FreeVar {
  lo: number;
  hi: number;
}

const _tipV = new THREE.Vector3();

type Finisher = (v: DofVec, out: DofVec) => DofVec;

const _fin = newVec();

/** Tip of the FINISHED pose (side swap, air tuck, crouch → squash applied) in fighter-local metres (forward, up). */
function tipFinished(s: Solver, fin: Finisher, v: DofVec, role: TipRole, out: THREE.Vector3): boolean {
  fin(v, _fin);
  if (!tipOf(s, _fin, role, out)) return false;
  const sq = _fin[DOF.rootSquash];
  out.y *= 1 - sq;
  out.z *= 1 + 0.5 * sq;
  return true;
}

function costOf(s: Solver, fin: Finisher, v: DofVec, role: TipRole, tx: number, ty: number, free: Bounded[], x0: number[]): number {
  if (!tipFinished(s, fin, v, role, _tipV)) return 1e9;
  // A small tolerance keeps the authored template where it already reaches (tip inside the hitbox core).
  let c = Math.max(0, Math.hypot(_tipV.z - tx, _tipV.y - ty) - 0.1);
  for (let i = 0; i < free.length; i++) {
    const r = free[i].hi - free[i].lo;
    if (r > 1e-9) {
      const d = (v[DOF[free[i].d]] - x0[i]) / r;
      c += 0.05 * d * d;
    }
  }
  return c;
}

function setFree(v: DofVec, f: Bounded, x: number): void {
  v[DOF[f.d]] = x;
  if (f.tie) for (const t of f.tie) v[DOF[t]] = x;
}

/** Improve the free DOFs of `v` (in place) so the finished tip approaches (tx, ty); returns the final tip distance. */
function fit(s: Solver, fin: Finisher, v: DofVec, role: TipRole, tx: number, ty: number, free: Bounded[]): number {
  const x0 = free.map((f) => v[DOF[f.d]]);
  const step = free.map((f) => (f.hi - f.lo) * 0.2);
  let best = costOf(s, fin, v, role, tx, ty, free, x0);
  for (let iter = 0; iter < 60; iter++) {
    let improved = false;
    for (let i = 0; i < free.length; i++) {
      const f = free[i];
      const cur = v[DOF[f.d]];
      let bestX = cur;
      for (const dir of [1, -1]) {
        const nx = Math.min(f.hi, Math.max(f.lo, cur + dir * step[i]));
        if (nx === cur) continue;
        setFree(v, f, nx);
        const c = costOf(s, fin, v, role, tx, ty, free, x0);
        if (c < best - 1e-6) {
          best = c;
          bestX = nx;
          improved = true;
        }
      }
      setFree(v, f, bestX);
    }
    if (!improved) {
      let small = true;
      for (let i = 0; i < free.length; i++) {
        step[i] *= 0.5;
        if (step[i] > (free[i].hi - free[i].lo) * 0.004) small = false;
      }
      if (small) break;
    }
  }
  if (!tipFinished(s, fin, v, role, _tipV)) return 1e9;
  return Math.hypot(_tipV.z - tx, _tipV.y - ty);
}

// ── Build ──────────────────────────────────────────────────────────────────────

let cache = new WeakMap<MoveBody, Map<string, BuiltMove>>();

const TAIL_LAG: Partial<Record<DofName, number>> = { tailPitch: 2, tailYaw: 2, tail2Pitch: 3.5, tail2Yaw: 3.5 };

function oppositeRole(r: TipRole): TipRole {
  switch (r) {
    case 'foreNear':
      return 'foreFar';
    case 'foreFar':
      return 'foreNear';
    case 'hindNear':
      return 'hindFar';
    case 'hindFar':
      return 'hindNear';
    case 'wingNear':
      return 'wingFar';
    case 'wingFar':
      return 'wingNear';
    default:
      return r;
  }
}

export function getBuilt(animal: AnimalId, body: MoveBody, air: boolean, chain = 0): BuiltMove {
  let m = cache.get(body);
  if (m === undefined) {
    m = new Map();
    cache.set(body, m);
  }
  const key = `${animal}|${air ? 1 : 0}`;
  let b = m.get(key);
  if (b === undefined) {
    b = buildMove(animal, body, air, chain);
    m.set(key, b);
  }
  return b;
}

/** Drop every cached built move (tests / profile hot reload). */
export function clearBuilt(): void {
  cache = new WeakMap();
}

function firstActive(body: MoveBody): number {
  if (body.hitboxes.length === 0) return body.startup;
  let f = Infinity;
  for (const h of body.hitboxes) f = Math.min(f, h.from);
  return Number.isFinite(f) ? f : body.startup;
}

function activeEndOf(body: MoveBody, strike: number): number {
  let e = strike + 1;
  for (const h of body.hitboxes) e = Math.max(e, h.to);
  return e;
}

export function buildMove(animal: AnimalId, body: MoveBody, air: boolean, chain: number): BuiltMove {
  const solver = getSolver(animal);
  const prof = solver.profile;
  const strikeF = firstActive(body);
  const activeEnd = activeEndOf(body, strikeF);
  const total = Math.max(body.startup + body.active + body.recovery, activeEnd + 1);
  const recovery = Math.max(1, total - activeEnd);

  // ── target point at the first active frame ──
  const anim = body.anim ?? {};
  const act0 = activeAt(body, strikeF);
  const main = act0.length > 0 ? act0.reduce((a, h) => (h.damage > a.damage ? h : a), act0[0]) : null;
  const P = { x: 0, y: 0 };
  if (typeof anim.reach === 'number' && typeof anim.height === 'number') {
    P.x = anim.reach as number;
    P.y = anim.height as number;
  } else if (main !== null) {
    hitboxCentre(main, strikeF, P);
  } else {
    P.x = 1.2;
    P.y = 1;
  }
  const ctx = makeCtx(prof, body, air, chain, (r) => solver.cp.hasTip(r), P);
  const gen = prof.overrides?.[body.archetype] ?? ARCHETYPES[body.archetype];
  const spec: ArchSpec = gen(ctx);
  const swap = spec.swap === true;
  const solveRole: TipRole = solver.cp.hasTip(spec.tip) ? spec.tip : 'body';
  const actualRole: TipRole = swap ? oppositeRole(solveRole) : solveRole;

  // ── free variables: drop undriven DOFs, intersect with the profile limits ──
  const free: Bounded[] = [];
  for (const f of spec.free) {
    if (!solver.cp.drives(f.d)) continue;
    const lim = prof.limits?.[f.d];
    const lo = lim ? Math.max(lim[0], f.lo) : f.lo;
    const hi = lim ? Math.min(lim[1], f.hi) : f.hi;
    if (hi - lo > 1e-6) free.push({ ...f, lo, hi });
  }

  // ── sample frames across the active window ──
  const frames: number[] = [strikeF];
  // (WP-A3: a move with `mid` keys owns its active-window motion; no intermediate tracking samples are inserted.)
  const needsTrack =
    spec.mid === undefined &&
    (body.hitboxes.some((h) => h.path !== undefined && h.path.length > 1) ||
      body.hitboxes.some((h) => h.from > strikeF) ||
      spec.drift !== undefined);
  if (needsTrack && activeEnd - 1 > strikeF) {
    const span = activeEnd - 1 - strikeF;
    const n = Math.min(span, 5);
    for (let i = 1; i <= n; i++) frames.push(Math.round(strikeF + (span * i) / n));
  }
  const uniq = [...new Set(frames)].sort((a, b) => a - b);

  // ── finishing: side swap, air tuck, crouch → squash ──
  const airTuck = air ? vecOf(AIR_TUCK) : newVec();
  // WP-A3: the profile's constant neutral overlay (eagle: the wings rest at full span but the neutral is folded).
  const neutralSpec = air ? (prof.neutralAir ?? prof.neutral) : prof.neutral;
  const neutralV = neutralSpec !== undefined ? vecOf(neutralSpec) : newVec();
  const finishInto: Finisher = (v, out) => {
    if (out !== v) out.set(v);
    if (swap) swapSides(out, out);
    for (let i = 0; i < DOF_N; i++) out[i] += airTuck[i] + neutralV[i];
    // The legs are rigid: a grounded crouch lowers the hips through the floor, so it becomes a root squash instead.
    const bu = DOF.bodyUp;
    if (!air && out[bu] < 0) {
      const hh = prof.hipHeight ?? 0.9;
      out[DOF.rootSquash] += Math.min(MAX_SQUASH, -out[bu] / hh);
      out[bu] = 0;
    }
    return out;
  };
  const finish = (v: DofVec): DofVec => finishInto(v, newVec());

  // ── solve B_i ──
  const noFit = spec.noFit === true || main === null;
  const base = vecOf(spec.B);
  const solved: DofVec[] = [];
  const fitSamples: FitSample[] = [];
  const near = { x: 0, y: 0 };
  const tgt = { x: 0, y: 0 };
  // Displacement of the reference hitbox over the active window (carries anim.reach/height along sweeping boxes).
  const c0 = { x: 0, y: 0 };
  if (main !== null) hitboxCentre(main, strikeF, c0);
  let prev: DofVec = base;
  for (let i = 0; i < uniq.length; i++) {
    const g = uniq[i];
    const v = copyVec(prev);
    if (i === 0 && spec.B !== undefined) v.set(base);
    if (!noFit) {
      const act = activeAt(body, g);
      let px = P.x;
      let py = P.y;
      if (main !== null) {
        hitboxCentre(main, g, near);
        px += near.x - c0.x;
        py += near.y - c0.y;
      }
      let bestD = Infinity;
      tgt.x = px;
      tgt.y = py;
      for (const h of act.length > 0 ? act : [main as HitboxDef]) {
        coreTarget(h, g, px, py, near);
        const d = Math.hypot(near.x - px, near.y - py);
        if (d < bestD) {
          bestD = d;
          tgt.x = near.x;
          tgt.y = near.y;
        }
      }
      const err = fit(solver, finishInto, v, actualRole, tgt.x, tgt.y, free);
      fitSamples.push({ frame: g, err, tx: tgt.x, ty: tgt.y });
    }
    solved.push(v);
    prev = v;
  }

  // ── timeline ──
  const B0 = solved[0];
  const Bl = solved[solved.length - 1];
  const drift = spec.drift !== undefined ? vecOf(spec.drift) : null;
  const Zv = finish(newVec());
  const endV = finish(spec.end !== undefined ? vecOf(spec.end) : newVec());

  const lag = new Float64Array(DOF_N);
  if (actualRole !== 'tail') for (const k in TAIL_LAG) lag[DOF[k as DofName]] = TAIL_LAG[k as DofName] as number;

  // WP-P: weight-scaled wind-up (see windup.ts) and follow-through knobs, all derived from the move data.
  const weight = moveWeight(body, strikeF);
  const wAmp = windupAmp(weight, strikeF);
  const assemble = (La: number, ampA: number, pow: number, useLoad = true): Key[] => {
    const keys: Key[] = [{ f: 0, v: Zv, ease: 'lin' }];
    const A = vecOf(spec.A(B0));
    if (spec.script !== undefined) {
      // WP-B2: an authored script replaces the anticipation / load / pre keys and the wind-up layer entirely.
      for (const s of spec.script) {
        if (s.f <= 0.01 || s.f >= strikeF - 0.01) continue;
        const sv = vecOf(typeof s.v === 'function' ? s.v(B0) : s.v);
        keys.push({ f: s.f, v: finish(sv), ease: s.ease ?? 'inout', pow: s.pow });
      }
      for (let i = 0; i < DOF_N; i++) A[i] *= ampA;
      keys.push({ f: strikeF, v: finish(B0), ease: spec.strikeEase ?? 'inout', pow: spec.strikePow });
    } else {
      applyWindup(A, B0, ctx, spec, prof, solveRole, { weight, amp: wAmp });
      for (let i = 0; i < DOF_N; i++) A[i] *= ampA;
      if (La >= 0.05) keys.push({ f: La, v: finish(A), ease: 'out', pow: Math.max(1, Math.min(1.7, pow + 0.25)) });
      // "Load": a slightly deeper coil just before the release, so the wind-up keeps building instead of parking.
      const Rl = useLoad && strikeF >= 8 && wAmp > 0.25 && La >= 0.05 ? Math.min(3.5, Math.max(1.5, 0.2 * strikeF)) : 0;
      if (Rl > 0 && strikeF - Rl > La + 0.75) {
        const L = copyVec(A);
        for (let i = 0; i < DOF_N; i++) L[i] = A[i] * (1 + 0.14 * wAmp);
        keys.push({ f: strikeF - Rl, v: finish(L), ease: 'inout' });
      }
      if (spec.pre) {
        for (const p of spec.pre) {
          const pf = Math.max(La + 0.25, strikeF - p.before);
          if (pf < strikeF - 0.01) {
            const pv = vecOf(p.v(B0));
            keys.push({ f: pf, v: finish(pv), ease: 'inout' });
          }
        }
      }
      keys.push({ f: strikeF, v: finish(B0), ease: 'in', pow });
    }
    for (let i = 1; i < solved.length; i++) {
      let v = solved[i];
      if (drift !== null && i === solved.length - 1) {
        v = copyVec(v);
        addPartialVec(v, drift);
      } else if (drift !== null) {
        v = copyVec(v);
        addPartialVec(v, drift, (uniq[i] - strikeF) / Math.max(1, uniq[uniq.length - 1] - strikeF));
      }
      keys.push({ f: uniq[i], v: finish(v), ease: 'inout' });
    }
    // WP-A3: extra keys inside the active window (periodic beats / pulses) on top of the tracked strike pose.
    if (spec.mid) {
      const span = uniq.length > 1 ? Math.max(1, uniq[uniq.length - 1] - strikeF) : Math.max(1, activeEnd - strikeF);
      for (const m of spec.mid) {
        const f = strikeF + m.at;
        if (f <= strikeF + 0.01 || f >= activeEnd - 0.01) continue;
        let i = 0;
        while (i < uniq.length - 2 && f >= uniq[i + 1]) i++;
        const a = solved[i];
        const b = solved[Math.min(i + 1, solved.length - 1)];
        const sp = uniq.length > 1 ? Math.min(1, Math.max(0, (f - uniq[i]) / Math.max(1e-6, uniq[Math.min(i + 1, uniq.length - 1)] - uniq[i]))) : 0;
        const mv = newVec();
        for (let d = 0; d < DOF_N; d++) mv[d] = a[d] + (b[d] - a[d]) * sp;
        if (drift !== null) addPartialVec(mv, drift, (f - strikeF) / span);
        addPartialVec(mv, vecOf(m.v));
        keys.push({ f, v: finish(mv), ease: 'inout' });
      }
    }
    // Hold the last strike pose until the first frame after the active window, then follow through and settle.
    const lastStrike = drift !== null ? addPartialVec(copyVec(Bl), drift) : Bl;
    const lastF = Math.max(uniq[uniq.length - 1], activeEnd - 1);
    if (activeEnd > lastF + 0.5 || drift === null) keys.push({ f: activeEnd, v: finish(lastStrike), ease: 'lin' });
    // A move that finishes a whole turn (spins, rolls) needs a longer, gentler spin-down (WP-P: cap 14 instead of 7 frames).
    const ft = Math.min(Math.max(2, recovery * (spec.ftFrac ?? 0.2)), Math.max(2, recovery * 0.6), spec.end !== undefined ? 14 : 7);
    // Heavier moves overshoot more and COMMIT: the overshoot is held (a slow creep) for part of the recovery before the settle.
    const ov = (spec.over ?? 0.1) * (1 + 0.7 * weight);
    const O = copyVec(lastStrike);
    for (let i = 0; i < DOF_N; i++) O[i] += (lastStrike[i] - A[i]) * ov;
    if (spec.end !== undefined) for (const k in spec.end) O[DOF[k as DofName]] = spec.end[k as DofName] as number;
    keys.push({ f: activeEnd + ft, v: finish(O), ease: 'out' });
    const dwell = recovery * (spec.commit ?? 0.3 * weight);
    if (dwell > 0.75 && activeEnd + ft + dwell < total - 2) {
      const Df = finish(O);
      for (let i = 0; i < DOF_N; i++) Df[i] += (endV[i] - Df[i]) * 0.1;
      keys.push({ f: activeEnd + ft + dwell, v: Df, ease: 'inout' });
    }
    keys.push({ f: total, v: endV, ease: spec.settleEase ?? 'inout', pow: spec.settlePow });
    keys.sort((a, b) => a.f - b.f);
    return keys;
  };

  // ── smoothness repair loop ──
  // The measured pose is what reaches the screen: the entry blend from the rest/idle pose (see `entryBlend`) times the timeline.
  // Candidates (anticipation amplitude, anticipation end, strike-ease exponent) run from the most expressive to the plainest;
  // the first one that fits the per-frame angular budget wins.
  const La0 = strikeF <= 2 ? Math.max(0.5, strikeF * 0.5) : Math.min(Math.max(0.55 * strikeF, 1.5), Math.max(1.0, strikeF - 1.2));
  const bf = entryBlendFrames(strikeF);
  const tries: [number, number, number, boolean][] = [];
  if (spec.script !== undefined) tries.push([spec.script.length > 0 ? spec.script[0].f : 0, 1, 1.45, false]); // an authored script is built once, as written
  else for (const amp of [1, 0.7, 0.4, 0.15, 0]) for (const lf of [1, 0.6, 0.2]) for (const pow of [1.45, 1.2, 1.0]) for (const ld of [true, false]) tries.push([lf === 0.2 && La0 < 3 ? 0 : La0 * lf, amp, pow, ld]);
  let best: { tl: Timeline; maxStep: number; maxStrike: number; score: number; La: number } | null = null;
  const nTouched = solver.cp.touched.length;
  const eA = new Float64Array(nTouched * 3);
  const eB = new Float64Array(nTouched * 3);
  const tmpV = newVec();
  const nodeV = newVec();
  for (const [La, ampA, pow, ld] of tries) {
    const keys = assemble(La, ampA, pow, ld);
    const tl = new Timeline(keys, lag);
    let maxN = 0;
    let maxS = 0;
    let viol = 0;
    // The entry blends from the idle pose, which already equals the profile's neutral overlay (zero for most animals).
    nodeV.set(neutralV);
    jointEulers(solver, nodeV, eA);
    let pFwd = nodeV[DOF.bodyFwd];
    let pUp = nodeV[DOF.bodyUp] - nodeV[DOF.rootSquash] * 0.9;
    for (let fr = 0; fr < total; fr++) {
      tl.evalAt(fr, tmpV);
      const w = entryBlend(fr, bf);
      for (let i = 0; i < DOF_N; i++) nodeV[i] = neutralV[i] + (tmpV[i] - neutralV[i]) * w;
      jointEulers(solver, nodeV, eB);
      let st = 0;
      for (let j = 0; j < nTouched; j++) st = Math.max(st, eulerStep(eA, eB, j));
      // WP-P: the body translation (lunge / crouch) has its own per-frame budget, expressed as an equivalent angular step (1 rad = 1 m).
      const cFwd = nodeV[DOF.bodyFwd];
      const cUp = nodeV[DOF.bodyUp] - nodeV[DOF.rootSquash] * 0.9;
      const dPos = Math.max(Math.abs(cFwd - pFwd), Math.abs(cUp - pUp));
      pFwd = cFwd;
      pUp = cUp;
      const sideStrike = fr >= strikeF - 2 && fr <= activeEnd - 1;
      const posViol = dPos - (sideStrike ? POS_STRIKE : POS_NORMAL) * 0.94;
      // Steps ENDING on frames [strike − 2 .. activeEnd − 1] are strike steps (the accelerating swing + the active window).
      const strikeSide = fr >= strikeF - 2 && fr <= activeEnd - 1;
      if (strikeSide) maxS = Math.max(maxS, st);
      else maxN = Math.max(maxN, st);
      viol = Math.max(viol, st - (strikeSide ? STEP_STRIKE : STEP_NORMAL) * 0.94, posViol);
      eA.set(eB);
    }
    // (WP-P) candidates run from the most expressive to the plainest: a plainer one must be clearly better to replace an earlier one.
    if (best === null || viol < best.score - 0.03) best = { tl, maxStep: maxN, maxStrike: maxS, score: viol, La };
    if (viol <= 0) break;
  }
  const chosen = best as NonNullable<typeof best>;
  return {
    animal,
    body,
    air,
    archetype: body.archetype,
    strikeFrame: strikeF,
    activeEnd,
    total,
    tip: actualRole,
    timeline: chosen.tl,
    peak: finish(B0),
    fit: fitSamples,
    maxStep: chosen.maxStep,
    maxStrikeStep: chosen.maxStrike,
    anticipationEnd: chosen.La,
    weight,
    windupAmp: wAmp,
  };
}

function addPartialVec(v: DofVec, d: DofVec, k = 1): DofVec {
  for (let i = 0; i < DOF_N; i++) v[i] += d[i] * k;
  return v;
}
