/**
 * v1.8: the Battle Royale data fingerprint covers the ARENAS registry (so editing the jungle's trees / terrain / pads
 * changes it, and two builds with different jungles cannot play together), while the colosseum constants that were
 * already hashed stay exactly as they were and Champions League data is untouched.
 */

import { describe, it, expect } from 'vitest';
import { computeFingerprint, fingerprintData, fnv1a32, hex32, stableStringify } from '../../src/online/room/fingerprint';
import { ARENAS, JUNGLE_ARENA } from '../../src/config/arenas';
import * as arena from '../../src/config/arena';

type BrData = { animals: unknown; balance: unknown; traps: unknown; arena: unknown; arenas: typeof ARENAS; terrain: unknown };

describe('battleRoyale fingerprint covers the arena registry', () => {
  const data = fingerprintData('battleRoyale') as BrData;

  it('hashes the ARENAS registry as an additive key; the original inputs are still all there', () => {
    expect(Object.keys(data).sort()).toEqual(['animals', 'arena', 'arenas', 'balance', 'terrain', 'traps']);
    expect(data.arenas).toBe(ARENAS);
    expect(Object.keys(data.arenas).sort()).toEqual(['colosseum', 'jungle']);
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

  it('is plain data: no cycles (stableStringify would throw) and stable key order', () => {
    expect(() => stableStringify(ARENAS)).not.toThrow();
    expect(stableStringify(ARENAS)).toBe(stableStringify(JSON.parse(JSON.stringify(ARENAS))));
  });

  it('Champions League data does not include the arenas', () => {
    const cl = fingerprintData('championsLeague') as Record<string, unknown>;
    expect(Object.keys(cl).sort()).toEqual(['movesets', 'phys', 'stages']);
  });
});
