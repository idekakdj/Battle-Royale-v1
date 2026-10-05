/**
 * WP-N6: the host and client match drivers end-to-end on a LoopbackNetwork (no WebGL): a full headless match with a host and
 * two remote humans, equivalence of the final standings, id remapping, the start gate, bot takeover and the offline path.
 */

import { describe, expect, it } from 'vitest';
import { World } from '../../src/sim/World';
import { BotManager } from '../../src/ai/BotManager';
import { EventBus } from '../../src/core/EventBus';
import { LocalSimDriver } from '../../src/match/SimDriver';
import { seatRoster } from '../../src/match/seating';
import { swapId } from '../../src/online/br/idSwap';
import { decodeResults, encodeResults, type BrResults } from '../../src/online/br/miscCodec';
import { ANIMAL_IDS } from '../../src/config/animals';
import type { AnimalId, FighterIntent, GameEvent, GameEventOf, WorldSnapshot } from '../../src/core/types';
import { neutral } from './brTestUtil';
import { DT, disposeSession, makeDriverSession } from './brControllerHarness';

const animals = ANIMAL_IDS as AnimalId[];

/** What a client receives for the host's results: the wire round trip (f32 time, 1/16 damage steps). */
function overTheWire(r: BrResults | null): BrResults | null {
  return r === null ? null : decodeResults(encodeResults(r));
}

function deaths(events: readonly GameEvent[]): Array<GameEventOf<'death'>> {
  return events.filter((e): e is GameEventOf<'death'> => e.type === 'death');
}

/** Kills implied by `death` events (killerId >= 0) per controller id. */
function killsFromEvents(events: readonly GameEvent[], n: number): number[] {
  const k = new Array<number>(n).fill(0);
  for (const e of deaths(events)) if (e.killerId >= 0 && e.killerId < n) k[e.killerId]++;
  return k;
}

describe('host + 2 clients: a full headless match', () => {
  for (const [label, net, maxTicks] of [
    ['perfect network', {}, 24000],
    ['60 ms +-20 jitter, 5% loss', { latencyMs: 60, jitterMs: 20, loss: 0.05 }, 24000],
  ] as const) {
    it(`standings agree on every machine (${label})`, async () => {
      const s = await makeDriverSession({ fighters: 4, humanSlots: [0, 1, 2], net, difficulty: 3 });
      s.runToEnd(maxTicks);
      expect(s.host.simSnapshot().matchOver).toBe(true);

      const hostRes = s.host.results();
      expect(hostRes).not.toBeNull();
      if (hostRes === null) return;
      expect(hostRes.fighters).toHaveLength(4);
      // exactly one champion, all other placements distinct
      const places = hostRes.fighters.map((f) => f.placement).sort((a, b) => a - b);
      expect(hostRes.fighters[hostRes.winnerId].placement).toBe(1);
      expect(new Set(places).size).toBe(4);

      for (const c of s.clients) {
        // the host's reliable BR_RESULTS reached the client, byte-for-byte equivalent
        expect(c.driver.results()).toEqual(overTheWire(hostRes));
        // exactly one matchEnd reached the controller bus; its winner (controller ids) maps back to the host's winner slot
        const ends = c.events.filter((e): e is GameEventOf<'matchEnd'> => e.type === 'matchEnd');
        expect(ends).toHaveLength(1);
        expect(swapId(ends[0].winnerId, 0, c.slot)).toBe(hostRes.winnerId);
        // the final view agrees with the sim: alive flags + kills per fighter (controller id i = slot swapId(i, 0, c.slot))
        const view = c.views[c.views.length - 1];
        expect(view.matchOver).toBe(true);
        expect(swapId(view.winnerId, 0, c.slot)).toBe(hostRes.winnerId);
        const sim = s.host.simSnapshot();
        for (let i = 0; i < 4; i++) {
          const slot = swapId(i, 0, c.slot);
          expect(view.fighters[i].id).toBe(i);
          expect(view.fighters[i].animal).toBe(animals[slot]);
          expect(view.fighters[i].alive).toBe(sim.fighters[slot].alive);
          expect(view.fighters[i].kills).toBe(sim.fighters[slot].kills);
        }
        // the deaths (victim, killer, placement) match the host's, in order, after mapping controller ids back to slots
        const back = (id: number): number => (id < 0 ? id : swapId(id, 0, c.slot));
        const mine = deaths(c.events).map((e) => [back(e.targetId), back(e.killerId), e.placement]);
        const theirs = deaths(s.hostEvents).map((e) => [e.targetId, e.killerId, e.placement]);
        expect(mine).toEqual(theirs);
        // kills implied by the death events agree with the snapshot stats on both sides
        expect(killsFromEvents(c.events, 4)).toEqual(view.fighters.map((f) => f.kills));
      }
      expect(killsFromEvents(s.hostEvents, 4)).toEqual(s.host.snapshot().fighters.map((f) => f.kills));
      disposeSession(s);
    }, 120000);
  }

  it('a ten-fighter room (humans spread around the ring, seven bots) plays to a single champion everywhere', async () => {
    const s = await makeDriverSession({ fighters: 10, humanSlots: [0, 4, 7], net: { latencyMs: 40, jitterMs: 10, loss: 0.02 }, difficulty: 2 });
    s.runToEnd(40000);
    expect(s.host.simSnapshot().matchOver).toBe(true);
    const res = s.host.results();
    expect(res).not.toBeNull();
    if (res === null) return;
    expect(res.fighters.filter((f) => f.placement === 1)).toHaveLength(1);
    expect(new Set(res.fighters.map((f) => f.placement)).size).toBe(10);
    for (const c of s.clients) {
      expect(c.driver.results()).toEqual(overTheWire(res));
      const view = c.views[c.views.length - 1];
      expect(view.matchOver).toBe(true);
      expect(swapId(view.winnerId, 0, c.slot)).toBe(res.winnerId);
      expect(deaths(c.events)).toHaveLength(9);
      expect(killsFromEvents(c.events, 10)).toEqual(view.fighters.map((f) => f.kills));
    }
    disposeSession(s);
  }, 180000);

  it("clients' own actions register on the host and the local player is fighter 0 on every machine", async () => {
    const s = await makeDriverSession({ fighters: 4, humanSlots: [0, 1, 2], difficulty: 3 });
    s.run(900);
    // the host saw swings by the remote humans' fighters (slots 1 and 2): their intents drive the host World
    const swings = new Set(s.hostEvents.filter((e) => e.type === 'swingImpact').map((e) => (e as GameEventOf<'swingImpact'>).fighterId));
    expect(swings.has(1)).toBe(true);
    expect(swings.has(2)).toBe(true);
    // and each client sees ITS OWN swings as fighter 0 (id swap), the host's as fighter 1 or 2 mapped back
    for (const c of s.clients) {
      const ids = new Set(c.events.filter((e) => e.type === 'swingImpact').map((e) => (e as GameEventOf<'swingImpact'>).fighterId));
      expect(ids.has(0)).toBe(true);
      const view = c.views[c.views.length - 1];
      expect(view.fighters[0].animal).toBe(animals[c.slot]);
      // the client's own fighter 0 sits where the host's fighter `slot` is (within network delay)
      const sim = s.host.simSnapshot().fighters[c.slot];
      expect(Math.hypot(view.fighters[0].pos.x - sim.pos.x, view.fighters[0].pos.z - sim.pos.z)).toBeLessThan(2.5);
    }
    disposeSession(s);
  }, 60000);

  it('only the host seat is flagged isPlayer (so any slot can be handed to a bot)', async () => {
    const s = await makeDriverSession({ fighters: 4, humanSlots: [0, 1, 2] });
    s.run(5);
    expect(s.host.snapshot().fighters.map((f) => f.isPlayer)).toEqual([true, false, false, false]);
    disposeSession(s);
  });
});

describe('start gate', () => {
  it('holds the countdown until every remote human reported in, and names who it waits for', async () => {
    const s = await makeDriverSession({ fighters: 4, humanSlots: [0, 1, 2], holdClients: true });
    s.run(120);
    expect(s.host.waiting).toBe(true);
    expect(s.host.waitingFor()).toEqual(['Ann', 'Bob']);
    expect(s.host.snapshot().time).toBeCloseTo(-3, 5); // frozen countdown, nothing simulated
    s.startClients();
    s.run(4);
    expect(s.host.waiting).toBe(false);
    s.run(60);
    expect(s.host.snapshot().time).toBeGreaterThan(-3);
    disposeSession(s);
  });

  it('starts anyway after the gate timeout', async () => {
    const s = await makeDriverSession({ fighters: 4, humanSlots: [0, 1, 2], holdClients: true, gateTimeoutS: 0.5 });
    s.run(20);
    expect(s.host.waiting).toBe(true);
    s.run(20);
    expect(s.host.waiting).toBe(false);
    s.run(10);
    expect(s.host.snapshot().time).toBeGreaterThan(-3);
    disposeSession(s);
  });

  it('a client that never connects does not block a host with gate 0', async () => {
    const s = await makeDriverSession({ fighters: 4, humanSlots: [0, 1, 2], holdClients: true, gateTimeoutS: 0 });
    s.run(5);
    expect(s.host.waiting).toBe(false);
    disposeSession(s);
  });
});

describe('bot takeover when a peer leaves', () => {
  it('the slot is handed to its bot brain; the others keep playing', async () => {
    // Ann (slot 1) stands still (neutral intent), then drops out at tick 400; Bob keeps fighting.
    const s = await makeDriverSession({
      fighters: 5,
      humanSlots: [0, 1, 2],
      difficulty: 4,
      script: (who, tick, truth, slot, r) => {
        if (who === 1) return neutral();
        return chaserLike(truth, slot, tick, r);
      },
    });
    const left: Array<{ slot: number; name: string }> = [];
    s.host.onPeerLeft((i) => left.push({ slot: i.slot, name: i.name }));
    s.run(400);
    const idle = s.host.simSnapshot().fighters[1];
    expect(s.host.net.remoteSlots()).toEqual([1, 2]);

    // Ann's machine goes away
    s.clients[0].machine.transport.dispose();
    s.run(2);
    expect(left).toEqual([{ slot: 1, name: 'Ann' }]);
    expect(s.host.net.remoteSlots()).toEqual([2]);

    // within a couple of seconds the bot brain is driving fighter 1: it moves (and/or attacks) although no human does
    const start1 = { x: idle.pos.x, z: idle.pos.z };
    let travelled = 0;
    let acted = false;
    for (let i = 0; i < 240; i++) {
      s.step();
      const f = s.host.simSnapshot().fighters[1];
      if (!f.alive) break;
      travelled = Math.max(travelled, Math.hypot(f.pos.x - start1.x, f.pos.z - start1.z));
      if (f.action !== 'idle' && f.action !== 'run') acted = true;
    }
    expect(travelled > 1.5 || acted || !s.host.simSnapshot().fighters[1].alive).toBe(true);
    // Bob's client still gets snapshots and the match continues
    const bob = s.clients[1];
    const before = bob.views.length;
    s.run(60);
    expect(bob.views.length).toBeGreaterThan(before);
    expect(s.host.waiting).toBe(false);
    disposeSession(s);
  }, 60000);

  it('a client whose host link drops reports it (the screen turns that into host-left)', async () => {
    const s = await makeDriverSession({ fighters: 4, humanSlots: [0, 1, 2] });
    const reasons: string[] = [];
    s.clients[0].driver.onHostLeft((r) => reasons.push(r));
    s.run(100);
    s.hostMachine.transport.dispose();
    s.run(5);
    expect(reasons).toHaveLength(1);
    disposeSession(s);
  });
});

function chaserLike(truth: WorldSnapshot, slot: number, tick: number, r: () => number): FighterIntent {
  const me = truth.fighters[slot];
  const out = neutral();
  if (!me.alive) return out;
  let best = -1;
  let bd = Infinity;
  for (const f of truth.fighters) {
    if (f.id === slot || !f.alive) continue;
    const d = Math.hypot(f.pos.x - me.pos.x, f.pos.z - me.pos.z);
    if (d < bd) {
      bd = d;
      best = f.id;
    }
  }
  if (best < 0) return out;
  const t = truth.fighters[best];
  const dx = t.pos.x - me.pos.x;
  const dz = t.pos.z - me.pos.z;
  const len = Math.max(1e-6, Math.hypot(dx, dz));
  out.moveX = dx / len;
  out.moveZ = dz / len;
  out.aimYaw = Math.atan2(dx, dz);
  out.attack = bd < 3.2 && ((tick % 11 < 2) || r() < 0.2);
  return out;
}

describe('host that is not slot 0', () => {
  it('remaps roster, names, snapshots and events so the host is controller fighter 0', async () => {
    // slots: client Ann at 0, Bob at 1, the HOST sits at slot 2 (humans list: first entry is the host)
    const s = await makeDriverSession({ fighters: 5, humanSlots: [2, 0, 1], difficulty: 3 });
    expect(s.start.localSlot).toBe(2);
    expect(s.host.hostSlot).toBe(2);
    expect(s.host.roster[0].animal).toBe(animals[2]);
    expect(s.host.roster[2].animal).toBe(animals[0]);
    expect(s.host.names[0]).toBe('Hosty');
    expect(s.host.names[2]).toBe('Ann');
    expect(s.host.names[1]).toBe('Bob');
    expect(s.host.names[3]).toBeNull();
    expect(s.host.roster[0].isPlayer).toBe(true);

    s.runToEnd(24000);
    const sim = s.host.simSnapshot();
    const view = s.host.snapshot();
    expect(sim.matchOver).toBe(true);
    for (let i = 0; i < 5; i++) {
      const slot = swapId(i, 0, 2);
      expect(view.fighters[i].id).toBe(i);
      expect(view.fighters[i].animal).toBe(animals[slot]);
      expect(view.fighters[i].kills).toBe(sim.fighters[slot].kills);
    }
    // controller-id events are consistent with the controller-id snapshot (kills implied by deaths)
    expect(killsFromEvents(s.hostEvents, 5)).toEqual(view.fighters.map((f) => f.kills));
    // results stay in SLOT space and agree on the clients
    const res = s.host.results();
    expect(res).not.toBeNull();
    for (const c of s.clients) {
      expect(c.driver.results()).toEqual(overTheWire(res));
      const cv = c.views[c.views.length - 1];
      expect(killsFromEvents(c.events, 5)).toEqual(cv.fighters.map((f) => f.kills));
      expect(cv.fighters[0].animal).toBe(animals[c.slot]);
    }
    disposeSession(s);
  }, 120000);
});

describe('offline path is unchanged', () => {
  it('LocalSimDriver reproduces the legacy World + BotManager loop tick for tick', () => {
    const seed = 91234;
    const animal: AnimalId = 'rhino';
    const difficulty = 3 as const;
    const driver = new LocalSimDriver({ animal, difficulty, seed });

    // The pre-refactor MatchController path, inlined.
    const roster = seatRoster(animal, seed);
    const bus = new EventBus();
    const legacyEvents: GameEvent[] = [];
    bus.onAny((e) => legacyEvents.push(e));
    const world = new World({ roster, difficulty }, seed, bus);
    const bots = new BotManager(bus, difficulty, seed);
    let snap = world.snapshot();

    const driverEvents: GameEvent[] = [];
    driver.bus.onAny((e) => driverEvents.push(e));
    expect(driver.roster).toEqual(roster);
    expect(driver.names.every((n) => n === null)).toBe(true);
    expect(driver.pausable).toBe(true);
    expect(driver.stepsSim).toBe(true);
    expect(JSON.stringify(driver.snapshot())).toBe(JSON.stringify(snap));

    for (let t = 0; t < 900; t++) {
      // a deterministic scripted player: circle, swing, block and use abilities now and then
      const a = t * 0.02;
      const intent: FighterIntent = {
        moveX: Math.cos(a),
        moveZ: Math.sin(a),
        aimYaw: a,
        attack: t % 17 < 2,
        block: t % 90 > 70,
        special: t % 131 === 0,
        ultimate: t % 397 === 0,
        jump: t % 211 === 0,
      };
      const dead = t > 600 && !snap.fighters[0].alive;
      driver.tick(DT, dead ? null : { ...intent });
      if (!dead) world.setIntent(0, { ...intent });
      bots.update(snap, DT);
      for (let id = 1; id < roster.length; id++) world.setIntent(id, bots.getIntent(id));
      world.step(DT);
      snap = world.snapshot();
      if (t % 30 === 0 || t === 899) expect(JSON.stringify(driver.snapshot())).toBe(JSON.stringify(snap));
    }
    expect(JSON.stringify(driverEvents)).toBe(JSON.stringify(legacyEvents));
    expect(driverEvents.length).toBeGreaterThan(0);
  });
});
