import { describe, expect, it } from 'vitest';
import type { GameEvent } from '../../src/core/types';
import {
  EVENT_ANGLE_TOLERANCE,
  EVENT_CODECS,
  EVENT_POS_TOLERANCE,
  EVENT_STRENGTH_TOLERANCE,
  EVENT_TYPES,
  MAX_EVENTS_PER_BATCH,
  decodeEventBatch,
  encodeEventBatch,
  encodeEventBatches,
} from '../../src/online/br/eventCodec';
import { angleDiff } from '../../src/online/br/tables';
import { SAMPLES, busyMatch, recordJungleWander, rng } from './brTestUtil';

function eventMismatches(a: unknown, b: unknown, path = 'e'): string[] {
  if (typeof a === 'number' && typeof b === 'number') {
    if (path.endsWith('.yaw')) return Math.abs(angleDiff(a, b)) <= EVENT_ANGLE_TOLERANCE ? [] : [`${path}: ${a} vs ${b}`];
    if (path.endsWith('.strength')) return Math.abs(a - b) <= EVENT_STRENGTH_TOLERANCE ? [] : [`${path}: ${a} vs ${b}`];
    return Math.abs(a - b) <= Math.max(1e-6, Math.abs(a) * 1e-6) ? [] : [`${path}: ${a} vs ${b}`];
  }
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    const bad: string[] = [];
    const ka = Object.keys(a as object).sort();
    const kb = Object.keys(b as object).sort();
    if (JSON.stringify(ka) !== JSON.stringify(kb)) return [`${path}: keys ${ka} vs ${kb}`];
    const isVec = ka.join() === 'x,y,z';
    for (const k of ka) {
      const va = (a as Record<string, unknown>)[k];
      const vb = (b as Record<string, unknown>)[k];
      if (isVec && typeof va === 'number' && typeof vb === 'number') {
        if (Math.abs(va - vb) > EVENT_POS_TOLERANCE) bad.push(`${path}.${k}: ${va} vs ${vb}`);
      } else bad.push(...eventMismatches(va, vb, `${path}.${k}`));
    }
    return bad;
  }
  return a === b ? [] : [`${path}: ${String(a)} vs ${String(b)}`];
}

/** Compile-time exhaustiveness: adding a GameEvent variant without a case here is a type error (`never` is not assignable). */
function variantIndex(e: GameEvent): number {
  switch (e.type) {
    case 'hit':
    case 'blocked':
    case 'guardBreak':
    case 'death':
    case 'ultimate':
    case 'special':
    case 'telegraph':
    case 'pickup':
    case 'comboFinisher':
    case 'crateBreak':
    case 'swingImpact':
    case 'ultimateTarget':
    case 'ultimateFizzle':
    case 'ultimateStage':
    case 'blink':
    case 'projectileImpact':
    case 'trapTriggered':
    case 'trapDamage':
    case 'trapExpired':
    case 'landingImpact':
    case 'matchEnd':
    case 'splash':
      return EVENT_CODECS[e.type].tag;
    default: {
      const unhandled: never = e;
      return unhandled;
    }
  }
}

describe('event codec', () => {
  it('an exhaustive switch over the union agrees with the codec table', () => {
    for (const e of Object.values(SAMPLES) as GameEvent[]) expect(variantIndex(e)).toBe(EVENT_CODECS[e.type].tag);
  });

  it('has a codec, a sample and a distinct tag for every GameEvent variant', () => {
    const types = Object.keys(SAMPLES).sort();
    expect([...EVENT_TYPES].sort()).toEqual(types);
    const tags = new Set(types.map((t) => EVENT_CODECS[t as GameEvent['type']].tag));
    expect(tags.size).toBe(types.length);
    expect(types.length).toBe(22);
  });

  it.each(Object.keys(SAMPLES))('round-trips %s', (type) => {
    const ev = SAMPLES[type as GameEvent['type']];
    const bytes = encodeEventBatch({ firstSeq: 5, timeMs: 1234, events: [ev] });
    const out = decodeEventBatch(bytes);
    expect(out).not.toBeNull();
    expect(out?.firstSeq).toBe(5);
    expect(out?.timeMs).toBe(1234);
    expect(out?.events).toHaveLength(1);
    expect(eventMismatches(ev, out?.events[0])).toEqual([]);
  });

  it('round-trips all variants in one batch and keeps sequence ids contiguous', () => {
    const events = Object.values(SAMPLES) as GameEvent[];
    const out = decodeEventBatch(encodeEventBatch({ firstSeq: 4_000_000_000, timeMs: -3000, events }));
    expect(out?.firstSeq).toBe(4_000_000_000);
    expect(out?.timeMs).toBe(-3000);
    expect(out?.events.length).toBe(events.length);
    events.forEach((e, i) => expect(eventMismatches(e, out?.events[i])).toEqual([]));
  });

  it('every event of a real 60 s match round-trips', () => {
    const rec = busyMatch();
    const seen = new Set<string>();
    let n = 0;
    for (let t = 0; t < rec.events.length; t++) {
      const evs = rec.events[t];
      if (evs.length === 0) continue;
      const out = decodeEventBatch(encodeEventBatch({ firstSeq: n, timeMs: Math.round(rec.snapshots[t].time * 1000), events: evs }));
      expect(out).not.toBeNull();
      evs.forEach((e, i) => {
        seen.add(e.type);
        expect(eventMismatches(e, out?.events[i]), `${e.type} @tick ${t}`).toEqual([]);
      });
      n += evs.length;
    }
    expect(n).toBeGreaterThan(50);
    for (const t of ['hit', 'death', 'swingImpact']) expect(seen.has(t)).toBe(true);
  });

  it('v1.8 splash: entering / leaving, the strength extremes and the water-surface height survive the wire', () => {
    for (const entering of [true, false]) {
      for (const strength of [0, 0.15, 0.5, 1 / 3, 0.999, 1]) {
        const ev: GameEvent = { type: 'splash', fighterId: 7, pos: { x: -3.25, y: 0.55, z: 1.5 }, entering, strength };
        const out = decodeEventBatch(encodeEventBatch({ firstSeq: 1, timeMs: 0, events: [ev] }));
        expect(out?.events).toHaveLength(1);
        const e = out?.events[0] as Extract<GameEvent, { type: 'splash' }>;
        expect(e.type).toBe('splash');
        expect(e.entering).toBe(entering);
        expect(e.fighterId).toBe(7);
        expect(Math.abs(e.strength - strength)).toBeLessThanOrEqual(EVENT_STRENGTH_TOLERANCE);
        expect(eventMismatches(ev, e)).toEqual([]);
      }
    }
    // out-of-range / NaN strengths clamp instead of corrupting the byte
    for (const [strength, want] of [[-2, 0], [5, 1], [Number.NaN, 0]] as const) {
      const ev: GameEvent = { type: 'splash', fighterId: 0, pos: { x: 0, y: 0, z: 0 }, entering: true, strength };
      const out = decodeEventBatch(encodeEventBatch({ firstSeq: 1, timeMs: 0, events: [ev] }));
      expect((out?.events[0] as Extract<GameEvent, { type: 'splash' }>).strength).toBe(want);
    }
  });

  it('v1.8 splash: a corrupt entering byte (> 1) drops the packet', () => {
    const ok = encodeEventBatch({ firstSeq: 1, timeMs: 0, events: [{ type: 'splash', fighterId: 1, pos: { x: 0, y: 0, z: 0 }, entering: true, strength: 0.5 }] });
    // layout: varu seq(1) · i32 time(4) · u8 count(1) · tag(1) · fighter(1) · vec3(6) · entering(1) · strength(1)
    const bad = ok.slice();
    bad[1 + 4 + 1 + 1 + 1 + 6] = 2;
    expect(decodeEventBatch(ok)).not.toBeNull();
    expect(decodeEventBatch(bad)).toBeNull();
  });

  it('every splash event of a jungle wading stress round-trips', () => {
    const rec = recordJungleWander(404, 60);
    let n = 0;
    for (let t = 0; t < rec.events.length; t++) {
      const evs = rec.events[t].filter((e) => e.type === 'splash');
      if (evs.length === 0) continue;
      const out = decodeEventBatch(encodeEventBatch({ firstSeq: n, timeMs: Math.round(rec.snapshots[t].time * 1000), events: evs }));
      expect(out).not.toBeNull();
      evs.forEach((e, i) => expect(eventMismatches(e, out?.events[i]), `splash @tick ${t}`).toEqual([]));
      n += evs.length;
    }
    expect(n).toBeGreaterThan(20);
  });

  it('splits oversized event lists into consecutive batches', () => {
    const many: GameEvent[] = Array.from({ length: 450 }, (_, i) => ({ type: 'comboFinisher', fighterId: i % 10 }));
    const batches = encodeEventBatches(100, 5, many);
    expect(batches.length).toBe(Math.ceil(450 / MAX_EVENTS_PER_BATCH));
    let next = 100;
    let total = 0;
    for (const b of batches) {
      const d = decodeEventBatch(b);
      expect(d?.firstSeq).toBe(next);
      next += d?.events.length ?? 0;
      total += d?.events.length ?? 0;
    }
    expect(total).toBe(450);
  });

  it('fuzz: garbage, truncations and bit flips never throw', () => {
    const r = rng(77);
    for (let i = 0; i < 20000; i++) {
      const b = new Uint8Array(Math.floor(r() * 120));
      for (let k = 0; k < b.length; k++) b[k] = Math.floor(r() * 256);
      decodeEventBatch(b);
    }
    const good = encodeEventBatch({ firstSeq: 1, timeMs: 1, events: Object.values(SAMPLES) as GameEvent[] });
    for (let len = 0; len < good.length; len++) expect(decodeEventBatch(good.subarray(0, len))).toBeNull();
    for (let i = 0; i < good.length; i++) {
      for (let bit = 0; bit < 8; bit++) {
        const c = good.slice();
        c[i] ^= 1 << bit;
        decodeEventBatch(c);
      }
    }
    const extra = new Uint8Array(good.length + 1);
    extra.set(good);
    expect(decodeEventBatch(extra)).toBeNull();
  });
});
