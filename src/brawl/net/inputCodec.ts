/**
 * Champions League online — input codec (v1.5, plan §4).
 *
 * A `BrawlIntent` travels as 3 bytes: `moveX` and `moveY` as int8 steps of 1/16 (−16…16) and one flag byte
 * (jump · jumpHeld · light · heavy · dodge). Because the stick is quantised, EVERY machine must simulate the quantised
 * value — including the local player's own machine — so the local intent goes through {@link quantizeIntent} (or
 * {@link packIntent}) before it reaches the sim. In memory an input is a {@link PackedInput}: one 24-bit integer
 * (`flags << 16 | moveY << 8 | moveX`), cheap to store, compare and hash.
 */

import type { BrawlIntent } from '../types';
import type { ByteReader, ByteWriter } from '../../online/wire';

/** One input as a 24-bit integer: bits 0–7 moveX (int8), 8–15 moveY (int8), 16–23 flags. */
export type PackedInput = number;

export const INPUT_BYTES = 3;
/** The stick resolution: values are multiples of 1/AXIS_STEPS. */
export const AXIS_STEPS = 16;

export const F_JUMP = 1;
export const F_JUMP_HELD = 2;
export const F_LIGHT = 4;
export const F_HEAVY = 8;
export const F_DODGE = 16;
/** The one-tick edge flags (cleared in predictions). */
export const EDGE_FLAGS = F_JUMP | F_LIGHT | F_HEAVY | F_DODGE;
const FLAG_MASK = F_JUMP | F_JUMP_HELD | F_LIGHT | F_HEAVY | F_DODGE;

/** Nothing pressed. */
export const IDLE_PACKED: PackedInput = 0;

/** −16…16 steps for a −1…1 axis value (non-finite → 0). */
export function quantizeAxis(v: number): number {
  if (!(v === v) || v === Infinity || v === -Infinity) return 0;
  const s = Math.round(v * AXIS_STEPS);
  return s < -AXIS_STEPS ? -AXIS_STEPS : s > AXIS_STEPS ? AXIS_STEPS : s;
}

export function packIntent(i: BrawlIntent): PackedInput {
  const x = quantizeAxis(i.moveX);
  const y = quantizeAxis(i.moveY);
  const flags =
    (i.jump ? F_JUMP : 0) | (i.jumpHeld ? F_JUMP_HELD : 0) | (i.light ? F_LIGHT : 0) | (i.heavy ? F_HEAVY : 0) | (i.dodge ? F_DODGE : 0);
  return (x & 0xff) | ((y & 0xff) << 8) | (flags << 16);
}

function clampStep(s: number): number {
  return s < -AXIS_STEPS ? -AXIS_STEPS : s > AXIS_STEPS ? AXIS_STEPS : s;
}

/** Decode into `out` (allocated when omitted). Out-of-range bytes from a corrupt packet are clamped to ±1. */
export function unpackIntent(p: PackedInput, out?: BrawlIntent): BrawlIntent {
  const o = out ?? { moveX: 0, moveY: 0, jump: false, jumpHeld: false, light: false, heavy: false, dodge: false };
  const flags = (p >> 16) & FLAG_MASK;
  o.moveX = clampStep((p << 24) >> 24) / AXIS_STEPS;
  o.moveY = clampStep((p << 16) >> 24) / AXIS_STEPS;
  o.jump = (flags & F_JUMP) !== 0;
  o.jumpHeld = (flags & F_JUMP_HELD) !== 0;
  o.light = (flags & F_LIGHT) !== 0;
  o.heavy = (flags & F_HEAVY) !== 0;
  o.dodge = (flags & F_DODGE) !== 0;
  return o;
}

/** The intent as the sim must see it on every machine (stick snapped to 1/16, flags unchanged). */
export function quantizeIntent(i: BrawlIntent, out?: BrawlIntent): BrawlIntent {
  return unpackIntent(packIntent(i), out);
}

/** The edge flags removed (prediction: a held stick / held jump repeats, a button press does not). */
export function clearEdges(p: PackedInput): PackedInput {
  return p & ~(EDGE_FLAGS << 16);
}

/** The edge flags of `p` alone (all other bits zero). */
export function edgesOf(p: PackedInput): PackedInput {
  return p & (EDGE_FLAGS << 16);
}

export function writeInput(w: ByteWriter, p: PackedInput): void {
  w.u8(p & 0xff).u8((p >> 8) & 0xff).u8((p >> 16) & 0xff);
}

export function readInput(r: ByteReader): PackedInput {
  const x = r.u8();
  const y = r.u8();
  const f = r.u8() & FLAG_MASK;
  return x | (y << 8) | (f << 16);
}

/** Pack a run of inputs (no header) into `INPUT_BYTES` each (convenience for tests / tools). */
export function encodeInputList(list: readonly PackedInput[]): Uint8Array {
  const out = new Uint8Array(list.length * INPUT_BYTES);
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    out[i * 3] = p & 0xff;
    out[i * 3 + 1] = (p >> 8) & 0xff;
    out[i * 3 + 2] = (p >> 16) & FLAG_MASK;
  }
  return out;
}

export function decodeInputList(bytes: Uint8Array): PackedInput[] {
  const out: PackedInput[] = [];
  for (let i = 0; i + 2 < bytes.length; i += 3) out.push(bytes[i] | (bytes[i + 1] << 8) | ((bytes[i + 2] & FLAG_MASK) << 16));
  return out;
}
