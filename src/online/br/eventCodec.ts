/**
 * Battle Royale `GameEvent` codec (WP-N3). Reliable `BR_EVENTS` batches:
 *
 *   varu firstSeq · i32 timeMs (host sim time of the tick) · u8 count · count × event
 *   event = u8 tag · variant fields
 *
 * Event `i` of a batch has sequence id `firstSeq + i`; the client de-duplicates by that id (so a re-delivered batch, or the
 * overlap of two batches, never plays a sound twice).
 *
 * EXHAUSTIVENESS: {@link EVENT_CODECS} is a mapped type over `GameEvent['type']`, so adding a variant to the union without a
 * codec entry here is a COMPILE error; {@link eventTag} / {@link EVENT_TYPES} are derived from it.
 */

import type { GameEvent, GameEventOf } from '../../core/types';
import { ByteReader, ByteWriter } from '../wire';
import {
  ANIMAL_TABLE,
  PICKUP_KIND_TABLE,
  PROJECTILE_KIND_TABLE,
  Q,
  TELEGRAPH_KIND_TABLE,
  TRAP_KIND_TABLE,
  ULT_TARGET_KIND_TABLE,
  angleToU16,
  decEnum,
  encEnum,
  readFiniteF32,
  readOptId,
  readVec3,
  u16ToAngle,
  writeOptId,
  writeVec3,
} from './tables';

type Type = GameEvent['type'];

interface EventCodec<K extends Type> {
  tag: number;
  write(w: ByteWriter, e: GameEventOf<K>): void;
  read(r: ByteReader): GameEventOf<K>;
}

const bool = (r: ByteReader): boolean => {
  const v = r.u8();
  if (v > 1) throw new RangeError('bad bool');
  return v === 1;
};
const step3 = (r: ByteReader): 0 | 1 | 2 => {
  const v = r.u8();
  if (v > 2) throw new RangeError('bad step');
  return v as 0 | 1 | 2;
};
const f32 = readFiniteF32;

/** Every GameEvent variant has exactly one codec; a missing key is a type error. */
export const EVENT_CODECS: { [K in Type]: EventCodec<K> } = {
  hit: {
    tag: 1,
    write: (w, e) => {
      writeOptId(w, e.attackerId);
      writeOptId(w, e.targetId);
      w.f32(e.damage);
      writeVec3(w, e.pos);
      w.u8(e.heavy ? 1 : 0);
    },
    read: (r) => ({
      type: 'hit',
      attackerId: readOptId(r),
      targetId: readOptId(r),
      damage: f32(r),
      pos: readVec3(r),
      heavy: bool(r),
    }),
  },
  blocked: {
    tag: 2,
    write: (w, e) => {
      writeOptId(w, e.attackerId);
      writeOptId(w, e.targetId);
      w.f32(e.damage);
      writeVec3(w, e.pos);
    },
    read: (r) => ({ type: 'blocked', attackerId: readOptId(r), targetId: readOptId(r), damage: f32(r), pos: readVec3(r) }),
  },
  guardBreak: {
    tag: 3,
    write: (w, e) => {
      writeOptId(w, e.targetId);
      writeVec3(w, e.pos);
    },
    read: (r) => ({ type: 'guardBreak', targetId: readOptId(r), pos: readVec3(r) }),
  },
  death: {
    tag: 4,
    write: (w, e) => {
      writeOptId(w, e.targetId);
      writeOptId(w, e.killerId);
      w.u8(Math.max(0, Math.min(255, e.placement)));
    },
    read: (r) => ({ type: 'death', targetId: readOptId(r), killerId: readOptId(r), placement: r.u8() }),
  },
  ultimate: {
    tag: 5,
    write: (w, e) => {
      writeOptId(w, e.fighterId);
      w.u8(encEnum(ANIMAL_TABLE, e.animal));
    },
    read: (r) => ({ type: 'ultimate', fighterId: readOptId(r), animal: decEnum(ANIMAL_TABLE, r.u8()) }),
  },
  special: {
    tag: 6,
    write: (w, e) => {
      writeOptId(w, e.fighterId);
      w.u8(encEnum(ANIMAL_TABLE, e.animal));
    },
    read: (r) => ({ type: 'special', fighterId: readOptId(r), animal: decEnum(ANIMAL_TABLE, r.u8()) }),
  },
  telegraph: {
    tag: 7,
    write: (w, e) => {
      writeOptId(w, e.fighterId);
      w.u8(encEnum(TELEGRAPH_KIND_TABLE, e.kind));
      writeVec3(w, e.pos);
      w.f32(e.radius);
      w.u16(angleToU16(e.yaw));
      w.f32(e.arcDeg);
      w.f32(e.windup);
    },
    read: (r) => ({
      type: 'telegraph',
      fighterId: readOptId(r),
      kind: decEnum(TELEGRAPH_KIND_TABLE, r.u8()),
      pos: readVec3(r),
      radius: f32(r),
      yaw: u16ToAngle(r.u16()),
      arcDeg: f32(r),
      windup: f32(r),
    }),
  },
  pickup: {
    tag: 8,
    write: (w, e) => {
      writeOptId(w, e.fighterId);
      w.u8(encEnum(PICKUP_KIND_TABLE, e.kind));
      writeVec3(w, e.pos);
    },
    read: (r) => ({ type: 'pickup', fighterId: readOptId(r), kind: decEnum(PICKUP_KIND_TABLE, r.u8()), pos: readVec3(r) }),
  },
  comboFinisher: {
    tag: 9,
    write: (w, e) => writeOptId(w, e.fighterId),
    read: (r) => ({ type: 'comboFinisher', fighterId: readOptId(r) }),
  },
  crateBreak: {
    tag: 10,
    write: (w, e) => {
      w.varu(e.crateId);
      writeVec3(w, e.pos);
    },
    read: (r) => ({ type: 'crateBreak', crateId: r.varu(), pos: readVec3(r) }),
  },
  swingImpact: {
    tag: 11,
    write: (w, e) => {
      writeOptId(w, e.fighterId);
      writeVec3(w, e.pos);
      w.u16(angleToU16(e.yaw));
      w.f32(e.range);
      w.f32(e.arcDeg);
      w.u8(e.step);
    },
    read: (r) => ({
      type: 'swingImpact',
      fighterId: readOptId(r),
      pos: readVec3(r),
      yaw: u16ToAngle(r.u16()),
      range: f32(r),
      arcDeg: f32(r),
      step: step3(r),
    }),
  },
  ultimateTarget: {
    tag: 12,
    write: (w, e) => {
      writeOptId(w, e.fighterId);
      w.u8(encEnum(ANIMAL_TABLE, e.animal));
      w.u8(encEnum(ULT_TARGET_KIND_TABLE, e.kind));
      writeOptId(w, e.targetId);
      writeVec3(w, e.from);
      writeVec3(w, e.to);
      w.f32(e.range);
      w.f32(e.width);
      w.f32(e.windup);
    },
    read: (r) => ({
      type: 'ultimateTarget',
      fighterId: readOptId(r),
      animal: decEnum(ANIMAL_TABLE, r.u8()),
      kind: decEnum(ULT_TARGET_KIND_TABLE, r.u8()),
      targetId: readOptId(r),
      from: readVec3(r),
      to: readVec3(r),
      range: f32(r),
      width: f32(r),
      windup: f32(r),
    }),
  },
  ultimateFizzle: {
    tag: 13,
    write: (w, e) => writeOptId(w, e.fighterId),
    read: (r) => ({ type: 'ultimateFizzle', fighterId: readOptId(r), reason: 'noTarget' }),
  },
  ultimateStage: {
    tag: 14,
    write: (w, e) => {
      writeOptId(w, e.fighterId);
      w.u8(encEnum(ANIMAL_TABLE, e.animal));
      w.varu(Math.max(0, e.stage));
      writeOptId(w, e.targetId);
      writeVec3(w, e.pos);
    },
    read: (r) => ({
      type: 'ultimateStage',
      fighterId: readOptId(r),
      animal: decEnum(ANIMAL_TABLE, r.u8()),
      stage: r.varu(),
      targetId: readOptId(r),
      pos: readVec3(r),
    }),
  },
  blink: {
    tag: 15,
    write: (w, e) => {
      writeOptId(w, e.fighterId);
      writeVec3(w, e.from);
      writeVec3(w, e.to);
    },
    read: (r) => ({ type: 'blink', fighterId: readOptId(r), from: readVec3(r), to: readVec3(r) }),
  },
  projectileImpact: {
    tag: 16,
    write: (w, e) => {
      w.u8(encEnum(PROJECTILE_KIND_TABLE, e.kind));
      writeVec3(w, e.pos);
      w.f32(e.radius);
      writeOptId(w, e.ownerId);
      writeOptId(w, e.hitId);
    },
    read: (r) => ({
      type: 'projectileImpact',
      kind: decEnum(PROJECTILE_KIND_TABLE, r.u8()),
      pos: readVec3(r),
      radius: f32(r),
      ownerId: readOptId(r),
      hitId: readOptId(r),
    }),
  },
  trapTriggered: {
    tag: 17,
    write: (w, e) => {
      w.varu(e.trapId);
      w.u8(encEnum(TRAP_KIND_TABLE, e.kind));
      writeVec3(w, e.pos);
      writeOptId(w, e.fighterId);
    },
    read: (r) => ({
      type: 'trapTriggered',
      trapId: r.varu(),
      kind: decEnum(TRAP_KIND_TABLE, r.u8()),
      pos: readVec3(r),
      fighterId: readOptId(r),
    }),
  },
  trapDamage: {
    tag: 18,
    write: (w, e) => {
      w.varu(e.trapId);
      w.u8(encEnum(TRAP_KIND_TABLE, e.kind));
      writeOptId(w, e.targetId);
      w.f32(e.damage);
      writeVec3(w, e.pos);
    },
    read: (r) => ({
      type: 'trapDamage',
      trapId: r.varu(),
      kind: decEnum(TRAP_KIND_TABLE, r.u8()),
      targetId: readOptId(r),
      damage: f32(r),
      pos: readVec3(r),
    }),
  },
  trapExpired: {
    tag: 19,
    write: (w, e) => {
      w.varu(e.trapId);
      w.u8(encEnum(TRAP_KIND_TABLE, e.kind));
      writeVec3(w, e.pos);
    },
    read: (r) => ({ type: 'trapExpired', trapId: r.varu(), kind: decEnum(TRAP_KIND_TABLE, r.u8()), pos: readVec3(r) }),
  },
  landingImpact: {
    tag: 20,
    write: (w, e) => {
      writeOptId(w, e.fighterId);
      writeVec3(w, e.pos);
      w.f32(e.radius);
      w.f32(e.damage);
      w.f32(e.height);
    },
    read: (r) => ({
      type: 'landingImpact',
      fighterId: readOptId(r),
      pos: readVec3(r),
      radius: f32(r),
      damage: f32(r),
      height: f32(r),
    }),
  },
  matchEnd: {
    tag: 21,
    write: (w, e) => writeOptId(w, e.winnerId),
    read: (r) => ({ type: 'matchEnd', winnerId: readOptId(r) }),
  },
};

/** All variant names, in tag order (derived from the exhaustive table). */
export const EVENT_TYPES = (Object.keys(EVENT_CODECS) as Type[]).sort((a, b) => EVENT_CODECS[a].tag - EVENT_CODECS[b].tag);

const BY_TAG = new Map<number, EventCodec<Type>>();
for (const t of EVENT_TYPES) BY_TAG.set(EVENT_CODECS[t].tag, EVENT_CODECS[t] as unknown as EventCodec<Type>);

export function eventTag(type: Type): number {
  return EVENT_CODECS[type].tag;
}

export function writeEvent(w: ByteWriter, e: GameEvent): void {
  const c = EVENT_CODECS[e.type] as unknown as EventCodec<Type>;
  w.u8(c.tag);
  c.write(w, e as never);
}

export function readEvent(r: ByteReader): GameEvent {
  const c = BY_TAG.get(r.u8());
  if (c === undefined) throw new RangeError('unknown event tag');
  return c.read(r) as GameEvent;
}

// ── Batches ──────────────────────────────────────────────────────────────────

export interface EventBatch {
  /** Sequence id of `events[0]`; event i has id `firstSeq + i`. */
  firstSeq: number;
  /** Host sim time (ms) of the tick the events were emitted in. */
  timeMs: number;
  events: GameEvent[];
}

/** Hard cap per batch (events beyond it should be split by the caller; see {@link encodeEventBatches}). */
export const MAX_EVENTS_PER_BATCH = 200;

export function encodeEventBatch(batch: EventBatch): Uint8Array {
  const n = Math.min(MAX_EVENTS_PER_BATCH, batch.events.length);
  const w = new ByteWriter(16 + n * 24);
  w.varu(batch.firstSeq >>> 0);
  w.i32(batch.timeMs);
  w.u8(n);
  for (let i = 0; i < n; i++) writeEvent(w, batch.events[i]);
  return w.finish();
}

/** Splits an arbitrarily long event list into wire batches with consecutive sequence ids. */
export function encodeEventBatches(firstSeq: number, timeMs: number, events: readonly GameEvent[]): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < events.length; i += MAX_EVENTS_PER_BATCH) {
    out.push(encodeEventBatch({ firstSeq: firstSeq + i, timeMs, events: events.slice(i, i + MAX_EVENTS_PER_BATCH) }));
  }
  return out;
}

/** Never throws: corrupt input gives null. */
export function decodeEventBatch(bytes: Uint8Array): EventBatch | null {
  try {
    const r = new ByteReader(bytes);
    const firstSeq = r.varu();
    const timeMs = r.i32();
    const n = r.u8();
    const events: GameEvent[] = [];
    for (let i = 0; i < n; i++) events.push(readEvent(r));
    if (r.remaining !== 0) return null;
    return { firstSeq, timeMs, events };
  } catch {
    return null;
  }
}

/** Quantisation tolerance of event positions (m). */
export const EVENT_POS_TOLERANCE = 0.5 / Q.POS + 1e-9;
/** Quantisation tolerance of event yaw angles (rad). */
export const EVENT_ANGLE_TOLERANCE = (Math.PI * 2) / Q.ANGLE + 1e-9;
