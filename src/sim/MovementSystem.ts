/**
 * Movement & collision (BLUEPRINT §7.8): accel/decel steering, gravity, jump,
 * fear/root/slow/block/attack move modifiers, yaw turning, soft fighter push-out,
 * circle/segment/AABB obstacle push-out, wall clamp, dais step-up, and the
 * charge-stepping helper abilities reuse (rhino/hippo/mole/panther/eagle).
 */

import type { Fighter, Sim, CrateRuntime } from './Fighter';
import { MOVE, ARENA } from '../config/balance';
import { WALL_RADIUS } from '../config/arena';
import { GLIDE_HEIGHT, RUN_TURN_RATE, FIGHTER_PUSH_FRACTION, FIGHTER_PUSH_HEIGHT } from './simTuning';
import { COMBO } from '../config/balance';
import { rotateToward, dirToYaw, clamp } from '../core/math';
import { speedMult, fearFleeYaw } from './StatusEffects';

/** Ground height under (x,z): the dais top where applicable, else 0 (§7.8). */
export function groundHeightAt(x: number, z: number): number {
  const d = Math.sqrt(x * x + z * z);
  return d <= 4 ? ARENA.daisY : ARENA.groundY;
}

/** Result of a push-out resolution pass. */
export interface CollisionResult {
  corrX: number;
  corrZ: number;
  hitCrate: CrateRuntime | null;
}

const RESULT: CollisionResult = { corrX: 0, corrZ: 0, hitCrate: null };

/**
 * Push `f` out of every solid obstacle + live crate it overlaps (does NOT touch
 * the arena wall). Mole `burrowed` and airborne fighters above a low wall/crate
 * pass through. Returns the net correction and any crate hit.
 */
export function resolveObstacles(sim: Sim, f: Fighter, ignoreObstacles: boolean): CollisionResult {
  RESULT.corrX = 0;
  RESULT.corrZ = 0;
  RESULT.hitCrate = null;
  if (ignoreObstacles) return RESULT;
  const r = f.def.radius;
  const y = f.state.pos.y;

  for (let i = 0; i < sim.staticObstacles.length; i++) {
    const ob = sim.staticObstacles[i];
    if (ob.shape === 'circle') {
      if (ob.walkable) continue; // dais: step-up, not a blocker
      pushOutCircle(f, ob.x, ob.z, ob.radius + r);
    } else if (ob.shape === 'segment') {
      if (ob.jumpable && y >= ob.height) continue; // jumped/glided over
      pushOutSegment(f, ob.ax, ob.az, ob.bx, ob.bz, ob.thickness * 0.5 + r);
    }
  }
  for (let i = 0; i < sim.crates.length; i++) {
    const c = sim.crates[i];
    if (!c.alive) continue;
    if (y >= c.height) continue; // cleared by jump/glide
    if (pushOutAabb(f, c.x, c.z, c.halfX, c.halfZ, r)) RESULT.hitCrate = c;
  }
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

/** Clamp a fighter inside the arena wall (circle r=30). Returns true if clamped. */
export function clampToWall(f: Fighter): boolean {
  const maxR = WALL_RADIUS - f.def.radius;
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
  // Stopped if a correction pushed us back against the travel direction.
  const opposed = res.corrX * dirX + res.corrZ * dirZ;
  const stopped = hitWall || opposed < -1e-4;
  return { stopped, hitCrate: res.hitCrate };
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
  const baseSpeed = f.def.speed * speedMult(f);

  // Desired horizontal velocity.
  let dvx = 0;
  let dvz = 0;
  if (f.fearTimer > 0) {
    const fy = fearFleeYaw(f);
    dvx = Math.sin(fy) * baseSpeed;
    dvz = Math.cos(fy) * baseSpeed;
  } else if (!disabled && f.rootTimer <= 0 && f.hitstunTimer <= 0) {
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

  // Jump start (edge) — only when free & grounded.
  if (
    f.edgeJump &&
    !s.airborne &&
    !disabled &&
    !f.blocking &&
    !f.swinging &&
    f.ability === null &&
    f.rootTimer <= 0
  ) {
    s.vel.y = MOVE.jumpVelocity;
    s.airborne = true;
  }

  // Vertical integration.
  const gy = groundHeightAt(s.pos.x, s.pos.z);
  if (s.airborne || s.pos.y > gy + 1e-4) {
    s.airborne = true;
    s.vel.y -= MOVE.gravity * dt;
    s.pos.y += s.vel.y * dt;
    if (s.pos.y <= gy && s.vel.y <= 0) {
      s.pos.y = gy;
      s.vel.y = 0;
      s.airborne = false;
      maybeStartGlide(f); // no-op unless eagle holding jump — handled at apex normally
    }
  } else {
    s.pos.y = gy;
    s.vel.y = 0;
    s.airborne = false;
  }

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
  if (f.state.glideT > 0) return;
  if (f.state.airborne && f.intent.jump && f.glideCd <= 0 && f.state.vel.y <= MOVE.jumpVelocity * 0.4) {
    f.state.glideT = glide.duration;
  }
}

function updateGlide(sim: Sim, f: Fighter, dt: number): void {
  const glide = f.def.perks.glide;
  const s = f.state;
  if (glide === undefined) {
    s.glideT = 0;
    return;
  }
  // End conditions: released jump or ran out of glide time.
  if (!f.intent.jump || s.glideT <= 0 || f.isDisabled()) {
    s.glideT = 0;
    f.glideCd = glide.cooldown;
    s.airborne = true; // fall next tick under gravity
    return;
  }
  s.glideT = Math.max(0, s.glideT - dt);
  s.pos.y = GLIDE_HEIGHT;
  s.airborne = true;
  s.vel.y = 0;
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
  // Glide crosses low walls/crates but not pillars/wall (y high enough).
  resolveObstacles(sim, f, false);
  clampToWall(f);
  if (s.glideT <= 0) {
    f.glideCd = glide.cooldown;
  }
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
}
