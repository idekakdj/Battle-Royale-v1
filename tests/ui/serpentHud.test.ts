/**
 * v1.9 Ocean Dome sea-serpent warning HUD (WP-O4): the pure view model (marker angle math relative to the camera yaw, strip +
 * altitude detection, banner lifecycle, hidden on other arenas, spectators), parity of that detection with the real sim's hit
 * rule, the DOM layer (fake DOM) and the kill-feed text / row for serpent deaths.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../src/core/EventBus';
import { wrapAngle } from '../../src/core/math';
import type { GameEvent, SerpentState, WorldSnapshot } from '../../src/core/types';
import { ANIMALS, ANIMAL_IDS } from '../../src/config/animals';
import { ARENAS, arenaGroundHeight } from '../../src/config/arenas';
import { SERPENT } from '../../src/config/serpent';
import { World } from '../../src/sim/World';
import { seatRoster } from '../../src/match/seating';
import {
  BANNER_FADE_MS,
  BANNER_HOLD_MS,
  SERPENT_WARN_MARGIN,
  SerpentHudModel,
  killCauseText,
  serpentDirection,
  serpentMarkerAngle,
  serpentStripDistance,
  serpentThreat,
} from '../../src/ui/serpentHudModel';
import { SerpentHud } from '../../src/ui/SerpentHud';
import { HUD } from '../../src/ui/HUD';
import { serpentGlyphSvg } from '../../src/ui/buffIcons';
import { FakeDocument, FakeElement } from './fakeDom';

const OCEAN = ARENAS.ocean;
const R = OCEAN.wallRadius;

const serp = (phase: SerpentState['phase'], angleDeg: number, t = 0): SerpentState => ({ phase, angleDeg, t, headR: R });

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
    // player standing at the 90° edge's far side: the edge point at 0° (x = 30, z = 0) is at (+x, −z·0)... measure from (0, 20)
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
  });

  it('agrees with the real sim: fighters the HUD calls in-strip (margin 0) are the ones the strike hits', () => {
    const bus = new EventBus();
    const roster = seatRoster('lion', 31, OCEAN);
    const world = new World({ roster, difficulty: 1, arena: 'ocean' }, 31, bus, { traps: false, serpent: { chance: 0 } });
    const hits = new Set<number>();
    bus.on('serpentHit', (e) => hits.add(e.fighterId));
    // strike along +x (θ = 0): five fighters on the flat seabed (r 20..28), alternating sides, 0.4 m inside / outside the capsule
    const expected = new Map<number, boolean>();
    for (let id = 1; id <= 5; id++) {
      const radius = ANIMALS[roster[id].animal].radius;
      const inside = id % 2 === 1;
      const z = (inside ? 1 : -1) * (SERPENT.headRadius + radius + (inside ? -0.4 : 0.4));
      const st = world.fighters[id].state;
      st.pos.x = 19 + id * 1.8;
      st.pos.z = z;
      st.pos.y = arenaGroundHeight(OCEAN, st.pos.x, st.pos.z);
      expected.set(id, inside);
      const th = serpentThreat(OCEAN, 0, st.pos, radius);
      // the HUD's margin only ever adds warnings: strictly-inside fighters are in-strip, strictly-outside ones are not (0.4 > 0.3)
      expect(th.inStrip).toBe(inside);
    }
    expect(world.debugTriggerSerpent(0)).toBe(true);
    for (let i = 0; i < 400 && world.serpent?.active !== false; i++) world.step(1 / 60);
    for (let i = 0; i < 400 && world.serpent?.active === true; i++) world.step(1 / 60);
    for (const [id, inside] of expected) expect(hits.has(id), `fighter ${id} (${roster[id].animal})`).toBe(inside);
  });

  it('every animal id has a body radius the model can use', () => {
    for (const id of ANIMAL_IDS) expect(ANIMALS[id].radius).toBeGreaterThan(0.3);
  });
});

describe('SerpentHudModel', () => {
  const player = { x: 22, y: 0, z: 0, radius: ANIMALS.lion.radius };

  it('banner lifecycle: off -> hold (~1 s) -> fade (0.5 s) -> off; a new warning restarts it; serpentEnd clears it', () => {
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
    m.onEnd();
    expect(m.bannerAt(9500)).toBe('off');
    expect(BANNER_HOLD_MS).toBeGreaterThanOrEqual(900);
    expect(BANNER_HOLD_MS).toBeLessThanOrEqual(1100);
  });

  it('is inert on arenas without the serpent hazard, whatever events or snapshots arrive', () => {
    for (const id of ['colosseum', 'jungle'] as const) {
      const m = new SerpentHudModel(ARENAS[id]);
      expect(m.enabled).toBe(false);
      m.onWarning(0);
      expect(m.bannerAt(10)).toBe('off');
      const v = m.frame(10, serp('warn', 10), { camYaw: 0, player });
      expect(v).toMatchObject({ banner: 'off', marker: false, status: 'off' });
    }
    expect(new SerpentHudModel(OCEAN).enabled).toBe(true);
  });

  it('warn phase: MOVE! inside the strip, SAFE outside; strike / hold / retreat keep a timer-less marker', () => {
    const m = new SerpentHudModel(OCEAN);
    m.onWarning(0);
    const inside = m.frame(100, serp('warn', 0), { camYaw: 0, player: { ...player, z: 0.5 } });
    expect(inside).toMatchObject({ banner: 'hold', marker: true, status: 'move', phase: 'warn', lineFrac: 1 });
    const outside = m.frame(100, serp('warn', 0), { camYaw: 0, player: { ...player, z: 12 } });
    expect(outside).toMatchObject({ marker: true, status: 'safe' });
    expect(outside.lineFrac).toBe(0); // 12 m off: beyond reach + the fade distance
    expect(m.frame(100, serp('strike', 0), { camYaw: 0, player }).status).toBe('strike');
    expect(m.frame(100, serp('hold', 0), { camYaw: 0, player }).status).toBe('after');
    expect(m.frame(100, serp('retreat', 0), { camYaw: 0, player }).status).toBe('after');
    expect(m.frame(100, serp('hold', 0), { camYaw: 0, player }).marker).toBe(true);
  });

  it('lineFrac grows as the player nears the strip (0 far .. 1 inside); an immune (high) player is shown safe', () => {
    const m = new SerpentHudModel(OCEAN);
    const f = (z: number): number => m.frame(0, serp('warn', 0), { camYaw: 0, player: { ...player, z } }).lineFrac;
    const reach = SERPENT.stripHalfWidth + player.radius + SERPENT_WARN_MARGIN;
    expect(f(0)).toBe(1);
    expect(f(reach)).toBe(1);
    expect(f(reach + 2)).toBeGreaterThan(0);
    expect(f(reach + 2)).toBeLessThan(1);
    expect(f(reach + 4)).toBeLessThan(f(reach + 2));
    expect(f(reach + 20)).toBe(0);
    const eagle = m.frame(0, serp('warn', 0), { camYaw: 0, player: { x: 22, y: 6, z: 0, radius: ANIMALS.eagle.radius } });
    expect(eagle).toMatchObject({ status: 'safe', lineFrac: 0, marker: true });
  });

  it('the marker angle follows the camera yaw frame by frame', () => {
    const m = new SerpentHudModel(OCEAN);
    const a0 = m.frame(0, serp('warn', 200), { camYaw: 0, player }).markerAngle;
    const a1 = m.frame(0, serp('warn', 200), { camYaw: -0.4, player }).markerAngle;
    expect(wrapAngle(a1 - a0)).toBeCloseTo(-0.4, 10); // yaw decreased by 0.4 (turned right): the marker moved 0.4 rad left
    expect(a0).toBeCloseTo(serpentMarkerAngle(200, 0, player.x, player.z, R), 10);
  });

  it('spectators (no local player) see the banner only: no marker, no status', () => {
    const m = new SerpentHudModel(OCEAN);
    m.onWarning(0);
    const v = m.frame(200, serp('warn', 10), { camYaw: 0, player: null });
    expect(v).toMatchObject({ banner: 'hold', marker: false, status: 'off' });
    expect(m.frame(2000, serp('warn', 10), { camYaw: 0, player: null }).banner).toBe('off');
  });

  it('no snapshot block (event over / not started yet): no marker; a banner that is still fading may remain', () => {
    const m = new SerpentHudModel(OCEAN);
    expect(m.frame(0, undefined, { camYaw: 0, player })).toMatchObject({ banner: 'off', marker: false, status: 'off' });
    m.onWarning(0);
    expect(m.frame(100, undefined, { camYaw: 0, player })).toMatchObject({ banner: 'hold', marker: false });
  });
});

// ── DOM layer ────────────────────────────────────────────────────────────────────────────────────────────────

function snapshot(opts: { alive?: boolean; x?: number; y?: number; z?: number; serpent?: SerpentState }): WorldSnapshot {
  const f = {
    id: 0,
    animal: 'lion',
    alive: opts.alive ?? true,
    pos: { x: opts.x ?? 22, y: opts.y ?? 0, z: opts.z ?? 0 },
  };
  return { time: 5, fighters: [f], ...(opts.serpent !== undefined ? { serpent: opts.serpent } : {}) } as unknown as WorldSnapshot;
}

describe('SerpentHud (DOM)', () => {
  let doc: FakeDocument;
  let layer: FakeElement;
  let hud: SerpentHud;
  const q = (cls: string): FakeElement => layer.find((e) => e.classList.contains(cls))[0];

  beforeEach(() => {
    doc = new FakeDocument();
    vi.stubGlobal('document', doc);
    layer = doc.createElement('div');
    hud = new SerpentHud(OCEAN);
    hud.mount(layer as unknown as HTMLElement);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('mounts its banner, chip, marker and line into the HUD layer and removes them on unmount', () => {
    expect(layer.find((e) => e.classList.contains('gk-serpent'))).toHaveLength(1);
    expect(q('gk-serpent__banner').textContent).toBe('SEA SERPENT!');
    expect(q('gk-serpent__banner').attributes.get('role')).toBe('alert');
    hud.unmount();
    expect(layer.children).toHaveLength(0);
  });

  it('warning event -> banner holds, chip says MOVE! in the strip / SAFE outside, marker + line show; fade, then end clears it', () => {
    hud.onWarning(0);
    hud.update(snapshot({ z: 0.2, serpent: serp('warn', 0) }), 0, 1280, 720, 100, false);
    expect(q('gk-serpent__banner').classList.contains('is-hold')).toBe(true);
    expect(q('gk-serpent__chip').textContent).toBe('MOVE!');
    expect(q('gk-serpent__chip').classList.contains('is-on')).toBe(true);
    expect(q('gk-serpent').dataset.status).toBe('move');
    expect(q('gk-serpent__marker').classList.contains('is-on')).toBe(true);
    expect(q('gk-serpent__marker').style).toHaveProperty('transform');
    const tf = (q('gk-serpent__marker').style as unknown as { transform: string }).transform;
    expect(tf).toMatch(/^translate3d\(-?[\d.]+px,-?[\d.]+px,0\) rotate\(-?[\d.]+rad\)$/);
    expect((q('gk-serpent__line').style as unknown as { transform: string }).transform).toContain('scaleY(');

    hud.update(snapshot({ z: 12, serpent: serp('warn', 0, 0.3) }), 0, 1280, 720, 400, false);
    expect(q('gk-serpent__chip').textContent).toBe('SAFE');
    expect(q('gk-serpent').dataset.status).toBe('safe');

    hud.update(snapshot({ z: 12, serpent: serp('warn', 0, 0.9) }), 0, 1280, 720, 1200, false);
    expect(q('gk-serpent__banner').classList.contains('is-hold')).toBe(false);
    expect(q('gk-serpent__banner').classList.contains('is-fade')).toBe(true);

    hud.update(snapshot({ z: 12, serpent: serp('strike', 0, 0.1) }), 0, 1280, 720, 2000, false);
    expect(q('gk-serpent__banner').classList.contains('is-fade')).toBe(false);
    expect(q('gk-serpent__chip').classList.contains('is-on')).toBe(false);
    expect(q('gk-serpent__marker').classList.contains('is-on')).toBe(true); // the small timer-less marker stays

    hud.onEnd();
    hud.update(snapshot({}), 0, 1280, 720, 2100, false);
    expect(q('gk-serpent__marker').classList.contains('is-on')).toBe(false);
    expect(q('gk-serpent').dataset.status).toBe('off');
  });

  it('a dead local player (spectating) sees the banner only', () => {
    hud.onWarning(0);
    hud.update(snapshot({ alive: false, serpent: serp('warn', 0) }), 0, 1280, 720, 100, true);
    expect(q('gk-serpent__banner').classList.contains('is-hold')).toBe(true);
    expect(q('gk-serpent__marker').classList.contains('is-on')).toBe(false);
    expect(q('gk-serpent__chip').classList.contains('is-on')).toBe(false);
  });

  it('the marker rides the screen rim: inside the viewport, at least the edge margin from each side, on every angle', () => {
    for (let a = 0; a < 360; a += 17) {
      hud.onWarning(0);
      hud.update(snapshot({ serpent: serp('warn', a) }), a * 0.01, 1280, 720, 100, false);
      const m = /translate3d\((-?[\d.]+)px,(-?[\d.]+)px/.exec((q('gk-serpent__marker').style as unknown as { transform: string }).transform);
      expect(m).not.toBeNull();
      const x = Number(m?.[1]);
      const y = Number(m?.[2]);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(1280);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(720);
    }
  });

  it('never creates anything on a serpent-free arena (the controller does not mount it, and the model stays off)', () => {
    const colosseum = new SerpentHud(ARENAS.colosseum);
    const l2 = doc.createElement('div');
    colosseum.mount(l2 as unknown as HTMLElement);
    colosseum.onWarning(0);
    colosseum.update(snapshot({ serpent: serp('warn', 0) }), 0, 1280, 720, 100, false);
    const banner = l2.find((e) => e.classList.contains('gk-serpent__banner'))[0];
    expect(banner.classList.contains('is-hold')).toBe(false);
    expect(l2.find((e) => e.classList.contains('is-on'))).toHaveLength(0);
  });
});

// ── kill feed ────────────────────────────────────────────────────────────────────────────────────────────────

describe('kill feed: serpent deaths', () => {
  it('killCauseText: serpent kills read "was eaten by the Sea Serpent"; traps and fighters have no cause text', () => {
    expect(killCauseText('serpent')).toBe('was eaten by the Sea Serpent');
    expect(killCauseText('trap')).toBeNull();
    expect(killCauseText(undefined)).toBeNull();
  });

  it('the serpent glyph is a real inline SVG (distinct from the trap glyphs)', () => {
    const g = serpentGlyphSvg();
    expect(g.startsWith('<svg')).toBe(true);
    expect(g).toContain('aria-hidden="true"');
    expect(g.length).toBeGreaterThan(200);
  });

  describe('HUD.killFeed rows', () => {
    let doc: FakeDocument;
    let hud: HUD;
    let host: FakeElement;

    beforeEach(() => {
      doc = new FakeDocument();
      vi.stubGlobal('document', doc);
      vi.stubGlobal('window', { setTimeout: () => 0, clearTimeout: () => undefined });
      host = doc.createElement('div');
      hud = new HUD();
      hud.mount(host as unknown as HTMLElement);
    });
    afterEach(() => vi.unstubAllGlobals());

    const rows = (): FakeElement[] => host.find((e) => e.classList.contains('gk-hud__kf-row'));

    it('a serpent death gets the serpent glyph, the cause text and the is-serpent row class (no killer head)', () => {
      hud.killFeed({ killerAnimal: 'lion', victimAnimal: 'python', cause: 'serpent', victimName: 'Bob' });
      const row = rows()[0];
      expect(row.classList.contains('is-serpent')).toBe(true);
      expect(row.classList.contains('is-trap')).toBe(false);
      expect(row.innerHTML).toContain('was eaten by the Sea Serpent');
      expect(row.innerHTML).toContain('is-serpent');
      expect(row.innerHTML).toContain('Bob');
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
      expect(normal.classList.contains('is-serpent')).toBe(false);
    });
  });
});

describe('death events carry the cause the controller reads', () => {
  it('a serpent kill is death {killerId: -1, cause: "serpent"} (and a trap kill has no cause)', () => {
    const e: GameEvent = { type: 'death', targetId: 3, killerId: -1, placement: 4, cause: 'serpent' };
    const cause = e.type === 'death' && e.killerId === -1 ? (e.cause === 'serpent' ? 'serpent' : 'trap') : undefined;
    expect(cause).toBe('serpent');
    const t: GameEvent = { type: 'death', targetId: 3, killerId: -1, placement: 4 };
    expect(t.type === 'death' && t.cause === undefined).toBe(true);
  });
});
