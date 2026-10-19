/**
 * v1.9 end-to-end: a Battle Royale host simulates the OCEAN DOME (real World + bots) and a forced sea-serpent event hits two remote
 * humans; the clients' rendered views carry the serpent state through its phases and receive the four serpent events and the
 * `cause: 'serpent'` death — through the real host / client sessions over the loopback network (snapshot codec block, event codec,
 * de-duplication, interpolation, id swap).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { GameEvent, SerpentPhase, SerpentState } from '../../src/core/types';
import { swapSample } from '../../src/online/br/BrNetClient';
import { arenaGroundHeight, arenaSerpentBand, getArena } from '../../src/config/arenas';
import { serpentLaneBins } from '../../src/config/serpentLanes';
import { obstacleSurfaceDist } from '../../src/sim/TrapSystem';
import { SERPENT } from '../../src/config/serpent';
import { EVENT_ANGLE_DEG_TOLERANCE } from '../../src/online/br/eventCodec';
import { runSession, type Session } from './brNetHarness';
import { neutral } from './brTestUtil';

const ARENA = getArena('ocean');
const TRIGGER_TICK = 300; // 3 s countdown + 2 s of fight

/**
 * An angle whose strike line is clear of solids at the three radii the test stands on, is one of the LOW serpent's allowed lines
 * (v1.10: it never runs over the upper platforms) and keeps the three spots on low ground (the low serpent only hurts the low band).
 */
function clearAngle(): number {
  const lowBins = new Set(serpentLaneBins(ARENA).low);
  for (let a = 0; a < 360; a += 3) {
    const rad = (a * Math.PI) / 180;
    const spots = [8, 12, 22].map((r) => ({ x: r * Math.cos(rad), z: r * Math.sin(rad) }));
    if (
      lowBins.has(a) &&
      spots.every((p) => obstacleSurfaceDist(p.x, p.z, ARENA) >= 3 && arenaSerpentBand(ARENA, p.x, p.z) === 'low')
    ) {
      return a;
    }
  }
  throw new Error('no clear strike line on the ocean arena');
}
const ANGLE = clearAngle();

type Hit = Extract<GameEvent, { type: 'serpentHit' }>;
type Death = Extract<GameEvent, { type: 'death' }>;
/** The events this scenario is about: the four serpent events (hits only for the two scripted humans — bots may wander onto the line) and fighter 2's death. */
const serpentEvents = (evs: readonly GameEvent[]): GameEvent[] =>
  evs.filter((e) => (e.type === 'serpentHit' ? e.fighterId === 1 || e.fighterId === 2 : e.type.startsWith('serpent') || (e.type === 'death' && e.targetId === 2)));

let session: Session;
beforeAll(async () => {
  const rad = (ANGLE * Math.PI) / 180;
  const stand = (s: Session, id: number, r: number): void => {
    const st = s.world.fighters[id].state;
    st.pos.x = r * Math.cos(rad);
    st.pos.z = r * Math.sin(rad);
    st.pos.y = arenaGroundHeight(ARENA, st.pos.x, st.pos.z);
    st.vel.x = 0;
    st.vel.y = 0;
    st.vel.z = 0;
    st.airborne = false;
  };
  let strikeSeen = false;
  session = await runSession({
    arena: 'ocean',
    seconds: 12,
    clients: 2,
    seed: 616,
    worldOpts: { traps: false },
    script: () => neutral(),
    onTick: (tick, s) => {
      if (tick === TRIGGER_TICK) s.world.debugTriggerSerpent(ANGLE);
      const snap = s.truth[s.truth.length - 1].serpent;
      if (tick >= TRIGGER_TICK - 30 && tick <= TRIGGER_TICK + 140 && snap !== undefined && snap.phase !== 'hold' && snap.phase !== 'retreat') {
        stand(s, 1, 22); // remote human 1: tough, stays on the line
        stand(s, 2, 12); // remote human 2: about to be killed
        s.world.fighters[1].state.hp = s.world.fighters[1].state.maxHp;
      }
      if (snap?.phase === 'strike' && !strikeSeen) {
        strikeSeen = true;
        s.world.fighters[2].state.hp = 100;
      }
    },
  });
}, 120_000);

describe('BR online: sea serpent on the Ocean Dome', () => {
  it('the host really ran the event: warning, strike, two hits (300 and the last 100 hp), a serpent kill, end', () => {
    const evs = session.truthEvents.flat();
    expect(evs.filter((e) => e.type === 'serpentWarning')).toHaveLength(1);
    expect(evs.filter((e) => e.type === 'serpentStrike')).toHaveLength(1);
    expect(evs.filter((e) => e.type === 'serpentEnd')).toHaveLength(1);
    const hits = evs.filter((e): e is Hit => e.type === 'serpentHit' && (e.fighterId === 1 || e.fighterId === 2));
    expect(hits.map((h) => [h.fighterId, h.damage])).toEqual([[1, SERPENT.damage], [2, 100]]);
    const death = evs.find((e): e is Death => e.type === 'death' && e.targetId === 2);
    expect(death).toMatchObject({ type: 'death', targetId: 2, killerId: -1, cause: 'serpent' });
    // snapshot truth: the block exists exactly while the event runs
    const phases = session.truth.map((s) => s.serpent?.phase ?? null);
    const first = phases.findIndex((p) => p !== null);
    const last = phases.length - 1 - [...phases].reverse().findIndex((p) => p !== null);
    expect(first).toBeGreaterThanOrEqual(TRIGGER_TICK - 1);
    expect(phases.slice(first, last + 1).every((p) => p !== null)).toBe(true);
    expect(last - first + 1).toBeGreaterThanOrEqual(Math.floor((SERPENT.warnS + SERPENT.strikeS + SERPENT.holdS + SERPENT.retreatS) * 60) - 2);
    expect(session.truth.filter((s) => s.serpent !== undefined && s.serpent.angleDeg !== ANGLE)).toHaveLength(0);
  });

  it('every client receives the serpent events once each, in order, with the right fields (including the serpent death)', () => {
    for (const c of [0, 1]) {
      const got = serpentEvents(session.released[c].map((r) => r.ev));
      const want = serpentEvents(session.truthEvents.flat());
      expect(got.map((e) => e.type), `client ${c}`).toEqual(want.map((e) => e.type));
      expect(got.map((e) => e.type)).toEqual(['serpentWarning', 'serpentStrike', 'serpentHit', 'serpentHit', 'death', 'serpentEnd']);
      const w = got.find((e) => e.type === 'serpentWarning') as Extract<GameEvent, { type: 'serpentWarning' }>;
      expect(Math.abs(w.angleDeg - ANGLE)).toBeLessThanOrEqual(EVENT_ANGLE_DEG_TOLERANCE);
      expect(w.warnS).toBeCloseTo(SERPENT.warnS, 3);
      const hits = got.filter((e): e is Hit => e.type === 'serpentHit');
      expect(hits.map((h) => [h.fighterId, h.damage])).toEqual([[1, SERPENT.damage], [2, 100]]);
      const truthHits = session.truthEvents.flat().filter((e): e is Hit => e.type === 'serpentHit' && (e.fighterId === 1 || e.fighterId === 2));
      hits.forEach((h, i) => {
        expect(Math.abs(h.pos.x - truthHits[i].pos.x)).toBeLessThanOrEqual(0.0051);
        expect(Math.abs(h.pos.z - truthHits[i].pos.z)).toBeLessThanOrEqual(0.0051);
      });
      const death = got.find((e): e is Death => e.type === 'death');
      expect(death).toMatchObject({ type: 'death', targetId: 2, killerId: -1, cause: 'serpent' });
    }
  });

  it('the client view carries the serpent through warn -> strike -> hold -> retreat and nothing outside the event', () => {
    const frames = session.frames[0];
    const seq: SerpentPhase[] = [];
    let before = 0;
    let after = 0;
    let started = false;
    let ended = false;
    for (const { sample } of frames) {
      const s = sample.view.serpent;
      if (s === undefined) {
        if (started) ended = true;
        else before++;
        continue;
      }
      expect(ended, 'the serpent block reappeared after the event ended').toBe(false);
      started = true;
      if (seq[seq.length - 1] !== s.phase) seq.push(s.phase);
      expect(Math.abs(s.angleDeg - ANGLE)).toBeLessThanOrEqual(0.01);
    }
    after = ended ? 1 : 0;
    expect(seq).toEqual(['warn', 'strike', 'hold', 'retreat']);
    expect(before).toBeGreaterThan(200);
    expect(after).toBe(1);
  });

  it('the view tracks the host: head distance and phase agree with the host truth at the view time (except right at a phase flip)', () => {
    const truth = session.truth;
    let checked = 0;
    let phaseAgree = 0;
    let worst = 0;
    for (const { sample } of session.frames[0]) {
      const v = sample.view.serpent;
      if (v === undefined) continue;
      let k = Math.round((sample.view.time - truth[0].time) * 60);
      k = Math.max(0, Math.min(truth.length - 1, k));
      const t: SerpentState | undefined = truth[k].serpent;
      if (t === undefined) continue;
      const near = [-6, -3, 3, 6].some((d) => truth[Math.max(0, Math.min(truth.length - 1, k + d))].serpent?.phase !== t.phase);
      if (near) continue;
      checked++;
      if (v.phase === t.phase) phaseAgree++;
      worst = Math.max(worst, Math.abs(v.headR - t.headR));
    }
    expect(checked).toBeGreaterThan(60);
    expect(phaseAgree / checked).toBeGreaterThan(0.97);
    // the head moves 68 m/s: one snapshot interval (33 ms) is 2.3 m, so a few metres of slack covers interpolation + quantisation
    expect(worst).toBeLessThan(4.5);
  });

  it('the controller-facing sample (local player swapped to id 0) keeps the serpent block and remaps the serpentHit / death ids', () => {
    let swappedHits = 0;
    let rawHits = 0;
    let blockKept = 0;
    for (const { sample } of session.frames[0]) {
      const m = swapSample(sample, 0, session.slots[0]);
      if (sample.view.serpent !== undefined) {
        expect(m.view.serpent).toEqual(sample.view.serpent);
        blockKept++;
      } else expect(m.view.serpent).toBeUndefined();
      for (const e of sample.events) if (e.type === 'serpentHit' && e.fighterId === 1) rawHits++;
      for (const e of m.events) if (e.type === 'serpentHit' && e.fighterId === 0) swappedHits++;
      for (const e of m.events) if (e.type === 'death' && e.cause === 'serpent') expect(e.killerId).toBe(-1);
      for (const e of m.events) if (e.type === 'serpentWarning' || e.type === 'serpentStrike' || e.type === 'serpentEnd') expect(e).toEqual(sample.events.find((x) => x.type === e.type));
    }
    expect(blockKept).toBeGreaterThan(100);
    expect(rawHits).toBe(1);
    expect(swappedHits).toBe(rawHits);
  });

  it('the colosseum session on the same harness never carries serpent data', async () => {
    const col = await runSession({ seconds: 8, clients: 1, seed: 616, script: () => neutral() });
    expect(col.truth.every((s) => s.serpent === undefined)).toBe(true);
    expect(col.truthEvents.flat().some((e) => e.type.startsWith('serpent'))).toBe(false);
    expect(col.frames[0].every((f) => f.sample.view.serpent === undefined)).toBe(true);
  }, 60_000);
});
