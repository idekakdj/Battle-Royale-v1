/**
 * Eagle — Death From Above (v1.3 "stoop", locked-on with a tracked-then-committed reticle).
 *
 *   cast    lock a foe (16 m, 90° cone, `requireTarget`: no target = fizzle, nothing spent)
 *   Windup  ASCENT 0.8 s: the eagle rockets up in a corkscrew, out of sight. Untargetable, uninterruptible.
 *   Active  TRACK 1.2 s (stage 0): a red reticle on the ground follows the victim with lag while the eagle
 *           circles ~20 m up; `ultimateStage` 0 carries the lagging centre every 0.1 s.
 *           COMMIT 0.5 s (stage 1): the circle freezes (`ultimateStage` 1, fixed centre) — leaving it dodges.
 *           STOOP: a fast dive (25 m/s) onto the committed point. Anyone whose body overlaps the circle at
 *           arrival takes 240 (radius 1.4); anyone else within 3 m takes 60 splash. `ultimateStage` 2 = impact.
 *   Recovery whiff (nobody hit) 1 s, hit 0.55 s.
 *
 * The eagle owns its position for the whole ultimate (`movementOwned`), so the v1.2 flight rules
 * (attack lock above 3.2 m, landing slam) never fire: `World` cancels any glide when a cast starts and
 * `locomote` is skipped, hence no `pendingLandingPeak`. It touches down exactly once, here.
 *
 * Config: src/config/ultimates/eagle.ts · AI: src/ai/ultScripts/eagle.ts · Rig: src/render/animals/Eagle.ts
 */

import { clamp01, dirToYaw, rotateToward } from '../../core/math';
import { EAGLE_DFA as K } from '../../config/ultimates/eagle';
import type { AbilityRuntime, Fighter, Sim } from '../Fighter';
import { clampToWall, groundHeightAt, resolveObstacles } from '../MovementSystem';
import { AOE_HEIGHT, emitCastEvents, emitUltimateStage, emitUltimateTarget, hitArea, toRecovery, ultOpts } from './common';
import type { UltimateImpl } from './types';

/** Recovery after a landing that hit somebody (s); a whiff uses `spec.recovery`. */
export const DFA_HIT_RECOVERY_S = 0.55;
/** Hard cap on the horizontal follow speed of the high hold (m/s). */
const HOLD_MAX_SPEED = 24;
/** Follow time constant of the hold position (s). */
const HOLD_FOLLOW_S = 0.3;
/** Yaw turn rate while flying (rad/s). */
const YAW_RATE = 12;

type Beat = 'ascent' | 'track' | 'commit' | 'dive';

/** Per-cast scratch (kept off the shared AbilityRuntime shape). */
interface Dfa {
  beat: Beat;
  /** Reticle centre (tracks while beat === 'track', then fixed). */
  rx: number;
  rz: number;
  emitT: number;
  /** Ascent helix. */
  y0: number;
  hcx: number;
  hcz: number;
  hA0: number;
  /** Orbit angle around the reticle. */
  ang: number;
  /** Dive. */
  dx: number;
  dy: number;
  dz: number;
  remain: number;
  diveT: number;
}

const STATE = new WeakMap<AbilityRuntime, Dfa>();

function get(rt: AbilityRuntime): Dfa {
  let s = STATE.get(rt);
  if (s === undefined) {
    s = { beat: 'ascent', rx: rt.px, rz: rt.pz, emitT: 0, y0: 0, hcx: 0, hcz: 0, hA0: 0, ang: 0, dx: 0, dy: -1, dz: 0, remain: 0, diveT: 0 };
    STATE.set(rt, s);
  }
  return s;
}

/** Current phase of a running Death From Above (test / debug hook). */
export function dfaBeat(rt: AbilityRuntime | null): Beat | null {
  if (rt === null) return null;
  const s = STATE.get(rt);
  return s === undefined ? null : s.beat;
}

/** Committed / tracked reticle centre of a running Death From Above (test / debug hook). */
export function dfaReticle(rt: AbilityRuntime | null): { x: number; z: number } | null {
  if (rt === null) return null;
  const s = STATE.get(rt);
  return s === undefined ? null : { x: s.rx, z: s.rz };
}

const smooth = (u: number): number => u * u * (3 - 2 * u);

/** Move the eagle to (x, y, z) this tick, deriving its velocity, and turn toward its heading. */
function fly(f: Fighter, x: number, y: number, z: number, dt: number, faceVelocity: boolean): void {
  const s = f.state;
  const ox = s.pos.x;
  const oy = s.pos.y;
  const oz = s.pos.z;
  s.pos.x = x;
  s.pos.y = y;
  s.pos.z = z;
  clampToWall(f); // the flight line stays inside the arena; velocity below reflects what actually happened
  const inv = dt > 1e-6 ? 1 / dt : 0;
  s.vel.x = (s.pos.x - ox) * inv;
  s.vel.y = (s.pos.y - oy) * inv;
  s.vel.z = (s.pos.z - oz) * inv;
  if (faceVelocity && Math.hypot(s.vel.x, s.vel.z) > 0.4) {
    s.yaw = rotateToward(s.yaw, dirToYaw(s.vel.x, s.vel.z), YAW_RATE * dt);
  }
}

/** Follow the victim with an exponential lag (the reticle), emitting stage 0 at a steady cadence. */
function trackReticle(sim: Sim, f: Fighter, rt: AbilityRuntime, st: Dfa, dt: number): void {
  const v = rt.lockId >= 0 ? sim.fighters[rt.lockId] : undefined;
  if (v !== undefined && v.state.alive) {
    const k = 1 - Math.exp(-dt / K.trackLagS);
    st.rx += (v.state.pos.x - st.rx) * k;
    st.rz += (v.state.pos.z - st.rz) * k;
  }
  st.emitT -= dt;
  if (st.emitT <= 0) {
    st.emitT += K.trackEmitS;
    emitUltimateStage(sim, f, rt, 0, { x: st.rx, y: groundHeightAt(st.rx, st.rz, sim.arena), z: st.rz });
  }
}

export const eagleUltimate: UltimateImpl = {
  start(sim, f, rt, target) {
    const spec = rt.spec;
    const st = get(rt);
    st.rx = rt.px = target.to.x;
    st.rz = rt.pz = target.to.z;
    st.y0 = f.state.pos.y;
    st.hA0 = f.state.yaw + Math.PI / 2;
    st.hcx = f.state.pos.x - K.helixRadius * Math.sin(st.hA0);
    st.hcz = f.state.pos.z - K.helixRadius * Math.cos(st.hA0);
    // The reticle marker is drawn by the VFX module; the ground telegraph ring is intentionally negligible.
    emitCastEvents(sim, f, rt, target.to.x, target.to.z, 0.05, 0, K.ascentS);
    emitUltimateTarget(sim, f, rt, target, K.ascentS);
    f.untargetable = true;
    f.ccImmuneChannel = true;
    f.state.actionDur = K.ascentS + K.trackS + K.commitS + 1.0 + (spec.recovery ?? 1);
  },

  windupDuration() {
    return K.ascentS;
  },

  windupTick(_sim, f, rt, dt) {
    const st = get(rt);
    f.untargetable = true;
    f.ccImmuneChannel = true;
    f.state.airborne = true;
    const u = clamp01((rt.t + dt) / K.ascentS);
    const alt = groundHeightAt(f.state.pos.x, f.state.pos.z, f.arena) + K.holdAlt;
    const y = st.y0 + (alt - st.y0) * smooth(u);
    // Corkscrew: one steady helix around a centre offset from the launch point.
    const phi = st.hA0 + Math.PI * 2 * K.helixTurns * u;
    const x = st.hcx + K.helixRadius * Math.sin(phi);
    const z = st.hcz + K.helixRadius * Math.cos(phi);
    fly(f, x, y, z, dt, true);
  },

  activate(sim, f, rt) {
    const st = get(rt);
    st.beat = 'track';
    st.emitT = 0;
    // Start the reticle on the victim (or where it was locked if the victim is gone) and orbit from where we are.
    const v = rt.lockId >= 0 ? sim.fighters[rt.lockId] : undefined;
    if (v !== undefined && v.state.alive) {
      st.rx = v.state.pos.x;
      st.rz = v.state.pos.z;
    }
    st.ang = Math.atan2(f.state.pos.x - st.rx, f.state.pos.z - st.rz);
    rt.t = 0;
    emitUltimateStage(sim, f, rt, 0, { x: st.rx, y: groundHeightAt(st.rx, st.rz, sim.arena), z: st.rz });
    st.emitT = K.trackEmitS;
  },

  activeTick(sim, f, rt, dt) {
    const st = get(rt);
    f.untargetable = true;
    f.ccImmuneChannel = true;
    f.state.airborne = true;

    if (st.beat === 'track' || st.beat === 'commit') {
      rt.t += dt;
      if (st.beat === 'track') {
        trackReticle(sim, f, rt, st, dt);
        if (rt.t >= K.trackS) {
          st.beat = 'commit';
          rt.t = 0;
          rt.px = st.rx;
          rt.pz = st.rz;
          emitUltimateStage(sim, f, rt, 1, { x: st.rx, y: groundHeightAt(st.rx, st.rz, sim.arena), z: st.rz });
        }
      } else if (rt.t >= K.commitS) {
        // Launch the stoop from wherever the circling hold has brought us.
        st.beat = 'dive';
        st.diveT = 0;
      }
      // High circling hold: orbit the (moving, then frozen) reticle, banking toward it.
      st.ang += K.orbitRate * dt;
      const px = st.rx + K.orbitRadius * Math.sin(st.ang);
      const pz = st.rz + K.orbitRadius * Math.cos(st.ang);
      const s = f.state;
      const alt = groundHeightAt(px, pz, sim.arena) + K.holdAlt + Math.sin(sim.time * 2.2) * 0.35;
      // Critically-damped-ish follow, capped so a distant start does not teleport.
      const k = 1 - Math.exp(-dt / HOLD_FOLLOW_S);
      let mx = (px - s.pos.x) * k;
      let mz = (pz - s.pos.z) * k;
      const mlen = Math.hypot(mx, mz);
      const cap = HOLD_MAX_SPEED * dt;
      if (mlen > cap) {
        mx *= cap / mlen;
        mz *= cap / mlen;
      }
      const ny = s.pos.y + (alt - s.pos.y) * k;
      fly(f, s.pos.x + mx, ny, s.pos.z + mz, dt, true);
      if (st.beat === 'dive') {
        // Aim the stoop now that the launch point is known.
        const tx = st.rx;
        const tz = st.rz;
        const ty = groundHeightAt(tx, tz, sim.arena);
        const ddx = tx - s.pos.x;
        const ddy = ty - s.pos.y;
        const ddz = tz - s.pos.z;
        const len = Math.hypot(ddx, ddy, ddz);
        st.remain = len;
        st.dx = ddx / len;
        st.dy = ddy / len;
        st.dz = ddz / len;
      }
      return;
    }

    // STOOP.
    st.diveT += dt;
    const ramp = smooth(clamp01(st.diveT / K.diveRampS));
    const speed = K.diveSpeed * (0.55 + 0.45 * ramp);
    const step = speed * dt;
    const s = f.state;
    if (step < st.remain) {
      st.remain -= step;
      fly(f, s.pos.x + st.dx * step, s.pos.y + st.dy * step, s.pos.z + st.dz * step, dt, false);
      // Face down the dive line.
      s.yaw = rotateToward(s.yaw, dirToYaw(st.dx, st.dz), 20 * dt);
      s.vel.x = st.dx * speed;
      s.vel.y = st.dy * speed;
      s.vel.z = st.dz * speed;
      return;
    }
    land(sim, f, rt, st);
  },

  recoveryDuration(rt) {
    return rt.didHit ? DFA_HIT_RECOVERY_S : rt.spec.recovery ?? 1;
  },

  abort(_sim, f) {
    f.untargetable = false;
    f.ccImmuneChannel = false;
    f.state.airborne = false;
  },
};

/** Touch down on the committed point: direct + splash, one `ultimateStage` 2, then recovery. */
function land(sim: Sim, f: Fighter, rt: AbilityRuntime, st: Dfa): void {
  const spec = rt.spec;
  const s = f.state;
  s.pos.x = st.rx;
  s.pos.z = st.rz;
  resolveObstacles(sim, f, false);
  clampToWall(f);
  s.pos.y = groundHeightAt(s.pos.x, s.pos.z, sim.arena);
  s.vel.x = 0;
  s.vel.y = 0;
  s.vel.z = 0;
  s.airborne = false;
  f.untargetable = false;
  f.ccImmuneChannel = false;

  const once = new Set<number>();
  const direct = hitArea(sim, f, {
    shape: 'circle',
    cx: s.pos.x,
    cz: s.pos.z,
    cy: s.pos.y,
    yaw: s.yaw,
    range: spec.radius ?? K.directRadius,
    arcDeg: 360,
    heightTol: AOE_HEIGHT,
    base: spec.damage ?? 240,
    opts: ultOpts('stagger'),
    once,
  });
  const splash = hitArea(sim, f, {
    shape: 'circle',
    cx: s.pos.x,
    cz: s.pos.z,
    cy: s.pos.y,
    yaw: s.yaw,
    range: spec.splashRadius ?? 3,
    arcDeg: 360,
    heightTol: AOE_HEIGHT,
    base: spec.splashDamage ?? 60,
    opts: ultOpts('stagger'),
    once,
  });
  rt.didHit = direct || splash;
  emitUltimateStage(sim, f, rt, 2, { x: s.pos.x, y: s.pos.y, z: s.pos.z });
  // The recovery gets its own clock for the rig (actionT/actionDur restart at the touchdown).
  s.actionT = 0;
  s.actionDur = rt.didHit ? DFA_HIT_RECOVERY_S : spec.recovery ?? 1;
  toRecovery(rt);
}
