/**
 * Battle Royale wire format — enum lookup tables and quantisation helpers (WP-N3).
 *
 * Every string-union of the sim model becomes a small integer on the wire through an ordered table. The tables are
 * checked against the TypeScript unions at COMPILE time ({@link AssertCovers}): adding a member to `FighterAction`,
 * `AnimalId`, `BuffState['kind']`, … without extending the table here breaks `tsc`. The order of a table IS the wire
 * format — only ever append, and bump `ONLINE_PROTOCOL_VERSION` when you change one.
 */

import type {
  AnimalId,
  BuffState,
  FighterAction,
  PickupState,
  ProjectileState,
  TrapKind,
  TrapPhase,
  UltTargetKind,
  Vec3,
} from '../../core/types';
import type { ByteReader, ByteWriter } from '../wire';

/** Compile-time proof that table `T` lists every member of union `U` (and nothing else). */
export type AssertCovers<U extends string, T extends readonly string[]> = [Exclude<U, T[number]>, Exclude<T[number], U>] extends [
  never,
  never,
]
  ? true
  : never;

export const ANIMAL_TABLE = ['lion', 'gorilla', 'crocodile', 'hippo', 'rhino', 'eagle', 'panther', 'python', 'giraffe', 'mole'] as const;
export const ACTION_TABLE = [
  'idle',
  'run',
  'attack1',
  'attack2',
  'attack3',
  'special',
  'ultimate',
  'block',
  'stagger',
  'knockdown',
  'hit',
  'dead',
  'burrowed',
  'glide',
  'grab',
  'grabbed',
  'feared',
  'jump',
] as const;
export const BUFF_TABLE = ['speed', 'rage', 'slow', 'bleed', 'root', 'blind', 'dmgTakenUp', 'armorUp', 'atkSpeedUp', 'stealth'] as const;
export const PICKUP_KIND_TABLE = ['heal', 'speed', 'rage'] as const;
export const TRAP_KIND_TABLE = ['fire', 'spikes'] as const;
export const TRAP_PHASE_TABLE = ['armed', 'active', 'cooldown'] as const;
export const ULT_PHASE_TABLE = ['windup', 'active', 'recovery'] as const;
export const ULT_TARGET_KIND_TABLE = ['lock', 'line', 'ground', 'self'] as const;
export const PROJECTILE_KIND_TABLE = ['boulder'] as const;
export const TELEGRAPH_KIND_TABLE = ['special', 'ultimate'] as const;

// Compile-time exhaustiveness (each line fails to compile if the table and the union diverge).
export const TABLES_OK: [
  AssertCovers<AnimalId, typeof ANIMAL_TABLE>,
  AssertCovers<FighterAction, typeof ACTION_TABLE>,
  AssertCovers<BuffState['kind'], typeof BUFF_TABLE>,
  AssertCovers<PickupState['kind'], typeof PICKUP_KIND_TABLE>,
  AssertCovers<TrapKind, typeof TRAP_KIND_TABLE>,
  AssertCovers<TrapPhase, typeof TRAP_PHASE_TABLE>,
  AssertCovers<NonNullable<import('../../core/types').FighterState['ultPhase']>, typeof ULT_PHASE_TABLE>,
  AssertCovers<UltTargetKind, typeof ULT_TARGET_KIND_TABLE>,
  AssertCovers<ProjectileState['kind'], typeof PROJECTILE_KIND_TABLE>,
  AssertCovers<'special' | 'ultimate', typeof TELEGRAPH_KIND_TABLE>,
] = [true, true, true, true, true, true, true, true, true, true];

/** Index of `v` in `table`; throws on an unknown member (encoder side: programmer error). */
export function encEnum<T extends string>(table: readonly T[], v: T): number {
  const i = table.indexOf(v);
  if (i < 0) throw new RangeError(`unknown enum member ${String(v)}`);
  return i;
}

/** Member at index `i`; throws `RangeError` on a corrupt index (decoder side: the packet is dropped). */
export function decEnum<T extends string>(table: readonly T[], i: number): T {
  if (i < 0 || i >= table.length) throw new RangeError('enum index out of range');
  return table[i];
}

// ── Quantisation ─────────────────────────────────────────────────────────────

const TWO_PI = Math.PI * 2;

/** Quantisation steps and the worst-case round-trip error each implies (documented + asserted in tests). */
export const Q = {
  /** Positions / event positions: int16 at 1/100 m → |error| ≤ 0.005 m, range ±327 m. */
  POS: 100,
  /** Velocities: int16 at 1/32 m/s → |error| ≤ 0.016 m/s, range ±1023 m/s. */
  VEL: 32,
  /** hp / guard: uint16 at 1/16 → error ≤ 0.0625 (hp rounds UP so a live fighter never reads 0), range 4095. */
  HP: 16,
  /** ultCharge: uint16 at 1/100 (99.99 stays < 100 so "ready" is exact) → error ≤ 0.01. */
  ULT: 100,
  /** Timers (seconds): uint16 at 1/1000 → error ≤ 0.0005 s, range 65.5 s (larger values clamp). */
  TIME: 1000,
  /** Misc small floats (radius, bloodlust): uint16 at 1/1000. Cooldowns round UP so a running cooldown never reads 0. */
  SMALL: 1000,
  /** Angles: uint16 over [0, 2π) → error ≤ 2π/65536/2 ≈ 4.8e-5 rad. */
  ANGLE: 65536,
  /** Move stick: int8 at 1/127 → error ≤ 0.004 per axis. */
  STICK: 127,
} as const;

export const TOLERANCE = {
  pos: 0.5 / Q.POS + 1e-9,
  vel: 0.5 / Q.VEL + 1e-9,
  hp: 1 / Q.HP + 1e-9,
  ult: 1 / Q.ULT + 1e-9,
  time: 1 / Q.TIME + 1e-9,
  angle: TWO_PI / Q.ANGLE + 1e-9,
  stick: 1 / Q.STICK + 1e-9,
} as const;

function clampInt(v: number, lo: number, hi: number): number {
  if (!(v === v)) return 0; // NaN → 0
  return v < lo ? lo : v > hi ? hi : v;
}

export function qI16(v: number, scale: number): number {
  return clampInt(Math.round(v * scale), -32768, 32767);
}
export function qU16(v: number, scale: number): number {
  return clampInt(Math.round(v * scale), 0, 65535);
}
export function qU16Ceil(v: number, scale: number): number {
  return clampInt(Math.ceil(v * scale - 1e-9), 0, 65535);
}

/** Wrap an angle (radians, any magnitude) to u16 over one turn. */
export function angleToU16(a: number): number {
  if (!(a === a) || a === Infinity || a === -Infinity) return 0;
  let t = (a / TWO_PI) % 1;
  if (t < 0) t += 1;
  return Math.round(t * Q.ANGLE) & 0xffff;
}

/** u16 → radians in [0, 2π). */
export function u16ToAngle(u: number): number {
  return (u / Q.ANGLE) * TWO_PI;
}

/** Smallest signed difference a − b wrapped into (−π, π]. */
export function angleDiff(a: number, b: number): number {
  let d = (a - b) % TWO_PI;
  if (d > Math.PI) d -= TWO_PI;
  else if (d <= -Math.PI) d += TWO_PI;
  return d;
}

/** Shortest-path angle lerp. */
export function lerpAngle(a: number, b: number, t: number): number {
  return a + angleDiff(b, a) * t;
}

export function writeVec3(w: ByteWriter, v: Vec3): void {
  w.i16(qI16(v.x, Q.POS)).i16(qI16(v.y, Q.POS)).i16(qI16(v.z, Q.POS));
}

export function readVec3(r: ByteReader): Vec3 {
  return { x: r.i16() / Q.POS, y: r.i16() / Q.POS, z: r.i16() / Q.POS };
}

/** Fighter-id field that may be −1: stored as `id + 1` in one byte (0 = none). */
export function writeOptId(w: ByteWriter, id: number): void {
  w.u8(id < 0 || !(id === id) ? 0 : Math.min(254, id) + 1);
}
export function readOptId(r: ByteReader): number {
  return r.u8() - 1;
}

/** Reads a finite f32 (non-finite → RangeError so garbage packets are dropped). */
export function readFiniteF32(r: ByteReader): number {
  const v = r.f32();
  if (!Number.isFinite(v)) throw new RangeError('non-finite float');
  return v;
}

/** u16 wrap-around comparison: is `a` newer than `b` (a ≠ b and within half the space ahead)? */
export function seq16Newer(a: number, b: number): boolean {
  return a !== b && ((a - b) & 0xffff) < 0x8000;
}
