/**
 * v1.10 TWO SERPENT LANES (docs/OCEAN-HEIGHTS-PLAN.md section 1.2-1.4): a LOW and a HIGH serpent that roll the same chance at the same times
 * from independent streams, strike along lines that keep them apart (the low one never runs over the upper platforms, the high one always
 * crosses them), and each hurt only the fighters of their own band (by the ground height under the fighter) within `hazardHeight` of the
 * ground, once per event. Runs on the synthetic two-height dome (tests/sim/heightsFixture.ts), not on the real Ocean Dome layout.
 */
import { describe, it, expect } from 'vitest';
import { SerpentSystem } from '../../src/sim/SerpentSystem';
import { SERPENT, SERPENT_EVENT_S } from '../../src/config/serpent';
import { SERPENT_LANES, pickLaneAngle, serpentLaneBins, stripHighLength, stripMaxGround } from '../../src/config/serpentLanes';
import { arenaGroundHeight, arenaSerpentBand } from '../../src/config/arenas';
import { mulberry32 } from '../../src/core/math';
import type { GameEvent, SerpentTier } from '../../src/core/types';
import { FLAT_ARENA, stand, stubSim, trueDeal } from './serpentHelpers';
import {
  DT,
  HEIGHTS_ARENA,
  SPLIT_Y,
  heightsArena,
  heightsWorld,
  neutralIntent,
  ofType,
  parkOthers,
  runSerpentsToEnd,
  standAt,
  stepN,
} from './heightsFixture';

const hits = (events: readonly GameEvent[]) => ofType(events, 'serpentHit');
const tierOf = (e: GameEvent): string => (e as { tier?: string }).tier ?? 'low';

/** Runs every started lane of a stub-sim system to its end. */
function runAll(sys: SerpentSystem, sim: ReturnType<typeof stubSim>['sim'], ticks = 400): void {
  for (let i = 0; i < ticks && sys.active; i++) {
    sim.time += DT;
    sys.step(sim, DT, trueDeal);
  }
}

describe('the lane tables of the fixture', () => {
  const bins = serpentLaneBins(HEIGHTS_ARENA);

  it('have both lanes, disjoint where it matters: every low bin keeps the padded strip off high ground, every high bin crosses it', () => {
    expect(bins.low.length).toBeGreaterThan(200);
    expect(bins.high.length).toBeGreaterThan(20);
    const hw = SERPENT.stripHalfWidth + SERPENT_LANES.lowClearMargin;
    for (const b of bins.low) {
      expect(stripMaxGround(HEIGHTS_ARENA, b, hw), `low bin ${b}`).toBeLessThan(SPLIT_Y);
      expect(stripMaxGround(HEIGHTS_ARENA, b + 1, hw), `low bin ${b}`).toBeLessThan(SPLIT_Y);
    }
    for (const b of bins.high) expect(stripHighLength(HEIGHTS_ARENA, b + 0.5, SPLIT_Y), `high bin ${b}`).toBeGreaterThanOrEqual(SERPENT_LANES.highMinOverlapM);
    // no bin is in both lanes
    const low = new Set(bins.low);
    for (const b of bins.high) expect(low.has(b), `bin ${b}`).toBe(false);
  });

  it('an arena without serpentSplitY has only the low lane, covering every bin (the single v1.9 serpent)', () => {
    const flat = serpentLaneBins(FLAT_ARENA);
    expect(flat.low).toHaveLength(360);
    expect(flat.high).toHaveLength(0);
    const sys = new SerpentSystem(1, FLAT_ARENA);
    expect(sys.low).not.toBeNull();
    expect(sys.high).toBeNull();
    expect(sys.lanes).toHaveLength(1);
  });
});

describe('independent rolls (own streams, same times, same chance)', () => {
  /** First roll (t = SERPENT.intervalS) outcome of both lanes for `seed`. */
  function firstRolls(seed: number, opts = {}) {
    const { sim, events } = stubSim([], HEIGHTS_ARENA);
    const sys = new SerpentSystem(seed, HEIGHTS_ARENA, opts);
    sim.time = SERPENT.intervalS;
    sys.step(sim, DT, trueDeal);
    return { sys, events, low: sys.low?.rollLog[0], high: sys.high?.rollLog[0] };
  }

  it('over 4000 seeds the first roll gives about 25 % both / 25 % low only / 25 % high only / 25 % neither (50 % each lane)', () => {
    const N = 4000;
    const tally = { both: 0, lowOnly: 0, highOnly: 0, none: 0 };
    let lowN = 0;
    let highN = 0;
    for (let seed = 1; seed <= N; seed++) {
      const r = firstRolls(seed);
      expect(r.low?.at).toBe(SERPENT.intervalS);
      expect(r.high?.at).toBe(SERPENT.intervalS); // the same roll time
      const l = r.low?.started === true;
      const h = r.high?.started === true;
      if (l) lowN++;
      if (h) highN++;
      if (l && h) tally.both++;
      else if (l) tally.lowOnly++;
      else if (h) tally.highOnly++;
      else tally.none++;
    }
    console.log(`[serpent lanes] first roll over ${N} seeds:`, JSON.stringify(tally), `low ${(lowN / N).toFixed(3)} high ${(highN / N).toFixed(3)}`);
    for (const [k, v] of Object.entries(tally)) {
      expect(v / N, k).toBeGreaterThan(0.22);
      expect(v / N, k).toBeLessThan(0.28);
    }
    expect(lowN / N).toBeGreaterThan(0.47);
    expect(lowN / N).toBeLessThan(0.53);
    expect(highN / N).toBeGreaterThan(0.47);
    expect(highN / N).toBeLessThan(0.53);
  });

  it('later rolls follow the same law for both lanes, each lane on its own schedule (t = 20, 40, … 200 s)', () => {
    let rolls = 0;
    let low = 0;
    let high = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const { sim } = stubSim([], HEIGHTS_ARENA);
      const sys = new SerpentSystem(seed, HEIGHTS_ARENA);
      for (let k = 1; k <= 10; k++) {
        sim.time = SERPENT.intervalS * k;
        sys.step(sim, DT, trueDeal);
        if (sys.active) sys.abort(sim); // every roll a real roll
      }
      rolls += 10;
      low += (sys.low?.rollLog ?? []).filter((r) => r.started).length;
      high += (sys.high?.rollLog ?? []).filter((r) => r.started).length;
      expect(sys.low?.rollLog.map((r) => r.at)).toEqual(sys.high?.rollLog.map((r) => r.at));
    }
    expect(low / rolls).toBeGreaterThan(0.47);
    expect(low / rolls).toBeLessThan(0.53);
    expect(high / rolls).toBeGreaterThan(0.47);
    expect(high / rolls).toBeLessThan(0.53);
  });

  it('both lanes can start on the SAME tick: two warnings (the low one without a tier key, the high one with tier "high"), two snapshots', () => {
    let seed = 1;
    while (!(firstRolls(seed).low?.started === true && firstRolls(seed).high?.started === true)) seed++;
    const r = firstRolls(seed);
    expect(r.sys.low?.phase).toBe('warn');
    expect(r.sys.high?.phase).toBe('warn');
    const warns = ofType(r.events, 'serpentWarning');
    expect(warns).toHaveLength(2);
    expect(warns.filter((w) => w.tier === undefined)).toHaveLength(1);
    expect(warns.filter((w) => w.tier === 'high')).toHaveLength(1);
    expect('tier' in (warns.find((w) => w.tier === undefined) as object)).toBe(false); // exactly the v1.9.1 event
    expect(r.sys.snapshot()?.angleDeg).toBe(r.low?.angleDeg);
    expect(r.sys.snapshotHigh()?.angleDeg).toBe(r.high?.angleDeg);
    expect(r.sys.snapshot()?.phase).toBe('warn');
    expect(r.sys.snapshotHigh()?.phase).toBe('warn');
  });

  it('either lane can start alone, and neither can start (the other lane is untouched)', () => {
    const seen = { lowOnly: false, highOnly: false, none: false };
    for (let seed = 1; seed <= 200 && !(seen.lowOnly && seen.highOnly && seen.none); seed++) {
      const r = firstRolls(seed);
      const l = r.low?.started === true;
      const h = r.high?.started === true;
      expect(r.sys.low?.phase !== null).toBe(l);
      expect(r.sys.high?.phase !== null).toBe(h);
      expect(r.sys.snapshot() !== undefined).toBe(l);
      expect(r.sys.snapshotHigh() !== undefined).toBe(h);
      expect(ofType(r.events, 'serpentWarning')).toHaveLength((l ? 1 : 0) + (h ? 1 : 0));
      if (l && !h) seen.lowOnly = true;
      if (h && !l) seen.highOnly = true;
      if (!l && !h) seen.none = true;
    }
    expect(seen).toEqual({ lowOnly: true, highOnly: true, none: true });
  });

  it('the streams are seed ^ salt: the low lane is the v1.9 stream, the high lane uses highSeedSalt, both draw one chance then pickLaneAngle', () => {
    for (const seed of [1, 7, 12345, 0xdeadbeef]) {
      const want = (tier: SerpentTier, salt: number) => {
        const rng = mulberry32((seed ^ salt) >>> 0);
        const started = rng() < SERPENT.chance;
        return { started, angleDeg: started ? pickLaneAngle(HEIGHTS_ARENA, tier, rng) : -1 };
      };
      const r = firstRolls(seed);
      const wl = want('low', SERPENT.seedSalt);
      const wh = want('high', SERPENT_LANES.highSeedSalt);
      expect(r.low?.started).toBe(wl.started);
      expect(r.low?.angleDeg).toBe(wl.angleDeg);
      expect(r.high?.started).toBe(wh.started);
      expect(r.high?.angleDeg).toBe(wh.angleDeg);
    }
    expect(SERPENT_LANES.highSeedSalt).not.toBe(SERPENT.seedSalt);
  });

  it('options apply to BOTH lanes: chance 1 starts both at firstAtS, chance 0 neither; lanes picks which exist', () => {
    const both = firstRolls(5, { chance: 1, firstAtS: 20 });
    expect(both.low?.started).toBe(true);
    expect(both.high?.started).toBe(true);
    const never = firstRolls(5, { chance: 0 });
    expect(never.low?.started).toBe(false);
    expect(never.high?.started).toBe(false);
    const early = stubSim([], HEIGHTS_ARENA);
    const sys = new SerpentSystem(5, HEIGHTS_ARENA, { chance: 1, firstAtS: 2, intervalS: 7 });
    early.sim.time = 1.99;
    sys.step(early.sim, DT, trueDeal);
    expect(sys.low?.rollLog).toHaveLength(0);
    expect(sys.high?.rollLog).toHaveLength(0);
    early.sim.time = 2;
    sys.step(early.sim, DT, trueDeal);
    expect(sys.low?.rollLog.map((r) => r.at)).toEqual([2]);
    expect(sys.high?.rollLog.map((r) => r.at)).toEqual([2]);

    const onlyLow = new SerpentSystem(5, HEIGHTS_ARENA, { chance: 1, firstAtS: 1, lanes: ['low'] });
    expect(onlyLow.high).toBeNull();
    const onlyHigh = new SerpentSystem(5, HEIGHTS_ARENA, { chance: 1, firstAtS: 1, lanes: ['high'] });
    expect(onlyHigh.low).toBeNull();
    expect(onlyHigh.lanes).toHaveLength(1);
    const s2 = stubSim([], HEIGHTS_ARENA);
    s2.sim.time = 1;
    onlyHigh.step(s2.sim, DT, trueDeal);
    onlyLow.step(s2.sim, DT, trueDeal);
    const w = ofType(s2.events, 'serpentWarning');
    expect(w.map(tierOf).sort()).toEqual(['high', 'low']);
    // 'high' on an arena without a split is ignored
    expect(new SerpentSystem(5, FLAT_ARENA, { lanes: ['low', 'high'] }).high).toBeNull();
  });

  it('a roll that falls due during one lane\'s event is skipped by THAT lane only', () => {
    const { sim, events } = stubSim([], HEIGHTS_ARENA);
    const sys = new SerpentSystem(9, HEIGHTS_ARENA, { chance: 1, intervalS: 1 }); // the 2.7 s event outlasts the 1 s interval
    expect(sys.trigger(200, 'low')).toBe(true); // a low event is queued; the high lane is idle
    sim.time = 0.5;
    sys.step(sim, DT, trueDeal);
    sim.time = 1;
    sys.step(sim, DT, trueDeal);
    expect(sys.low?.rollLog).toEqual([expect.objectContaining({ at: 1, started: false, skipped: true })]);
    expect(sys.high?.rollLog).toEqual([expect.objectContaining({ at: 1, started: true, skipped: false })]);
    expect(ofType(events, 'serpentWarning').map(tierOf)).toEqual(['low', 'high']);
  });

  it('a lane without any allowed strike line never starts an event (the roll is logged as not started)', () => {
    const arena = heightsArena({ serpent: true, serpentSplitY: 99 }); // nothing is that high: no high bins
    expect(serpentLaneBins(arena).high).toHaveLength(0);
    const { sim, events } = stubSim([], arena);
    const sys = new SerpentSystem(3, arena, { chance: 1, firstAtS: 1 });
    sim.time = 1;
    sys.step(sim, DT, trueDeal);
    expect(sys.low?.rollLog[0].started).toBe(true);
    expect(sys.high?.rollLog).toEqual([expect.objectContaining({ started: false, skipped: false, angleDeg: -1 })]);
    expect(sys.high?.phase).toBeNull();
    expect(ofType(events, 'serpentWarning').map(tierOf)).toEqual(['low']);
    expect(sys.trigger(undefined, 'high')).toBe(false); // no angle can be drawn
    expect(sys.trigger(45, 'high')).toBe(true); // an explicit angle is the caller's business
  });
});

describe('strike angles stay in their lane', () => {
  it('pickLaneAngle: low angles come from low bins and never touch high ground (padded strip), high angles from high bins and always cross it', () => {
    const bins = serpentLaneBins(HEIGHTS_ARENA);
    const rng = mulberry32(2024);
    const lowUsed = new Set<number>();
    const highUsed = new Set<number>();
    for (let i = 0; i < 20000; i++) {
      const lo = pickLaneAngle(HEIGHTS_ARENA, 'low', rng);
      const hi = pickLaneAngle(HEIGHTS_ARENA, 'high', rng);
      expect(lo).toBeGreaterThanOrEqual(0);
      expect(lo).toBeLessThan(360);
      expect(hi).toBeGreaterThanOrEqual(0);
      expect(hi).toBeLessThan(360);
      lowUsed.add(Math.floor(lo));
      highUsed.add(Math.floor(hi));
      expect(stripMaxGround(HEIGHTS_ARENA, lo, SERPENT.stripHalfWidth), `low ${lo}`).toBeLessThan(SPLIT_Y);
      expect(stripHighLength(HEIGHTS_ARENA, hi, SPLIT_Y), `high ${hi}`).toBeGreaterThan(0);
    }
    // every allowed bin is used, and nothing else
    expect([...lowUsed].sort((a, b) => a - b)).toEqual([...bins.low]);
    expect([...highUsed].sort((a, b) => a - b)).toEqual([...bins.high]);
  });

  it('end to end on the sim: 300 LOW events never hurt anyone standing on the platform top or the upper ramp; 300 HIGH events always hurt one placed on the high ground of their line', () => {
    const onPlatform = [stand(0, 'gorilla', 14, 0, 6.5), stand(1, 'gorilla', 14, 2.5, 6.5), stand(2, 'gorilla', 14, -2.5, 6.5), stand(3, 'gorilla', 14, -5, arenaGroundHeight(HEIGHTS_ARENA, 14, -5)), stand(4, 'gorilla', 14, -8, arenaGroundHeight(HEIGHTS_ARENA, 14, -8))];
    for (let i = 0; i < 300; i++) {
      const { sim, events } = stubSim(onPlatform, HEIGHTS_ARENA);
      const sys = new SerpentSystem(1000 + i, HEIGHTS_ARENA);
      expect(sys.trigger(undefined, 'low')).toBe(true);
      runAll(sys, sim);
      expect(hits(events), `low event ${i}`).toHaveLength(0);
      // ... and not merely because of the band rule: the strip itself never reaches them (lateral distance to the strike ray)
      const a = ((sys.low?.angleDeg ?? 0) * Math.PI) / 180;
      for (const f of onPlatform) {
        const along = f.state.pos.x * Math.cos(a) + f.state.pos.z * Math.sin(a);
        const lateral = Math.abs(-f.state.pos.x * Math.sin(a) + f.state.pos.z * Math.cos(a));
        expect(along > 0 && lateral < SERPENT.headRadius + f.def.radius, `low event ${i} (${sys.low?.angleDeg}) over fighter ${f.id}`).toBe(false);
      }
    }
    const rng = mulberry32(99);
    for (let i = 0; i < 300; i++) {
      const angle = pickLaneAngle(HEIGHTS_ARENA, 'high', rng);
      // the first point of the centre line (walking in from the dome edge) that is on high ground
      const c = Math.cos((angle * Math.PI) / 180);
      const s = Math.sin((angle * Math.PI) / 180);
      let r = HEIGHTS_ARENA.wallRadius - 1.5;
      while (r > 0 && arenaSerpentBand(HEIGHTS_ARENA, c * r, s * r) !== 'high') r -= 0.05;
      expect(r, `high angle ${angle} has high ground on its line`).toBeGreaterThan(0);
      const high = stand(0, 'gorilla', c * r, s * r, arenaGroundHeight(HEIGHTS_ARENA, c * r, s * r));
      const low = stand(1, 'gorilla', c * 27, s * 27, 0); // on the floor at the dome edge, on the same line
      const { sim, events } = stubSim([high, low], HEIGHTS_ARENA);
      const sys = new SerpentSystem(5000 + i, HEIGHTS_ARENA);
      expect(sys.trigger(angle, 'high')).toBe(true);
      runAll(sys, sim);
      expect(hits(events).map((h) => [h.fighterId, tierOf(h)]), `high event ${i} at ${angle}`).toEqual([[0, 'high']]);
      expect(high.state.hp).toBe(high.state.maxHp - 300);
      expect(low.state.hp).toBe(low.state.maxHp);
    }
  });
});

describe('each serpent hurts only its own band', () => {
  /** Platform fighter (high band), floor fighters (low band) on one strike line along +x (angle 0). */
  function lineUp() {
    const platform = stand(0, 'gorilla', 14, 0, 6.5);
    const floorFar = stand(1, 'gorilla', 24, 0);
    const floorNear = stand(2, 'gorilla', 5, 0);
    const offLine = stand(3, 'gorilla', 5, 9);
    return { platform, floorFar, floorNear, offLine, all: [platform, floorFar, floorNear, offLine] };
  }

  it('the LOW serpent hits the floor fighters on its line and skips the one on the platform (even though the strip runs right over it)', () => {
    const t = lineUp();
    const { sim, events } = stubSim(t.all, HEIGHTS_ARENA);
    const sys = new SerpentSystem(1, HEIGHTS_ARENA);
    sys.trigger(0, 'low');
    runAll(sys, sim);
    expect(hits(events).map((h) => h.fighterId).sort()).toEqual([1, 2]);
    expect(hits(events).every((h) => tierOf(h) === 'low' && h.tier === undefined)).toBe(true);
    expect(t.platform.state.hp).toBe(t.platform.state.maxHp);
    expect(t.floorFar.state.hp).toBe(t.floorFar.state.maxHp - 300);
    expect(t.offLine.state.hp).toBe(t.offLine.state.maxHp);
  });

  it('the HIGH serpent hits the platform fighter only', () => {
    const t = lineUp();
    const { sim, events } = stubSim(t.all, HEIGHTS_ARENA);
    const sys = new SerpentSystem(1, HEIGHTS_ARENA);
    sys.trigger(0, 'high');
    runAll(sys, sim);
    expect(hits(events).map((h) => [h.fighterId, h.tier])).toEqual([[0, 'high']]);
    expect(t.platform.state.hp).toBe(t.platform.state.maxHp - 300);
    for (const f of [t.floorFar, t.floorNear, t.offLine]) expect(f.state.hp).toBe(f.state.maxHp);
  });

  it('both at once on the same line: everyone on the line is hit exactly once, by the serpent of their band; their events are tagged', () => {
    const t = lineUp();
    const { sim, events } = stubSim(t.all, HEIGHTS_ARENA);
    const sys = new SerpentSystem(1, HEIGHTS_ARENA);
    sys.trigger(0, 'low');
    sys.trigger(0, 'high');
    runAll(sys, sim);
    const h = hits(events);
    expect(h.map((x) => x.fighterId).sort()).toEqual([0, 1, 2]);
    expect(h.find((x) => x.fighterId === 0)?.tier).toBe('high');
    for (const id of [1, 2]) expect(h.find((x) => x.fighterId === id)?.tier).toBeUndefined();
    for (const f of [t.platform, t.floorFar, t.floorNear]) expect(f.state.hp).toBe(f.state.maxHp - 300);
    expect(t.offLine.state.hp).toBe(t.offLine.state.maxHp);
    // each lane ends once, with its own tag
    expect(ofType(events, 'serpentEnd').map(tierOf).sort()).toEqual(['high', 'low']);
    expect(ofType(events, 'serpentStrike').map(tierOf).sort()).toEqual(['high', 'low']);
    expect(sys.active).toBe(false);
  });

  it('the ramp splits at the split height: just above 4.5 m of ground is the high serpent\'s, just below is the low serpent\'s', () => {
    // ground = 6.5 * (z + 22) / 19 on the ramp: 4.5 m at z = -8.846
    const upper = stand(0, 'gorilla', 14, -8.5, arenaGroundHeight(HEIGHTS_ARENA, 14, -8.5));
    const lower = stand(1, 'gorilla', 14, -9.2, arenaGroundHeight(HEIGHTS_ARENA, 14, -9.2));
    expect(arenaSerpentBand(HEIGHTS_ARENA, 14, -8.5)).toBe('high');
    expect(arenaSerpentBand(HEIGHTS_ARENA, 14, -9.2)).toBe('low');
    const angle = (Math.atan2(-8.85, 14) * 180) / Math.PI; // through both, 0.7 m apart (the strip is 3.6 m wide)
    for (const tier of ['low', 'high'] as const) {
      const { sim, events } = stubSim([upper, lower], HEIGHTS_ARENA);
      const sys = new SerpentSystem(1, HEIGHTS_ARENA);
      sys.trigger(angle, tier);
      runAll(sys, sim);
      expect(hits(events).map((h) => h.fighterId), tier).toEqual([tier === 'high' ? 0 : 1]);
      upper.state.hp = upper.state.maxHp;
      lower.state.hp = lower.state.maxHp;
    }
  });

  it('the altitude rule is per band: standing on the platform = altitude 0; 2.9 m above its top is hit, 3.1 m above is not; a soaring eagle over the floor is not hit by either', () => {
    for (const [dy, want] of [[0, true], [2.9, true], [3.1, false]] as const) {
      const f = stand(0, 'eagle', 14, 0, 6.5 + dy);
      const { sim, events } = stubSim([f], HEIGHTS_ARENA);
      const sys = new SerpentSystem(1, HEIGHTS_ARENA);
      sys.trigger(0, 'high');
      runAll(sys, sim);
      expect(hits(events).length, `${dy} m above the platform`).toBe(want ? 1 : 0);
    }
    const eagle = stand(0, 'eagle', 24, 0, 5);
    const { sim, events } = stubSim([eagle], HEIGHTS_ARENA);
    const sys = new SerpentSystem(1, HEIGHTS_ARENA);
    sys.trigger(0, 'low');
    sys.trigger(0, 'high');
    runAll(sys, sim);
    expect(hits(events)).toHaveLength(0);
  });

  it('burrowed and untargetable fighters are immune to the high serpent too; dead fighters are ignored', () => {
    const mole = stand(0, 'mole', 14, 0, 6.5);
    mole.state.burrowT = 0.5;
    const ghost = stand(1, 'eagle', 14, 1.5, 6.5);
    ghost.untargetable = true;
    const dead = stand(2, 'lion', 14, -1.5, 6.5);
    dead.state.alive = false;
    dead.state.hp = 0;
    const normal = stand(3, 'lion', 16, 0, 6.5);
    const { sim, events } = stubSim([mole, ghost, dead, normal], HEIGHTS_ARENA);
    const sys = new SerpentSystem(1, HEIGHTS_ARENA);
    sys.trigger(0, 'high');
    runAll(sys, sim);
    expect(hits(events).map((h) => h.fighterId)).toEqual([3]);
  });

  it('once per event: a fighter standing on the platform is hit by the high serpent exactly once, hp -300; the swept head never double-hits', () => {
    const f = stand(0, 'gorilla', 14, 0, 6.5);
    const { sim, events } = stubSim([f], HEIGHTS_ARENA);
    const sys = new SerpentSystem(1, HEIGHTS_ARENA);
    sys.trigger(0, 'high');
    runAll(sys, sim);
    expect(hits(events)).toHaveLength(1);
    expect(hits(events)[0]).toMatchObject({ fighterId: 0, damage: 300, tier: 'high', pos: { x: 14, y: 6.5, z: 0 } });
    expect(f.state.hp).toBe(f.state.maxHp - 300);
    // a second event is a new event: it hits again
    sys.trigger(0, 'high');
    runAll(sys, sim);
    expect(hits(events)).toHaveLength(2);
    expect(f.state.hp).toBe(f.state.maxHp - 600);
  });

  it('a fighter that crosses bands DURING the strike is hurt by each lane at most once, and only while it is in that lane\'s band when the head passes', () => {
    // The fighter stands on the floor next to the platform when the low head passes it (hit), then is carried onto the platform
    // before the high head passes (hit once by the high serpent) - and a later pass of either head never hits it again.
    const f = stand(0, 'gorilla', 24, 0);
    const { sim, events } = stubSim([f], HEIGHTS_ARENA);
    const sys = new SerpentSystem(1, HEIGHTS_ARENA);
    sys.trigger(0, 'low');
    sys.trigger(0, 'high');
    let moved = false;
    for (let i = 0; i < 400 && sys.active; i++) {
      sim.time += DT;
      sys.step(sim, DT, trueDeal);
      if (!moved && hits(events).some((h) => h.fighterId === 0 && h.tier === undefined)) {
        f.state.pos.x = 14;
        f.state.pos.y = 6.5;
        moved = true;
      }
    }
    expect(moved).toBe(true);
    expect(hits(events).map((h) => [h.fighterId, h.tier ?? 'low'])).toEqual([[0, 'low'], [0, 'high']]);
    expect(f.state.hp).toBe(f.state.maxHp - 600);
  });
});

describe('World wiring (snapshot, events, kills, determinism)', () => {
  it('debugTriggerSerpent(angle, tier): the tier picks the lane; lanes are independent (a busy low lane does not block the high one)', () => {
    const { world, events } = heightsWorld(['lion', 'gorilla', 'rhino'], 3);
    parkOthers(world, []);
    expect(world.debugTriggerSerpent(200, 'low')).toBe(true);
    expect(world.debugTriggerSerpent(10, 'low')).toBe(false);
    expect(world.debugTriggerSerpent(0, 'high')).toBe(true);
    expect(world.debugTriggerSerpent(5, 'high')).toBe(false);
    expect(world.snapshot().serpent).toBeUndefined();
    expect(world.snapshot().serpentHigh).toBeUndefined(); // both queued: they start with the next tick
    world.step(DT);
    const snap = world.snapshot();
    expect(snap.serpent?.angleDeg).toBe(200);
    expect(snap.serpentHigh?.angleDeg).toBe(0);
    expect(snap.serpent?.phase).toBe('warn');
    expect(snap.serpentHigh?.phase).toBe('warn');
    const warns = ofType(events, 'serpentWarning');
    expect(warns.map((w) => [w.angleDeg, tierOf(w)])).toEqual([[200, 'low'], [0, 'high']]);
    runSerpentsToEnd(world);
    expect(world.snapshot().serpent).toBeUndefined();
    expect(world.snapshot().serpentHigh).toBeUndefined();
    expect(events.filter((e) => e.type === 'serpentEnd').map(tierOf).sort()).toEqual(['high', 'low']);
    // the default tier is low, and the debug hook draws an allowed angle of the lane's own stream when none is given
    expect(world.debugTriggerSerpent()).toBe(true);
    expect(world.debugTriggerSerpent(undefined, 'high')).toBe(true);
    world.step(DT);
    const s2 = world.snapshot();
    expect(serpentLaneBins(HEIGHTS_ARENA).low).toContain(Math.floor(s2.serpent?.angleDeg as number));
    expect(serpentLaneBins(HEIGHTS_ARENA).high).toContain(Math.floor(s2.serpentHigh?.angleDeg as number));
  });

  it('the high lane is absent from arenas without a split: no serpentHigh, debugTriggerSerpent(.., "high") is false, the snapshot JSON has no such key', () => {
    const { world } = heightsWorld(['lion', 'gorilla'], 3, { arena: FLAT_ARENA });
    expect(world.serpent?.high).toBeNull();
    expect(world.debugTriggerSerpent(90, 'high')).toBe(false);
    expect(world.debugTriggerSerpent(90)).toBe(true);
    world.step(DT);
    expect('serpentHigh' in world.snapshot()).toBe(false);
    expect('serpent' in world.snapshot()).toBe(true);
    runSerpentsToEnd(world);
    expect(world.snapshot().serpent).toBeUndefined();
  });

  it('a kill by the high serpent: killerId -1, cause "serpent", hit.tier "high", hp actually removed; nobody is credited', () => {
    const { world, events } = heightsWorld(['lion', 'gorilla', 'rhino'], 4);
    parkOthers(world, [0]);
    standAt(world, 0, 14, 0);
    world.fighters[0].state.hp = 120;
    world.fighters[0].lastAttackerId = 1;
    stepN(world, 2);
    world.debugTriggerSerpent(0, 'high');
    runSerpentsToEnd(world);
    const h = hits(events);
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ fighterId: 0, damage: 120, tier: 'high' });
    expect(ofType(events, 'death')[0]).toEqual({ type: 'death', targetId: 0, killerId: -1, placement: 10, cause: 'serpent' });
    expect(world.fighters[1].state.kills).toBe(0);
  });

  it('true damage through the World: a BLOCKING fighter on the platform loses exactly 300 to the high serpent, nothing else changes', () => {
    const run = (strike: boolean) => {
      const { world, events } = heightsWorld(['lion', 'gorilla', 'rhino'], 8);
      parkOthers(world, [0]);
      standAt(world, 0, 14, 0);
      stepN(world, 2);
      if (strike) world.debugTriggerSerpent(0, 'high');
      for (let i = 0; i < 260; i++) {
        world.setIntent(0, { ...neutralIntent(), block: true });
        world.step(DT);
      }
      return { st: world.fighters[0].state, events };
    };
    const q = run(false);
    const s = run(true);
    expect(s.st.hp).toBe(q.st.hp - 300);
    expect({ ...s.st, hp: 0 }).toEqual({ ...q.st, hp: 0 });
    expect(s.st.damageBlocked).toBe(0);
  });

  it('the match ending mid-event ends BOTH events at once (one serpentEnd per lane, the high one tagged)', () => {
    const { world, events } = heightsWorld(['lion', 'gorilla'], 3);
    standAt(world, 0, 5, 20);
    standAt(world, 1, 24, 0);
    world.fighters[1].state.hp = 100; // the low strike kills the only opponent
    world.debugTriggerSerpent(0, 'low');
    world.debugTriggerSerpent(0, 'high');
    runSerpentsToEnd(world);
    expect(world.matchOver).toBe(true);
    expect(world.snapshot().serpent).toBeUndefined();
    expect(world.snapshot().serpentHigh).toBeUndefined();
    expect(world.serpent?.active).toBe(false);
    const ends = ofType(events, 'serpentEnd');
    expect(ends.map(tierOf).sort()).toEqual(['high', 'low']);
    const names = events.map((e) => e.type).filter((t) => t === 'death' || t === 'matchEnd' || t === 'serpentEnd');
    expect(names.indexOf('death')).toBeLessThan(names.indexOf('matchEnd'));
  });

  it('is deterministic: the same seed and options give identical rolls, events and snapshots (both blocks); a different seed does not', () => {
    const roster = ['lion', 'gorilla', 'rhino', 'hippo', 'panther', 'giraffe'] as const;
    const run = (seed: number) => {
      const hw = heightsWorld([...roster], seed, { world: { serpent: { chance: 0.5, firstAtS: 1, intervalS: 4 } } });
      const snaps: string[] = [];
      for (let i = 0; i < 1800 && !hw.world.matchOver; i++) {
        hw.world.step(DT);
        const s = hw.world.snapshot();
        if (s.serpent !== undefined || s.serpentHigh !== undefined) snaps.push(JSON.stringify([s.serpent, s.serpentHigh]));
      }
      return { log: [hw.world.serpent?.low?.rollLog, hw.world.serpent?.high?.rollLog], events: hw.events, snaps };
    };
    const a = run(4242);
    const b = run(4242);
    expect(a.events.filter((e) => e.type.startsWith('serpent')).length).toBeGreaterThan(8);
    expect(a.events.some((e) => tierOf(e) === 'high' && e.type === 'serpentWarning')).toBe(true);
    expect(a.log).toEqual(b.log);
    expect(a.events).toEqual(b.events);
    expect(a.snaps).toEqual(b.snaps);
    expect(JSON.stringify(run(4243).log)).not.toBe(JSON.stringify(a.log));
  });

  it('the serpents never perturb the sim RNG, and the high lane\'s presence does not change the low lane\'s story', () => {
    const base = heightsWorld(['lion', 'gorilla', 'rhino', 'hippo'], 77);
    const forced = heightsWorld(['lion', 'gorilla', 'rhino', 'hippo'], 77, { world: { serpent: { chance: 1, firstAtS: 0.1, intervalS: 2 } } });
    for (let i = 0; i < 600; i++) {
      base.world.step(DT);
      forced.world.step(DT);
    }
    expect(forced.world.serpent?.eventsStarted).toBeGreaterThan(0);
    expect(forced.world.serpent?.high?.eventsStarted).toBeGreaterThan(0);
    expect(forced.world.rng()).toBe(base.world.rng());
    // the low lane's rolls are the same with or without the high lane
    const both = new SerpentSystem(31, HEIGHTS_ARENA);
    const lowOnly = new SerpentSystem(31, HEIGHTS_ARENA, { lanes: ['low'] });
    for (const sys of [both, lowOnly]) {
      const { sim } = stubSim([], HEIGHTS_ARENA);
      for (let k = 1; k <= 8; k++) {
        sim.time = 20 * k;
        sys.step(sim, DT, trueDeal);
        if (sys.active) sys.abort(sim);
      }
    }
    expect(both.low?.rollLog).toEqual(lowOnly.low?.rollLog);
  });

  it('a full event timeline of the high lane matches the low lane\'s (same warn / strike / hold / retreat)', () => {
    const { world } = heightsWorld(['lion', 'gorilla'], 3);
    parkOthers(world, []);
    world.debugTriggerSerpent(0, 'high');
    world.step(DT);
    let ticks = 1;
    const phases: string[] = [];
    while (world.snapshot().serpentHigh !== undefined && ticks < 400) {
      const p = world.snapshot().serpentHigh?.phase as string;
      if (phases[phases.length - 1] !== p) phases.push(p);
      world.step(DT);
      ticks++;
    }
    expect(phases).toEqual(['warn', 'strike', 'hold', 'retreat']);
    expect(Math.abs(ticks - SERPENT_EVENT_S / DT)).toBeLessThanOrEqual(2);
  });
});
