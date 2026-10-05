import { describe, expect, it } from 'vitest';
import type { FighterIntent } from '../../src/core/types';
import { INTENT_PACKET_BYTES, IntentSender, RemoteIntent, decodeIntentPacket } from '../../src/online/br/intentCodec';
import { TOLERANCE, angleDiff } from '../../src/online/br/tables';
import { neutral, rng } from './brTestUtil';

function decode(b: Uint8Array) {
  const p = decodeIntentPacket(b);
  if (p === null) throw new Error('decode failed');
  return p;
}

describe('intent codec', () => {
  it('is exactly 12 bytes and round-trips within tolerance', () => {
    const r = rng(5);
    for (let i = 0; i < 2000; i++) {
      const a = r() * 2 * Math.PI - Math.PI;
      const m = r();
      const intent: FighterIntent = { ...neutral(), moveX: Math.cos(a) * m, moveZ: Math.sin(a) * m, aimYaw: (r() - 0.5) * 40, block: r() < 0.5, jump: r() < 0.5 };
      const s = new IntentSender();
      const bytes = s.next(intent, 1234, i % 2 === 0);
      expect(bytes.length).toBe(INTENT_PACKET_BYTES);
      const p = decode(bytes);
      expect(Math.abs(p.moveX - intent.moveX)).toBeLessThanOrEqual(TOLERANCE.stick);
      expect(Math.abs(p.moveZ - intent.moveZ)).toBeLessThanOrEqual(TOLERANCE.stick);
      expect(Math.abs(angleDiff(p.aimYaw, intent.aimYaw))).toBeLessThanOrEqual(TOLERANCE.angle);
      expect(p.block).toBe(intent.block);
      expect(p.jump).toBe(intent.jump);
      expect(p.needKeyframe).toBe(i % 2 === 0);
      expect(p.ackSnap).toBe(1234);
      expect(Math.hypot(p.moveX, p.moveZ)).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  it('counts only rising edges and carries the counters in every packet', () => {
    const s = new IntentSender();
    const send = (attack: boolean, special = false, ultimate = false) => decode(s.next({ ...neutral(), attack, special, ultimate }, 0, false));
    expect(send(false).attackCount).toBe(0);
    expect(send(true).attackCount).toBe(1);
    expect(send(true).attackCount).toBe(1); // held: no new edge
    expect(send(false).attackCount).toBe(1);
    expect(send(true, true).attackCount).toBe(2);
    const p = send(false, false, true);
    expect([p.attackCount, p.specialCount, p.ultimateCount]).toEqual([2, 1, 1]);
    expect(s.pressed).toEqual({ attack: 2, special: 1, ultimate: 1 });
    // counters persist in later packets until more presses
    expect(decode(s.next(neutral(), 0, false)).attackCount).toBe(2);
  });

  it('rejects malformed packets without throwing', () => {
    expect(decodeIntentPacket(new Uint8Array(0))).toBeNull();
    expect(decodeIntentPacket(new Uint8Array(11))).toBeNull();
    expect(decodeIntentPacket(new Uint8Array(13))).toBeNull();
    const bad = new Uint8Array(12);
    bad[2] = 0x80; // reserved flag bit
    expect(decodeIntentPacket(bad)).toBeNull();
    const r = rng(9);
    for (let i = 0; i < 5000; i++) {
      const b = new Uint8Array(12);
      for (let k = 0; k < 12; k++) b[k] = Math.floor(r() * 256);
      const p = decodeIntentPacket(b);
      if (p !== null) expect(Math.hypot(p.moveX, p.moveZ)).toBeLessThanOrEqual(1 + 1e-9);
    }
  });
});

describe('RemoteIntent (host side)', () => {
  const mk = (seq: number, over: Partial<ReturnType<typeof decode>> = {}) => ({
    seq,
    block: false,
    jump: false,
    needKeyframe: false,
    moveX: 0,
    moveZ: 0,
    aimYaw: 0,
    attackCount: 0,
    specialCount: 0,
    ultimateCount: 0,
    ackSnap: 0,
    ...over,
  });

  it('emits queued edges as separate rising edges: pulse, gap, pulse', () => {
    const ri = new RemoteIntent();
    ri.ingest(mk(0, { attackCount: 3 }), 0);
    const seen: boolean[] = [];
    for (let t = 0; t < 8; t++) seen.push(ri.consume(t).attack);
    expect(seen).toEqual([true, false, true, false, true, false, false, false]);
    expect(ri.stats.edgesAccepted).toBe(3);
    expect(ri.stats.edgesConsumed).toBe(3);
  });

  it('takes levels from the newest sequence only (reordered / duplicate packets are ignored), across the u16 wrap', () => {
    const ri = new RemoteIntent();
    ri.ingest(mk(65534, { moveX: 1 }), 0);
    ri.ingest(mk(65535, { moveX: 0.5 }), 1);
    ri.ingest(mk(0, { moveX: -0.5 }), 2);
    ri.ingest(mk(65535, { moveX: 1 }), 3); // late duplicate of an older seq
    expect(ri.consume(4).moveX).toBe(-0.5);
    expect(ri.stats.stale).toBe(1);
    expect(ri.newestSeq).toBe(0);
  });

  it('a duplicated or reordered packet never doubles an edge, a later packet recovers a lost one', () => {
    const ri = new RemoteIntent();
    ri.ingest(mk(0, { attackCount: 1 }), 0);
    ri.ingest(mk(0, { attackCount: 1 }), 0); // dup
    ri.ingest(mk(2, { attackCount: 2 }), 1); // seq 1 lost
    ri.ingest(mk(1, { attackCount: 1 }), 2); // late arrival of the lost one: its counter is old news
    let pulses = 0;
    for (let t = 0; t < 10; t++) if (ri.consume(2).attack) pulses++;
    expect(pulses).toBe(2);
  });

  it('survives the 8-bit counter wrap', () => {
    const s = new IntentSender();
    const ri = new RemoteIntent();
    let pressed = 0;
    let consumed = 0;
    for (let i = 0; i < 1500; i++) {
      const p = decode(s.next({ ...neutral(), attack: i % 2 === 0 }, 0, false));
      if (i % 2 === 0) pressed++;
      ri.ingest(p, i);
      if (ri.consume(i).attack) consumed++;
    }
    for (let i = 0; i < 40; i++) if (ri.consume(2000).attack) consumed++;
    expect(pressed).toBe(750);
    expect(consumed).toBe(750);
  });

  it('releases movement and block when the stream goes silent, keeps the aim', () => {
    const ri = new RemoteIntent(300);
    ri.ingest(mk(0, { moveX: 1, moveZ: -1, block: true, jump: true, aimYaw: 2 }), 1000);
    const live = ri.consume(1100);
    expect(live.moveX).toBe(1);
    expect(live.block).toBe(true);
    const stale = ri.consume(1400);
    expect([stale.moveX, stale.moveZ, stale.block, stale.jump]).toEqual([0, 0, false, false]);
    expect(stale.aimYaw).toBe(2);
  });

  it('property: under loss / duplication / reordering every rising edge is consumed exactly once', () => {
    for (const [loss, dup, maxDelay, seed] of [
      [0.05, 0.05, 4, 11],
      [0.3, 0.2, 8, 12],
      [0.5, 0.1, 12, 13],
    ] as const) {
      const r = rng(seed);
      const sender = new IntentSender();
      const host = new RemoteIntent();
      const inflight: { at: number; bytes: Uint8Array }[] = [];
      let pressed = 0;
      let consumed = 0;
      let prevAttack = false;
      let prevSpecial = false;
      let prevUlt = false;
      let pressedSpecial = 0;
      let consumedSpecial = 0;
      let pressedUlt = 0;
      let consumedUlt = 0;
      let maxConsecutive = 0;
      let run = 0;
      const ticks = 30000;
      for (let t = 0; t < ticks + 200; t++) {
        let intent = neutral();
        if (t < ticks) {
          // bursty button mashing (some presses on consecutive ticks)
          const attack = r() < 0.12;
          const special = r() < 0.02;
          const ultimate = r() < 0.01;
          intent = { ...neutral(), attack, special, ultimate, moveX: r() - 0.5 };
          if (attack && !prevAttack) pressed++;
          if (special && !prevSpecial) pressedSpecial++;
          if (ultimate && !prevUlt) pressedUlt++;
          prevAttack = attack;
          prevSpecial = special;
          prevUlt = ultimate;
        }
        // the client keeps streaming (neutral) packets after the last press, as the real one does
        const bytes = sender.next(intent, 0, false);
        for (let c = 0; c < (r() < dup ? 2 : 1); c++) {
          if (r() < loss) continue;
          inflight.push({ at: t + Math.floor(r() * (maxDelay + 1)), bytes });
        }
        for (let i = inflight.length - 1; i >= 0; i--) {
          if (inflight[i].at <= t) {
            const p = decodeIntentPacket(inflight[i].bytes);
            if (p !== null) host.ingest(p, t * 16.667);
            inflight.splice(i, 1);
          }
        }
        const out = host.consume(t * 16.667);
        if (out.attack) {
          consumed++;
          run++;
          maxConsecutive = Math.max(maxConsecutive, run);
        } else run = 0;
        if (out.special) consumedSpecial++;
        if (out.ultimate) consumedUlt++;
      }
      const dropped = host.stats.edgesDropped;
      expect(dropped, `loss ${loss}`).toBe(0);
      expect(consumed, `attack loss ${loss}`).toBe(pressed);
      expect(consumedSpecial).toBe(pressedSpecial);
      expect(consumedUlt).toBe(pressedUlt);
      expect(maxConsecutive).toBe(1); // every consumed edge is a genuine rising edge
    }
  });
});
