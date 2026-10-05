import { describe, expect, it } from 'vitest';
import {
  AXIS_STEPS,
  EDGE_FLAGS,
  F_DODGE,
  F_HEAVY,
  F_JUMP,
  F_JUMP_HELD,
  F_LIGHT,
  clearEdges,
  decodeInputList,
  edgesOf,
  encodeInputList,
  packIntent,
  quantizeAxis,
  quantizeIntent,
  readInput,
  unpackIntent,
  writeInput,
} from '../../src/brawl/net/inputCodec';
import {
  CTL_FORFEIT,
  decodeChecksum,
  decodeControl,
  decodeInputs,
  decodeSync,
  encodeChecksum,
  encodeControl,
  encodeInputs,
  encodeSync,
} from '../../src/brawl/net/protocol';
import { ByteReader, ByteWriter } from '../../src/online/wire';
import type { BrawlIntent } from '../../src/brawl/types';

const base: BrawlIntent = { moveX: 0, moveY: 0, jump: false, jumpHeld: false, light: false, heavy: false, dodge: false };

describe('input codec', () => {
  it('quantises axes to steps of 1/16 and clamps', () => {
    expect(quantizeAxis(0)).toBe(0);
    expect(quantizeAxis(1)).toBe(16);
    expect(quantizeAxis(-1)).toBe(-16);
    expect(quantizeAxis(0.5)).toBe(8);
    expect(quantizeAxis(0.51)).toBe(8);
    expect(quantizeAxis(0.55)).toBe(9);
    expect(quantizeAxis(7)).toBe(16);
    expect(quantizeAxis(-7)).toBe(-16);
    expect(quantizeAxis(NaN)).toBe(0);
    expect(quantizeAxis(Infinity)).toBe(0);
    expect(AXIS_STEPS).toBe(16);
  });

  it('round-trips every axis step and flag combination through one 24-bit integer and 3 bytes', () => {
    for (let x = -16; x <= 16; x++) {
      for (let y = -16; y <= 16; y += 4) {
        for (let flags = 0; flags < 32; flags++) {
          const i: BrawlIntent = {
            moveX: x / 16,
            moveY: y / 16,
            jump: (flags & F_JUMP) !== 0,
            jumpHeld: (flags & F_JUMP_HELD) !== 0,
            light: (flags & F_LIGHT) !== 0,
            heavy: (flags & F_HEAVY) !== 0,
            dodge: (flags & F_DODGE) !== 0,
          };
          const p = packIntent(i);
          expect(p).toBeGreaterThanOrEqual(0);
          expect(p).toBeLessThan(1 << 24);
          expect(unpackIntent(p)).toEqual(i);
          const w = new ByteWriter(4);
          writeInput(w, p);
          const bytes = w.finish();
          expect(bytes.length).toBe(3);
          expect(readInput(new ByteReader(bytes))).toBe(p);
        }
      }
    }
  });

  it('quantizeIntent snaps to the grid, is idempotent and keeps the flags', () => {
    const q = quantizeIntent({ ...base, moveX: 0.33, moveY: -0.9, jump: true, light: true });
    expect(q.moveX).toBe(5 / 16);
    expect(q.moveY).toBe(-14 / 16);
    expect(q.jump && q.light).toBe(true);
    expect(quantizeIntent(q)).toEqual(q);
    const out = { ...base };
    expect(quantizeIntent({ ...base, moveX: 1 }, out)).toBe(out);
    expect(out.moveX).toBe(1);
    // identical on "every machine": the same number out for the same number in
    expect(packIntent({ ...base, moveX: 0.33 })).toBe(packIntent({ ...base, moveX: 5 / 16 }));
  });

  it('edge flags can be cleared / isolated; held state survives', () => {
    const p = packIntent({ moveX: 1, moveY: 0.5, jump: true, jumpHeld: true, light: true, heavy: true, dodge: true });
    const c = clearEdges(p);
    expect(unpackIntent(c)).toEqual({ moveX: 1, moveY: 0.5, jump: false, jumpHeld: true, light: false, heavy: false, dodge: false });
    expect(edgesOf(p) >> 16).toBe(EDGE_FLAGS);
    expect(edgesOf(c)).toBe(0);
    expect(c | edgesOf(p)).toBe(p);
  });

  it('corrupt bytes are clamped to the legal range instead of injecting extreme values', () => {
    const p = 0x80 | (0x7f << 8) | (0xff << 16);
    const i = unpackIntent(p);
    expect(i.moveX).toBe(-1);
    expect(i.moveY).toBe(1);
    const r = readInput(new ByteReader(new Uint8Array([0x80, 0x7f, 0xff])));
    expect(r >> 16).toBe(31);
  });

  it('encodes a run of inputs', () => {
    const list = [0, 1, 0x1f0000, 0xff, packIntent({ ...base, moveX: -0.5, dodge: true })];
    expect(decodeInputList(encodeInputList(list))).toEqual(list);
  });
});

describe('rollback wire messages', () => {
  it('round-trips CL_INPUTS / CL_SYNC / CL_CHECKSUM / CL_CONTROL', () => {
    const inputs = { frame: 123456, ack: 123400, start: 123440, inputs: [1, 2, 0x1f00ff, 0] };
    expect(decodeInputs(encodeInputs(inputs))).toEqual(inputs);
    const sync = { frame16: 1975296, confirmed: 123450, seq: 513, echoSeq: 0xffff, holdMs: 40 };
    expect(decodeSync(encodeSync(sync))).toEqual(sync);
    const ck = { frame: 90, checksum: 4294967295, ctlCount: 2, final: true, winner: -1 };
    expect(decodeChecksum(encodeChecksum(ck))).toEqual(ck);
    const ck2 = { frame: 120, checksum: 17, ctlCount: 0, final: false, winner: 3 };
    expect(decodeChecksum(encodeChecksum(ck2))).toEqual(ck2);
    const ctl = { type: CTL_FORFEIT, seq: 3, slot: 2, frame: 777, tailStart: 700, tail: [5, 6, 7] };
    expect(decodeControl(encodeControl(ctl))).toEqual(ctl);
  });

  it('a CL_INPUTS packet is 14 bytes + 3 per input', () => {
    expect(encodeInputs({ frame: 1, ack: 1, start: 1, inputs: new Array<number>(16).fill(0) }).length).toBe(13 + 3 * 16);
  });

  it('truncated or oversized packets throw RangeError (they are dropped by the session)', () => {
    const good = encodeInputs({ frame: 1, ack: 1, start: 1, inputs: [1, 2, 3] });
    for (let n = 0; n < good.length; n++) expect(() => decodeInputs(good.subarray(0, n))).toThrow(RangeError);
    const big = new ByteWriter(32).u32(1).u32(1).u32(1).u8(200).finish();
    expect(() => decodeInputs(big)).toThrow(RangeError);
    expect(() => decodeSync(new Uint8Array(3))).toThrow(RangeError);
    expect(() => decodeChecksum(new Uint8Array(5))).toThrow(RangeError);
    const c = encodeControl({ type: CTL_FORFEIT, seq: 1, slot: 1, frame: 5, tailStart: 0, tail: [1, 2] });
    for (let n = 0; n < c.length; n++) expect(() => decodeControl(c.subarray(0, n))).toThrow(RangeError);
  });
});
