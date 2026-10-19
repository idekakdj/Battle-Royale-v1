/**
 * v1.8: the Battle Royale data fingerprint covers the ARENAS registry (so editing the jungle's trees / terrain / pads
 * changes it, and two builds with different jungles cannot play together), while the colosseum constants that were
 * already hashed stay exactly as they were and Champions League data is untouched.
 */

import { describe, it, expect } from 'vitest';
import { computeFingerprint, diffVersions, fingerprintData, fnv1a32, hex32, localVersions, stableStringify } from '../../src/online/room/fingerprint';
import { ARENAS, JUNGLE_ARENA, OCEAN_ARENA } from '../../src/config/arenas';
import * as arena from '../../src/config/arena';
import * as serpentCfg from '../../src/config/serpent';
import { SERPENT_LANES } from '../../src/config/serpentLanes';
import { ONLINE_PROTOCOL_VERSION } from '../../src/online/types';

type BrData = {
  animals: unknown;
  balance: unknown;
  traps: unknown;
  arena: unknown;
  arenas: typeof ARENAS;
  terrain: unknown;
  serpent: Record<string, unknown>;
  serpentLanes: Record<string, number>;
  hazards: Record<string, unknown>;
};

describe('battleRoyale fingerprint covers the arena registry', () => {
  const data = fingerprintData('battleRoyale') as BrData;

  it('hashes the ARENAS registry as an additive key; the original inputs are still all there', () => {
    expect(Object.keys(data).sort()).toEqual(['animals', 'arena', 'arenas', 'balance', 'hazards', 'serpent', 'serpentLanes', 'terrain', 'traps']);
    expect(data.arenas).toBe(ARENAS);
    expect(Object.keys(data.arenas).sort()).toEqual(['colosseum', 'jungle', 'ocean']);
    expect(stableStringify(data.arena)).toBe(stableStringify({ ...arena }));
  });

  it('is deterministic and an 8-digit hex string', () => {
    expect(computeFingerprint('battleRoyale')).toMatch(/^[0-9a-f]{8}$/);
    expect(computeFingerprint('battleRoyale')).toBe(computeFingerprint('battleRoyale'));
  });

  it('changes when a jungle value changes (a tree moves, a moss patch grows, the pool deepens)', () => {
    const base = stableStringify(data);
    const hash = (text: string): string => hex32(fnv1a32(text));
    const baseHash = hash(base);

    const treeMoved = { ...data, arenas: { ...ARENAS, jungle: { ...JUNGLE_ARENA, circles: JUNGLE_ARENA.circles.map((c, i) => (i === 0 ? { ...c, x: c.x + 0.1 } : c)) } } };
    expect(hash(stableStringify(treeMoved))).not.toBe(baseHash);

    const mossGrown = {
      ...data,
      arenas: { ...ARENAS, jungle: { ...JUNGLE_ARENA, terrain: JUNGLE_ARENA.terrain.map((t, i) => (i === 1 ? { ...t, radius: t.radius + 0.1 } : t)) } },
    };
    expect(hash(stableStringify(mossGrown))).not.toBe(baseHash);

    const deeper = {
      ...data,
      arenas: { ...ARENAS, jungle: { ...JUNGLE_ARENA, terrain: JUNGLE_ARENA.terrain.map((t) => (t.kind === 'water' ? { ...t, depth: 0.6 } : t)) } },
    };
    expect(hash(stableStringify(deeper))).not.toBe(baseHash);

    // the v1.8 terrain tuning (moss slow, water multiplier range, splash) and the per-animal swim attribute are hashed too
    const t = data.terrain as { TERRAIN: { moss: { slow: number } } };
    const mossSlower = { ...data, terrain: { ...t, TERRAIN: { ...t.TERRAIN, moss: { ...t.TERRAIN.moss, slow: 0.4 } } } };
    expect(hash(stableStringify(mossSlower))).not.toBe(baseHash);
    const a = data.animals as Record<string, { swim: number }>;
    const swimmer = { ...data, animals: { ...a, giraffe: { ...a.giraffe, swim: a.giraffe.swim + 0.1 } } };
    expect(hash(stableStringify(swimmer))).not.toBe(baseHash);

    // dropping the registry entirely is also visible
    const { arenas: _drop, ...without } = data;
    expect(hash(stableStringify(without))).not.toBe(baseHash);
  });

  it('v1.9 hashes the sea-serpent numbers: changing any of them changes the fingerprint', () => {
    expect(stableStringify(data.serpent)).toBe(stableStringify({ ...serpentCfg }));
    expect((data.serpent as { SERPENT: Record<string, number> }).SERPENT.damage).toBe(300);
    const hash = (text: string): string => hex32(fnv1a32(text));
    const baseHash = hash(stableStringify(data));
    const S = (data.serpent as { SERPENT: Record<string, number> }).SERPENT;
    for (const key of ['intervalS', 'chance', 'warnS', 'strikeS', 'holdS', 'retreatS', 'stripHalfWidth', 'headRadius', 'damage', 'hazardHeight', 'seedSalt']) {
      expect(typeof S[key], key).toBe('number');
      const changed = { ...data, serpent: { ...data.serpent, SERPENT: { ...S, [key]: S[key] * 1.01 + 0.01 } } };
      expect(hash(stableStringify(changed)), key).not.toBe(baseHash);
    }
    // the ocean arena's hazard flag is part of the registry hash too
    const noSerpent = { ...data, arenas: { ...ARENAS, ocean: { ...ARENAS.ocean, hazards: { serpent: false } } } };
    expect(hash(stableStringify(noSerpent))).not.toBe(baseHash);
  });

  it('Champions League is unaffected by the serpent numbers', () => {
    expect(Object.keys(fingerprintData('championsLeague') as object)).not.toContain('serpent');
  });

  it('is plain data: no cycles (stableStringify would throw) and stable key order', () => {
    expect(() => stableStringify(ARENAS)).not.toThrow();
    expect(stableStringify(ARENAS)).toBe(stableStringify(JSON.parse(JSON.stringify(ARENAS))));
  });

  it('Champions League data does not include the arenas', () => {
    const cl = fingerprintData('championsLeague') as Record<string, unknown>;
    expect(Object.keys(cl).sort()).toEqual(['movesets', 'phys', 'stages']);
  });
});

describe('v1.10 the fingerprint covers the serpent lanes, the split height and the fall rule', () => {
  const data = fingerprintData('battleRoyale') as BrData;
  const hash = (v: unknown): string => hex32(fnv1a32(stableStringify(v)));
  const baseHash = hash(data);

  it('speaks protocol 4 (snapshot flag 128, the tier bit, the fall event, death cause 2)', () => {
    expect(ONLINE_PROTOCOL_VERSION).toBe(4);
    expect(localVersions().protocol).toBe(4);
  });

  it('hashes SERPENT_LANES: changing any lane number changes the fingerprint', () => {
    expect(stableStringify(data.serpentLanes)).toBe(stableStringify({ ...SERPENT_LANES }));
    for (const key of Object.keys(SERPENT_LANES) as Array<keyof typeof SERPENT_LANES>) {
      expect(typeof data.serpentLanes[key], key).toBe('number');
      const changed = { ...data, serpentLanes: { ...data.serpentLanes, [key]: data.serpentLanes[key] + 1 } };
      expect(hash(changed), key).not.toBe(baseHash);
    }
  });

  it("lists every arena's hazards explicitly: the split height and the fall rule are part of the hash on their own (arenas unchanged)", () => {
    expect(Object.keys(data.hazards).sort()).toEqual(['colosseum', 'jungle', 'ocean']);
    for (const id of ['colosseum', 'jungle', 'ocean'] as const) expect(data.hazards[id]).toEqual(ARENAS[id].hazards ?? null);
    const base = OCEAN_ARENA.hazards ?? {};
    const split = (base as { serpentSplitY?: number }).serpentSplitY ?? 4.5;
    const fall = (base as { fallDamage?: { minDrop: number; damage: number } }).fallDamage ?? { minDrop: 3.4, damage: 50 };
    const variants: Array<[string, unknown]> = [
      ['serpentSplitY', { ...base, serpentSplitY: split + 0.1 }],
      ['fallDamage.damage', { ...base, fallDamage: { ...fall, damage: fall.damage + 1 } }],
      ['fallDamage.minDrop', { ...base, fallDamage: { ...fall, minDrop: fall.minDrop + 0.1 } }],
      ['fallDamage removed', { serpent: true, serpentSplitY: split }],
      ['serpentSplitY removed', { serpent: true, fallDamage: fall }],
      ['hazards removed', null],
    ];
    for (const [name, h] of variants) {
      const changed = { ...data, hazards: { ...data.hazards, ocean: h } };
      expect(hash(changed), name).not.toBe(baseHash);
    }
    // another arena's hazards count too
    expect(hash({ ...data, hazards: { ...data.hazards, jungle: { serpent: true } } })).not.toBe(baseHash);
  });

  it('a peer whose lane / hazard data differs is refused by the handshake (diffVersions reports the battleRoyale fingerprint)', () => {
    const mine = localVersions();
    const theirs = { ...mine, fingerprints: { ...mine.fingerprints, battleRoyale: hash({ ...data, serpentLanes: { ...data.serpentLanes, highSeedSalt: 1 } }) } };
    expect(diffVersions(mine, theirs)).toEqual(['fingerprint:battleRoyale']);
    expect(diffVersions(mine, { ...mine })).toEqual([]);
    expect(diffVersions(mine, { ...mine, protocol: 3 })).toEqual(['protocol']);
  });

  it('Champions League is untouched by all of it', () => {
    const cl = fingerprintData('championsLeague') as Record<string, unknown>;
    expect(Object.keys(cl)).not.toContain('serpentLanes');
    expect(Object.keys(cl)).not.toContain('hazards');
  });
});
