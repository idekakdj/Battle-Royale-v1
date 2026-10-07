/**
 * Steering (BLUEPRINT §10.3 executor half 1).
 *
 * Seek / flee / strafe-orbit plus obstacle avoidance via feeler probes against
 * the ARENA's obstacle layout (round blockers = pillars/trees, low segments =
 * fallen columns/logs, live crates from the snapshot) and local avoidance of other fighters. Everything writes into a
 * caller-owned {@link Move2} so hot paths allocate nothing.
 */

import type { FighterState, TrapState, WorldSnapshot } from '../core/types';
import { CRATE_HALF } from '../config/arena';
import type { ArenaDef } from '../config/arenas';
import { arenaGroundHeight } from '../config/arenas';
import type { TrapAwareness } from '../config/botProfiles';

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
  arena: ArenaDef,
): boolean {
  if (out.x === 0 && out.z === 0) return false;

  let ax = out.x;
  let az = out.z;
  let jumpable = false;

  if (!ignoreObstacles) {
    // Pillars / tree trunks — closest approach of the probe segment to each circle.
    const pillars = arena.circles;
    for (let i = 0; i < pillars.length; i++) {
      const p = pillars[i];
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
    const columns = arena.segments;
    for (let i = 0; i < columns.length; i++) {
      const w = columns[i];
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
  const wallR = arena.wallRadius;
  if (fr > wallR - 1.6 && fr > 1e-6) {
    const pull = (fr - (wallR - 1.6)) * 0.9;
    ax -= (fx / fr) * pull;
    az -= (fz / fr) * pull;
  }

  setDir(out, ax, az);
  return jumpable;
}

/** Clearance (m) beyond a fallen column's tip for the detour waypoint. */
const DETOUR_TIP_CLEAR = 1.2;

/**
 * v1.1 fix (low-wall standoff): the obstacle feelers only bend the path
 * locally, so two fighters on opposite sides of a fallen column used to slide
 * along it forever — neither could reach the other and the match timed out.
 * When the straight line self→(tx,tz) crosses a column, steer `out` toward a
 * waypoint just past the column tip that gives the shorter way round.
 * Returns true when a detour was applied.
 */
export function lowWallDetour(
  out: Move2,
  sx: number,
  sz: number,
  tx: number,
  tz: number,
  selfRadius: number,
  arena: ArenaDef,
): boolean {
  const columns = arena.segments;
  for (let i = 0; i < columns.length; i++) {
    const w = columns[i];
    const ex = w.bx - w.ax;
    const ez = w.bz - w.az;
    const len = Math.sqrt(ex * ex + ez * ez);
    if (len < 1e-6) continue;
    const ux = ex / len;
    const uz = ez / len;
    // Column extended at both tips by our body radius (+ a little).
    const pad = selfRadius + 0.4;
    const ax = w.ax - ux * pad;
    const az = w.az - uz * pad;
    const bx = w.bx + ux * pad;
    const bz = w.bz + uz * pad;
    if (!segmentsCross(sx, sz, tx, tz, ax, az, bx, bz)) continue;
    // Pick the tip giving the shorter path self → tip → target.
    const clear = selfRadius + DETOUR_TIP_CLEAR;
    const pax = w.ax - ux * clear;
    const paz = w.az - uz * clear;
    const pbx = w.bx + ux * clear;
    const pbz = w.bz + uz * clear;
    const viaA = Math.hypot(pax - sx, paz - sz) + Math.hypot(tx - pax, tz - paz);
    const viaB = Math.hypot(pbx - sx, pbz - sz) + Math.hypot(tx - pbx, tz - pbz);
    if (viaA <= viaB) seek(out, sx, sz, pax, paz);
    else seek(out, sx, sz, pbx, pbz);
    return true;
  }
  return false;
}

/** Proper 2D segment intersection test (p1→p2 vs p3→p4). */
function segmentsCross(
  x1: number,
  z1: number,
  x2: number,
  z2: number,
  x3: number,
  z3: number,
  x4: number,
  z4: number,
): boolean {
  const d1 = cross(x4 - x3, z4 - z3, x1 - x3, z1 - z3);
  const d2 = cross(x4 - x3, z4 - z3, x2 - x3, z2 - z3);
  const d3 = cross(x2 - x1, z2 - z1, x3 - x1, z3 - z1);
  const d4 = cross(x2 - x1, z2 - z1, x4 - x1, z4 - z1);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

function cross(ax: number, az: number, bx: number, bz: number): number {
  return ax * bz - az * bx;
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

// -- v1.2 arena traps ---------------------------------------------------------

/** Ground height under (x,z) - mirrors the sim (dais top inside its radius, when the arena has a dais). */
export function groundY(x: number, z: number, arena: ArenaDef): number {
  return arenaGroundHeight(arena, x, z);
}

/** Probe length (m) for bending around armed plates / active hazards ahead. */
const TRAP_PROBE_LEN = 3.2;

/** Index of the active trap whose hazard contains (sx,sz) (+`pad` m), else -1. */
export function activeTrapAt(traps: readonly TrapState[], sx: number, sz: number, pad: number): number {
  for (let i = 0; i < traps.length; i++) {
    const t = traps[i];
    if (t.phase !== 'active') continue;
    const r = t.radius + pad;
    const dx = sx - t.pos.x;
    const dz = sz - t.pos.z;
    if (dx * dx + dz * dz <= r * r) return i;
  }
  return -1;
}

/**
 * v1.2 trap awareness. Bends `out` around hazards on the path ahead and, when
 * the bot is standing in an active hazard, turns it straight out. Levels:
 *  - `ignore` (Cub): no-op.
 *  - `soft` (Fighter): steps out of active hazards; nudges around an armed
 *    plate only when it lies squarely on the path (cheap detours only).
 *  - `route` / `exploit` (Veteran / Apex): routes around armed plates and
 *    active hazards with a margin and leaves an active hazard at once.
 * Returns true while escaping an active hazard (the brain keeps that heading).
 */
export function avoidTraps(
  out: Move2,
  sx: number,
  sz: number,
  selfRadius: number,
  traps: readonly TrapState[],
  mode: TrapAwareness,
): boolean {
  if (mode === 'ignore' || traps.length === 0) return false;
  const skilled = mode === 'route' || mode === 'exploit';

  // Escape: inside (or at the lip of) an active hazard -> head straight out.
  const lip = skilled ? 0.6 : 0.2;
  const inside = activeTrapAt(traps, sx, sz, lip);
  if (inside >= 0) {
    const t = traps[inside];
    let ex = sx - t.pos.x;
    let ez = sz - t.pos.z;
    if (ex * ex + ez * ez < 1e-6) {
      // Dead centre: leave along the current heading (or +X).
      const moving = out.x !== 0 || out.z !== 0;
      ex = moving ? out.x : 1;
      ez = moving ? out.z : 0;
    }
    setDir(out, ex, ez);
    return true;
  }

  if (out.x === 0 && out.z === 0) return false;
  let ax = out.x;
  let az = out.z;
  for (let i = 0; i < traps.length; i++) {
    const t = traps[i];
    if (t.phase === 'cooldown') continue; // spent plate: safe to cross
    const relX = t.pos.x - sx;
    const relZ = t.pos.z - sz;
    if (t.phase === 'armed' && !skilled) {
      // Fighter: only sidestep a plate squarely ahead (cheap, local).
      const ahead = relX * out.x + relZ * out.z;
      if (ahead < 0 || ahead > 1.8 + t.radius) continue;
      const lat = relX * out.z - relZ * out.x;
      if (Math.abs(lat) > t.radius * 0.7) continue;
    }
    const margin = t.radius + (skilled ? selfRadius * 0.5 + 0.6 : 0.3);
    let proj = relX * out.x + relZ * out.z;
    if (proj < 0) continue;
    if (proj > TRAP_PROBE_LEN) proj = TRAP_PROBE_LEN;
    const px = sx + out.x * proj;
    const pz = sz + out.z * proj;
    let dx = px - t.pos.x;
    let dz = pz - t.pos.z;
    let d = Math.sqrt(dx * dx + dz * dz);
    if (d >= margin) continue;
    if (d < 1e-6) {
      // Heading straight at the centre: pick the perpendicular side.
      dx = -out.z;
      dz = out.x;
      d = 1;
    }
    const push = ((margin - d) / margin) * (skilled ? 2.2 : 1.2);
    ax += (dx / d) * push;
    az += (dz / d) * push;
  }
  setDir(out, ax, az);
  return false;
}
