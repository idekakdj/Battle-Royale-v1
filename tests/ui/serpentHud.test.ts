/**
 * v1.9 Ocean Dome sea-serpent warning HUD (WP-O4) and its v1.10 two-lane form (WP-H5): the pure view model (marker angle math
 * relative to the camera yaw, strip + altitude + BAND detection per lane, banner lifecycle per lane, which chips show, hidden on
 * other arenas, spectators), parity of that detection with the real sim's hit rule (both lanes), the DOM layer (fake DOM), the
 * kill-feed text / rows for serpent and fall deaths and the local player's fall feedback.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../src/core/EventBus';
import { wrapAngle } from '../../src/core/math';
import type { GameEvent, SerpentState, WorldSnapshot } from '../../src/core/types';
import { ANIMALS, ANIMAL_IDS } from '../../src/config/animals';
import { ARENAS, OCEAN_STACKS, OCEAN_UPPER_HEIGHT, arenaGroundHeight, type ArenaDef } from '../../src/config/arenas';
import { SERPENT } from '../../src/config/serpent';
import { World } from '../../src/sim/World';
import { seatRoster } from '../../src/match/seating';
import {
  BANNER_FADE_MS,
  BANNER_HOLD_MS,
  SERPENT_BANNER_TEXT,
  SERPENT_BAND_MARGIN,
  SERPENT_WARN_MARGIN,
  SerpentHudModel,
  killCauseText,
  serpentBandsAt,
  serpentChipText,
  serpentDirection,
  serpentMarkerAngle,
  serpentStripDistance,
  serpentThreat,
} from '../../src/ui/serpentHudModel';
import { SERPENT_EDGE_MARGIN, SERPENT_HIGH_INSET, SerpentHud } from '../../src/ui/SerpentHud';
import { FALL_HINT_TEXT, HUD } from '../../src/ui/HUD';
import { fallGlyphSvg, serpentGlyphSvg } from '../../src/ui/buffIcons';
import { FakeDocument, FakeElement } from './fakeDom';

const OCEAN = ARENAS.ocean;
const R = OCEAN.wallRadius;
const SPLIT = OCEAN.hazards?.serpentSplitY ?? 4.5;
/** The tower at 180 degrees (x = -19, z = 0): its top is 6.5 m, the seabed beyond it (x < -23) is 0 m. */
const TOWER = OCEAN_STACKS[1];

const serp = (phase: SerpentState['phase'], angleDeg: number, t = 0): SerpentState => ({ phase, angleDeg, t, headR: R });

/** Positions: a spot on the seabed under the +x and -x strike lines, the middle of the 180-degree tower, and a ramp spot at the split. */
const SEABED = { x: 22, y: 0, z: 0 };
const SEABED_W = { x: -26, y: 0, z: 0.2 };
const TOWER_TOP = { x: TOWER.x, y: OCEAN_UPPER_HEIGHT, z: TOWER.z + 0.3 };
const radius = ANIMALS.lion.radius;

/** A spot on the 180-degree causeway whose ground height is within a few cm of the split height (both lanes count there). */
function contourSpot(): { x: number; y: number; z: number } {
  let best = { x: -10, y: 0, z: 0 };
  let bestD = Infinity;
  for (let x = -6; x >= -19; x -= 0.01) {
    const g = arenaGroundHeight(OCEAN, x, 0);
    const d = Math.abs(g - SPLIT);
    if (d < bestD) {
      bestD = d;
      best = { x, y: g, z: 0 };
    }
  }
  return best;
}

describe('serpentMarkerAngle (screen angle, clockwise from up, relative to the camera yaw)', () => {
  it('uses the same convention as the threat arrows: -wrap(atan2(dx, dz) - camYaw)', () => {
    for (const [angleDeg, camYaw, px, pz] of [
      [0, 0, 0, 0],
      [90, 1.2, 4, -3],
      [250.7, -2.4, -9, 11],
      [333, 3.0, 20, 5],
    ] as const) {
      const d = serpentDirection(angleDeg);
      const expected = -wrapAngle(Math.atan2(d.x * R - px, d.z * R - pz) - camYaw);
      expect(serpentMarkerAngle(angleDeg, camYaw, px, pz, R)).toBeCloseTo(expected, 10);
    }
  });

  it('straight ahead = 0, to the right = +π/2, behind = ±π, left = −π/2 (player at the centre)', () => {
    // the strike from the +x edge (0°): world yaw of that direction is atan2(1, 0) = π/2
    expect(serpentMarkerAngle(0, Math.PI / 2, 0, 0, R)).toBeCloseTo(0, 10);
    // camera yaw decreases when turning right: a camera 90° to the LEFT of that edge sees it on the right
    expect(serpentMarkerAngle(0, Math.PI / 2 + Math.PI / 2, 0, 0, R)).toBeCloseTo(Math.PI / 2, 10);
    expect(serpentMarkerAngle(0, Math.PI / 2 - Math.PI / 2, 0, 0, R)).toBeCloseTo(-Math.PI / 2, 10);
    expect(Math.abs(serpentMarkerAngle(0, Math.PI / 2 + Math.PI, 0, 0, R))).toBeCloseTo(Math.PI, 10);
  });

  it('turning the camera right (yaw decreases) swings the marker left by exactly the turn; the result stays in (−π, π]', () => {
    const base = serpentMarkerAngle(40, 0.5, 3, 4, R);
    const turned = serpentMarkerAngle(40, 0.5 - 0.3, 3, 4, R); // yaw decreases = turn right
    expect(wrapAngle(turned - base)).toBeCloseTo(-0.3, 10);
    for (let yaw = -7; yaw <= 7; yaw += 0.37) {
      const a = serpentMarkerAngle(123, yaw, -5, 8, R);
      expect(a).toBeGreaterThan(-Math.PI - 1e-9);
      expect(a).toBeLessThanOrEqual(Math.PI + 1e-9);
    }
  });

  it('points at the EDGE POINT seen from the player (not just along the strike direction)', () => {
    const fromCentre = serpentMarkerAngle(0, 0, 0, 0, R);
    const fromSouth = serpentMarkerAngle(0, 0, 0, 20, R);
    expect(fromCentre).not.toBeCloseTo(fromSouth, 2);
    const d = serpentDirection(0);
    expect(fromSouth).toBeCloseTo(-wrapAngle(Math.atan2(d.x * R - 0, d.z * R - 20)), 10);
  });

  it('a player standing on the edge point falls back to the strike direction (no NaN)', () => {
    const d = serpentDirection(75);
    const a = serpentMarkerAngle(75, 0.3, d.x * R, d.z * R, R);
    expect(Number.isFinite(a)).toBe(true);
    expect(a).toBeCloseTo(-wrapAngle(Math.atan2(d.x, d.z) - 0.3), 10);
  });
});

describe('strip distance + in-strip detection', () => {
  it('distance is to the segment centre -> edge (clamped at both ends)', () => {
    expect(serpentStripDistance(0, 10, 3, R)).toBeCloseTo(3, 10); // beside the line
    expect(serpentStripDistance(0, 10, 0, R)).toBe(0); // on it
    expect(serpentStripDistance(0, 35, 0, R)).toBeCloseTo(5, 10); // beyond the wall end: to the endpoint
    expect(serpentStripDistance(0, -5, 0, R)).toBeCloseTo(5, 10); // behind the centre: to the centre point (the head stops there)
    expect(serpentStripDistance(90, 4, 12, R)).toBeCloseTo(4, 10); // the 90° strike runs along +z
  });

  it('serpentThreat: inside when within stripHalfWidth + radius + margin, with the boundary inclusive', () => {
    const r = ANIMALS.lion.radius;
    const reach = SERPENT.stripHalfWidth + r + SERPENT_WARN_MARGIN;
    const at = (z: number) => serpentThreat(OCEAN, 0, { x: 22, y: 0, z }, r);
    expect(at(0).inStrip).toBe(true);
    expect(at(reach - 0.01).inStrip).toBe(true);
    expect(at(reach + 0.05).inStrip).toBe(false);
    expect(at(0).reach).toBeCloseTo(reach, 10);
    expect(at(-(reach - 0.01)).inStrip).toBe(true); // symmetric
  });

  it('altitude immunity is measured above the LOCAL ground (the plateau is 3 m up)', () => {
    const r = ANIMALS.eagle.radius;
    const plateau = arenaGroundHeight(OCEAN, 0, 0);
    expect(plateau).toBeGreaterThan(2.9);
    // on the seabed: 5 m up is above the 3 m reach -> immune; 2.5 m up is not
    expect(serpentThreat(OCEAN, 0, { x: 22, y: 5, z: 0 }, r)).toMatchObject({ immune: true, inStrip: false });
    expect(serpentThreat(OCEAN, 0, { x: 22, y: 2.5, z: 0 }, r)).toMatchObject({ immune: false, inStrip: true });
    // standing on the plateau (y = 3) is NOT altitude: still in the strip
    expect(serpentThreat(OCEAN, 90, { x: 0, y: plateau, z: 0 }, r)).toMatchObject({ immune: false, inStrip: true });
    // 5.5 m above the sea bed would be immune, but only 2.5 m above the plateau it is not
    expect(serpentThreat(OCEAN, 90, { x: 0, y: plateau + 2.5, z: 0 }, r).immune).toBe(false);
    expect(serpentThreat(OCEAN, 90, { x: 0, y: plateau + SERPENT.hazardHeight + 0.01, z: 0 }, r).immune).toBe(true);
    // exactly hazardHeight above the ground is still hit (the sim's rule is "<=")
    expect(serpentThreat(OCEAN, 90, { x: 0, y: plateau + SERPENT.hazardHeight, z: 0 }, r).immune).toBe(false);
    // on a tower top (6.5 m) standing is not altitude either
    expect(serpentThreat(OCEAN, 180, TOWER_TOP, radius)).toMatchObject({ immune: false, inStrip: true });
  });

  it('agrees with the real sim (LOW serpent): fighters the HUD calls in-strip (margin 0) are the ones the strike hits', () => {
    const bus = new EventBus();
    const roster = seatRoster('lion', 31, OCEAN);
    const world = new World({ roster, difficulty: 1, arena: 'ocean' }, 31, bus, { traps: false, serpent: { chance: 0 } });
    const hits = new Set<number>();
    bus.on('serpentHit', (e) => {
      if (e.tier === undefined) hits.add(e.fighterId);
    });
    // strike along +x (θ = 0): five fighters on the flat seabed (r 20..28), alternating sides, 0.4 m inside / outside the capsule
    const expected = new Map<number, boolean>();
    for (let id = 1; id <= 5; id++) {
      const rad = ANIMALS[roster[id].animal].radius;
      const inside = id % 2 === 1;
      const z = (inside ? 1 : -1) * (SERPENT.headRadius + rad + (inside ? -0.4 : 0.4));
      const st = world.fighters[id].state;
      st.pos.x = 19 + id * 1.8;
      st.pos.z = z;
      st.pos.y = arenaGroundHeight(OCEAN, st.pos.x, st.pos.z);
      expected.set(id, inside);
      const th = serpentThreat(OCEAN, 0, st.pos, rad);
      // the HUD's margin only ever adds warnings: strictly-inside fighters are in-strip, strictly-outside ones are not (0.4 > 0.3)
      expect(th.inStrip).toBe(inside);
      expect(serpentBandsAt(OCEAN, st.pos.x, st.pos.z).low).toBe(true);
    }
    expect(world.debugTriggerSerpent(0)).toBe(true);
    for (let i = 0; i < 400 && world.serpent?.active !== false; i++) world.step(1 / 60);
    for (let i = 0; i < 400 && world.serpent?.active === true; i++) world.step(1 / 60);
    for (const [id, inside] of expected) expect(hits.has(id), `fighter ${id} (${roster[id].animal})`).toBe(inside);
  });

  it('agrees with the real sim (HIGH serpent): on the tower top in the strip = hit; the seabed under the same line is not', () => {
    const bus = new EventBus();
    const roster = seatRoster('lion', 32, OCEAN);
    const world = new World({ roster, difficulty: 1, arena: 'ocean' }, 32, bus, { traps: false, serpent: { chance: 0 } });
    const hits = new Set<number>();
    bus.on('serpentHit', (e) => {
      if (e.tier === 'high') hits.add(e.fighterId);
    });
    // fighters 1, 2 on the tower top (inside / outside the capsule), 3 and 4 on the seabed beyond it, both inside the capsule
    const spots = [
      { id: 1, x: TOWER.x, z: TOWER.z + 0.2, inside: true, high: true },
      { id: 2, x: TOWER.x + 0.5, z: TOWER.z + (SERPENT.headRadius + ANIMALS[roster[2].animal].radius + 0.4), inside: false, high: true },
      { id: 3, x: -25.5, z: 0.2, inside: true, high: false },
      { id: 4, x: -27.5, z: -0.3, inside: true, high: false },
    ];
    for (const s of spots) {
      const st = world.fighters[s.id].state;
      st.pos.x = s.x;
      st.pos.z = s.z;
      st.pos.y = arenaGroundHeight(OCEAN, s.x, s.z);
      const rad = ANIMALS[roster[s.id].animal].radius;
      expect(serpentThreat(OCEAN, 180, st.pos, rad).inStrip).toBe(s.inside);
      const bands = serpentBandsAt(OCEAN, s.x, s.z);
      expect(bands.high).toBe(s.high);
      expect(bands.low).toBe(!s.high);
    }
    expect(world.debugTriggerSerpent(180, 'high')).toBe(true);
    for (let i = 0; i < 400 && world.serpent?.high?.active !== true; i++) world.step(1 / 60);
    for (let i = 0; i < 600 && world.serpent?.high?.active === true; i++) world.step(1 / 60);
    expect([...hits].sort()).toEqual([1]);
  });

  it('every animal id has a body radius the model can use', () => {
    for (const id of ANIMAL_IDS) expect(ANIMALS[id].radius).toBeGreaterThan(0.3);
  });
});

describe('serpentBandsAt (the sim\'s band by GROUND height, widened at the split)', () => {
  it('seabed, terrace and plateau are low only; a tower top is high only', () => {
    expect(serpentBandsAt(OCEAN, 22, 0)).toEqual({ low: true, high: false });
    expect(serpentBandsAt(OCEAN, 14, 0)).toEqual({ low: true, high: false }); // terrace
    expect(serpentBandsAt(OCEAN, 0, 0)).toEqual({ low: true, high: false }); // plateau (3 m)
    expect(serpentBandsAt(OCEAN, TOWER.x, TOWER.z)).toEqual({ low: false, high: true });
  });

  it('right at the split height both lanes count; the margin is small', () => {
    const c = contourSpot();
    expect(Math.abs(c.y - SPLIT)).toBeLessThan(0.05);
    expect(serpentBandsAt(OCEAN, c.x, c.z)).toEqual({ low: true, high: true });
    expect(SERPENT_BAND_MARGIN).toBeGreaterThan(0.2);
    expect(SERPENT_BAND_MARGIN).toBeLessThan(0.6);
  });

  it('an arena without a split is the single v1.9 serpent: low everywhere', () => {
    const flat: ArenaDef = { ...OCEAN, hazards: { serpent: true } };
    expect(serpentBandsAt(flat, TOWER.x, TOWER.z)).toEqual({ low: true, high: false });
    expect(serpentBandsAt(ARENAS.colosseum, 3, 4)).toEqual({ low: true, high: false });
  });
});

describe('SerpentHudModel', () => {
  const player = { ...SEABED, radius };
  const frame = (m: SerpentHudModel, blocks: { serpent?: SerpentState; serpentHigh?: SerpentState }, p: { x: number; y: number; z: number } | null, camYaw = 0, nowMs = 100) =>
    m.frame(nowMs, blocks, { camYaw, player: p === null ? null : { ...p, radius } });

  it('banner lifecycle per lane: off -> hold (~1 s) -> fade (0.5 s) -> off; a new warning restarts it; serpentEnd clears only its lane', () => {
    const m = new SerpentHudModel(OCEAN);
    expect(m.bannerAt(0)).toBe('off');
    m.onWarning(1000);
    expect(m.bannerAt(999)).toBe('off'); // a clock that ran backwards never shows a stale banner
    expect(m.bannerAt(1000)).toBe('hold');
    expect(m.bannerAt(1000 + BANNER_HOLD_MS - 1)).toBe('hold');
    expect(m.bannerAt(1000 + BANNER_HOLD_MS)).toBe('fade');
    expect(m.bannerAt(1000 + BANNER_HOLD_MS + BANNER_FADE_MS - 1)).toBe('fade');
    expect(m.bannerAt(1000 + BANNER_HOLD_MS + BANNER_FADE_MS)).toBe('off');
    m.onWarning(9000);
    expect(m.bannerAt(9500)).toBe('hold');
    m.onEnd('low');
    expect(m.bannerAt(9500)).toBe('off');
    expect(BANNER_HOLD_MS).toBeGreaterThanOrEqual(900);
    expect(BANNER_HOLD_MS).toBeLessThanOrEqual(1100);
    // the lanes are independent
    m.onWarning(20000, 'low');
    m.onWarning(20300, 'high');
    expect(m.bannerAt(20400, 'low')).toBe('hold');
    expect(m.bannerAt(20400, 'high')).toBe('hold');
    expect(m.bannerAt(21100, 'low')).toBe('fade');
    expect(m.bannerAt(21100, 'high')).toBe('hold');
    m.onEnd('high');
    expect(m.bannerAt(20400, 'high')).toBe('off');
    expect(m.bannerAt(20400, 'low')).toBe('hold');
    m.onWarning(30000, 'high');
    m.onEnd(); // no tier: the match ended mid-event, everything goes
    expect(m.bannerAt(30100, 'low')).toBe('off');
    expect(m.bannerAt(30100, 'high')).toBe('off');
  });

  it('banner copy names the lane', () => {
    expect(SERPENT_BANNER_TEXT.low).toBe('SEA SERPENT! — LOW GROUND');
    expect(SERPENT_BANNER_TEXT.high).toBe('SEA SERPENT! — HIGH GROUND');
  });

  it('is inert on arenas without the serpent hazard, whatever events or snapshots arrive', () => {
    for (const id of ['colosseum', 'jungle'] as const) {
      const m = new SerpentHudModel(ARENAS[id]);
      expect(m.enabled).toBe(false);
      m.onWarning(0);
      m.onWarning(0, 'high');
      expect(m.bannerAt(10)).toBe('off');
      expect(m.bannerAt(10, 'high')).toBe('off');
      const v = frame(m, { serpent: serp('warn', 10), serpentHigh: serp('warn', 20) }, player, 0, 10);
      expect(v.low).toMatchObject({ banner: 'off', marker: false, status: 'off', chip: false });
      expect(v.high).toMatchObject({ banner: 'off', marker: false, status: 'off', chip: false });
    }
    expect(new SerpentHudModel(OCEAN).enabled).toBe(true);
  });

  it('an arena with the serpent but no split has no high lane: its banner and block are ignored', () => {
    const flat: ArenaDef = { ...OCEAN, hazards: { serpent: true } };
    const m = new SerpentHudModel(flat);
    m.onWarning(0, 'high');
    expect(m.bannerAt(10, 'high')).toBe('off');
    const v = frame(m, { serpentHigh: serp('warn', 180) }, TOWER_TOP, 0, 10);
    expect(v.high).toMatchObject({ active: false, marker: false, chip: false });
  });

  it('LOW lane, warn phase: MOVE! inside the strip, SAFE outside; strike / hold / retreat keep a timer-less marker', () => {
    const m = new SerpentHudModel(OCEAN);
    m.onWarning(0);
    const inside = frame(m, { serpent: serp('warn', 0) }, { ...SEABED, z: 0.5 }).low;
    expect(inside).toMatchObject({ banner: 'hold', marker: true, status: 'move', phase: 'warn', lineFrac: 1, onBand: true, chip: true });
    const outside = frame(m, { serpent: serp('warn', 0) }, { ...SEABED, z: 12 }).low;
    expect(outside).toMatchObject({ marker: true, status: 'safe', chip: true });
    expect(outside.lineFrac).toBe(0); // 12 m off: beyond reach + the fade distance
    const strike = frame(m, { serpent: serp('strike', 0) }, SEABED).low;
    expect(strike).toMatchObject({ status: 'strike', chip: false });
    expect(frame(m, { serpent: serp('hold', 0) }, SEABED).low.status).toBe('after');
    expect(frame(m, { serpent: serp('retreat', 0) }, SEABED).low.status).toBe('after');
    expect(frame(m, { serpent: serp('hold', 0) }, SEABED).low.marker).toBe(true);
    expect(frame(m, { serpent: serp('warn', 0) }, SEABED).high).toMatchObject({ active: false, marker: false, chip: false });
  });

  it('LOW lane: lineFrac grows as the player nears the strip (0 far .. 1 inside); an immune (high-flying) player is shown safe', () => {
    const m = new SerpentHudModel(OCEAN);
    const f = (z: number): number => frame(m, { serpent: serp('warn', 0) }, { ...SEABED, z }).low.lineFrac;
    const reach = SERPENT.stripHalfWidth + player.radius + SERPENT_WARN_MARGIN;
    expect(f(0)).toBe(1);
    expect(f(reach)).toBe(1);
    expect(f(reach + 2)).toBeGreaterThan(0);
    expect(f(reach + 2)).toBeLessThan(1);
    expect(f(reach + 4)).toBeLessThan(f(reach + 2));
    expect(f(reach + 20)).toBe(0);
    const eagle = m.frame(0, { serpent: serp('warn', 0) }, { camYaw: 0, player: { x: 22, y: 6, z: 0, radius: ANIMALS.eagle.radius } });
    expect(eagle.low).toMatchObject({ status: 'safe', lineFrac: 0, marker: true });
  });

  it('HIGH lane: a player on a tower top inside the strip says MOVE!; one on the seabed in the same geometric strip is SAFE (wrong band)', () => {
    const m = new SerpentHudModel(OCEAN);
    const up = frame(m, { serpentHigh: serp('warn', 180) }, TOWER_TOP).high;
    expect(up).toMatchObject({ active: true, marker: true, status: 'move', onBand: true, lineFrac: 1, chip: true });
    const down = frame(m, { serpentHigh: serp('warn', 180) }, SEABED_W).high;
    expect(down).toMatchObject({ marker: true, status: 'safe', onBand: false, lineFrac: 0, chip: true }); // the lone lane still reads SAFE
    // on the plateau a high strike (any angle) is SAFE too
    const plateau = frame(m, { serpentHigh: serp('warn', 180) }, { x: -4, y: 3, z: 0 }).high;
    expect(plateau).toMatchObject({ status: 'safe', onBand: false });
    // a strike that ends: the small marker stays, calm
    expect(frame(m, { serpentHigh: serp('strike', 180) }, SEABED_W).high.status).toBe('after');
    expect(frame(m, { serpentHigh: serp('strike', 180) }, TOWER_TOP).high.status).toBe('strike');
  });

  it('a LOW strike while standing on a tower top is SAFE', () => {
    const m = new SerpentHudModel(OCEAN);
    const v = frame(m, { serpent: serp('warn', 180) }, TOWER_TOP).low;
    expect(v).toMatchObject({ status: 'safe', onBand: false, lineFrac: 0, chip: true });
  });

  it('both lanes running: only the lane of the player\'s band gets a chip (low on the seabed, high on a tower)', () => {
    const m = new SerpentHudModel(OCEAN);
    const both = { serpent: serp('warn', 0), serpentHigh: serp('warn', 180) };
    const onSea = frame(m, both, { ...SEABED, z: 0.4 });
    expect(onSea.low).toMatchObject({ chip: true, status: 'move', onBand: true });
    expect(onSea.high).toMatchObject({ chip: false, status: 'safe', onBand: false, marker: true });
    expect(onSea.labelChips).toBe(false);
    expect(serpentChipText(onSea.low, onSea.labelChips)).toBe('MOVE!');
    expect(serpentChipText(onSea.high, onSea.labelChips)).toBe('');
    const onTower = frame(m, both, TOWER_TOP);
    expect(onTower.high).toMatchObject({ chip: true, status: 'move', onBand: true });
    expect(onTower.low).toMatchObject({ chip: false, status: 'safe', onBand: false });
    expect(onTower.labelChips).toBe(false);
  });

  it('on the contour (a ramp at the split height) both lanes are relevant: both chips show, labelled by lane', () => {
    const m = new SerpentHudModel(OCEAN);
    const c = contourSpot();
    const v = frame(m, { serpent: serp('warn', 180), serpentHigh: serp('warn', 180) }, c);
    expect(v.low).toMatchObject({ chip: true, onBand: true, status: 'move' });
    expect(v.high).toMatchObject({ chip: true, onBand: true, status: 'move' });
    expect(v.labelChips).toBe(true);
    expect(serpentChipText(v.low, v.labelChips)).toBe('LOW · MOVE!');
    expect(serpentChipText(v.high, v.labelChips)).toBe('HIGH · MOVE!');
    // safe in both when the strikes are elsewhere
    const away = frame(m, { serpent: serp('warn', 0), serpentHigh: serp('warn', 90) }, c);
    expect(serpentChipText(away.low, true)).toBe('LOW · SAFE');
    expect(serpentChipText(away.high, true)).toBe('HIGH · SAFE');
  });

  it('chips only show during the warning', () => {
    const m = new SerpentHudModel(OCEAN);
    for (const phase of ['strike', 'hold', 'retreat'] as const) {
      const v = frame(m, { serpent: serp(phase, 0), serpentHigh: serp(phase, 180) }, SEABED);
      expect(v.low.chip).toBe(false);
      expect(v.high.chip).toBe(false);
      expect(serpentChipText(v.low, false)).toBe('');
    }
  });

  it('the marker angle follows the camera yaw frame by frame (each lane)', () => {
    const m = new SerpentHudModel(OCEAN);
    const blocks = { serpent: serp('warn', 200), serpentHigh: serp('warn', 20) };
    const a0 = frame(m, blocks, player, 0);
    const a1 = frame(m, blocks, player, -0.4);
    expect(wrapAngle(a1.low.markerAngle - a0.low.markerAngle)).toBeCloseTo(-0.4, 10); // yaw decreased by 0.4 (turned right): the marker moved 0.4 rad left
    expect(wrapAngle(a1.high.markerAngle - a0.high.markerAngle)).toBeCloseTo(-0.4, 10);
    expect(a0.low.markerAngle).toBeCloseTo(serpentMarkerAngle(200, 0, player.x, player.z, R), 10);
    expect(a0.high.markerAngle).toBeCloseTo(serpentMarkerAngle(20, 0, player.x, player.z, R), 10);
  });

  it('spectators (no local player) see the banners only: no marker, no status, no chip', () => {
    const m = new SerpentHudModel(OCEAN);
    m.onWarning(0);
    m.onWarning(0, 'high');
    const v = frame(m, { serpent: serp('warn', 10), serpentHigh: serp('warn', 190) }, null, 0, 200);
    expect(v.low).toMatchObject({ banner: 'hold', marker: false, status: 'off', chip: false, active: true });
    expect(v.high).toMatchObject({ banner: 'hold', marker: false, status: 'off', chip: false, active: true });
    const later = frame(m, { serpent: serp('warn', 10), serpentHigh: serp('warn', 190) }, null, 0, 2000);
    expect(later.low.banner).toBe('off');
    expect(later.high.banner).toBe('off');
  });

  it('no snapshot block (event over / not started yet): no marker; a banner that is still fading may remain', () => {
    const m = new SerpentHudModel(OCEAN);
    expect(frame(m, {}, player, 0, 0).low).toMatchObject({ banner: 'off', marker: false, status: 'off' });
    m.onWarning(0, 'high');
    const v = frame(m, {}, player, 0, 100);
    expect(v.high).toMatchObject({ banner: 'hold', marker: false });
    expect(v.low.banner).toBe('off');
  });
});

// ── DOM layer ────────────────────────────────────────────────────────────────────────────────────────────────

function snapshot(opts: {
  alive?: boolean;
  x?: number;
  y?: number;
  z?: number;
  serpent?: SerpentState;
  serpentHigh?: SerpentState;
}): WorldSnapshot {
  const f = {
    id: 0,
    animal: 'lion',
    alive: opts.alive ?? true,
    pos: { x: opts.x ?? 22, y: opts.y ?? 0, z: opts.z ?? 0 },
  };
  return {
    time: 5,
    fighters: [f],
    ...(opts.serpent !== undefined ? { serpent: opts.serpent } : {}),
    ...(opts.serpentHigh !== undefined ? { serpentHigh: opts.serpentHigh } : {}),
  } as unknown as WorldSnapshot;
}

type Tier = 'low' | 'high';

describe('SerpentHud (DOM)', () => {
  let doc: FakeDocument;
  let layer: FakeElement;
  let hud: SerpentHud;
  const has = (cls: string) => (e: FakeElement): boolean => e.classList.contains(cls);
  const q = (cls: string): FakeElement => layer.find(has(cls))[0];
  const rim = (t: Tier): FakeElement => layer.find((e) => e.classList.contains('gk-serpent__lane') && e.dataset.tier === t)[0];
  const card = (t: Tier): FakeElement => layer.find((e) => e.classList.contains('gk-serpent__card') && e.dataset.tier === t)[0];
  const banner = (t: Tier): FakeElement => card(t).find(has('gk-serpent__banner'))[0];
  const chip = (t: Tier): FakeElement => card(t).find(has('gk-serpent__chip'))[0];
  const marker = (t: Tier): FakeElement => rim(t).find(has('gk-serpent__marker'))[0];
  const line = (t: Tier): FakeElement => rim(t).find(has('gk-serpent__line'))[0];
  const tf = (e: FakeElement): string => (e.style as unknown as { transform: string }).transform;

  beforeEach(() => {
    doc = new FakeDocument();
    vi.stubGlobal('document', doc);
    layer = doc.createElement('div');
    hud = new SerpentHud(OCEAN);
    hud.mount(layer as unknown as HTMLElement);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('mounts one banner + chip card and one rim marker + line per lane into the HUD layer and removes them on unmount', () => {
    expect(layer.find(has('gk-serpent'))).toHaveLength(1);
    expect(layer.find(has('gk-serpent__banner'))).toHaveLength(2);
    expect(layer.find(has('gk-serpent__marker'))).toHaveLength(2);
    expect(banner('low').textContent).toBe('SEA SERPENT! — LOW GROUND');
    expect(banner('high').textContent).toBe('SEA SERPENT! — HIGH GROUND');
    expect(banner('low').attributes.get('role')).toBe('alert');
    hud.unmount();
    expect(layer.children).toHaveLength(0);
  });

  it('LOW warning event -> banner holds, chip says MOVE! in the strip / SAFE outside, marker + line show; fade, then end clears it', () => {
    hud.onWarning(0);
    hud.update(snapshot({ z: 0.2, serpent: serp('warn', 0) }), 0, 1280, 720, 100, false);
    expect(banner('low').classList.contains('is-hold')).toBe(true);
    expect(banner('high').classList.contains('is-hold')).toBe(false);
    expect(chip('low').textContent).toBe('MOVE!');
    expect(chip('low').classList.contains('is-on')).toBe(true);
    expect(card('low').classList.contains('is-on')).toBe(true);
    expect(card('high').classList.contains('is-on')).toBe(false); // no room taken by a lane that is not running
    expect(rim('low').dataset.status).toBe('move');
    expect(marker('low').classList.contains('is-on')).toBe(true);
    expect(marker('high').classList.contains('is-on')).toBe(false);
    expect(tf(marker('low'))).toMatch(/^translate3d\(-?[\d.]+px,-?[\d.]+px,0\) rotate\(-?[\d.]+rad\)$/);
    expect(tf(line('low'))).toContain('scaleY(');

    hud.update(snapshot({ z: 12, serpent: serp('warn', 0, 0.3) }), 0, 1280, 720, 400, false);
    expect(chip('low').textContent).toBe('SAFE');
    expect(card('low').dataset.status).toBe('safe');

    hud.update(snapshot({ z: 12, serpent: serp('warn', 0, 0.9) }), 0, 1280, 720, 1200, false);
    expect(banner('low').classList.contains('is-hold')).toBe(false);
    expect(banner('low').classList.contains('is-fade')).toBe(true);

    hud.update(snapshot({ z: 12, serpent: serp('strike', 0, 0.1) }), 0, 1280, 720, 2000, false);
    expect(banner('low').classList.contains('is-fade')).toBe(false);
    expect(chip('low').classList.contains('is-on')).toBe(false);
    expect(card('low').classList.contains('is-on')).toBe(false);
    expect(marker('low').classList.contains('is-on')).toBe(true); // the small timer-less marker stays

    hud.onEnd('low');
    hud.update(snapshot({}), 0, 1280, 720, 2100, false);
    expect(marker('low').classList.contains('is-on')).toBe(false);
    expect(rim('low').dataset.status).toBe('off');
  });

  it('both lanes at once: two stacked banners, one rim marker each, the chip only under the lane of the player\'s band', () => {
    hud.onWarning(0, 'low');
    hud.onWarning(50, 'high');
    // the player on the seabed, in the low strip
    hud.update(snapshot({ z: 0.2, serpent: serp('warn', 0), serpentHigh: serp('warn', 180) }), 0, 1280, 720, 100, false);
    expect(banner('low').classList.contains('is-hold')).toBe(true);
    expect(banner('high').classList.contains('is-hold')).toBe(true);
    expect(card('low').classList.contains('is-on')).toBe(true);
    expect(card('high').classList.contains('is-on')).toBe(true);
    expect(chip('low').textContent).toBe('MOVE!');
    expect(chip('high').textContent).toBe('');
    expect(marker('low').classList.contains('is-on')).toBe(true);
    expect(marker('high').classList.contains('is-on')).toBe(true);
    expect(rim('high').classList.contains('is-off-band')).toBe(true); // dimmed: cannot hurt the seabed
    expect(rim('low').classList.contains('is-off-band')).toBe(false);
    // the same moment for a player on the 180-degree tower top
    hud.update(snapshot({ x: TOWER_TOP.x, y: TOWER_TOP.y, z: TOWER_TOP.z, serpent: serp('warn', 0), serpentHigh: serp('warn', 180) }), 0, 1280, 720, 120, false);
    expect(chip('high').textContent).toBe('MOVE!');
    expect(chip('low').textContent).toBe('');
    expect(rim('low').classList.contains('is-off-band')).toBe(true);
    expect(rim('high').classList.contains('is-off-band')).toBe(false);
    expect(rim('high').dataset.status).toBe('move');
    // the high end event only drops the high lane
    hud.onEnd('high');
    hud.update(snapshot({ x: TOWER_TOP.x, y: TOWER_TOP.y, z: TOWER_TOP.z, serpent: serp('warn', 0) }), 0, 1280, 720, 140, false);
    expect(banner('high').classList.contains('is-hold')).toBe(false);
    expect(marker('high').classList.contains('is-on')).toBe(false);
    expect(banner('low').classList.contains('is-hold')).toBe(true);
    expect(marker('low').classList.contains('is-on')).toBe(true);
  });

  it('on the contour both chips show with a lane label', () => {
    hud.onWarning(0, 'low');
    hud.onWarning(0, 'high');
    const c = contourSpot();
    hud.update(snapshot({ x: c.x, y: c.y, z: c.z, serpent: serp('warn', 180), serpentHigh: serp('warn', 180) }), 0, 1280, 720, 100, false);
    expect(chip('low').textContent).toBe('LOW · MOVE!');
    expect(chip('high').textContent).toBe('HIGH · MOVE!');
  });

  it('the high lane\'s chevron sits further in from the rim than the low one when both point the same way', () => {
    hud.onWarning(0, 'low');
    hud.onWarning(0, 'high');
    hud.update(snapshot({ serpent: serp('warn', 0), serpentHigh: serp('warn', 0) }), 0, 1280, 720, 100, false);
    const xy = (e: FakeElement): [number, number] => {
      const m = /translate3d\((-?[\d.]+)px,(-?[\d.]+)px/.exec(tf(e));
      return [Number(m?.[1]), Number(m?.[2])];
    };
    const [lx, ly] = xy(marker('low'));
    const [hx, hy] = xy(marker('high'));
    // identical angles, so the two chevrons lie on one ray from the screen centre; the high one is SERPENT_HIGH_INSET px nearer to it
    const dl = Math.hypot(lx - 640, ly - 360);
    const dh = Math.hypot(hx - 640, hy - 360);
    expect(dl).toBeGreaterThan(dh);
    expect(SERPENT_HIGH_INSET).toBeGreaterThan(30);
    expect(SERPENT_EDGE_MARGIN).toBeGreaterThan(60);
  });

  it('a dead local player (spectating) sees the banners only', () => {
    hud.onWarning(0, 'low');
    hud.onWarning(0, 'high');
    hud.update(snapshot({ alive: false, serpent: serp('warn', 0), serpentHigh: serp('warn', 180) }), 0, 1280, 720, 100, true);
    for (const t of ['low', 'high'] as const) {
      expect(banner(t).classList.contains('is-hold')).toBe(true);
      expect(marker(t).classList.contains('is-on')).toBe(false);
      expect(chip(t).classList.contains('is-on')).toBe(false);
    }
  });

  it('the markers ride the screen rim: inside the viewport, at least the edge margin from each side, on every angle (both lanes)', () => {
    for (let a = 0; a < 360; a += 17) {
      hud.onWarning(0, 'low');
      hud.onWarning(0, 'high');
      hud.update(snapshot({ serpent: serp('warn', a), serpentHigh: serp('warn', (a + 120) % 360) }), a * 0.01, 1280, 720, 100, false);
      for (const t of ['low', 'high'] as const) {
        const m = /translate3d\((-?[\d.]+)px,(-?[\d.]+)px/.exec(tf(marker(t)));
        expect(m).not.toBeNull();
        const x = Number(m?.[1]);
        const y = Number(m?.[2]);
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(1280);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(720);
      }
    }
  });

  it('never creates anything on a serpent-free arena (the controller does not mount it, and the model stays off)', () => {
    const colosseum = new SerpentHud(ARENAS.colosseum);
    const l2 = doc.createElement('div');
    colosseum.mount(l2 as unknown as HTMLElement);
    colosseum.onWarning(0);
    colosseum.update(snapshot({ serpent: serp('warn', 0), serpentHigh: serp('warn', 180) }), 0, 1280, 720, 100, false);
    expect(l2.find(has('gk-serpent__banner')).every((b) => !b.classList.contains('is-hold'))).toBe(true);
    expect(l2.find(has('is-on'))).toHaveLength(0);
  });

  it('no match is left with a stale card: a full onEnd() (match end mid-event) clears both lanes at once', () => {
    hud.onWarning(0, 'low');
    hud.onWarning(0, 'high');
    hud.update(snapshot({ serpent: serp('warn', 0), serpentHigh: serp('warn', 180) }), 0, 1280, 720, 100, false);
    expect(q('gk-serpent__card')).toBeDefined();
    hud.onEnd();
    for (const t of ['low', 'high'] as const) {
      expect(banner(t).classList.contains('is-hold')).toBe(false);
      expect(card(t).classList.contains('is-on')).toBe(false);
      expect(marker(t).classList.contains('is-on')).toBe(false);
    }
  });
});

// ── kill feed + fall feedback ─────────────────────────────────────────────────────────────────────────────────

describe('kill feed: serpent and fall deaths', () => {
  it('killCauseText: serpent kills read "was eaten by the Sea Serpent", falls "fell from the heights"; traps and fighters have none', () => {
    expect(killCauseText('serpent')).toBe('was eaten by the Sea Serpent');
    expect(killCauseText('fall')).toBe('fell from the heights');
    expect(killCauseText('trap')).toBeNull();
    expect(killCauseText(undefined)).toBeNull();
  });

  it('the serpent and fall glyphs are real inline SVGs, distinct from each other', () => {
    const g = serpentGlyphSvg();
    expect(g.startsWith('<svg')).toBe(true);
    expect(g).toContain('aria-hidden="true"');
    expect(g.length).toBeGreaterThan(200);
    const f = fallGlyphSvg();
    expect(f.startsWith('<svg')).toBe(true);
    expect(f).toContain('aria-hidden="true"');
    expect(f.length).toBeGreaterThan(150);
    expect(f).not.toBe(g);
  });

  describe('HUD rows + fall feedback', () => {
    let doc: FakeDocument;
    let hud: HUD;
    let host: FakeElement;
    let timers: Array<{ fn: () => void; ms: number; id: number }>;

    beforeEach(() => {
      doc = new FakeDocument();
      vi.stubGlobal('document', doc);
      timers = [];
      let next = 1;
      vi.stubGlobal('window', {
        setTimeout: (fn: () => void, ms: number): number => {
          const id = next++;
          timers.push({ fn, ms, id });
          return id;
        },
        clearTimeout: (id: number): void => {
          timers = timers.filter((t) => t.id !== id);
        },
      });
      host = doc.createElement('div');
      hud = new HUD();
      hud.mount(host as unknown as HTMLElement);
    });
    afterEach(() => vi.unstubAllGlobals());

    const rows = (): FakeElement[] => host.find((e) => e.classList.contains('gk-hud__kf-row'));
    const one = (cls: string): FakeElement => host.find((e) => e.classList.contains(cls))[0];

    it('a serpent death gets the serpent glyph, the cause text and the is-serpent row class (no killer head)', () => {
      hud.killFeed({ killerAnimal: 'lion', victimAnimal: 'python', cause: 'serpent', victimName: 'Bob' });
      const row = rows()[0];
      expect(row.classList.contains('is-serpent')).toBe(true);
      expect(row.classList.contains('is-trap')).toBe(false);
      expect(row.classList.contains('is-fall')).toBe(false);
      expect(row.innerHTML).toContain('was eaten by the Sea Serpent');
      expect(row.innerHTML).toContain('is-serpent');
      expect(row.innerHTML).toContain('Bob');
      expect(row.innerHTML).not.toContain('Arena trap');
    });

    it('a fatal fall gets the falling glyph, "fell from the heights" and the is-fall row class (no killer head, no killer name)', () => {
      hud.killFeed({ killerAnimal: 'lion', victimAnimal: 'rhino', cause: 'fall', victimName: 'Cleo', killerName: 'Ghost' });
      const row = rows()[0];
      expect(row.classList.contains('is-fall')).toBe(true);
      expect(row.classList.contains('is-serpent')).toBe(false);
      expect(row.classList.contains('is-trap')).toBe(false);
      expect(row.innerHTML).toContain('fell from the heights');
      expect(row.innerHTML).toContain('is-fall');
      expect(row.innerHTML).toContain('Cleo');
      expect(row.innerHTML).not.toContain('Ghost');
      expect(row.innerHTML).not.toContain('Sea Serpent');
      expect(row.innerHTML).not.toContain('Arena trap');
    });

    it('a trap death keeps its glyph and gets no cause text; a normal kill gets neither', () => {
      hud.killFeed({ killerAnimal: 'lion', victimAnimal: 'rhino', cause: 'trap', trapKind: 'fire' });
      hud.killFeed({ killerAnimal: 'lion', victimAnimal: 'hippo' });
      const [trap, normal] = rows();
      expect(trap.classList.contains('is-trap')).toBe(true);
      expect(trap.classList.contains('is-serpent')).toBe(false);
      expect(trap.innerHTML).toContain('Arena trap');
      expect(trap.innerHTML).not.toContain('Sea Serpent');
      expect(normal.innerHTML).not.toContain('Sea Serpent');
      expect(normal.innerHTML).not.toContain('fell from');
      expect(normal.classList.contains('is-serpent')).toBe(false);
      expect(normal.classList.contains('is-fall')).toBe(false);
    });

    it('fallHit: red edge flash + a floating "-50", and the one-line hint only the FIRST time in a match', () => {
      const flash = one('gk-hud__fall-flash');
      const num = one('gk-hud__fall-num');
      const hint = one('gk-hud__fall-hint');
      expect(hint.textContent).toBe(FALL_HINT_TEXT);
      expect(FALL_HINT_TEXT).toBe('Took the long way down — use the ramps');
      expect(flash.classList.contains('is-active')).toBe(false);
      expect(hud.fallHit(50)).toBe(true);
      expect(num.textContent).toBe('-50');
      expect(flash.classList.contains('is-active')).toBe(true);
      expect(num.classList.contains('is-active')).toBe(true);
      expect(hint.classList.contains('is-active')).toBe(true);
      // each effect cleans itself up
      for (const t of [...timers]) t.fn();
      expect(flash.classList.contains('is-active')).toBe(false);
      expect(num.classList.contains('is-active')).toBe(false);
      expect(hint.classList.contains('is-active')).toBe(false);
      // a second fall: flash + number again, but no hint
      expect(hud.fallHit(50)).toBe(false);
      expect(flash.classList.contains('is-active')).toBe(true);
      expect(num.classList.contains('is-active')).toBe(true);
      expect(hint.classList.contains('is-active')).toBe(false);
      // a new match (remount) shows the hint again
      hud.unmount();
      hud.mount(host as unknown as HTMLElement);
      expect(hud.fallHit(50)).toBe(true);
    });

    it('fallHit does nothing on an unmounted HUD', () => {
      hud.unmount();
      expect(hud.fallHit(50)).toBe(false);
    });
  });
});

describe('death events carry the cause the controller reads', () => {
  it('serpent and fall kills are death {killerId: -1, cause}; a trap kill has no cause', () => {
    const pick = (e: GameEvent): 'serpent' | 'fall' | 'trap' | undefined =>
      e.type === 'death' && e.killerId === -1 ? (e.cause === 'serpent' ? 'serpent' : e.cause === 'fall' ? 'fall' : 'trap') : undefined;
    expect(pick({ type: 'death', targetId: 3, killerId: -1, placement: 4, cause: 'serpent' })).toBe('serpent');
    expect(pick({ type: 'death', targetId: 3, killerId: -1, placement: 4, cause: 'fall' })).toBe('fall');
    expect(pick({ type: 'death', targetId: 3, killerId: -1, placement: 4 })).toBe('trap');
    expect(pick({ type: 'death', targetId: 3, killerId: 1, placement: 4 })).toBeUndefined();
  });
});
