/**
 * Canonical state encoding for `BrawlWorld.saveState / loadState / checksum` (online rollback, v1.5).
 *
 * The whole mutable gameplay state is one flat sequence of doubles, written in a fixed order by ONE function
 * (`BrawlWorld.syncState`) that runs in two modes: writing (save / checksum) and reading (load). Because the same code
 * and the same call order serve both directions, a field can never be saved but forgotten on load. The checksum hashes
 * the same doubles (bit patterns, canonicalised) with 32-bit integer mixing, so it is identical on every machine.
 */

import type { BrawlAction, HitboxView, MoveBody, MovePhase, MoveId } from '../types';

const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
/** Index of the high / low 32-bit word of a double inside a Uint32Array view of a Float64Array. */
const HI = LITTLE_ENDIAN ? 1 : 0;
const LO = LITTLE_ENDIAN ? 0 : 1;

/** A saved world state. Plain data except `bodies` / `hitViews`, which reference shared IMMUTABLE objects. */
export interface BrawlSavedState {
  /** The sim frame the state was captured at (`world.frame`). */
  frame: number;
  /** Canonical doubles (see `BrawlWorld.syncState`). Only the first `len` entries are meaningful. */
  data: Float64Array;
  /** Same buffer as `data`, viewed as 32-bit words (used by the checksum). */
  words: Uint32Array;
  len: number;
  /** Per fighter, the move body in play (shared registry object, never mutated by the sim). */
  bodies: Array<MoveBody | null>;
  /** The hitbox views of the last resolved step (the array is never mutated after creation). */
  hitViews: readonly HitboxView[];
}

export function createSavedState(capacity = 1024): BrawlSavedState {
  const data = new Float64Array(capacity);
  return { frame: 0, data, words: new Uint32Array(data.buffer), len: 0, bodies: [], hitViews: [] };
}

/** Index tables for the string enums stored as numbers. */
class EnumTable<T extends string> {
  private readonly toIdx = new Map<string, number>();
  constructor(private readonly names: readonly T[]) {
    for (let i = 0; i < names.length; i++) this.toIdx.set(names[i], i);
  }
  index(v: T | null): number {
    if (v === null) return -1;
    const i = this.toIdx.get(v);
    if (i === undefined) throw new Error(`stateIO: unknown enum value ${String(v)}`);
    return i;
  }
  name(i: number): T | null {
    return i < 0 ? null : this.names[i];
  }
}

// `Record<…, true>` forces these lists to stay in sync with the unions in ../types.
const ACTION_SET: Record<BrawlAction, true> = {
  idle: true,
  walk: true,
  run: true,
  jumpSquat: true,
  rise: true,
  fall: true,
  fastFall: true,
  landing: true,
  crouch: true,
  attack: true,
  dodgeSpot: true,
  dodgeRoll: true,
  dodgeAir: true,
  hitstun: true,
  tumble: true,
  knockdown: true,
  getup: true,
  ledgeHang: true,
  ledgeClimb: true,
  respawn: true,
  ko: true,
};
const MOVE_ID_SET: Record<MoveId, true> = {
  lightN: true,
  lightS: true,
  lightD: true,
  lightU: true,
  heavyN: true,
  heavyS: true,
  heavyD: true,
  heavyU: true,
};
const PHASE_SET: Record<MovePhase, true> = { startup: true, active: true, recovery: true };

const ACTIONS = new EnumTable<BrawlAction>(Object.keys(ACTION_SET) as BrawlAction[]);
const MOVE_IDS_T = new EnumTable<MoveId>(Object.keys(MOVE_ID_SET) as MoveId[]);
const PHASES = new EnumTable<MovePhase>(Object.keys(PHASE_SET) as MovePhase[]);

/**
 * Sequential reader / writer over a Float64Array. In write mode every accessor stores its argument and returns it;
 * in read mode it ignores the argument and returns the stored value — so `f.x = io.n(f.x)` saves in one mode and
 * restores in the other.
 */
export class StateIO {
  data: Float64Array = new Float64Array(0);
  words: Uint32Array = new Uint32Array(0);
  pos = 0;
  reading = false;

  /** Start writing into `s` (its buffers are used and, if they overflow, replaced). */
  beginWrite(s: BrawlSavedState): void {
    this.data = s.data;
    this.words = s.words;
    this.pos = 0;
    this.reading = false;
  }

  /** Start reading from `s`. */
  beginRead(s: BrawlSavedState): void {
    this.data = s.data;
    this.words = s.words;
    this.pos = 0;
    this.reading = true;
  }

  /** After a write: store the (possibly regrown) buffers and the length back into `s`. */
  endWrite(s: BrawlSavedState): void {
    s.data = this.data;
    s.words = this.words;
    s.len = this.pos;
  }

  private grow(): void {
    const next = new Float64Array(this.data.length * 2);
    next.set(this.data);
    this.data = next;
    this.words = new Uint32Array(next.buffer);
  }

  private put(v: number): void {
    if (this.pos >= this.data.length) this.grow();
    this.data[this.pos++] = v;
  }

  n(v: number): number {
    if (this.reading) return this.data[this.pos++];
    this.put(v);
    return v;
  }

  b(v: boolean): boolean {
    if (this.reading) return this.data[this.pos++] !== 0;
    this.put(v ? 1 : 0);
    return v;
  }

  action(v: BrawlAction): BrawlAction {
    if (this.reading) return ACTIONS.name(this.data[this.pos++]) as BrawlAction;
    this.put(ACTIONS.index(v));
    return v;
  }

  moveId(v: MoveId | null): MoveId | null {
    if (this.reading) return MOVE_IDS_T.name(this.data[this.pos++]);
    this.put(MOVE_IDS_T.index(v));
    return v;
  }

  phase(v: MovePhase | null): MovePhase | null {
    if (this.reading) return PHASES.name(this.data[this.pos++]);
    this.put(PHASES.index(v));
    return v;
  }

  /** In-place number array (length-prefixed). */
  nums(arr: number[]): number[] {
    if (this.reading) {
      const len = this.data[this.pos++];
      arr.length = len;
      for (let i = 0; i < len; i++) arr[i] = this.data[this.pos++];
      return arr;
    }
    this.put(arr.length);
    for (let i = 0; i < arr.length; i++) this.put(arr[i]);
    return arr;
  }

  /** In-place MoveId array (length-prefixed). */
  moveIds(arr: MoveId[]): MoveId[] {
    if (this.reading) {
      const len = this.data[this.pos++];
      arr.length = len;
      for (let i = 0; i < len; i++) arr[i] = MOVE_IDS_T.name(this.data[this.pos++]) as MoveId;
      return arr;
    }
    this.put(arr.length);
    for (let i = 0; i < arr.length; i++) this.put(MOVE_IDS_T.index(arr[i]));
    return arr;
  }

  launch(v: { angle: number; speed: number } | null): { angle: number; speed: number } | null {
    if (this.reading) {
      if (this.data[this.pos++] === 0) return null;
      const angle = this.data[this.pos++];
      const speed = this.data[this.pos++];
      return { angle, speed };
    }
    if (v === null) {
      this.put(0);
    } else {
      this.put(1);
      this.put(v.angle);
      this.put(v.speed);
    }
    return v;
  }
}

/**
 * 32-bit checksum of `len` doubles held in `words` (murmur3-style mixing of both halves of every double; −0 and NaN are
 * canonicalised so equal values hash equally). Pure integer arithmetic ⇒ identical on every machine.
 */
export function hashWords(words: Uint32Array, len: number): number {
  let h = (0x9e3779b9 ^ len) | 0;
  for (let i = 0; i < len; i++) {
    let lo = words[2 * i + LO];
    let hi = words[2 * i + HI];
    if (hi === 0x80000000 && lo === 0) {
      hi = 0; // −0 → +0
    } else if ((hi & 0x7ff00000) === 0x7ff00000 && ((hi & 0x000fffff) | lo) !== 0) {
      hi = 0x7ff80000; // any NaN → the canonical quiet NaN
      lo = 0;
    }
    let k = Math.imul(lo, 0xcc9e2d51);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, 0x1b873593);
    h ^= k;
    h = (h << 13) | (h >>> 19);
    h = (Math.imul(h, 5) + 0xe6546b64) | 0;
    k = Math.imul(hi, 0xcc9e2d51);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, 0x1b873593);
    h ^= k;
    h = (h << 13) | (h >>> 19);
    h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  }
  h ^= len << 3;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Checksum of a saved state (equals `world.checksum()` taken at the moment of the save). */
export function checksumOfSaved(s: BrawlSavedState): number {
  return hashWords(s.words, s.len);
}
