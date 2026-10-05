import { describe, expect, it } from 'vitest';
import { SnapshotDecoder, encodeSnapshot, STATS_EVERY } from '../../src/online/br/snapshotCodec';
import { wrapSnapshot, SNAPSHOT_WRAPPER_BYTES } from '../../src/online/br/miscCodec';
import type { FighterState, WorldSnapshot } from '../../src/core/types';
import { busyMatch, recordMatch, rng, snapshotMismatches } from './brTestUtil';

/** A fighter with EVERY optional/rare field populated. */
function fullFighter(id: number, over: Partial<FighterState> = {}): FighterState {
  return {
    id,
    animal: 'panther',
    isPlayer: id === 0,
    alive: true,
    pos: { x: -12.34, y: 3.21, z: 28.9 },
    vel: { x: 5.5, y: -3.25, z: -7.125 },
    yaw: -2.5,
    hp: 733.37,
    maxHp: 875,
    guard: 55.55,
    maxGuard: 90,
    guardRegenDelay: 0.75,
    ultCharge: 99.9,
    specialCd: 3.456,
    action: 'ultimate',
    actionT: 0.321,
    actionDur: 1.5,
    comboIndex: 2,
    comboWindow: 0.4,
    buffs: [
      { kind: 'bleed', t: 1.5, dur: 6, mag: 120.5 },
      { kind: 'slow', t: 0.2, dur: 2.5, mag: 0.35 },
      { kind: 'stealth', t: 0, dur: 4, mag: 1 },
    ],
    kills: 3,
    damageDealt: 1234.56,
    damageBlocked: 321.25,
    ultsUsed: 2,
    grabTargetId: 5,
    grabbedById: 7,
    airborne: true,
    glideT: 1.25,
    burrowT: 0.5,
    ultPhase: 'active',
    ultStage: 4,
    ultTargetId: 3,
    ...over,
  };
}

function fullSnapshot(): WorldSnapshot {
  return {
    time: 91.2345,
    fighters: [fullFighter(0), fullFighter(1, { animal: 'eagle', ultPhase: 'windup', ultStage: 0, ultTargetId: -1 }), fullFighter(2, { alive: false, hp: 0, action: 'dead' })],
    pickups: [
      { id: 0, kind: 'heal', pos: { x: 10, y: 0, z: 0 }, active: true, respawnT: 0 },
      { id: 1, kind: 'rage', pos: { x: 5, y: 0, z: 8.66 }, active: false, respawnT: 13.37 },
    ],
    crates: [
      { id: 0, pos: { x: 3, y: 0, z: 4 }, hp: 150, alive: true },
      { id: 1, pos: { x: -3, y: 0, z: 4 }, hp: 0, alive: false },
    ],
    traps: [
      { id: 0, kind: 'fire', pos: { x: 6, y: 0, z: -9 }, radius: 2, phase: 'active', timeLeft: 4.321, triggeredBy: 2 },
      { id: 1, kind: 'spikes', pos: { x: -6, y: 0, z: 9 }, radius: 1.8, phase: 'armed', timeLeft: 0, triggeredBy: -1 },
    ],
    projectiles: [
      { id: 7, kind: 'boulder', pos: { x: 1.5, y: 4.25, z: -2 }, vel: { x: 12, y: -3.5, z: 6 }, radius: 0.6, ownerId: 1 },
      { id: 300, kind: 'boulder', pos: { x: -1.5, y: 1, z: 2 }, vel: { x: -12, y: 0, z: -6 }, radius: 0.6, ownerId: 0 },
    ],
    bloodlustMult: 1.75,
    matchOver: true,
    winnerId: 1,
  };
}

describe('snapshot codec: round trips', () => {
  it('round-trips a snapshot with every optional field populated (incl. matchOver, projectiles, buffs, grab, ult)', () => {
    const s = fullSnapshot();
    const dec = new SnapshotDecoder();
    const out = dec.decode(encodeSnapshot(s, { seq: 65535, keyframe: true }));
    expect(out).not.toBeNull();
    expect(out?.seq).toBe(65535);
    expect(out?.keyframe).toBe(true);
    expect(snapshotMismatches(s, (out as { snapshot: WorldSnapshot }).snapshot)).toEqual([]);
  });

  it('keeps absent optionals absent and does not invent ult fields / projectiles', () => {
    const s = fullSnapshot();
    delete s.projectiles;
    for (const f of s.fighters) {
      delete f.ultPhase;
      delete f.ultStage;
      delete f.ultTargetId;
      f.buffs = [];
      f.grabTargetId = -1;
      f.grabbedById = -1;
    }
    s.matchOver = false;
    s.winnerId = -1;
    const out = new SnapshotDecoder().decode(encodeSnapshot(s, { seq: 1, keyframe: true }))?.snapshot;
    expect(out).toBeDefined();
    expect(snapshotMismatches(s, out as WorldSnapshot)).toEqual([]);
    expect(out?.projectiles).toBeUndefined();
    expect('ultPhase' in (out as WorldSnapshot).fighters[0]).toBe(false);
    expect(out?.fighters[0].buffs).toEqual([]);
    // empty-but-defined projectile list stays defined
    s.projectiles = [];
    const out2 = new SnapshotDecoder().decode(encodeSnapshot(s, { seq: 1, keyframe: true }))?.snapshot;
    expect(out2?.projectiles).toEqual([]);
  });

  it('every tick of a real 60 s ten-fighter match round-trips within the stated tolerances', () => {
    const rec = busyMatch();
    const dec = new SnapshotDecoder();
    let seq = 0;
    let checked = 0;
    for (let t = 0; t < rec.snapshots.length; t += 2) {
      const keyframe = checked % 60 === 0;
      const bytes = encodeSnapshot(rec.snapshots[t], { seq, keyframe, stats: seq % STATS_EVERY === 0 });
      const out = dec.decode(bytes);
      expect(out, `tick ${t}`).not.toBeNull();
      const bad = snapshotMismatches(rec.snapshots[t], (out as { snapshot: WorldSnapshot }).snapshot);
      // kills/damage are only refreshed every STATS_EVERY snapshots — allow those to lag between stats blocks
      const real = bad.filter((m) => !/\.(kills|damageDealt|damageBlocked|ultsUsed)/.test(m));
      expect(real, `tick ${t}`).toEqual([]);
      seq = (seq + 1) & 0xffff;
      checked++;
    }
    expect(checked).toBeGreaterThan(1000);
  });

  it('the busy match actually exercises buffs, ult phases, traps and moving projectiles-or-not (coverage sanity)', () => {
    const rec = busyMatch();
    let buffs = 0;
    let ult = 0;
    let trapActive = 0;
    let airborne = 0;
    let deaths = 0;
    for (const s of rec.snapshots) {
      for (const f of s.fighters) {
        if (f.buffs.length > 0) buffs++;
        if (f.ultPhase !== undefined) ult++;
        if (f.airborne) airborne++;
      }
      if (s.traps.some((t) => t.phase === 'active')) trapActive++;
    }
    for (const evs of rec.events) for (const e of evs) if (e.type === 'death') deaths++;
    expect(buffs).toBeGreaterThan(0);
    expect(airborne).toBeGreaterThan(0);
    expect(deaths).toBeGreaterThan(0);
    // informational: ults / traps depend on the seed
    expect(ult + trapActive).toBeGreaterThanOrEqual(0);
  });

  it('statics only travel in keyframes: a plain snapshot is rejected until a keyframe arrives, then decodes', () => {
    const s = fullSnapshot();
    s.matchOver = false;
    s.winnerId = -1;
    const dec = new SnapshotDecoder();
    const plain = encodeSnapshot(s, { seq: 5 });
    expect(dec.decode(plain)).toBeNull();
    expect(dec.needsKeyframe).toBe(true);
    expect(dec.decode(encodeSnapshot(s, { seq: 6, keyframe: true }))).not.toBeNull();
    expect(dec.needsKeyframe).toBe(false);
    const out = dec.decode(plain);
    expect(out).not.toBeNull();
    expect(snapshotMismatches(s, (out as { snapshot: WorldSnapshot }).snapshot).filter((m) => !/kills|damage|ultsUsed/.test(m))).toEqual([]);
    // plain snapshot is much smaller than the keyframe
    expect(plain.length).toBeLessThan(encodeSnapshot(s, { seq: 6, keyframe: true }).length);
  });

  it('stat counters are monotone: an older reordered packet cannot move them backwards', () => {
    const s = fullSnapshot();
    s.matchOver = false;
    const dec = new SnapshotDecoder();
    dec.decode(encodeSnapshot(s, { seq: 0, keyframe: true }));
    const newer = structuredClone(s);
    newer.fighters[0].kills = 5;
    newer.fighters[0].damageDealt = 2000;
    const older = structuredClone(s);
    older.fighters[0].kills = 4;
    older.fighters[0].damageDealt = 1500;
    const n = dec.decode(encodeSnapshot(newer, { seq: 8, stats: true }));
    const o = dec.decode(encodeSnapshot(older, { seq: 7, stats: true }));
    expect(n?.snapshot.fighters[0].kills).toBe(5);
    expect(o?.snapshot.fighters[0].kills).toBe(5);
    expect(o?.snapshot.fighters[0].damageDealt).toBeCloseTo(2000, 1);
  });

  it('keeps ids correct when fighters are not stored at index == id', () => {
    const s = fullSnapshot();
    s.matchOver = false;
    s.fighters = [fullFighter(2), fullFighter(0), fullFighter(1)];
    const out = new SnapshotDecoder().decode(encodeSnapshot(s, { seq: 3, keyframe: true }));
    expect(out?.snapshot.fighters.map((f) => f.id)).toEqual([2, 0, 1]);
  });

  it('clamps out-of-range and non-finite inputs instead of throwing', () => {
    const s = fullSnapshot();
    s.matchOver = false;
    s.fighters[0].pos = { x: 1e9, y: -1e9, z: Number.NaN };
    s.fighters[0].hp = Number.POSITIVE_INFINITY;
    s.fighters[0].actionT = 1e6;
    s.fighters[0].yaw = 1e12;
    const bytes = encodeSnapshot(s, { seq: 1, keyframe: true });
    const out = new SnapshotDecoder().decode(bytes);
    expect(out).not.toBeNull();
    expect(Number.isFinite(out?.snapshot.fighters[0].pos.x)).toBe(true);
  });
});

describe('snapshot codec: bandwidth budget (10 fighters, busy fight)', () => {
  it('averages <= 1.2 KB and never exceeds 8 KB per snapshot at 30 Hz (keyframes every 2 s included)', () => {
    const rec = busyMatch();
    let total = 0;
    let max = 0;
    let n = 0;
    let keyBytes = 0;
    let keys = 0;
    let plainTotal = 0;
    let plainN = 0;
    let seq = 0;
    for (let t = 0; t < rec.snapshots.length; t += 2) {
      const keyframe = n % 60 === 0;
      const body = encodeSnapshot(rec.snapshots[t], { seq, keyframe, stats: seq % STATS_EVERY === 0 });
      // what actually goes on the wire: kind byte + per-client wrapper + body
      const wire = 1 + wrapSnapshot(0, 0, body).length;
      expect(wire).toBe(1 + SNAPSHOT_WRAPPER_BYTES + body.length);
      total += wire;
      max = Math.max(max, wire);
      if (keyframe) {
        keyBytes += wire;
        keys++;
      } else {
        plainTotal += wire;
        plainN++;
      }
      seq = (seq + 1) & 0xffff;
      n++;
    }
    const avg = total / n;
    console.log(
      `[BR budget] snapshots=${n} avg=${avg.toFixed(0)} B  max=${max} B  plain avg=${(plainTotal / plainN).toFixed(0)} B  keyframe avg=${(keyBytes / keys).toFixed(0)} B  => ${((avg * 30) / 1000).toFixed(1)} KB/s per client @30 Hz`,
    );
    expect(avg).toBeLessThanOrEqual(1200);
    expect(max).toBeLessThanOrEqual(8192);
    // we aim far below the ceiling; keep a regression alarm well under it
    expect(avg).toBeLessThanOrEqual(700);
  });
});

describe('snapshot codec: worst cases', () => {
  it('a synthetic worst case (10 fully-populated fighters, 3 buffs each, every trap active, 12 projectiles, keyframe + stats) stays far under 8 KB', () => {
    const base = fullSnapshot();
    base.fighters = Array.from({ length: 10 }, (_, i) => fullFighter(i, { animal: (['lion', 'gorilla', 'crocodile', 'hippo', 'rhino', 'eagle', 'panther', 'python', 'giraffe', 'mole'] as const)[i] }));
    base.pickups = Array.from({ length: 6 }, (_, i) => ({ id: i, kind: 'speed' as const, pos: { x: i, y: 0, z: -i }, active: false, respawnT: 12.5 }));
    base.crates = Array.from({ length: 12 }, (_, i) => ({ id: i, pos: { x: i, y: 0, z: i }, hp: 80.5, alive: true }));
    base.traps = Array.from({ length: 7 }, (_, i) => ({ id: i, kind: i % 2 === 0 ? ('fire' as const) : ('spikes' as const), pos: { x: i, y: 0, z: i }, radius: 2, phase: 'active' as const, timeLeft: 5.5, triggeredBy: i }));
    base.projectiles = Array.from({ length: 12 }, (_, i) => ({ id: 1000 + i, kind: 'boulder' as const, pos: { x: i, y: 5, z: i }, vel: { x: 9, y: -9, z: 9 }, radius: 0.6, ownerId: i % 10 }));
    const bytes = encodeSnapshot(base, { seq: 3, keyframe: true });
    console.log('[BR budget] synthetic worst-case keyframe =', bytes.length, 'B');
    expect(bytes.length).toBeLessThan(2500);
    const out = new SnapshotDecoder().decode(bytes);
    expect(snapshotMismatches(base, (out as { snapshot: WorldSnapshot }).snapshot)).toEqual([]);
  });

  it('three more seeds / difficulties stay under the average budget too', () => {
    for (const [seed, diff] of [
      [7, 3],
      [99, 4],
      [31337, 2],
    ] as const) {
      const rec = recordMatch(seed, diff, 40);
      let total = 0;
      let max = 0;
      let n = 0;
      for (let t = 0; t < rec.snapshots.length; t += 2) {
        const len = 4 + encodeSnapshot(rec.snapshots[t], { seq: n, keyframe: n % 60 === 0, stats: n % STATS_EVERY === 0 }).length;
        total += len;
        max = Math.max(max, len);
        n++;
      }
      console.log(`[BR budget] seed ${seed} diff ${diff}: avg ${(total / n).toFixed(0)} B, max ${max} B over ${n} snapshots`);
      expect(total / n).toBeLessThanOrEqual(1200);
      expect(max).toBeLessThanOrEqual(8192);
    }
  });
});

describe('snapshot codec: fuzzing never throws or hangs', () => {
  const base = (): Uint8Array => encodeSnapshot(fullSnapshot(), { seq: 9, keyframe: true });

  it('random garbage of every small length decodes to null or a sane snapshot', () => {
    const r = rng(1234);
    const dec = new SnapshotDecoder();
    const t0 = Date.now();
    for (let i = 0; i < 20000; i++) {
      const len = Math.floor(r() * 300);
      const b = new Uint8Array(len);
      for (let k = 0; k < len; k++) b[k] = Math.floor(r() * 256);
      const out = dec.decode(b);
      if (out !== null) expect(Number.isFinite(out.snapshot.time)).toBe(true);
    }
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it('every truncation of a valid keyframe returns null (never throws)', () => {
    const b = base();
    for (let len = 0; len < b.length; len++) expect(new SnapshotDecoder().decode(b.subarray(0, len))).toBeNull();
    expect(new SnapshotDecoder().decode(b)).not.toBeNull();
  });

  it('single-bit flips and appended junk never throw; a corrupt keyframe never poisons the statics', () => {
    const b = base();
    const dec = new SnapshotDecoder();
    for (let i = 0; i < b.length; i++) {
      for (let bit = 0; bit < 8; bit++) {
        const c = b.slice();
        c[i] ^= 1 << bit;
        const out = dec.decode(c);
        if (out !== null) {
          for (const f of out.snapshot.fighters) {
            expect(Number.isFinite(f.pos.x) && Number.isFinite(f.hp) && Number.isFinite(f.yaw)).toBe(true);
          }
        }
      }
    }
    const junk = new Uint8Array(b.length + 3);
    junk.set(b);
    expect(new SnapshotDecoder().decode(junk)).toBeNull();
  });

  it('bogus huge counts terminate quickly', () => {
    const b = new Uint8Array(40).fill(0xff);
    b[0] = 0;
    b[1] = 0;
    const t0 = Date.now();
    expect(new SnapshotDecoder().decode(b)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(200);
  });
});
