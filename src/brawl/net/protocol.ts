/**
 * Champions League online — wire formats of the four rollback messages (payloads after the `[kind]` byte that
 * `GameChannel` adds). All integers little-endian; a short or malformed payload throws `RangeError` (callers drop it).
 * The sender's slot is never transmitted: the receiver derives it from the peer id of the link the packet arrived on.
 *
 *   CL_INPUTS   unreliable  u32 frame · u32 ack · u32 start · u8 count · count × 3 bytes (PackedInput)
 *   CL_SYNC     unreliable  u32 frame16 (sender's clock in 1/16 frames) · u32 confirmed · u16 seq · u16 echoSeq · u16 holdMs
 *   CL_CHECKSUM reliable    u32 frame · u32 checksum · u8 ctlCount · u8 flags (1 = final) · i8 winner
 *   CL_CONTROL  reliable    u8 type (1 = forfeit) · u8 seq · u8 slot · u32 frame · u32 tailStart · u8 tailCount · tail × 3 bytes
 */

import { ByteReader, ByteWriter } from '../../online/wire';
import { readInput, writeInput } from './inputCodec';
import type { PackedInput } from './inputCodec';

export const MAX_INPUTS_PER_PACKET = 64;
export const NO_ECHO = 0xffff;
export const CTL_FORFEIT = 1;
export const CK_FINAL = 1;

export interface InputsMsg {
  /** Sender's current sim frame. */
  frame: number;
  /** The sender holds every input of the receiver for frames < ack. */
  ack: number;
  /** Frame of `inputs[0]` (the sender's own inputs). */
  start: number;
  inputs: PackedInput[];
}

export function encodeInputs(m: InputsMsg): Uint8Array {
  const w = new ByteWriter(16 + m.inputs.length * 3);
  w.u32(m.frame).u32(m.ack).u32(m.start).u8(m.inputs.length);
  for (const p of m.inputs) writeInput(w, p);
  return w.finish();
}

export function decodeInputs(b: Uint8Array): InputsMsg {
  const r = new ByteReader(b);
  const frame = r.u32();
  const ack = r.u32();
  const start = r.u32();
  const count = r.u8();
  if (count > MAX_INPUTS_PER_PACKET) throw new RangeError('CL_INPUTS: too many inputs');
  const inputs: PackedInput[] = [];
  for (let i = 0; i < count; i++) inputs.push(readInput(r));
  return { frame, ack, start, inputs };
}

export interface SyncMsg {
  /** The sender's sim clock in 1/16-frame units (current frame + fraction of the next). */
  frame16: number;
  confirmed: number;
  seq: number;
  echoSeq: number;
  holdMs: number;
}

export function encodeSync(m: SyncMsg): Uint8Array {
  return new ByteWriter(16).u32(m.frame16).u32(m.confirmed).u16(m.seq).u16(m.echoSeq).u16(Math.min(0xffff, Math.max(0, Math.round(m.holdMs)))).finish();
}

export function decodeSync(b: Uint8Array): SyncMsg {
  const r = new ByteReader(b);
  return { frame16: r.u32(), confirmed: r.u32(), seq: r.u16(), echoSeq: r.u16(), holdMs: r.u16() };
}

export interface ChecksumMsg {
  frame: number;
  checksum: number;
  /** Number of control events (forfeits) with an effective frame ≤ `frame` the sender knows. */
  ctlCount: number;
  final: boolean;
  /** Winner slot for a final report (−1 = draw). */
  winner: number;
}

export function encodeChecksum(m: ChecksumMsg): Uint8Array {
  return new ByteWriter(16).u32(m.frame).u32(m.checksum).u8(m.ctlCount).u8(m.final ? CK_FINAL : 0).i8(m.winner).finish();
}

export function decodeChecksum(b: Uint8Array): ChecksumMsg {
  const r = new ByteReader(b);
  const frame = r.u32();
  const checksum = r.u32();
  const ctlCount = r.u8();
  const flags = r.u8();
  const winner = r.i8();
  return { frame, checksum, ctlCount, final: (flags & CK_FINAL) !== 0, winner };
}

export interface ControlMsg {
  type: number;
  seq: number;
  /** The fighter slot being forfeited. */
  slot: number;
  /** Effective frame: the fighter is removed immediately before the step that leaves this frame. */
  frame: number;
  /** The forfeiting slot's real inputs for frames `tailStart …` (all < `frame`), so peers that missed the last ones can fill them. */
  tailStart: number;
  tail: PackedInput[];
}

export function encodeControl(m: ControlMsg): Uint8Array {
  const w = new ByteWriter(24 + m.tail.length * 3);
  w.u8(m.type).u8(m.seq).u8(m.slot).u32(m.frame).u32(m.tailStart).u8(m.tail.length);
  for (const p of m.tail) writeInput(w, p);
  return w.finish();
}

export function decodeControl(b: Uint8Array): ControlMsg {
  const r = new ByteReader(b);
  const type = r.u8();
  const seq = r.u8();
  const slot = r.u8();
  const frame = r.u32();
  const tailStart = r.u32();
  const count = r.u8();
  if (count > MAX_INPUTS_PER_PACKET) throw new RangeError('CL_CONTROL: tail too long');
  const tail: PackedInput[] = [];
  for (let i = 0; i < count; i++) tail.push(readInput(r));
  return { type, seq, slot, frame, tailStart, tail };
}
