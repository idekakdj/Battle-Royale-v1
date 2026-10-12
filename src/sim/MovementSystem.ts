/**
 * Movement & collision (BLUEPRINT §7.8): accel/decel steering, gravity, jump,
 * fear/root/slow/block/attack move modifiers, yaw turning, soft fighter push-out,
 * circle/segment/AABB obstacle push-out, wall clamp, dais step-up, and the
 * charge-stepping helper abilities reuse (rhino/hippo/mole/panther/eagle).
 */

import type { Fighter, Sim, CrateRuntime } from './Fighter';
import { MOVE } from '../config/balance';
import { TERRAIN } from '../config/terrain';
import type { ArenaDef } from '../config/arenas';
import { arenaGroundHeight, arenaCliffPush, arenaStepLimit, ARENA_SNAP_DOWN, ARENA_STEP_UP } from '../config/arenas';
import { GLIDE_HEIGHT, RUN_TURN_RATE, FIGHTER_PUSH_FRACTION, FIGHTER_PUSH_HEIGHT } from './simTuning';
import { COMBO } from '../config/balance';
import { rotateToward, dirToYaw, clamp } from '../core/math';
import { speedMult, fearFleeYaw } from './StatusEffects';

/** Soar altitude controller gain (1/s): target climb speed = gain × altitude error, capped. */
const SOAR_ALT_GAIN = 4;

/** Ground height under (x,z) in `arena`: the dais top where the arena has one and (x,z) is on it, else 0 (§7.8). */
export function groundHeightAt(x: number, z: number, arena: ArenaDef): number {
  return arenaGroundHeight(arena, x, z);
}

/** Result of a push-out resolution pass. */
export interface CollisionResult {
  corrX: number;
  corrZ: number;
  hitCrate: CrateRuntime | null;
}

const RESULT: CollisionResult = { corrX: 0, corrZ: 0, hitCrate: null };
const CLIFF_OUT = { x: 0, z: 0 };

/**
 * v1.9 CLIFF RULE (arenas with a `heightfield` only; a no-op everywhere else). Treat every part of the heightfield that is higher
 * than the fighter's STEP LIMIT as a solid: a grounded fighter can only step up `ARENA_STEP_UP` (0.6 m) above its feet, an airborne
 * one enters terrain up to its feet + `ARENA_AIR_CLEARANCE` (so a jump clears a ≤ 1.2 m step but not a 1.5 m terrace). The fighter's body
 * circle is pushed out of the blocked region exactly like an obstacle (the blocked component is removed, the rest slides), so
 * knockback, charges, pounces and carries stop at a cliff instead of teleporting up it. Walking down is always allowed. Must run
 * BEFORE the fighter's `pos.y` is re-seated on the new ground (the feet height of the previous tick is the reference).
 * Adds the displacement to {@link RESULT} so callers' "stopped by geometry" tests (charges, carries) see it. Returns true if it moved.
 */
export function pushOutOfCliffs(arena: ArenaDef, f: Fighter): boolean {
  if (arena.heightfield === undefined) return false;
  const s = f.state;
  const gy = arenaGroundHeight(arena, s.pos.x, s.pos.z);
  const limit = arenaStepLimit(s.airborne ? Math.max(s.pos.y, f.airPeakY) : s.pos.y, gy);
  if (!arenaCliffPush(arena, s.pos.x, s.pos.z, f.def.radius, limit, CLIFF_OUT)) return false;
  RESULT.corrX += CLIFF_OUT.x - s.pos.x;
  RESULT.corrZ += CLIFF_OUT.z - s.pos.z;
  s.pos.x = CLIFF_OUT.x;
  s.pos.z = CLIFF_OUT.z;
  return true;
}

/**
 * Push `f` out of every solid obstacle + live crate it overlaps (does NOT touch
 * the arena wall). Mole `burrowed` and airborne fighters above a low wall/crate
 * pass through. Returns the net correction and any crate hit. In a heightfield
 * arena it also keeps the fighter out of cliffs (see {@link pushOutOfCliffs}),
 * even when `ignoreObstacles` (a burrowed mole tunnels under pillars, not through a cliff).
 */
export function resolveObstacles(sim: Sim, f: Fighter, ignoreObstacles: boolean, cliffs = true): CollisionResult {
  RESULT.corrX = 0;
  RESULT.corrZ = 0;
  RESULT.hitCrate = null;
  if (ignoreObstacles) {
    if (cliffs) pushOutOfCliffs(sim.arena, f);
    return RESULT;
  }
  const r = f.def.radius;
  const y = f.state.pos.y;

  for (let i = 0; i < sim.staticObstacles.length; i++) {
    const ob = sim.staticObstacles[i];
    if (ob.shape === 'circle') {
      if (ob.walkable) continue; // dais: step-up, not a blocker
      if (ob.jumpable && y >= (ob.baseY ?? 0) + ob.height) continue; // (no shipped circle is jumpable; trees/pillars always block)
      pushOutCircle(f, ob.x, ob.z, ob.radius + r);
    } else if (ob.shape === 'segment') {
      if (ob.jumpable && y >= (ob.baseY ?? 0) + ob.height) continue; // jumped/glided over
      pushOutSegment(f, ob.ax, ob.az, ob.bx, ob.bz, ob.thickness * 0.5 + r);
    }
  }
  for (let i = 0; i < sim.crates.length; i++) {
    const c = sim.crates[i];
    if (!c.alive) continue;
    if (y >= (c.baseY ?? 0) + c.height) continue; // cleared by jump/glide
    if (pushOutAabb(f, c.x, c.z, c.halfX, c.halfZ, r)) RESULT.hitCrate = c;
  }
  if (cliffs) pushOutOfCliffs(sim.arena, f);
  return RESULT;
}

function pushOutCircle(f: Fighter, ox: number, oz: number, minDist: number): void {
  const dx = f.state.pos.x - ox;
  const dz = f.state.pos.z - oz;
  const d = Math.sqrt(dx * dx + dz * dz);
  if (d >= minDist) return;
  let ux: number;
  let uz: number;
  if (d < 1e-6) {
    // Degenerate: exactly at the centre — push out along +X by the full radius.
    ux = 1;
    uz = 0;
  } else {
    ux = dx / d;
    uz = dz / d;
  }
  const push = minDist - d;
  f.state.pos.x += ux * push;
  f.state.pos.z += uz * push;
  RESULT.corrX += ux * push;
  RESULT.corrZ += uz * push;
}

function pushOutSegment(f: Fighter, ax: number, az: number, bx: number, bz: number, minDist: number): void {
  const abx = bx - ax;
  const abz = bz - az;
  const len2 = abx * abx + abz * abz;
  let t = len2 > 1e-9 ? ((f.state.pos.x - ax) * abx + (f.state.pos.z - az) * abz) / len2 : 0;
  t = clamp(t, 0, 1);
  const cx = ax + abx * t;
  const cz = az + abz * t;
  pushOutCircle(f, cx, cz, minDist);
}

function pushOutAabb(f: Fighter, cx: number, cz: number, hx: number, hz: number, r: number): boolean {
  const nx = clamp(f.state.pos.x, cx - hx, cx + hx);
  const nz = clamp(f.state.pos.z, cz - hz, cz + hz);
  let dx = f.state.pos.x - nx;
  let dz = f.state.pos.z - nz;
  let d = Math.sqrt(dx * dx + dz * dz);
  if (d >= r) return false;
  if (d < 1e-6) {
    // Center inside the box: push out along the least-penetration axis.
    const penX = hx + r - Math.abs(f.state.pos.x - cx);
    const penZ = hz + r - Math.abs(f.state.pos.z - cz);
    if (penX < penZ) {
      const s = f.state.pos.x >= cx ? 1 : -1;
      f.state.pos.x += s * penX;
      RESULT.corrX += s * penX;
    } else {
      const s = f.state.pos.z >= cz ? 1 : -1;
      f.state.pos.z += s * penZ;
      RESULT.corrZ += s * penZ;
    }
    return true;
  }
  const push = (r - d) / d;
  f.state.pos.x += dx * push;
  f.state.pos.z += dz * push;
  RESULT.corrX += dx * push;
  RESULT.corrZ += dz * push;
  return true;
}

/** Clamp a fighter inside its arena's wall (circle of `arena.wallRadius`, 30 m in both arenas). Returns true if clamped. */
export function clampToWall(f: Fighter): boolean {
  const maxR = f.arena.wallRadius - f.def.radius;
  const d = Math.sqrt(f.state.pos.x * f.state.pos.x + f.state.pos.z * f.state.pos.z);
  if (d <= maxR) return false;
  const s = maxR / d;
  f.state.pos.x *= s;
  f.state.pos.z *= s;
  return true;
}

/**
 * Step a charging/dashing fighter `dist` metres along its ability direction and
 * resolve geometry. Returns whether geometry stopped it (wall/obstacle) and any
 * crate contacted — used by rhino Lockdown/Stampede, hippo Rush, etc.
 */
export function chargeStep(
  sim: Sim,
  f: Fighter,
  dist: number,
  ignoreObstacles: boolean,
): { stopped: boolean; hitCrate: CrateRuntime | null } {
  const dirX = f.ability !== null ? f.ability.dirX : Math.sin(f.state.yaw);
  const dirZ = f.ability !== null ? f.ability.dirZ : Math.cos(f.state.yaw);
  f.state.pos.x += dirX * dist;
  f.state.pos.z += dirZ * dist;
  const res = resolveObstacles(sim, f, ignoreObstacles);
  const hitWall = clampToWall(f);
  // Stopped if a correction pushed us back against the travel direction (cliffs count: resolveObstacles includes them).
  const opposed = res.corrX * dirX + res.corrZ * dirZ;
  const stopped = hitWall || opposed < -1e-4;
  if (sim.arena.heightfield !== undefined) followGround(sim.arena, f); // v1.9: a charge up a ramp / off a ledge keeps its feet on the ground
  return { stopped, hitCrate: res.hitCrate };
}

/**
 * v1.9: seat the feet of an ability-driven (position-owned) GROUNDED fighter on the ground under it: it rises with a ramp or step
 * (the cliff rule has already limited the climb to ≤ 0.6 m) and drops off a ledge at ≤ 0.3 m per tick. Airborne fighters keep their y.
 */
export function followGround(arena: ArenaDef, f: Fighter): void {
  const s = f.state;
  if (s.airborne) return;
  const gy = arenaGroundHeight(arena, s.pos.x, s.pos.z);
  if (s.pos.y < gy) s.pos.y = gy;
  else if (s.pos.y > gy) s.pos.y = Math.max(gy, s.pos.y - 0.3);
}

/**
 * Normal per-fighter locomotion for a tick (skipped when a system owns the
 * fighter's position). Handles glide, fear, root, jump, gravity, steering,
 * yaw, obstacle push-out, wall clamp and dais step-up.
 */
export function locomote(sim: Sim, f: Fighter, dt: number): void {
  if (f.movementOwned) return;
  const s = f.state;

  // Eagle glide: hold jump while airborne (§7.8). Handled before normal gravity.
  if (s.glideT > 0) {
    updateGlide(sim, f, dt);
    return;
  }

  const disabled = f.isDisabled();
  // v1.8: terrain (moss / shallow water) scales ORDINARY run speed only; `terrainSpeedMult` is exactly 1 off terrain.
  const baseSpeed = f.def.speed * speedMult(f) * f.terrainSpeedMult;

  // Desired horizontal velocity.
  let dvx = 0;
  let dvz = 0;
  if (f.fearTimer > 0) {
    const fy = fearFleeYaw(f);
    dvx = Math.sin(fy) * baseSpeed;
    dvz = Math.cos(fy) * baseSpeed;
  } else if (!disabled && f.rootTimer <= 0 && f.hitstunTimer <= 0 && f.landRecoverT <= 0) {
    let mx = f.intent.moveX;
    let mz = f.intent.moveZ;
    let mag = Math.sqrt(mx * mx + mz * mz);
    if (mag > 1) {
      mx /= mag;
      mz /= mag;
      mag = 1;
    }
    if (mag > 1e-4) {
      let mult = 1;
      if (f.swinging) mult = MOVE.attackMoveMult;
      else if (f.blocking) mult = f.def.perks.blockMoveMult ?? MOVE.blockMoveMult;
      const spd = baseSpeed * mult;
      dvx = mx * spd;
      dvz = mz * spd;
    }
  }

  // Steer current velocity toward desired (accel when speeding up, decel when slowing).
  const cx = s.vel.x;
  const cz = s.vel.z;
  const diffX = dvx - cx;
  const diffZ = dvz - cz;
  const diffLen = Math.sqrt(diffX * diffX + diffZ * diffZ);
  const desiredLen = Math.sqrt(dvx * dvx + dvz * dvz);
  const curLen = Math.sqrt(cx * cx + cz * cz);
  const rate = (desiredLen >= curLen ? MOVE.accel : MOVE.decel) * dt;
  if (diffLen <= rate || diffLen < 1e-6) {
    s.vel.x = dvx;
    s.vel.z = dvz;
  } else {
    s.vel.x = cx + (diffX / diffLen) * rate;
    s.vel.z = cz + (diffZ / diffLen) * rate;
  }
  s.pos.x += s.vel.x * dt;
  s.pos.z += s.vel.z * dt;

  // Knockback impulse (§7.8): additive displacement, stopped by geometry.
  if (f.knockTimer > 0) {
    s.pos.x += f.knockVX * dt;
    s.pos.z += f.knockVZ * dt;
    f.knockTimer = Math.max(0, f.knockTimer - dt);
  }

  // v1.9 cliffs (heightfield arenas only): keep the body out of ground that is too high to step onto, BEFORE the feet are re-seated.
  if (sim.arena.heightfield !== undefined) {
    RESULT.corrX = 0;
    RESULT.corrZ = 0;
    pushOutOfCliffs(sim.arena, f);
  }

  // Jump start (edge) — only when free & grounded.
  if (
    f.edgeJump &&
    !s.airborne &&
    !disabled &&
    !f.blocking &&
    !f.swinging &&
    f.ability === null &&
    f.rootTimer <= 0 &&
    f.landRecoverT <= 0
  ) {
    // v1.8: a jump out of water / moss is a small hop (see TERRAIN.wetJumpMult); exactly the normal jump everywhere else.
    s.vel.y = f.terrainSpeedMult < 1 ? MOVE.jumpVelocity * TERRAIN.wetJumpMult : MOVE.jumpVelocity;
    s.airborne = true;
  }

  // Vertical integration.
  const gy = groundHeightAt(s.pos.x, s.pos.z, sim.arena);
  // v1.9: a grounded fighter walking DOWN a ramp or over a small seam keeps contact (no fall, no 'jump' pose); real drops fall.
  const snapDown = !s.airborne && sim.arena.heightfield !== undefined && s.pos.y > gy && s.pos.y - gy <= ARENA_SNAP_DOWN;
  if (!snapDown && (s.airborne || s.pos.y > gy + 1e-4)) {
    s.airborne = true;
    s.vel.y -= MOVE.gravity * dt;
    // v1.2 controlled descent after an eagle flight.
    const soar = f.def.perks.soar;
    if (f.soarDescending && soar !== undefined && s.vel.y < -soar.descentMaxSpeed) s.vel.y = -soar.descentMaxSpeed;
    s.pos.y += s.vel.y * dt;
    if (f.soarDescending) f.soarPeak = Math.max(f.soarPeak, s.pos.y - gy);
    if (s.pos.y <= gy && s.vel.y <= 0) {
      s.pos.y = gy;
      s.vel.y = 0;
      s.airborne = false;
      onTouchdown(f);
    }
  } else {
    s.pos.y = gy;
    s.vel.y = 0;
    s.airborne = false;
  }
  // v1.9: the highest feet of this airborne episode (= the feet while grounded); only the cliff rule reads it
  f.airPeakY = s.airborne ? Math.max(f.airPeakY, s.pos.y) : s.pos.y;

  // Eagle: entering a glide from a jump while holding jump and rising/falling.
  maybeStartGlide(f);

  // Yaw turning (§7.2: attacks committed to ≤240°/s; running faces move dir).
  turnYaw(f, dt);

  // Geometry.
  const ignoreObstacles = s.burrowT > 0;
  resolveObstacles(sim, f, ignoreObstacles);
  clampToWall(f);
}

function turnYaw(f: Fighter, dt: number): void {
  const s = f.state;
  if (f.swinging) {
    s.yaw = rotateToward(s.yaw, f.intent.aimYaw, COMBO.attackTurnRateRad * dt);
  } else if (f.blocking || f.ability !== null) {
    s.yaw = rotateToward(s.yaw, f.intent.aimYaw, RUN_TURN_RATE * 2 * dt);
  } else if (f.fearTimer > 0) {
    s.yaw = rotateToward(s.yaw, fearFleeYaw(f), RUN_TURN_RATE * dt);
  } else {
    const speed = Math.sqrt(s.vel.x * s.vel.x + s.vel.z * s.vel.z);
    const target = speed > 0.3 ? dirToYaw(s.vel.x, s.vel.z) : f.intent.aimYaw;
    s.yaw = rotateToward(s.yaw, target, RUN_TURN_RATE * dt);
  }
}

/** Begin an eagle glide if airborne & holding jump & off cooldown (§7.8). */
function maybeStartGlide(f: Fighter): void {
  if (f.def.id !== 'eagle') return;
  const glide = f.def.perks.glide;
  if (glide === undefined) return;
  if (f.state.glideT > 0 || f.soarDescending || f.landRecoverT > 0) return;
  if (f.state.airborne && f.intent.jump && f.glideCd <= 0 && f.state.vel.y <= MOVE.jumpVelocity * 0.4) {
    f.state.glideT = glide.duration;
    f.flightT = 0;
    f.soarPeak = Math.max(0, f.state.pos.y - groundHeightAt(f.state.pos.x, f.state.pos.z, f.arena));
  }
}

/** Flight over (released / out of time / disabled): fall under a capped descent. */
function endFlight(f: Fighter): void {
  f.state.glideT = 0;
  f.state.airborne = true;
  f.soarDescending = true;
}

/**
 * Abort any eagle flight state without a landing slam (the eagle cast an
 * ability, or was grabbed/carried). The flight counts as used: cooldown starts.
 */
export function cancelFlight(f: Fighter): void {
  if (f.state.glideT <= 0 && !f.soarDescending && f.soarPeak <= 0) return;
  f.state.glideT = 0;
  f.soarDescending = false;
  f.soarPeak = 0;
  f.flightT = 0;
  const glide = f.def.perks.glide;
  if (glide !== undefined) f.glideCd = Math.max(f.glideCd, glide.cooldown);
}

/** Touchdown bookkeeping: flight cooldown starts, slam queued if the eagle flew high. */
function onTouchdown(f: Fighter): void {
  if (!f.soarDescending && f.soarPeak <= 0) return;
  const glide = f.def.perks.glide;
  const soar = f.def.perks.soar;
  if (glide !== undefined) f.glideCd = Math.max(f.glideCd, glide.cooldown);
  if (soar !== undefined && f.soarPeak >= soar.landMinHeight) f.pendingLandingPeak = f.soarPeak;
  f.soarDescending = false;
  f.soarPeak = 0;
  f.flightT = 0;
}

/**
 * Eagle glide + soar (§7.8, v1.2). Holding Space glides at `glideHeight`;
 * after `climbDelay` the eagle climbs at `climbRate` toward `maxHeight`
 * (eased by `climbAccel`), always moving at glide speed. `state.pos.y` /
 * `state.vel.y` carry altitude / climb rate for the renderer.
 */
function updateGlide(sim: Sim, f: Fighter, dt: number): void {
  const glide = f.def.perks.glide;
  const s = f.state;
  if (glide === undefined) {
    s.glideT = 0;
    return;
  }
  // End conditions: released jump, ran out of flight time, or hard CC.
  if (!f.intent.jump || s.glideT <= 0 || f.isDisabled()) {
    endFlight(f);
    return;
  }
  s.glideT = Math.max(0, s.glideT - dt);
  f.flightT += dt;
  s.airborne = true;
  const soar = f.def.perks.soar;
  if (soar !== undefined) {
    const gy = groundHeightAt(s.pos.x, s.pos.z, sim.arena);
    const alt = s.pos.y - gy;
    const want = f.flightT < soar.climbDelay ? soar.glideHeight : soar.maxHeight;
    const vyTarget = clamp((want - alt) * SOAR_ALT_GAIN, -soar.climbRate, soar.climbRate);
    const dv = vyTarget - s.vel.y;
    const maxDv = soar.climbAccel * dt;
    s.vel.y += Math.abs(dv) <= maxDv ? dv : Math.sign(dv) * maxDv;
    s.pos.y += s.vel.y * dt;
    if (s.pos.y > gy + soar.maxHeight) {
      s.pos.y = gy + soar.maxHeight;
      if (s.vel.y > 0) s.vel.y = 0;
    } else if (s.pos.y < gy) {
      s.pos.y = gy;
      if (s.vel.y < 0) s.vel.y = 0;
    }
    f.soarPeak = Math.max(f.soarPeak, s.pos.y - gy);
  } else {
    s.pos.y = GLIDE_HEIGHT;
    s.vel.y = 0;
  }
  // Horizontal glide toward intent direction at glide speed.
  let mx = f.intent.moveX;
  let mz = f.intent.moveZ;
  const mlen = Math.sqrt(mx * mx + mz * mz);
  if (mlen > 1e-4) {
    mx /= mlen;
    mz /= mlen;
  } else {
    mx = Math.sin(s.yaw);
    mz = Math.cos(s.yaw);
  }
  s.vel.x = mx * glide.speed;
  s.vel.z = mz * glide.speed;
  s.pos.x += s.vel.x * dt;
  s.pos.z += s.vel.z * dt;
  turnYaw(f, dt);
  // Glide crosses low walls/crates but not pillars/wall (y high enough). v1.9: a flying eagle also ignores cliffs (it soars onto any level).
  resolveObstacles(sim, f, false, false);
  clampToWall(f);
  if (s.glideT <= 0) endFlight(f);
}

/** Global soft fighter↔fighter push-out pass (§7.8). Order: id-ascending pairs. */
export function resolveFighterCollisions(sim: Sim): void {
  const fs = sim.fighters;
  for (let i = 0; i < fs.length; i++) {
    const a = fs[i];
    if (!a.state.alive || a.movementOwned || a.state.grabbedById !== -1) continue;
    for (let j = i + 1; j < fs.length; j++) {
      const b = fs[j];
      if (!b.state.alive || b.movementOwned || b.state.grabbedById !== -1) continue;
      if (Math.abs(a.state.pos.y - b.state.pos.y) > FIGHTER_PUSH_HEIGHT) continue;
      let dx = b.state.pos.x - a.state.pos.x;
      let dz = b.state.pos.z - a.state.pos.z;
      let d = Math.sqrt(dx * dx + dz * dz);
      const minD = a.def.radius + b.def.radius;
      if (d >= minD) continue;
      if (d < 1e-6) {
        dx = (a.id < b.id ? -1 : 1);
        dz = 0;
        d = 1;
      }
      const overlap = (minD - d) * FIGHTER_PUSH_FRACTION;
      const px = (dx / d) * overlap * 0.5;
      const pz = (dz / d) * overlap * 0.5;
      a.state.pos.x -= px;
      a.state.pos.z -= pz;
      b.state.pos.x += px;
      b.state.pos.z += pz;
    }
  }
  // Re-clamp anyone pushed through the wall.
  for (let i = 0; i < fs.length; i++) {
    if (fs[i].state.alive && !fs[i].movementOwned) clampToWall(fs[i]);
  }
  // v1.9: ... or into a cliff (a body pushed by another fighter slides along it like along a wall).
  if (sim.arena.heightfield !== undefined) {
    for (let i = 0; i < fs.length; i++) {
      const f = fs[i];
      if (!f.state.alive || f.movementOwned || f.state.glideT > 0) continue;
      pushOutOfCliffs(sim.arena, f);
      // ... and keep a grounded body's feet on the ground it was just pushed over (up a ramp edge / over a small seam)
      const s = f.state;
      if (!s.airborne) {
        const gy = arenaGroundHeight(sim.arena, s.pos.x, s.pos.z);
        if (s.pos.y < gy || s.pos.y - gy <= ARENA_SNAP_DOWN) s.pos.y = gy;
        else {
          s.airborne = true; // pushed off a ledge: the fall starts now
          f.airPeakY = Math.max(f.airPeakY, s.pos.y);
        }
      }
    }
  }
}

/**
 * v1.9: the ground reference of a ballistic leap (lion / gorilla leap, lion Pounce) over `frac` of its flight from (sx, sz) to (px, pz).
 * Flat arenas: the ground under the fighter, exactly as before. Heightfield arenas: never below the straight blend of the start and
 * landing ground heights, so a leap across a level change eases instead of popping 1.5 m when it crosses a ledge.
 */
export function leapGroundY(arena: ArenaDef, sx: number, sz: number, px: number, pz: number, x: number, z: number, frac: number): number {
  const gy = arenaGroundHeight(arena, x, z);
  if (arena.heightfield === undefined) return gy;
  const g0 = arenaGroundHeight(arena, sx, sz);
  const g1 = arenaGroundHeight(arena, px, pz);
  return Math.max(gy, g0 + (g1 - g0) * frac);
}

/**
 * v1.9: shorten a straight leap/dash from (sx, sz) toward (px, pz) so a body of `radius` never enters ground higher than a grounded
 * fighter with feet at `feetY` could step onto (the feet follow the ground along the way; walking down is free). Writes the farthest
 * reachable point to `out` and returns true if it had to be shortened. Flat arenas: a no-op returning false.
 */
export function clipPathToCliffs(
  arena: ArenaDef,
  sx: number,
  sz: number,
  px: number,
  pz: number,
  radius: number,
  feetY: number,
  out: { x: number; z: number },
): boolean {
  out.x = px;
  out.z = pz;
  if (arena.heightfield === undefined) return false;
  const dx = px - sx;
  const dz = pz - sz;
  const n = Math.max(1, Math.ceil(Math.sqrt(dx * dx + dz * dz) / 0.25));
  let h = feetY;
  let lastX = sx;
  let lastZ = sz;
  for (let i = 1; i <= n; i++) {
    const x = sx + (dx * i) / n;
    const z = sz + (dz * i) / n;
    if (arenaCliffPush(arena, x, z, radius, h + ARENA_STEP_UP, CLIFF_OUT)) {
      out.x = lastX;
      out.z = lastZ;
      return true;
    }
    h = arenaGroundHeight(arena, x, z);
    lastX = x;
    lastZ = z;
  }
  return false;
}
