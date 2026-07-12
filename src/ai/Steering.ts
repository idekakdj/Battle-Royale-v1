/**
 * Steering (BLUEPRINT §10.3 executor half 1).
 *
 * Seek / flee / strafe-orbit plus obstacle avoidance via feeler probes against
 * the CONFIG obstacle layout (pillars, fallen columns, live crates from the
 * snapshot) and local avoidance of other fighters. Everything writes into a
 * caller-owned {@link Move2} so hot paths allocate nothing.
 */

import type { FighterState, WorldSnapshot } from '../core/types';
import { PILLARS, FALLEN_COLUMNS, WALL_RADIUS, CRATE_HALF } from '../config/arena';

export interface Move2 {
  x: number;
  z: number;
}

/** Normalize (dx,dz) into `out`; zero vector stays zero. */
export function setDir(out: Move2, dx: number, dz: number): void {
  const len = Math.sqrt(dx * dx + dz * dz);
  if (len > 1e-6) {
    out.x = dx / len;
    out.z = dz / len;
  } else {
    out.x = 0;
    out.z = 0;
  }
}

export function seek(out: Move2, sx: number, sz: number, tx: number, tz: number): void {
  setDir(out, tx - sx, tz - sz);
}

export function flee(out: Move2, sx: number, sz: number, tx: number, tz: number): void {
  setDir(out, sx - tx, sz - tz);
}

/**
 * Strafe-orbit around (cx,cz) holding `spacing` metres. `sign` picks the orbit
 * direction; `tangentWeight` (0..1 ≈ strafeSkill) scales how much of the motion
 * is tangential vs pure radial spacing correction.
 */
export function orbit(
  out: Move2,
  sx: number,
  sz: number,
  cx: number,
  cz: number,
  sign: number,
  spacing: number,
  tangentWeight: number,
): void {
  const dx = sx - cx;
  const dz = sz - cz;
  const dist = Math.sqrt(dx * dx + dz * dz);
  if (dist < 1e-6) {
    out.x = 1;
    out.z = 0;
    return;
  }
  const nx = dx / dist;
  const nz = dz / dist;
  let radial = (dist - spacing) * 0.9;
  if (radial > 1) radial = 1;
  else if (radial < -1) radial = -1;
  setDir(out, -nz * sign * tangentWeight - nx * radial, nx * sign * tangentWeight - nz * radial);
}

const PROBE_LEN = 2.4;
const CRATE_AVOID_R = CRATE_HALF * Math.SQRT2 + 0.15; // circumscribe the AABB

/**
 * Bend `out` around obstacles along the path ahead. Returns true when the
 * blocking obstacle directly ahead is a jumpable low wall (fallen column), so
 * the brain may choose to jump it instead of walking around.
 */
export function avoidObstacles(
  out: Move2,
  sx: number,
  sz: number,
  selfRadius: number,
  crates: WorldSnapshot['crates'],
  ignoreObstacles: boolean,
): boolean {
  if (out.x === 0 && out.z === 0) return false;

  let ax = out.x;
  let az = out.z;
  let jumpable = false;

  if (!ignoreObstacles) {
    // Pillars — closest approach of the probe segment to each circle.
    for (let i = 0; i < PILLARS.length; i++) {
      const p = PILLARS[i];
      const relX = p.x - sx;
      const relZ = p.z - sz;
      let t = relX * out.x + relZ * out.z; // projection onto the unit dir
      if (t < 0) continue; // behind us
      if (t > PROBE_LEN) t = PROBE_LEN;
      const px = sx + out.x * t;
      const pz = sz + out.z * t;
      const dx = px - p.x;
      const dz = pz - p.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      const margin = p.radius + selfRadius + 0.35;
      if (d < margin && d > 1e-6) {
        const push = ((margin - d) / margin) * 1.8;
        ax += (dx / d) * push;
        az += (dz / d) * push;
      }
    }

    // Live crates — treated as circles.
    for (let i = 0; i < crates.length; i++) {
      const c = crates[i];
      if (!c.alive) continue;
      const relX = c.pos.x - sx;
      const relZ = c.pos.z - sz;
      let t = relX * out.x + relZ * out.z;
      if (t < 0) continue;
      if (t > PROBE_LEN) t = PROBE_LEN;
      const px = sx + out.x * t;
      const pz = sz + out.z * t;
      const dx = px - c.pos.x;
      const dz = pz - c.pos.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      const margin = CRATE_AVOID_R + selfRadius + 0.3;
      if (d < margin && d > 1e-6) {
        const push = ((margin - d) / margin) * 1.5;
        ax += (dx / d) * push;
        az += (dz / d) * push;
      }
    }

    // Fallen columns (jumpable low walls) — distance from a forward sample
    // point to the wall segment.
    for (let i = 0; i < FALLEN_COLUMNS.length; i++) {
      const w = FALLEN_COLUMNS[i];
      const px = sx + out.x * 1.3;
      const pz = sz + out.z * 1.3;
      const ex = w.bx - w.ax;
      const ez = w.bz - w.az;
      const lenSq = ex * ex + ez * ez;
      let t = lenSq > 1e-9 ? ((px - w.ax) * ex + (pz - w.az) * ez) / lenSq : 0;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
      const cx = w.ax + ex * t;
      const cz = w.az + ez * t;
      const dx = px - cx;
      const dz = pz - cz;
      const d = Math.sqrt(dx * dx + dz * dz);
      const margin = w.thickness * 0.5 + selfRadius + 0.3;
      if (d < margin) {
        jumpable = true;
        if (d > 1e-6) {
          const push = ((margin - d) / margin) * 1.2;
          ax += (dx / d) * push;
          az += (dz / d) * push;
        }
      }
    }
  }

  // Arena wall — steer inward when the path ahead leaves the sand.
  const fx = sx + out.x * 1.6;
  const fz = sz + out.z * 1.6;
  const fr = Math.sqrt(fx * fx + fz * fz);
  if (fr > WALL_RADIUS - 1.6 && fr > 1e-6) {
    const pull = (fr - (WALL_RADIUS - 1.6)) * 0.9;
    ax -= (fx / fr) * pull;
    az -= (fz / fr) * pull;
  }

  setDir(out, ax, az);
  return jumpable;
}

/**
 * Contact distance for local avoidance. Deliberately tight: the sim's soft
 * push-out already prevents overlap, and pushing away from the fighter we are
 * trying to hit creates out-of-range standoffs for short-reach animals.
 */
const SEP_MIN = 1.5;

/**
 * Push away from nearby fighters (local avoidance); re-normalizes `out`.
 * `ignoreId` (the current target) is exempt — we WANT to close on it.
 */
export function separation(
  out: Move2,
  self: FighterState,
  fighters: readonly FighterState[],
  ignoreId: number,
): void {
  let px = 0;
  let pz = 0;
  for (let i = 0; i < fighters.length; i++) {
    const f = fighters[i];
    if (f.id === self.id || f.id === ignoreId || !f.alive) continue;
    const dx = self.pos.x - f.pos.x;
    const dz = self.pos.z - f.pos.z;
    const dSq = dx * dx + dz * dz;
    if (dSq < SEP_MIN * SEP_MIN && dSq > 1e-9) {
      const d = Math.sqrt(dSq);
      const w = (1 - d / SEP_MIN) * 0.6;
      px += (dx / d) * w;
      pz += (dz / d) * w;
    }
  }
  if (px !== 0 || pz !== 0) setDir(out, out.x + px, out.z + pz);
}
