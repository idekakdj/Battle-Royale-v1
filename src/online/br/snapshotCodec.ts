/**
 * Battle Royale `WorldSnapshot` binary codec (WP-N3, plan §5).
 *
 * One self-contained packet per snapshot (no baseline / ack machinery, so any single lost or reordered packet is harmless):
 *
 *   header   u16 seq · i32 timeMs · u8 flags · u8 nFighters · u8 nPickups · u8 nCrates · u8 nTraps · u16 bloodlust×1000
 *            [u8 winner+1 when matchOver]
 *   statics  (KEYFRAME only, every ~2 s and for any client that asks) per fighter animal/isPlayer/maxHp/maxGuard,
 *            per pickup/crate/trap id + position (+ trap kind/radius)
 *   fighters per fighter: u8 flags · u8 action · i16 x · i16 z · u16 yaw · [y] [vel] · hp · guard · ult · varu optMask · optional groups
 *            (flags bit 7 = `inWater`, optMask bit 12 = `onMoss`: the v1.8 jungle terrain flags, absent/0 costs nothing)
 *   pickups  u8 kind|active · [respawnT]
 *   crates   u16 (hp×4 | alive<<15)
 *   traps    u8 phase|hasTime · u8 triggeredBy+1 · [timeLeft]
 *   projectiles (when present/non-empty) varu n · each id/kind/pos/vel/radius/owner
 *   stats    (flag; keyframes, every 8th seq, match over) per fighter kills · damageDealt · damageBlocked · ultsUsed
 *
 * Absent optional data costs nothing (ult fields, buffs, grab links, glide/burrow clocks, cooldown timers, …).
 * Quantisation steps and tolerances: see `Q` / `TOLERANCE` in tables.ts. `decode` NEVER throws: corrupt, truncated or
 * hostile bytes give `null`.
 */

import type {
  AnimalId,
  BuffState,
  FighterState,
  PickupState,
  ProjectileState,
  TrapKind,
  TrapState,
  Vec3,
  WorldSnapshot,
} from '../../core/types';
import { ByteReader, ByteWriter } from '../wire';
import {
  ACTION_TABLE,
  ANIMAL_TABLE,
  BUFF_TABLE,
  PICKUP_KIND_TABLE,
  PROJECTILE_KIND_TABLE,
  Q,
  TRAP_KIND_TABLE,
  TRAP_PHASE_TABLE,
  ULT_PHASE_TABLE,
  angleToU16,
  decEnum,
  encEnum,
  qI16,
  qU16,
  qU16Ceil,
  readFiniteF32,
  readOptId,
  readVec3,
  u16ToAngle,
  writeOptId,
  writeVec3,
} from './tables';

// ── Header flag bits ─────────────────────────────────────────────────────────
const H_KEYFRAME = 1;
const H_STATS = 2;
const H_MATCH_OVER = 4;
const H_PROJ_DEFINED = 8;
const H_PROJ_NONEMPTY = 16;
const H_EXPLICIT_IDS = 32;

// ── Fighter flag bits ────────────────────────────────────────────────────────
const F_ALIVE = 1;
const F_AIRBORNE = 2;
const F_HAS_Y = 4;
const F_HAS_VEL = 8;
const F_HAS_VY = 16;
// bits 5..6: comboIndex
const F_IN_WATER = 128; // v1.8 terrain flag (FighterState.inWater)

// ── Fighter optional-group bits (varu) ───────────────────────────────────────
const O_SPECIAL_CD = 1 << 0;
const O_ACTION_CLOCK = 1 << 1;
const O_COMBO_WINDOW = 1 << 2;
const O_GUARD_DELAY = 1 << 3;
const O_BUFFS = 1 << 4;
const O_GRABBED_BY = 1 << 5;
const O_GRAB_TARGET = 1 << 6;
const O_GLIDE = 1 << 7;
const O_BURROW = 1 << 8;
const O_ULT_PHASE = 1 << 9;
const O_ULT_STAGE = 1 << 10;
const O_ULT_TARGET = 1 << 11;
const O_ON_MOSS = 1 << 12; // v1.8 terrain flag (FighterState.onMoss); a flag only, no payload
const O_KNOWN = (1 << 13) - 1;

const MAX_FIGHTERS = 64;
const MAX_BUFFS = 32;
const MAX_PROJECTILES = 255;

/** Slowly-changing data sent in keyframes (plus ids/positions of the arena furniture). */
export interface SnapshotStatics {
  fighters: { id: number; animal: AnimalId; isPlayer: boolean; maxHp: number; maxGuard: number }[];
  pickups: { id: number; pos: Vec3 }[];
  crates: { id: number; pos: Vec3 }[];
  traps: { id: number; kind: TrapKind; pos: Vec3; radius: number }[];
}

export interface EncodeOptions {
  /** Snapshot sequence number (wraps at 65536). */
  seq: number;
  /** Include the statics block. */
  keyframe?: boolean;
  /** Include kills/damage/ult-use counters. Forced on for keyframes and match-over snapshots. */
  stats?: boolean;
}

export interface DecodedSnapshot {
  seq: number;
  keyframe: boolean;
  snapshot: WorldSnapshot;
}

/** Stats are re-sent every this many snapshots (they are monotone, the decoder carries the last known values). */
export const STATS_EVERY = 8;

export function extractStatics(s: WorldSnapshot): SnapshotStatics {
  return {
    fighters: s.fighters.map((f) => ({ id: f.id, animal: f.animal, isPlayer: f.isPlayer, maxHp: f.maxHp, maxGuard: f.maxGuard })),
    pickups: s.pickups.map((p) => ({ id: p.id, pos: { ...p.pos } })),
    crates: s.crates.map((c) => ({ id: c.id, pos: { ...c.pos } })),
    traps: s.traps.map((t) => ({ id: t.id, kind: t.kind, pos: { ...t.pos }, radius: t.radius })),
  };
}

// ── Encoder ──────────────────────────────────────────────────────────────────

export function encodeSnapshot(s: WorldSnapshot, opts: EncodeOptions): Uint8Array {
  const keyframe = opts.keyframe === true;
  const stats = keyframe || s.matchOver || opts.stats === true;
  const nF = s.fighters.length;
  if (nF > MAX_FIGHTERS) throw new RangeError('too many fighters');
  let explicitIds = false;
  for (let i = 0; i < nF; i++) if (s.fighters[i].id !== i) explicitIds = true;
  const proj = s.projectiles;
  const projNonEmpty = proj !== undefined && proj.length > 0;

  const w = new ByteWriter(64 + nF * 40);
  w.u16(opts.seq & 0xffff);
  w.i32(Math.round(s.time * 1000));
  let flags = 0;
  if (keyframe) flags |= H_KEYFRAME;
  if (stats) flags |= H_STATS;
  if (s.matchOver) flags |= H_MATCH_OVER;
  if (proj !== undefined) flags |= H_PROJ_DEFINED;
  if (projNonEmpty) flags |= H_PROJ_NONEMPTY;
  if (explicitIds) flags |= H_EXPLICIT_IDS;
  w.u8(flags);
  w.u8(nF).u8(s.pickups.length).u8(s.crates.length).u8(s.traps.length);
  w.u16(qU16(s.bloodlustMult, Q.SMALL));
  if (s.matchOver) writeOptId(w, s.winnerId);

  if (keyframe) writeStatics(w, extractStatics(s));

  for (let i = 0; i < nF; i++) writeFighter(w, s.fighters[i], explicitIds);

  for (const p of s.pickups) {
    const active = p.active;
    const hasT = !active && p.respawnT !== 0;
    w.u8(encEnum(PICKUP_KIND_TABLE, p.kind) | (active ? 4 : 0) | (hasT ? 128 : 0));
    if (hasT) w.u16(qU16(p.respawnT, Q.TIME));
  }
  for (const c of s.crates) {
    const hp = Math.max(0, Math.min(32767, Math.round(c.hp * 4)));
    w.u16(hp | (c.alive ? 0x8000 : 0));
  }
  for (const t of s.traps) {
    const qt = qU16(t.timeLeft, Q.TIME);
    w.u8(encEnum(TRAP_PHASE_TABLE, t.phase) | (qt !== 0 ? 128 : 0));
    writeOptId(w, t.triggeredBy);
    if (qt !== 0) w.u16(qt);
  }
  if (projNonEmpty) {
    const n = Math.min(MAX_PROJECTILES, proj.length);
    w.varu(n);
    for (let i = 0; i < n; i++) {
      const p = proj[i];
      w.varu(p.id);
      w.u8(encEnum(PROJECTILE_KIND_TABLE, p.kind));
      writeVec3(w, p.pos);
      w.i16(qI16(p.vel.x, Q.VEL)).i16(qI16(p.vel.y, Q.VEL)).i16(qI16(p.vel.z, Q.VEL));
      w.u16(qU16(p.radius, Q.SMALL));
      writeOptId(w, p.ownerId);
    }
  }
  if (stats) {
    for (let i = 0; i < nF; i++) {
      const f = s.fighters[i];
      w.varu(f.kills);
      w.varu(qCount(f.damageDealt));
      w.varu(qCount(f.damageBlocked));
      w.varu(f.ultsUsed);
    }
  }
  return w.finish();
}

function qCount(v: number): number {
  return v > 0 && v === v ? Math.min(0xfffffff, Math.round(v * 16)) : 0;
}

function writeStatics(w: ByteWriter, st: SnapshotStatics): void {
  for (const f of st.fighters) {
    w.varu(f.id);
    w.u8(encEnum(ANIMAL_TABLE, f.animal) | (f.isPlayer ? 128 : 0));
    w.f32(f.maxHp).f32(f.maxGuard);
  }
  for (const p of st.pickups) {
    w.varu(p.id);
    writeVec3(w, p.pos);
  }
  for (const c of st.crates) {
    w.varu(c.id);
    writeVec3(w, c.pos);
  }
  for (const t of st.traps) {
    w.varu(t.id);
    w.u8(encEnum(TRAP_KIND_TABLE, t.kind));
    writeVec3(w, t.pos);
    w.f32(t.radius);
  }
}

function writeFighter(w: ByteWriter, f: FighterState, explicitId: boolean): void {
  if (explicitId) w.varu(f.id);
  const qy = qI16(f.pos.y, Q.POS);
  const qvx = qI16(f.vel.x, Q.VEL);
  const qvz = qI16(f.vel.z, Q.VEL);
  const qvy = qI16(f.vel.y, Q.VEL);
  const hasVel = qvx !== 0 || qvz !== 0;
  let b0 = 0;
  if (f.alive) b0 |= F_ALIVE;
  if (f.airborne) b0 |= F_AIRBORNE;
  if (qy !== 0) b0 |= F_HAS_Y;
  if (hasVel) b0 |= F_HAS_VEL;
  if (qvy !== 0) b0 |= F_HAS_VY;
  b0 |= (f.comboIndex & 3) << 5;
  if (f.inWater === true) b0 |= F_IN_WATER;
  w.u8(b0);
  w.u8(encEnum(ACTION_TABLE, f.action));
  w.i16(qI16(f.pos.x, Q.POS)).i16(qI16(f.pos.z, Q.POS));
  w.u16(angleToU16(f.yaw));
  if (qy !== 0) w.i16(qy);
  if (hasVel) w.i16(qvx).i16(qvz);
  if (qvy !== 0) w.i16(qvy);
  w.u16(f.hp > 0 ? qU16Ceil(f.hp, Q.HP) : 0);
  w.u16(qU16(f.guard, Q.HP));
  w.u16(f.ultCharge >= 100 ? 10000 : Math.min(9999, qU16(f.ultCharge, Q.ULT)));

  const qCd = qU16Ceil(f.specialCd, Q.TIME / 10); // 1/100 s, rounded up
  const qAT = qU16(f.actionT, Q.TIME);
  const qAD = qU16(f.actionDur, Q.TIME);
  const qCw = qU16(f.comboWindow, Q.TIME);
  const qGd = qU16(f.guardRegenDelay, Q.TIME);
  const qGl = qU16(f.glideT, Q.TIME);
  const qBu = qU16(f.burrowT, Q.TIME);
  let opt = 0;
  if (qCd !== 0) opt |= O_SPECIAL_CD;
  if (qAT !== 0 || qAD !== 0) opt |= O_ACTION_CLOCK;
  if (qCw !== 0) opt |= O_COMBO_WINDOW;
  if (qGd !== 0) opt |= O_GUARD_DELAY;
  if (f.buffs.length > 0) opt |= O_BUFFS;
  if (f.grabbedById >= 0) opt |= O_GRABBED_BY;
  if (f.grabTargetId >= 0) opt |= O_GRAB_TARGET;
  if (qGl !== 0) opt |= O_GLIDE;
  if (qBu !== 0) opt |= O_BURROW;
  if (f.ultPhase !== undefined) opt |= O_ULT_PHASE;
  if (f.ultStage !== undefined) opt |= O_ULT_STAGE;
  if (f.ultTargetId !== undefined) opt |= O_ULT_TARGET;
  if (f.onMoss === true) opt |= O_ON_MOSS;
  w.varu(opt);
  if (opt & O_SPECIAL_CD) w.u16(qCd);
  if (opt & O_ACTION_CLOCK) w.u16(qAT).u16(qAD);
  if (opt & O_COMBO_WINDOW) w.u16(qCw);
  if (opt & O_GUARD_DELAY) w.u16(qGd);
  if (opt & O_BUFFS) {
    const n = Math.min(MAX_BUFFS, f.buffs.length);
    w.u8(n);
    for (let i = 0; i < n; i++) writeBuff(w, f.buffs[i]);
  }
  if (opt & O_GRABBED_BY) w.u8(Math.min(255, f.grabbedById));
  if (opt & O_GRAB_TARGET) w.u8(Math.min(255, f.grabTargetId));
  if (opt & O_GLIDE) w.u16(qGl);
  if (opt & O_BURROW) w.u16(qBu);
  if (opt & O_ULT_PHASE) w.u8(encEnum(ULT_PHASE_TABLE, f.ultPhase as NonNullable<FighterState['ultPhase']>));
  if (opt & O_ULT_STAGE) w.varu(Math.max(0, f.ultStage ?? 0));
  if (opt & O_ULT_TARGET) writeOptId(w, f.ultTargetId ?? -1);
}

function writeBuff(w: ByteWriter, b: BuffState): void {
  w.u8(encEnum(BUFF_TABLE, b.kind));
  w.u16(qU16(b.t, Q.TIME)).u16(qU16(b.dur, Q.TIME));
  w.f32(b.mag);
}

// ── Decoder ──────────────────────────────────────────────────────────────────

/**
 * Stateful decoder: remembers the last keyframe's statics and the last stats block (the counters are monotone, so a
 * reordered older packet can never move them backwards).
 */
export class SnapshotDecoder {
  statics: SnapshotStatics | null = null;
  private carry: { kills: number; dmg: number; blk: number; ults: number }[] = [];
  /** Set when a non-keyframe packet arrived before any keyframe (the client should ask for one). */
  needsKeyframe = true;

  /** Pre-seed statics learned out of band (e.g. from the room's roster) — optional. */
  reset(): void {
    this.statics = null;
    this.carry = [];
    this.needsKeyframe = true;
  }

  decode(bytes: Uint8Array): DecodedSnapshot | null {
    try {
      return this.decodeUnsafe(bytes);
    } catch {
      return null;
    }
  }

  private decodeUnsafe(bytes: Uint8Array): DecodedSnapshot | null {
    const r = new ByteReader(bytes);
    const seq = r.u16();
    const timeMs = r.i32();
    const flags = r.u8();
    if ((flags & 0xc0) !== 0) return null;
    const nF = r.u8();
    const nP = r.u8();
    const nC = r.u8();
    const nT = r.u8();
    if (nF > MAX_FIGHTERS) return null;
    const bloodlust = r.u16() / Q.SMALL;
    const matchOver = (flags & H_MATCH_OVER) !== 0;
    const winnerId = matchOver ? readOptId(r) : -1;
    const keyframe = (flags & H_KEYFRAME) !== 0;
    const hasStats = (flags & H_STATS) !== 0;
    const explicitIds = (flags & H_EXPLICIT_IDS) !== 0;

    let statics: SnapshotStatics;
    if (keyframe) {
      statics = readStatics(r, nF, nP, nC, nT);
    } else {
      if (this.statics === null) {
        this.needsKeyframe = true;
        return null;
      }
      statics = this.statics;
      if (statics.fighters.length !== nF || statics.pickups.length !== nP || statics.crates.length !== nC || statics.traps.length !== nT) {
        this.needsKeyframe = true;
        return null;
      }
    }

    const fighters: FighterState[] = new Array(nF);
    for (let i = 0; i < nF; i++) fighters[i] = readFighter(r, statics.fighters[i], i, explicitIds);

    const pickups: PickupState[] = new Array(nP);
    for (let i = 0; i < nP; i++) {
      const b = r.u8();
      if ((b & 0x78) !== 0) throw new RangeError('bad pickup byte');
      const active = (b & 4) !== 0;
      const respawnT = (b & 128) !== 0 ? r.u16() / Q.TIME : 0;
      pickups[i] = {
        id: statics.pickups[i].id,
        kind: decEnum(PICKUP_KIND_TABLE, b & 3),
        pos: { ...statics.pickups[i].pos },
        active,
        respawnT,
      };
    }
    const crates: WorldSnapshot['crates'] = new Array(nC);
    for (let i = 0; i < nC; i++) {
      const v = r.u16();
      crates[i] = { id: statics.crates[i].id, pos: { ...statics.crates[i].pos }, hp: (v & 0x7fff) / 4, alive: (v & 0x8000) !== 0 };
    }
    const traps: TrapState[] = new Array(nT);
    for (let i = 0; i < nT; i++) {
      const b = r.u8();
      if ((b & 0x7c) !== 0) throw new RangeError('bad trap byte');
      const triggeredBy = readOptId(r);
      const timeLeft = (b & 128) !== 0 ? r.u16() / Q.TIME : 0;
      const st = statics.traps[i];
      traps[i] = {
        id: st.id,
        kind: st.kind,
        pos: { ...st.pos },
        radius: st.radius,
        phase: decEnum(TRAP_PHASE_TABLE, b & 3),
        timeLeft,
        triggeredBy,
      };
    }
    let projectiles: ProjectileState[] | undefined;
    if ((flags & H_PROJ_DEFINED) !== 0) {
      projectiles = [];
      if ((flags & H_PROJ_NONEMPTY) !== 0) {
        const n = r.varu();
        if (n > MAX_PROJECTILES) throw new RangeError('too many projectiles');
        for (let i = 0; i < n; i++) {
          const id = r.varu();
          const kind = decEnum(PROJECTILE_KIND_TABLE, r.u8());
          const pos = readVec3(r);
          const vel = { x: r.i16() / Q.VEL, y: r.i16() / Q.VEL, z: r.i16() / Q.VEL };
          const radius = r.u16() / Q.SMALL;
          projectiles.push({ id, kind, pos, vel, radius, ownerId: readOptId(r) });
        }
      }
    }
    const newCarry: { kills: number; dmg: number; blk: number; ults: number }[] = [];
    if (hasStats) {
      for (let i = 0; i < nF; i++) {
        const c = this.carry[i] ?? { kills: 0, dmg: 0, blk: 0, ults: 0 };
        newCarry[i] = {
          kills: Math.max(c.kills, r.varu()),
          dmg: Math.max(c.dmg, r.varu() / 16),
          blk: Math.max(c.blk, r.varu() / 16),
          ults: Math.max(c.ults, r.varu()),
        };
      }
    }
    if (r.remaining !== 0) return null;
    if (hasStats) this.carry = newCarry;

    for (let i = 0; i < nF; i++) {
      const c = this.carry[i];
      if (c !== undefined) {
        fighters[i].kills = c.kills;
        fighters[i].damageDealt = c.dmg;
        fighters[i].damageBlocked = c.blk;
        fighters[i].ultsUsed = c.ults;
      }
    }
    if (keyframe) {
      this.statics = statics;
      this.needsKeyframe = false;
    }

    const snapshot: WorldSnapshot = {
      time: timeMs / 1000,
      fighters,
      pickups,
      crates,
      traps,
      bloodlustMult: bloodlust,
      matchOver,
      winnerId,
    };
    if (projectiles !== undefined) snapshot.projectiles = projectiles;
    return { seq, keyframe, snapshot };
  }
}

function readStatics(r: ByteReader, nF: number, nP: number, nC: number, nT: number): SnapshotStatics {
  const fighters: SnapshotStatics['fighters'] = [];
  for (let i = 0; i < nF; i++) {
    const id = r.varu();
    const b = r.u8();
    fighters.push({
      id,
      animal: decEnum(ANIMAL_TABLE, b & 127),
      isPlayer: (b & 128) !== 0,
      maxHp: readFiniteF32(r),
      maxGuard: readFiniteF32(r),
    });
  }
  const pickups: SnapshotStatics['pickups'] = [];
  for (let i = 0; i < nP; i++) pickups.push({ id: r.varu(), pos: readVec3(r) });
  const crates: SnapshotStatics['crates'] = [];
  for (let i = 0; i < nC; i++) crates.push({ id: r.varu(), pos: readVec3(r) });
  const traps: SnapshotStatics['traps'] = [];
  for (let i = 0; i < nT; i++) {
    const id = r.varu();
    const kind = decEnum(TRAP_KIND_TABLE, r.u8());
    traps.push({ id, kind, pos: readVec3(r), radius: readFiniteF32(r) });
  }
  return { fighters, pickups, crates, traps };
}

function readFighter(r: ByteReader, st: SnapshotStatics['fighters'][number], index: number, explicitId: boolean): FighterState {
  const id = explicitId ? r.varu() : index;
  const b0 = r.u8();
  const action = decEnum(ACTION_TABLE, r.u8());
  const x = r.i16() / Q.POS;
  const z = r.i16() / Q.POS;
  const yaw = u16ToAngle(r.u16());
  const y = (b0 & F_HAS_Y) !== 0 ? r.i16() / Q.POS : 0;
  let vx = 0;
  let vz = 0;
  if ((b0 & F_HAS_VEL) !== 0) {
    vx = r.i16() / Q.VEL;
    vz = r.i16() / Q.VEL;
  }
  const vy = (b0 & F_HAS_VY) !== 0 ? r.i16() / Q.VEL : 0;
  const hp = r.u16() / Q.HP;
  const guard = r.u16() / Q.HP;
  const ult = r.u16();
  if (ult > 10000) throw new RangeError('bad ult charge');
  const opt = r.varu();
  if (opt > O_KNOWN) throw new RangeError('unknown optional groups');

  const s: FighterState = {
    id,
    animal: st.animal,
    isPlayer: st.isPlayer,
    alive: (b0 & F_ALIVE) !== 0,
    pos: { x, y, z },
    vel: { x: vx, y: vy, z: vz },
    yaw,
    hp,
    maxHp: st.maxHp,
    guard,
    maxGuard: st.maxGuard,
    guardRegenDelay: 0,
    ultCharge: ult / Q.ULT,
    specialCd: 0,
    action,
    actionT: 0,
    actionDur: 0,
    comboIndex: ((b0 >> 5) & 3) as 0 | 1 | 2,
    comboWindow: 0,
    buffs: [],
    kills: 0,
    damageDealt: 0,
    damageBlocked: 0,
    ultsUsed: 0,
    grabTargetId: -1,
    grabbedById: -1,
    airborne: (b0 & F_AIRBORNE) !== 0,
    glideT: 0,
    burrowT: 0,
  };
  if (s.comboIndex > 2) throw new RangeError('bad combo index');
  if ((b0 & F_IN_WATER) !== 0) s.inWater = true;
  if (opt & O_ON_MOSS) s.onMoss = true;
  if (opt & O_SPECIAL_CD) s.specialCd = r.u16() / (Q.TIME / 10);
  if (opt & O_ACTION_CLOCK) {
    s.actionT = r.u16() / Q.TIME;
    s.actionDur = r.u16() / Q.TIME;
  }
  if (opt & O_COMBO_WINDOW) s.comboWindow = r.u16() / Q.TIME;
  if (opt & O_GUARD_DELAY) s.guardRegenDelay = r.u16() / Q.TIME;
  if (opt & O_BUFFS) {
    const n = r.u8();
    if (n > MAX_BUFFS) throw new RangeError('too many buffs');
    for (let i = 0; i < n; i++) {
      const kind = decEnum(BUFF_TABLE, r.u8());
      const t = r.u16() / Q.TIME;
      const dur = r.u16() / Q.TIME;
      s.buffs.push({ kind, t, dur, mag: readFiniteF32(r) });
    }
  }
  if (opt & O_GRABBED_BY) s.grabbedById = r.u8();
  if (opt & O_GRAB_TARGET) s.grabTargetId = r.u8();
  if (opt & O_GLIDE) s.glideT = r.u16() / Q.TIME;
  if (opt & O_BURROW) s.burrowT = r.u16() / Q.TIME;
  if (opt & O_ULT_PHASE) s.ultPhase = decEnum(ULT_PHASE_TABLE, r.u8());
  if (opt & O_ULT_STAGE) s.ultStage = r.varu();
  if (opt & O_ULT_TARGET) s.ultTargetId = readOptId(r);
  return s;
}

// ── Convenience wrappers ─────────────────────────────────────────────────────

/** Stateless one-shot decode of a KEYFRAME packet (tests / tools). Returns null for a non-keyframe. */
export function decodeKeyframe(bytes: Uint8Array): DecodedSnapshot | null {
  return new SnapshotDecoder().decode(bytes);
}
