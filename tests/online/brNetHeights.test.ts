/**
 * v1.10 end-to-end (protocol 4): a Battle Royale host simulates a two-height dome (tests/sim/heightsFixture.ts: flat floor + a 6.5 m
 * platform, hazards {serpent, serpentSplitY 4.5, fallDamage 50}) with real bots; two remote humans stand on the platform and the floor
 * while BOTH serpents strike on the same tick, then get shoved off the platform. The clients' rendered views must carry both serpent
 * blocks, receive the tiered serpent events, the `fall` events and the `cause: 'fall'` death exactly once and in order, and the
 * controller-facing id swap must remap them — through the real host / client sessions over the loopback network (snapshot codec
 * blocks, tier bit, fall codec, de-duplication, interpolation, id swap).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { GameEvent, SerpentPhase, SerpentState } from '../../src/core/types';
import { swapSample } from '../../src/online/br/BrNetClient';
import { serpentLaneBins } from '../../src/config/serpentLanes';
import { SERPENT } from '../../src/config/serpent';
import { EVENT_ANGLE_DEG_TOLERANCE, EVENT_POS_TOLERANCE } from '../../src/online/br/eventCodec';
import { arenaGroundHeight } from '../../src/config/arenas';
import { HEIGHTS_ARENA } from '../sim/heightsFixture';
import { runSession, type Session } from './brNetHarness';
import { neutral } from './brTestUtil';

const TRIGGER_TICK = 300; // 3 s countdown + 2 s of fight
const SHOVE_TICK = 560;
const lowBins = serpentLaneBins(HEIGHTS_ARENA).low;
/** A low-lane strike line over the floor on the west side (far from the platform at +x). */
const LOW_ANGLE = lowBins.includes(200) ? 200 : lowBins[Math.floor(lowBins.length / 2)];
const HIGH_ANGLE = 0; // straight through the platform centre (14, 0)

type Tiered = { tier?: 'high' };
const tierOf = (e: GameEvent): 'low' | 'high' => ((e as Tiered).tier === 'high' ? 'high' : 'low');
type Hit = Extract<GameEvent, { type: 'serpentHit' }>;
type Fall = Extract<GameEvent, { type: 'fall' }>;
type Death = Extract<GameEvent, { type: 'death' }>;

/** The events this scenario is about: the serpent events (hits only for the two scripted humans), their falls and deaths. */
const scenarioEvents = (evs: readonly GameEvent[]): GameEvent[] =>
  evs.filter((e) => {
    if (e.type === 'serpentHit') return e.fighterId === 1 || e.fighterId === 2;
    if (e.type === 'fall') return e.fighterId === 1 || e.fighterId === 2;
    if (e.type === 'death') return e.targetId === 1 || e.targetId === 2;
    return e.type.startsWith('serpent');
  });

let session: Session;
beforeAll(async () => {
  const stand = (s: Session, id: number, x: number, z: number): void => {
    const f = s.world.fighters[id];
    const st = f.state;
    st.pos.x = x;
    st.pos.z = z;
    st.pos.y = arenaGroundHeight(HEIGHTS_ARENA, x, z);
    st.vel.x = 0;
    st.vel.y = 0;
    st.vel.z = 0;
    st.airborne = false;
    f.lastGroundY = st.pos.y;
    f.fallArmed = false;
    st.hp = st.maxHp;
  };
  const rad = (LOW_ANGLE * Math.PI) / 180;
  session = await runSession({
    arena: 'ocean',
    seconds: 13,
    clients: 2,
    seed: 717,
    worldOpts: { traps: false, arena: HEIGHTS_ARENA },
    script: () => neutral(),
    onTick: (tick, s) => {
      if (tick === TRIGGER_TICK) {
        s.world.debugTriggerSerpent(LOW_ANGLE, 'low');
        s.world.debugTriggerSerpent(HIGH_ANGLE, 'high');
      }
      const live = s.truth[s.truth.length - 1];
      const striking = (live.serpent !== undefined && live.serpent.phase !== 'hold' && live.serpent.phase !== 'retreat') || (live.serpentHigh !== undefined && live.serpentHigh.phase !== 'hold' && live.serpentHigh.phase !== 'retreat');
      if (tick >= TRIGGER_TICK - 30 && tick <= TRIGGER_TICK + 140 && striking) {
        stand(s, 1, 14, 0); // remote human 1: on the platform, hit by the HIGH serpent
        stand(s, 2, 12 * Math.cos(rad), 12 * Math.sin(rad)); // remote human 2: on the floor, on the LOW serpent's line
      }
      if (tick === SHOVE_TICK - 5) {
        stand(s, 1, 14, 2.5);
        stand(s, 2, 16.5, 0);
        s.world.fighters[2].state.hp = 30; // the fall kills it
      }
      if (tick === SHOVE_TICK) {
        s.world.fighters[1].setKnockback(0, 1, 6); // off the platform's +z side onto the 3.0 m shelf: a 3.5 m drop
        s.world.fighters[2].setKnockback(1, 0, 6); // off the +x side onto the floor: a 6.5 m drop
      }
    },
  });
}, 120_000);

describe('BR online: two serpents and fall damage on a two-height dome', () => {
  it('the host really ran it: both serpents on the same tick, tiered hits, two falls (50 and the last 30 hp), a fall kill', () => {
    const evs = scenarioEvents(session.truthEvents.flat());
    const kinds = evs.map((e) => `${e.type}:${tierOf(e)}`);
    expect(kinds.filter((k) => k.startsWith('serpentWarning'))).toEqual(['serpentWarning:low', 'serpentWarning:high']);
    expect(kinds.filter((k) => k.startsWith('serpentStrike')).sort()).toEqual(['serpentStrike:high', 'serpentStrike:low']);
    expect(kinds.filter((k) => k.startsWith('serpentEnd')).sort()).toEqual(['serpentEnd:high', 'serpentEnd:low']);
    // the warnings came on the same tick
    const warnTicks = session.truthEvents.map((t, i) => (t.some((e) => e.type === 'serpentWarning') ? i : -1)).filter((i) => i >= 0);
    expect(warnTicks).toHaveLength(1);
    const hits = evs.filter((e): e is Hit => e.type === 'serpentHit');
    expect(hits.map((h) => [h.fighterId, tierOf(h), h.damage]).sort()).toEqual([[1, 'high', SERPENT.damage], [2, 'low', SERPENT.damage]]);
    const high = hits.find((h) => h.fighterId === 1);
    expect(high?.pos.y).toBe(6.5); // hit on the platform
    const falls = evs.filter((e): e is Fall => e.type === 'fall');
    expect(falls.map((f) => [f.fighterId, f.damage]).sort()).toEqual([[1, 50], [2, 30]]);
    expect(falls.find((f) => f.fighterId === 1)?.drop).toBeCloseTo(3.5, 6);
    expect(falls.find((f) => f.fighterId === 2)?.drop).toBeCloseTo(6.5, 6);
    const death = evs.find((e): e is Death => e.type === 'death' && e.targetId === 2);
    expect(death).toMatchObject({ type: 'death', targetId: 2, killerId: -1, cause: 'fall' });
    // snapshot truth: each block exists exactly while its event runs, both together
    const both = session.truth.filter((s) => s.serpent !== undefined && s.serpentHigh !== undefined).length;
    expect(both).toBeGreaterThanOrEqual(Math.floor(2.7 * 60) - 3);
    expect(session.truth.filter((s) => s.serpent !== undefined && s.serpent.angleDeg !== LOW_ANGLE)).toHaveLength(0);
    expect(session.truth.filter((s) => s.serpentHigh !== undefined && s.serpentHigh.angleDeg !== HIGH_ANGLE)).toHaveLength(0);
  });

  it('every client receives the same scenario events, once each, in order, with the right tiers, fields and cause', () => {
    const want = scenarioEvents(session.truthEvents.flat());
    for (const c of [0, 1]) {
      const got = scenarioEvents(session.released[c].map((r) => r.ev));
      expect(got.map((e) => `${e.type}:${tierOf(e)}`), `client ${c}`).toEqual(want.map((e) => `${e.type}:${tierOf(e)}`));
      for (let i = 0; i < want.length; i++) {
        const a = want[i];
        const b = got[i];
        expect(b.type).toBe(a.type);
        if (a.type === 'serpentWarning' && b.type === 'serpentWarning') {
          expect(Math.abs(a.angleDeg - b.angleDeg)).toBeLessThanOrEqual(EVENT_ANGLE_DEG_TOLERANCE);
          expect(b.warnS).toBeCloseTo(a.warnS, 3);
        }
        if (a.type === 'serpentHit' && b.type === 'serpentHit') {
          expect(b.fighterId).toBe(a.fighterId);
          expect(b.damage).toBe(a.damage);
          expect(Math.abs(a.pos.y - b.pos.y)).toBeLessThanOrEqual(EVENT_POS_TOLERANCE);
        }
        if (a.type === 'fall' && b.type === 'fall') {
          expect(b.fighterId).toBe(a.fighterId);
          expect(b.damage).toBe(a.damage);
          expect(Math.abs(a.drop - b.drop)).toBeLessThanOrEqual(0.0051);
          expect(Math.abs(a.pos.x - b.pos.x)).toBeLessThanOrEqual(EVENT_POS_TOLERANCE);
          expect(Math.abs(a.pos.y - b.pos.y)).toBeLessThanOrEqual(EVENT_POS_TOLERANCE);
        }
        if (a.type === 'death' && b.type === 'death') expect(b).toEqual(a);
      }
      const death = got.find((e): e is Death => e.type === 'death' && e.targetId === 2);
      expect(death).toMatchObject({ killerId: -1, cause: 'fall' });
    }
  });

  it('the client view carries BOTH blocks through warn -> strike -> hold -> retreat, at the same time, and nothing outside the events', () => {
    const frames = session.frames[0];
    for (const key of ['serpent', 'serpentHigh'] as const) {
      const seq: SerpentPhase[] = [];
      let started = false;
      let ended = false;
      for (const { sample } of frames) {
        const s = sample.view[key];
        if (s === undefined) {
          if (started) ended = true;
          continue;
        }
        expect(ended, `${key} reappeared after the event ended`).toBe(false);
        started = true;
        if (seq[seq.length - 1] !== s.phase) seq.push(s.phase);
        expect(Math.abs(s.angleDeg - (key === 'serpent' ? LOW_ANGLE : HIGH_ANGLE))).toBeLessThanOrEqual(0.01);
      }
      expect(seq, key).toEqual(['warn', 'strike', 'hold', 'retreat']);
      expect(ended, key).toBe(true);
    }
    expect(frames.filter((f) => f.sample.view.serpent !== undefined && f.sample.view.serpentHigh !== undefined).length).toBeGreaterThan(100);
  });

  it('the high block tracks the host: head distance and phase agree with the host truth at the view time (except right at a phase flip)', () => {
    const truth = session.truth;
    let checked = 0;
    let phaseAgree = 0;
    let worst = 0;
    for (const { sample } of session.frames[1]) {
      const v = sample.view.serpentHigh;
      if (v === undefined) continue;
      let k = Math.round((sample.view.time - truth[0].time) * 60);
      k = Math.max(0, Math.min(truth.length - 1, k));
      const t: SerpentState | undefined = truth[k].serpentHigh;
      if (t === undefined) continue;
      const near = [-6, -3, 3, 6].some((d) => truth[Math.max(0, Math.min(truth.length - 1, k + d))].serpentHigh?.phase !== t.phase);
      if (near) continue;
      checked++;
      if (v.phase === t.phase) phaseAgree++;
      worst = Math.max(worst, Math.abs(v.headR - t.headR));
    }
    expect(checked).toBeGreaterThan(60);
    expect(phaseAgree / checked).toBeGreaterThan(0.97);
    expect(worst).toBeLessThan(4.5);
  });

  it('the controller-facing sample (local player swapped to id 0) keeps both blocks and remaps serpentHit / fall / death ids', () => {
    let blocks = 0;
    let rawFalls = 0;
    let swappedFalls = 0;
    let swappedHits = 0;
    for (const { sample } of session.frames[0]) {
      const m = swapSample(sample, 0, session.slots[0]);
      expect(m.view.serpent).toEqual(sample.view.serpent);
      expect(m.view.serpentHigh).toEqual(sample.view.serpentHigh);
      if (sample.view.serpentHigh !== undefined) {
        expect(m.view.serpentHigh).not.toBe(sample.view.serpentHigh);
        blocks++;
      }
      for (const e of sample.events) if (e.type === 'fall' && e.fighterId === 1) rawFalls++;
      for (const e of m.events) {
        if (e.type === 'fall' && e.fighterId === 0) swappedFalls++;
        if (e.type === 'serpentHit' && e.fighterId === 0) {
          swappedHits++;
          expect(tierOf(e)).toBe('high'); // the platform human
        }
      }
      // tier survives the id swap on every serpent event
      for (const e of m.events) {
        if (!e.type.startsWith('serpent')) continue;
        const orig = sample.events.find((x) => x.type === e.type && tierOf(x) === tierOf(e));
        expect(orig, `${e.type} ${tierOf(e)}`).toBeDefined();
      }
    }
    expect(blocks).toBeGreaterThan(100);
    expect(rawFalls).toBe(1);
    expect(swappedFalls).toBe(rawFalls);
    expect(swappedHits).toBe(1);
  });

  it('the colosseum session on the same harness never carries the second serpent or a fall', async () => {
    const col = await runSession({ seconds: 8, clients: 1, seed: 717, script: () => neutral() });
    expect(col.truth.every((s) => s.serpent === undefined && s.serpentHigh === undefined)).toBe(true);
    expect(col.truthEvents.flat().some((e) => e.type === 'fall' || e.type.startsWith('serpent'))).toBe(false);
    expect(col.frames[0].every((f) => f.sample.view.serpentHigh === undefined)).toBe(true);
  }, 60_000);
});
