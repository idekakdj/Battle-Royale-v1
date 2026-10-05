import { describe, expect, it } from 'vitest';
import type { GameEvent, WorldSnapshot } from '../../src/core/types';
import { swapSample } from '../../src/online/br/BrNetClient';
import type { BrResults } from '../../src/online/br/miscCodec';
import { BrNetHost } from '../../src/online/br/BrNetHost';
import { MSG } from '../../src/online/types';
import type { GameChannel, OnlineStart } from '../../src/online/types';
import { chaserScript, runSession, TICK_MS } from './brNetHarness';
import { busyMatch, neutral } from './brTestUtil';

describe('BR sessions: lifecycle and robustness over LoopbackNetwork', () => {
  it('two remote humans (3 humans total) are independent: own edges, own interpolation, local-id swap puts each at 0', async () => {
    const seconds = 40;
    const quiet = Math.ceil((seconds * 1000) / TICK_MS) - 120;
    const s = await runSession({
      clients: 2,
      seconds,
      net: { latencyMs: 60, jitterMs: 20, loss: 0.05, duplicate: 0.02 },
      script: (c, t, truth, slot, r) => (t >= quiet ? neutral() : chaserScript(c, t, truth, slot, r)),
    });
    for (let c = 0; c < 2; c++) {
      const hs = s.host.clientStats(c + 1);
      const p = s.pressed[c];
      expect(hs?.intent.edgesConsumed).toBe(p.attack + p.special + p.ultimate);
      expect(hs?.intent.edgesDropped).toBe(0);
      expect(s.frames[c].length).toBeGreaterThan(s.truth.length - 130);
      const last = s.frames[c][s.frames[c].length - 1].sample;
      const sw = swapSample(last, 0, c + 1);
      expect(sw.view.fighters[0].animal).toBe(last.view.fighters[c + 1].animal);
      expect(sw.view.fighters[c + 1].animal).toBe(last.view.fighters[0].animal);
    }
    expect(s.host.remoteSlots()).toEqual([1, 2]);
    expect(s.host.isRemote(0)).toBe(false);
    expect(s.host.remoteIntent(0)).toBeNull();
    expect(s.host.remoteIntent(5)).toBeNull();
    // distinct clients produced distinct edge streams
    expect(s.pressed[0]).not.toEqual(s.pressed[1]);
  });

  it('a duplicated BR_EVENTS delivery is de-duplicated by sequence id (each event exactly once)', async () => {
    const s = await runSession({
      seconds: 25,
      tamper: (hostCh) => {
        const orig = hostCh.send.bind(hostCh);
        hostCh.send = (peer, ch, kind, payload) => {
          orig(peer, ch, kind, payload);
          if (kind === MSG.BR_EVENTS) orig(peer, ch, kind, payload); // re-deliver every batch
        };
      },
    });
    const truthCount = s.truthEvents.reduce((n, e) => n + e.length, 0);
    expect(truthCount).toBeGreaterThan(20);
    expect(s.released[0].length).toBe(truthCount);
    expect(s.clients[0].stats().duplicateEvents).toBe(truthCount);
  });

  it('recovers from a lost opening keyframe: heavy loss for the first second still yields a first frame quickly', async () => {
    const s = await runSession({
      seconds: 8,
      net: { latencyMs: 50, jitterMs: 10, loss: 0.8 },
      netSeed: 3,
      onTick: (tick, sess) => {
        if (tick === 60) sess.net.setConditions({ loss: 0.05 });
      },
    });
    expect(s.frames[0].length).toBeGreaterThan(0);
    expect(s.frames[0][0].tick).toBeLessThan(150);
    expect(s.clients[0].stats().keyframesReceived).toBeGreaterThan(0);
  });

  it('never renders a blink as a slide: the fighter is at the origin, then at the destination, with no frame in between', async () => {
    const s = await runSession({ seconds: 63, net: { latencyMs: 60, jitterMs: 20, loss: 0.05 } });
    const blinks: Array<{ id: number; t: number; dist: number }> = [];
    s.truthEvents.forEach((evs, k) =>
      evs.forEach((e) => {
        if (e.type === 'blink') blinks.push({ id: e.fighterId, t: s.truth[k].time, dist: Math.hypot(e.to.x - e.from.x, e.to.z - e.from.z) });
      }),
    );
    expect(blinks.length).toBeGreaterThan(3);
    let jumps = 0;
    let partial = 0;
    for (const b of blinks) {
      if (b.dist < 1.5) continue;
      const frames = s.frames[0].filter((f) => Math.abs(f.sample.renderTimeS - b.t) <= 0.12);
      for (let i = 1; i < frames.length; i++) {
        const A = frames[i - 1].sample.view.fighters[b.id].pos;
        const B = frames[i].sample.view.fighters[b.id].pos;
        const step = Math.hypot(B.x - A.x, B.z - A.z);
        if (step > 0.35) {
          // a single-frame jump covering (nearly) the whole blink distance
          if (step > 0.8 * b.dist) jumps++;
          else partial++;
        }
      }
    }
    expect(jumps).toBeGreaterThan(0);
    expect(partial).toBe(0);
  });

  it('a remote human leaving mid-match: host callback fires, the slot becomes bot-controllable, the match goes on', async () => {
    const left: Array<{ slot: number; reason: string }> = [];
    const s = await runSession({
      seconds: 12,
      net: { latencyMs: 30 },
      onTick: (tick, sess) => {
        if (tick === 0) sess.host.onPeerLeft((slot, reason) => left.push({ slot, reason }));
        if (tick === 300) sess.clientMachines[0].transport.dispose();
      },
    });
    expect(left).toHaveLength(1);
    expect(left[0].slot).toBe(1);
    expect(s.host.isRemote(1)).toBe(false);
    expect(s.host.remoteIntent(1)).toBeNull();
    expect(s.host.remoteSlots()).toEqual([]);
    expect(s.host.clientStats(1)?.connected).toBe(false);
    expect(s.truth.length).toBeGreaterThan(600); // host kept simulating
    // the slot is driven by its bot brain from then on: alive and moving, or already dead
    const end = s.truth[s.truth.length - 1].fighters[1];
    const before = s.truth[s.truth.length - 120].fighters[1];
    expect(!end.alive || Math.hypot(end.pos.x - before.pos.x, end.pos.z - before.pos.z) > 0.3 || end.action !== 'idle').toBe(true);
  });

  it('the host leaving fires onHostLeft on the client exactly once', async () => {
    const reasons: string[] = [];
    await runSession({
      seconds: 8,
      net: { latencyMs: 30 },
      onTick: (tick, sess) => {
        if (tick === 0) sess.clients[0].onHostLeft((r) => reasons.push(r));
        if (tick === 200) sess.hostMachine.transport.dispose();
      },
    });
    expect(reasons).toHaveLength(1);
  });

  it('QA: a host that leaves the match (but stays in the room) tells the clients at once with BR_BYE, exactly once', async () => {
    const reasons: Array<{ reason: string; tick: number }> = [];
    let tickNow = 0;
    await runSession({
      seconds: 8,
      net: { latencyMs: 30 },
      onTick: (tick, sess) => {
        tickNow = tick;
        if (tick === 0) sess.clients[0].onHostLeft((reason) => reasons.push({ reason, tick: tickNow }));
        if (tick === 200) {
          sess.host.sendBye();
          sess.host.sendBye(); // idempotent
        }
      },
    });
    expect(reasons).toHaveLength(1);
    expect(reasons[0].reason).toBe('host-left-match');
    expect(reasons[0].tick).toBeLessThan(200 + 30); // ~30 ms of latency, not a silence timeout
  });

  it('QA: BR_BYE after the match was decided is a no-op (the results message already told the clients)', async () => {
    const reasons: string[] = [];
    await runSession({
      seconds: 6,
      net: { latencyMs: 30 },
      onTick: (tick, sess) => {
        if (tick === 0) sess.clients[0].onHostLeft((r) => reasons.push(r));
        if (tick === 200) {
          const last: WorldSnapshot = sess.truth[sess.truth.length - 1];
          const fin: WorldSnapshot = { ...structuredClone(last), matchOver: true, winnerId: 3 };
          sess.host.afterStep(fin, [{ type: 'matchEnd', winnerId: 3 }]);
        }
        if (tick === 230) sess.host.sendBye();
      },
    });
    expect(reasons).toHaveLength(0);
  });

  it('match end: results arrive reliably with placements, and the stopped sim does not flood snapshots', async () => {
    const got: BrResults[] = [];
    const s = await runSession({
      seconds: 6,
      net: { latencyMs: 40, jitterMs: 10, loss: 0.1 },
      onTick: (tick, sess) => {
        if (tick === 0) sess.clients[0].onResults((r) => got.push(r));
        if (tick === 200) {
          // End the match by hand: two deaths, then a final snapshot with matchOver.
          const events: GameEvent[] = [
            { type: 'death', targetId: 7, killerId: 3, placement: 10 },
            { type: 'death', targetId: 5, killerId: 3, placement: 9 },
            { type: 'matchEnd', winnerId: 3 },
          ];
          const last: WorldSnapshot = sess.truth[sess.truth.length - 1];
          const fin: WorldSnapshot = { ...structuredClone(last), matchOver: true, winnerId: 3 };
          fin.fighters[3].kills = 2;
          sess.host.afterStep(fin, events);
          for (let i = 0; i < 40; i++) sess.host.afterStep(fin, []); // the sim stopped; repeated calls must not flood
        }
      },
    });
    expect(got).toHaveLength(1);
    expect(got[0].winnerId).toBe(3);
    expect(got[0].fighters).toHaveLength(10);
    expect(got[0].fighters[3].placement).toBe(1);
    expect(got[0].fighters[7].placement).toBe(10);
    expect(got[0].fighters[5].placement).toBe(9);
    expect(got[0].fighters[3].kills).toBe(2);
    expect(s.clients[0].results()?.winnerId).toBe(3);
  });

  it('after the match ends the final snapshot is repeated a bounded number of times, not streamed forever', () => {
    const sent: number[] = [];
    const chan: GameChannel = {
      localPeerId: 'host',
      peers: () => ['c1'],
      rttMs: () => 0,
      send: (_p, _c, kind) => void sent.push(kind),
      broadcast: () => undefined,
      onMessage: () => () => undefined,
      onPeerLeft: () => () => undefined,
    };
    let clock = 0;
    const start: OnlineStart = {
      mode: 'battleRoyale',
      seed: 1,
      slots: [
        { slot: 0, peerId: 'host', name: 'h', animal: 'lion', kind: 'human' },
        { slot: 1, peerId: 'c1', name: 'c', animal: 'eagle', kind: 'human' },
      ],
      localSlot: 0,
      hostPeerId: 'host',
    };
    const host = new BrNetHost({ channel: chan, start, now: () => clock });
    const snap = busyMatch().snapshots[500];
    const fin: WorldSnapshot = { ...structuredClone(snap), matchOver: true, winnerId: 2 };
    for (let i = 0; i < 1200; i++) {
      clock += 1000 / 60;
      host.afterStep(fin, []);
    }
    const snaps = sent.filter((k) => k === MSG.BR_SNAPSHOT).length;
    expect(snaps).toBeGreaterThanOrEqual(2);
    expect(snaps).toBeLessThanOrEqual(10);
    expect(sent.filter((k) => k === MSG.BR_RESULTS)).toHaveLength(1);
  });
});
