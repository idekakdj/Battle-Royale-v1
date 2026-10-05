import { describe, expect, it } from 'vitest';
import { LoopbackNetwork } from '../../src/online/transport/loopback';
import { LinkChannel } from '../../src/online/channel';
import { ByteReader, ByteWriter, frame, unframe } from '../../src/online/wire';
import { MSG } from '../../src/online/types';
import type { Link, Transport } from '../../src/online/types';

/** Two connected machines, each with a LinkChannel. */
async function pair(net: LoopbackNetwork) {
  const ta: Transport = net.createTransport();
  const tb: Transport = net.createTransport();
  const idA = await ta.open('a');
  const idB = await tb.open('b');
  const chA = new LinkChannel(idA);
  const chB = new LinkChannel(idB);
  for (const [t, ch] of [
    [ta, chA],
    [tb, chB],
  ] as const) {
    t.setHandlers({
      onLink: (l: Link) => ch.addLink(l),
      onData: (l, c, d) => ch.handleData(l, c, d),
      onClose: (l, r) => ch.handleClose(l, r),
    });
  }
  const link = await ta.connect('b');
  chA.addLink(link);
  net.advance(0);
  return { ta, tb, chA, chB };
}

describe('wire', () => {
  it('round-trips every primitive and rejects short reads', () => {
    const w = new ByteWriter(4);
    w.u8(255).i8(-5).u16(65535).i16(-300).u32(4294967295).i32(-70000).f32(1.5).f64(Math.PI).varu(300).varu(0).str('héllo 🦁');
    const r = new ByteReader(w.finish());
    expect(r.u8()).toBe(255);
    expect(r.i8()).toBe(-5);
    expect(r.u16()).toBe(65535);
    expect(r.i16()).toBe(-300);
    expect(r.u32()).toBe(4294967295);
    expect(r.i32()).toBe(-70000);
    expect(r.f32()).toBe(1.5);
    expect(r.f64()).toBe(Math.PI);
    expect(r.varu()).toBe(300);
    expect(r.varu()).toBe(0);
    expect(r.str()).toBe('héllo 🦁');
    expect(r.remaining).toBe(0);
    expect(() => r.u8()).toThrow(RangeError);
  });

  it('frames and unframes', () => {
    const f = frame(MSG.CL_INPUTS, new Uint8Array([1, 2, 3]));
    const u = unframe(f);
    expect(u.kind).toBe(MSG.CL_INPUTS);
    expect([...u.payload]).toEqual([1, 2, 3]);
    expect(() => unframe(new Uint8Array(0))).toThrow(RangeError);
  });
});

describe('loopback network', () => {
  it('delivers after the configured latency and reports peers', async () => {
    const net = new LoopbackNetwork({ latencyMs: 50 });
    const { chA, chB } = await pair(net);
    net.advance(60);
    expect(chA.peers()).toEqual(['b']);
    expect(chB.peers()).toEqual(['a']);
    const got: number[] = [];
    chB.onMessage((_p, kind, payload) => got.push(kind, payload[0]));
    chA.send('b', 'reliable', MSG.READY, new Uint8Array([7]));
    net.advance(49);
    expect(got).toEqual([]);
    net.advance(2);
    expect(got).toEqual([MSG.READY, 7]);
  });

  it('keeps reliable packets in order under jitter, while unreliable ones can reorder or drop', async () => {
    const net = new LoopbackNetwork({ latencyMs: 20, jitterMs: 80, loss: 0.3 }, 5);
    const { chA, chB } = await pair(net);
    net.advance(200);
    const reliable: number[] = [];
    const unreliable: number[] = [];
    chB.onMessage((_p, kind, payload, ch) => (ch === 'reliable' ? reliable : unreliable).push(payload[0] + kind * 0));
    for (let i = 0; i < 100; i++) {
      chA.send('b', 'reliable', MSG.CL_CONTROL, new Uint8Array([i]));
      chA.send('b', 'unreliable', MSG.CL_INPUTS, new Uint8Array([i]));
    }
    net.advance(2000);
    expect(reliable).toEqual(Array.from({ length: 100 }, (_, i) => i));
    expect(unreliable.length).toBeLessThan(100);
    expect(unreliable.length).toBeGreaterThan(40);
    const sorted = [...unreliable].sort((x, y) => x - y);
    expect(unreliable).not.toEqual(sorted); // jitter reordered something
  });

  it('is deterministic for a given seed', async () => {
    const run = async () => {
      const net = new LoopbackNetwork({ latencyMs: 30, jitterMs: 40, loss: 0.2, duplicate: 0.1 }, 99);
      const { chA, chB } = await pair(net);
      const log: string[] = [];
      chB.onMessage((_p, kind, payload) => log.push(`${net.now}:${kind}:${payload[0]}`));
      for (let i = 0; i < 50; i++) {
        chA.send('b', 'unreliable', MSG.CL_INPUTS, new Uint8Array([i]));
        net.advance(16);
      }
      net.advance(500);
      return log.join(',');
    };
    expect(await run()).toBe(await run());
  });

  it('notifies the other side when a peer leaves, and rejects duplicate ids', async () => {
    const net = new LoopbackNetwork({ latencyMs: 10 });
    const { tb, chA } = await pair(net);
    const left: string[] = [];
    chA.onPeerLeft((p, r) => left.push(`${p}:${r}`));
    tb.dispose();
    net.advance(50);
    expect(left).toEqual(['b:remote-closed']);
    expect(chA.peers()).toEqual([]);
    const dup = net.createTransport();
    await dup.open('same');
    await expect(net.createTransport().open('same')).rejects.toThrow('id-taken');
  });

  it('drops malformed packets instead of throwing', async () => {
    const net = new LoopbackNetwork();
    const { chB } = await pair(net);
    let n = 0;
    chB.onMessage(() => n++);
    const link = chB.getLink('a');
    expect(link).toBeDefined();
    chB.handleData(link as Link, 'reliable', new Uint8Array(0));
    expect(n).toBe(0);
  });
});
