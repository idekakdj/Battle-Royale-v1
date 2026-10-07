import { describe, expect, it } from 'vitest';
import type { FighterState, GameEvent, WorldSnapshot } from '../../src/core/types';
import { EVENT_ID_FIELDS, EVENT_NON_ID_NUMERIC_FIELDS, swapEventIds, swapId, swapIds, swapList, swapResults } from '../../src/online/br/idSwap';
import { SAMPLES, busyMatch } from './brTestUtil';

const A = 2;
const B = 5;
const OTHER = 7;

/** Fighter whose hp is a unique marker so it can be found again after the swap reorders the array. */
function fighter(id: number, over: Partial<FighterState> = {}): FighterState {
  return {
    id,
    animal: 'lion',
    isPlayer: false,
    alive: true,
    pos: { x: id, y: 0, z: -id },
    vel: { x: 0, y: 0, z: 0 },
    yaw: 0.1 * id,
    hp: 1000 + id,
    maxHp: 1000,
    guard: 50,
    maxGuard: 100,
    guardRegenDelay: 0,
    ultCharge: 10 * id,
    specialCd: 0,
    action: 'idle',
    actionT: 0,
    actionDur: 0,
    comboIndex: 0,
    comboWindow: 0,
    buffs: [{ kind: 'speed', t: 0.5, dur: 3, mag: 0.3 }],
    kills: id,
    damageDealt: 11 * id,
    damageBlocked: 3 * id,
    ultsUsed: 0,
    grabTargetId: -1,
    grabbedById: -1,
    airborne: false,
    glideT: 0,
    burrowT: 0,
    ...over,
  };
}

/** A snapshot whose every id-carrying field holds `v`. */
function snapshotWith(v: number): WorldSnapshot {
  return {
    time: 12.5,
    fighters: Array.from({ length: 10 }, (_, i) => fighter(i, { grabTargetId: v, grabbedById: v, ultTargetId: v, ultPhase: 'active', ultStage: 2 })),
    pickups: [{ id: 3, kind: 'heal', pos: { x: 1, y: 0, z: 2 }, active: true, respawnT: 0 }],
    crates: [{ id: 4, pos: { x: 3, y: 0, z: 4 }, hp: 100, alive: true }],
    traps: [{ id: 6, kind: 'fire', pos: { x: 5, y: 0, z: 6 }, radius: 2, phase: 'active', timeLeft: 3, triggeredBy: v }],
    projectiles: [{ id: 8, kind: 'boulder', pos: { x: 1, y: 2, z: 3 }, vel: { x: 4, y: 5, z: 6 }, radius: 0.6, ownerId: v }],
    bloodlustMult: 1.25,
    matchOver: true,
    winnerId: v,
  };
}

/** Every numeric leaf path of a snapshot (arrays indexed generically as `[]`). */
function numericPaths(o: unknown, prefix = '', out = new Set<string>()): Set<string> {
  if (typeof o === 'number') out.add(prefix);
  else if (Array.isArray(o)) o.forEach((x) => numericPaths(x, `${prefix}[]`, out));
  else if (o !== null && typeof o === 'object') for (const [k, v] of Object.entries(o)) numericPaths(v, prefix === '' ? k : `${prefix}.${k}`, out);
  return out;
}

/** Fighter-id snapshot fields (everything else numeric is NOT an id). */
const SNAPSHOT_ID_PATHS = new Set([
  'fighters[].id',
  'fighters[].grabTargetId',
  'fighters[].grabbedById',
  'fighters[].ultTargetId',
  'traps[].triggeredBy',
  'projectiles[].ownerId',
  'winnerId',
]);

describe('swapId', () => {
  it('exchanges a and b and leaves everything else (incl. −1) alone', () => {
    expect(swapId(A, A, B)).toBe(B);
    expect(swapId(B, A, B)).toBe(A);
    expect(swapId(OTHER, A, B)).toBe(OTHER);
    expect(swapId(-1, A, B)).toBe(-1);
    expect(swapId(3, 3, 3)).toBe(3);
  });
});

describe('swapIds(snapshot)', () => {
  for (const v of [A, B, OTHER, -1]) {
    it(`remaps every id-carrying field holding ${v === -1 ? '−1 (none)' : v} and touches nothing else`, () => {
      const orig = snapshotWith(v);
      const frozen = structuredClone(orig);
      const sw = swapIds(orig, A, B);
      expect(orig).toEqual(frozen); // input untouched
      // fighters travel with their data: marker hp 1000+origId
      expect(sw.fighters).toHaveLength(10);
      sw.fighters.forEach((f, idx) => {
        expect(f.id).toBe(idx); // array index == id invariant preserved
        const origId = swapId(idx, A, B); // the fighter now at idx used to be origId
        const o = orig.fighters[origId];
        expect(f.hp).toBe(o.hp);
        const { id: _i, grabTargetId: _g, grabbedById: _b, ultTargetId: _u, ...restNew } = f;
        const { id: _i2, grabTargetId: _g2, grabbedById: _b2, ultTargetId: _u2, ...restOld } = o;
        expect(restNew).toEqual(restOld);
        expect(f.grabTargetId).toBe(swapId(o.grabTargetId, A, B));
        expect(f.grabbedById).toBe(swapId(o.grabbedById, A, B));
        expect(f.ultTargetId).toBe(swapId(o.ultTargetId as number, A, B));
      });
      expect(sw.traps[0].triggeredBy).toBe(swapId(v, A, B));
      expect(sw.projectiles?.[0].ownerId).toBe(swapId(v, A, B));
      expect(sw.winnerId).toBe(swapId(v, A, B));
      // everything that is not an id is identical
      expect({ ...sw, fighters: 0, traps: 0, projectiles: 0, winnerId: 0 }).toEqual({ ...orig, fighters: 0, traps: 0, projectiles: 0, winnerId: 0 });
      expect({ ...sw.traps[0], triggeredBy: 0 }).toEqual({ ...orig.traps[0], triggeredBy: 0 });
      expect({ ...(sw.projectiles?.[0] as object), ownerId: 0 }).toEqual({ ...(orig.projectiles?.[0] as object), ownerId: 0 });
      // its own inverse
      expect(swapIds(sw, A, B)).toEqual(orig);
    });
  }

  it('every numeric snapshot field is classified as an id or a non-id (a new numeric field forces a decision here)', () => {
    const paths = numericPaths(snapshotWith(A));
    const known = new Set([
      ...SNAPSHOT_ID_PATHS,
      'time',
      'bloodlustMult',
      'pickups[].id',
      'pickups[].pos.x',
      'pickups[].pos.y',
      'pickups[].pos.z',
      'pickups[].respawnT',
      'crates[].id',
      'crates[].pos.x',
      'crates[].pos.y',
      'crates[].pos.z',
      'crates[].hp',
      'traps[].id',
      'traps[].pos.x',
      'traps[].pos.y',
      'traps[].pos.z',
      'traps[].radius',
      'traps[].timeLeft',
      'projectiles[].id',
      'projectiles[].pos.x',
      'projectiles[].pos.y',
      'projectiles[].pos.z',
      'projectiles[].vel.x',
      'projectiles[].vel.y',
      'projectiles[].vel.z',
      'projectiles[].radius',
      ...[
        'pos.x',
        'pos.y',
        'pos.z',
        'vel.x',
        'vel.y',
        'vel.z',
        'yaw',
        'hp',
        'maxHp',
        'guard',
        'maxGuard',
        'guardRegenDelay',
        'ultCharge',
        'specialCd',
        'actionT',
        'actionDur',
        'comboIndex',
        'comboWindow',
        'buffs[].t',
        'buffs[].dur',
        'buffs[].mag',
        'kills',
        'damageDealt',
        'damageBlocked',
        'ultsUsed',
        'glideT',
        'burrowT',
        'ultStage',
      ].map((p) => `fighters[].${p}`),
    ]);
    const unknown = [...paths].filter((p) => !known.has(p));
    expect(unknown).toEqual([]);
  });

  it('works on a swap with a fighter id outside the roster and on a === b', () => {
    const s = snapshotWith(A);
    expect(swapIds(s, A, A)).toEqual(s);
    const out = swapIds(s, A, 99);
    expect(out.fighters.map((f) => f.id)).toEqual(s.fighters.map((f) => (f.id === A ? 99 : f.id)));
    expect(swapIds(out, A, 99)).toEqual(s);
  });

  it('v1.8 terrain flags travel with their fighter through the swap (and absent stays absent)', () => {
    const s = snapshotWith(A);
    s.fighters[A].inWater = true;
    s.fighters[B].onMoss = true;
    const out = swapIds(s, A, B);
    // the swap exchanges the two slots, so the flagged fighters now sit at the other index but keep their flags
    expect(out.fighters[B].id).toBe(B);
    expect(out.fighters[B].inWater).toBe(true);
    expect(out.fighters[A].onMoss).toBe(true);
    expect(out.fighters[0].inWater).toBeUndefined();
    expect('inWater' in out.fighters[0]).toBe(false);
    expect(swapIds(out, A, B)).toEqual(s);
  });

  it('keeps an absent ultTargetId absent and an absent projectiles list absent', () => {
    const s = snapshotWith(A);
    delete s.projectiles;
    for (const f of s.fighters) delete f.ultTargetId;
    const out = swapIds(s, A, B);
    expect(out.projectiles).toBeUndefined();
    expect('ultTargetId' in out.fighters[0]).toBe(false);
  });

  it('is an involution on every snapshot of a real match, for several (a, b)', () => {
    const rec = busyMatch();
    for (let t = 0; t < rec.snapshots.length; t += 97) {
      for (const [a, b] of [
        [0, 3],
        [0, 9],
        [4, 6],
      ] as const) {
        const s = rec.snapshots[t];
        const sw = swapIds(s, a, b);
        expect(sw.fighters.map((f) => f.id)).toEqual(s.fighters.map((_, i) => i));
        expect(swapIds(sw, a, b)).toEqual(s);
      }
    }
  });
});

describe('swapEventIds', () => {
  const types = Object.keys(SAMPLES) as GameEvent['type'][];

  it('every numeric field of every variant is classified as a fighter id or a non-id', () => {
    for (const t of types) {
      const sample = SAMPLES[t] as unknown as Record<string, unknown>;
      const numeric = Object.entries(sample)
        .filter(([, v]) => typeof v === 'number')
        .map(([k]) => k)
        .sort();
      const classified = [...(EVENT_ID_FIELDS[t] as readonly string[]), ...(EVENT_NON_ID_NUMERIC_FIELDS[t] as readonly string[])].sort();
      expect(classified, t).toEqual(numeric);
    }
  });

  it.each(types)('%s: remaps each id field (for values a, b, other, −1) and nothing else; is its own inverse', (t) => {
    const base = SAMPLES[t] as unknown as Record<string, unknown>;
    const fields = EVENT_ID_FIELDS[t] as readonly string[];
    for (const field of fields) {
      for (const v of [A, B, OTHER, -1]) {
        const ev = { ...base, [field]: v } as unknown as GameEvent;
        const frozen = structuredClone(ev);
        const sw = swapEventIds(ev, A, B) as unknown as Record<string, unknown>;
        expect(ev).toEqual(frozen); // not mutated
        expect(sw[field]).toBe(swapId(v, A, B));
        const rest = { ...sw };
        const restOrig = { ...(ev as unknown as Record<string, unknown>) };
        for (const f of fields) {
          delete rest[f];
          delete restOrig[f];
        }
        expect(rest).toEqual(restOrig); // untouched: positions, damage, placement, trap/crate ids, …
        expect(swapEventIds(sw as unknown as GameEvent, A, B)).toEqual(ev);
      }
    }
    // all id fields at once with distinct values
    if (fields.length > 1) {
      const vals = [A, B, OTHER, 9];
      const ev = { ...base } as Record<string, unknown>;
      fields.forEach((f, i) => (ev[f] = vals[i % vals.length]));
      const sw = swapEventIds(ev as unknown as GameEvent, A, B) as unknown as Record<string, unknown>;
      fields.forEach((f) => expect(sw[f]).toBe(swapId(ev[f] as number, A, B)));
      expect(swapEventIds(sw as unknown as GameEvent, A, B)).toEqual(ev);
    }
  });

  it('v1.8 splash: fighterId is remapped, strength / entering / pos are not', () => {
    const ev: GameEvent = { type: 'splash', fighterId: A, pos: { x: 1, y: 0.55, z: 2 }, entering: true, strength: 0.7 };
    expect(swapEventIds(ev, A, B)).toEqual({ type: 'splash', fighterId: B, pos: { x: 1, y: 0.55, z: 2 }, entering: true, strength: 0.7 });
    expect(swapEventIds(swapEventIds(ev, A, B), A, B)).toEqual(ev);
    expect(swapEventIds(ev, B, OTHER)).toEqual(ev); // an unrelated pair leaves it alone
  });

  it('death.placement and crate/trap ids are not fighter ids', () => {
    const d = swapEventIds({ type: 'death', targetId: A, killerId: B, placement: A }, A, B);
    expect(d).toEqual({ type: 'death', targetId: B, killerId: A, placement: A });
    const c = swapEventIds({ type: 'crateBreak', crateId: A, pos: { x: 1, y: 2, z: 3 } }, A, B);
    expect(c).toEqual({ type: 'crateBreak', crateId: A, pos: { x: 1, y: 2, z: 3 } });
    const t = swapEventIds({ type: 'trapDamage', trapId: A, kind: 'fire', targetId: A, damage: 7, pos: { x: 0, y: 0, z: 0 } }, A, B);
    expect(t).toMatchObject({ trapId: A, targetId: B });
  });

  it('is an involution on every event of a real match', () => {
    const rec = busyMatch();
    let n = 0;
    for (const evs of rec.events) {
      for (const e of evs) {
        expect(swapEventIds(swapEventIds(e, 0, 6), 0, 6)).toEqual(e);
        n++;
      }
    }
    expect(n).toBeGreaterThan(50);
  });
});

describe('swapList / swapResults', () => {
  it('exchanges per-fighter entries and the winner', () => {
    expect(swapList([10, 11, 12, 13], 1, 3)).toEqual([10, 13, 12, 11]);
    expect(swapList([10, 11], 0, 5)).toEqual([10, 11]);
    const r = { winnerId: 3, matchTimeS: 42, fighters: [0, 1, 2, 3].map((i) => ({ placement: 4 - i, kills: i, damageDealt: i, damageBlocked: i, ultsUsed: i })) };
    const s = swapResults(r, 0, 3);
    expect(s.winnerId).toBe(0);
    expect(s.fighters.map((f) => f.kills)).toEqual([3, 1, 2, 0]);
    expect(swapResults(s, 0, 3)).toEqual(r);
  });
});
