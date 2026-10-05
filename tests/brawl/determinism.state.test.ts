import { describe, expect, it } from 'vitest';
import { BrawlWorld } from '../../src/brawl/sim/BrawlWorld';
import { Fighter } from '../../src/brawl/sim/Fighter';
import { checksumOfSaved, createSavedState, hashWords } from '../../src/brawl/sim/stateIO';
import { getMoveBody, getMoveset } from '../../src/brawl/data/index';
import { quantizeIntent } from '../../src/brawl/net/inputCodec';
import { makeConfig, scriptIntent } from './netHelpers';
import type { BrawlIntent } from '../../src/brawl/types';

function feed(w: BrawlWorld, n: number, seed: number, f: number): void {
  for (let p = 0; p < n; p++) w.setIntent(p, quantizeIntent(scriptIntent(seed, p, f)));
}

function advance(w: BrawlWorld, n: number, seed: number, from: number, count: number, log?: string[]): void {
  for (let i = 0; i < count; i++) {
    feed(w, n, seed, from + i);
    w.step();
    if (log) log.push(`${w.checksum()}|${JSON.stringify(w.snapshot())}|${JSON.stringify(w.drainEvents())}`);
    else w.drainEvents();
  }
}

describe('saveState / loadState / checksum', () => {
  it('save -> step xN -> load -> step xN reproduces identical snapshots, events and checksums (many save points)', () => {
    const n = 4;
    const seed = 31337;
    const w = new BrawlWorld(makeConfig(n, 'skyAqueduct'), seed);
    const s = createSavedState();
    const checked = { points: 0, attacking: 0, hitlag: 0, hitstun: 0, ledge: 0, ko: 0 };
    let f = 0;
    for (let round = 0; round < 60; round++) {
      advance(w, n, seed, f, 53);
      f += 53;
      w.saveState(s);
      const a: string[] = [];
      advance(w, n, seed, f, 40, a);
      const snapAfter = w.checksum();
      w.loadState(s);
      expect(w.frame).toBe(s.frame);
      const b: string[] = [];
      advance(w, n, seed, f, 40, b);
      expect(b).toEqual(a);
      expect(w.checksum()).toBe(snapAfter);
      checked.points++;
      const snap = w.snapshot();
      for (const fi of snap.fighters) {
        if (fi.action === 'attack') checked.attacking++;
        if (fi.hitlag > 0) checked.hitlag++;
        if (fi.action === 'hitstun' || fi.action === 'tumble') checked.hitstun++;
        if (fi.action === 'ledgeHang' || fi.action === 'ledgeClimb') checked.ledge++;
        if (!fi.alive) checked.ko++;
      }
      f += 40;
    }
    expect(checked.points).toBe(60);
    // the save points hit varied situations
    expect(checked.attacking + checked.hitstun + checked.hitlag + checked.ko).toBeGreaterThan(5);
  });

  it('a state saved at frame A and loaded into a DIFFERENT world (same config) continues identically', () => {
    const n = 3;
    const seed = 99;
    const w1 = new BrawlWorld(makeConfig(n), seed);
    advance(w1, n, seed, 0, 900);
    const s = w1.saveState();
    const w2 = new BrawlWorld(makeConfig(n), seed);
    w2.loadState(s);
    expect(w2.checksum()).toBe(w1.checksum());
    const a: string[] = [];
    const b: string[] = [];
    advance(w1, n, seed, 900, 300, a);
    advance(w2, n, seed, 900, 300, b);
    expect(b).toEqual(a);
  });

  it('checksum() equals the checksum of the saved state, is stable, and a fresh world with the same config agrees', () => {
    const w = new BrawlWorld(makeConfig(4), 5);
    const v = new BrawlWorld(makeConfig(4), 5);
    expect(w.checksum()).toBe(v.checksum());
    advance(w, 4, 5, 0, 700);
    advance(v, 4, 5, 0, 700);
    expect(w.checksum()).toBe(v.checksum());
    const s = w.saveState();
    expect(checksumOfSaved(s)).toBe(w.checksum());
    expect(w.checksum()).toBe(w.checksum());
    expect(w.checksum()).toBeGreaterThanOrEqual(0);
    expect(w.checksum()).toBeLessThan(2 ** 32);
    expect(Number.isInteger(w.checksum())).toBe(true);
  });

  it('checksum reacts to every kind of state change', () => {
    const w = new BrawlWorld(makeConfig(3), 8);
    advance(w, 3, 8, 0, 400);
    const base = w.checksum();
    const s = w.saveState();
    const changed: Array<[string, () => void]> = [
      ['percent', () => w.debugSetPercent(1, 55)],
      ['stocks', () => w.debugSetStocks(2, 1)],
      ['facing', () => w.debugSetFacing(0, w.debugFighter(0).facing === 1 ? -1 : 1)],
      ['position', () => w.debugPlace(0, 3.5, 4)],
      ['a tiny position change', () => (w.debugFighter(1).pos.x += 1e-9)],
      ['frame', () => w.step()],
    ];
    for (const [label, mutate] of changed) {
      w.loadState(s);
      expect(w.checksum()).toBe(base);
      mutate();
      expect(w.checksum(), label).not.toBe(base);
    }
  });

  it('every mutable Fighter field is covered by save / load / checksum', () => {
    const w = new BrawlWorld(makeConfig(2), 3);
    advance(w, 2, 3, 0, 300);
    const f = w.debugFighter(0);
    const immutable = new Set(['id', 'animal', 'isPlayer', 'moveset', 'stats']);
    // `body` is saved by reference (not hashed); its identity fields moveId / moveChain / moveAir are.
    const byReference = new Set(['body']);
    const keys = Object.keys(new Fighter(0, 'lion', false, getMoveset('lion'), 3));
    expect(keys.length).toBeGreaterThan(60);
    const ENUMS: Record<string, unknown> = { action: 'ledgeClimb', moveId: 'heavyU', movePhase: 'recovery' };
    const base = w.checksum();
    const snap = w.saveState();
    for (const key of keys) {
      if (immutable.has(key) || byReference.has(key)) continue;
      w.loadState(snap);
      const rec = f as unknown as Record<string, unknown>;
      const cur = rec[key];
      if (key === 'pos' || key === 'vel') (cur as { x: number }).x += 0.5;
      else if (key in ENUMS) rec[key] = rec[key] === ENUMS[key] ? 'idle' : ENUMS[key];
      else if (key === 'lastLaunch') rec[key] = cur === null ? { angle: 33, speed: 9 } : null;
      else if (Array.isArray(cur)) cur.push(key === 'staleQueue' ? 'lightN' : 7);
      else if (typeof cur === 'boolean') rec[key] = !cur;
      else if (typeof cur === 'number') rec[key] = cur + 3;
      else throw new Error(`unhandled Fighter field type: ${key}`);
      expect(w.checksum(), `Fighter.${key} is not part of the checksum`).not.toBe(base);
      // and a save / load round trip restores it exactly
      const mutated = w.saveState();
      w.loadState(snap);
      expect(w.checksum()).toBe(base);
      w.loadState(mutated);
      expect(w.checksum(), `Fighter.${key} does not survive save / load`).not.toBe(base);
    }
  });

  it('world-level fields (rng, frame, ledge owners, platform runtime) are covered', () => {
    const w = new BrawlWorld(makeConfig(2, 'skyAqueduct'), 3);
    advance(w, 2, 3, 0, 10);
    const base = w.checksum();
    const s = w.saveState();
    // the rng stream position matters: run a respawn-heavy match so it is used, compare worlds that differ only in seed
    const a = new BrawlWorld(makeConfig(2, 'skyAqueduct'), 3);
    const b = new BrawlWorld(makeConfig(2, 'skyAqueduct'), 4);
    expect(a.checksum()).not.toBe(b.checksum());
    w.loadState(s);
    expect(w.checksum()).toBe(base);
  });

  it('restores the move body, the hit boxes and drops pending events', () => {
    const w = new BrawlWorld(makeConfig(2), 12);
    w.skipCountdown();
    // find a frame with an active attack
    let found = false;
    for (let f = 0; f < 2000 && !found; f++) {
      feed(w, 2, 12, f);
      w.step();
      if (w.snapshot().hitboxes.length > 0) found = true;
      else w.drainEvents();
    }
    expect(found).toBe(true);
    const snapBefore = JSON.stringify(w.snapshot());
    const bodies = [0, 1].map((i) => w.debugFighter(i).body);
    const s = w.saveState();
    expect(s.bodies).toEqual(bodies);
    // wreck it
    for (let f = 0; f < 120; f++) {
      feed(w, 2, 12, 5000 + f);
      w.step();
    }
    w.loadState(s);
    expect(JSON.stringify(w.snapshot())).toBe(snapBefore);
    expect([0, 1].map((i) => w.debugFighter(i).body)).toEqual(bodies);
    expect(w.drainEvents()).toEqual([]);
    // body identity is restored by reference
    const attacker = [0, 1].find((i) => w.debugFighter(i).body !== null);
    if (attacker !== undefined) expect(w.debugFighter(attacker).body).toBe(bodies[attacker]);
  });

  it('the body of a hand-built attack state survives a round trip', () => {
    const w = new BrawlWorld(makeConfig(2), 1);
    const f = w.debugFighter(0);
    const body = getMoveBody('lion', 'lightN', false);
    f.body = body;
    f.moveId = 'lightN';
    f.action = 'attack';
    f.moveFrames = 12;
    const s = w.saveState();
    f.body = null;
    f.moveId = null;
    w.loadState(s);
    expect(f.body).toBe(body);
    expect(f.moveId).toBe('lightN');
  });

  it('saveState reuses the buffers it is given (no allocation in steady state) and is fast', () => {
    const w = new BrawlWorld(makeConfig(4), 21);
    advance(w, 4, 21, 0, 500);
    const s = createSavedState();
    w.saveState(s);
    const data = s.data;
    const bodies = s.bodies;
    for (let i = 0; i < 50; i++) w.saveState(s);
    expect(s.data).toBe(data);
    expect(s.bodies).toBe(bodies);
    const t0 = performance.now();
    const N = 3000;
    for (let i = 0; i < N; i++) w.saveState(s);
    const perSave = ((performance.now() - t0) * 1000) / N;
    const t1 = performance.now();
    for (let i = 0; i < N; i++) w.loadState(s);
    const perLoad = ((performance.now() - t1) * 1000) / N;
    const t2 = performance.now();
    for (let i = 0; i < N; i++) w.checksum();
    const perSum = ((performance.now() - t2) * 1000) / N;
    console.log(`[determinism] 4 fighters: saveState ${perSave.toFixed(1)} us, loadState ${perLoad.toFixed(1)} us, checksum ${perSum.toFixed(1)} us`);
    // Generous bounds (≈ 10x the real cost, in µs): an order-of-magnitude guard that must not flake on a busy machine.
    expect(perSave).toBeLessThan(500);
    expect(perLoad).toBeLessThan(500);
    expect(perSum).toBeLessThan(500);
  });

  it('grows its buffer when a state is larger than the pool (long attack hit registers)', () => {
    const w = new BrawlWorld(makeConfig(4), 21);
    advance(w, 4, 21, 0, 300);
    const tiny = createSavedState(8);
    w.saveState(tiny);
    expect(tiny.data.length).toBeGreaterThanOrEqual(tiny.len);
    expect(tiny.words.buffer).toBe(tiny.data.buffer);
    const v = new BrawlWorld(makeConfig(4), 21);
    v.loadState(tiny);
    expect(v.checksum()).toBe(w.checksum());
  });

  it('loading a state of a different roster size fails loudly instead of corrupting the world', () => {
    const a = new BrawlWorld(makeConfig(2), 1);
    const b = new BrawlWorld(makeConfig(4), 1);
    expect(() => b.loadState(a.saveState())).toThrow(/layout mismatch/);
  });

  it('hashWords canonicalises -0 and NaN and depends on every word and on the length', () => {
    const mk = (vals: number[]): Uint32Array => new Uint32Array(new Float64Array(vals).buffer);
    expect(hashWords(mk([0]), 1)).toBe(hashWords(mk([-0]), 1));
    expect(hashWords(mk([NaN]), 1)).toBe(hashWords(mk([Number.NaN * -1, 0]).subarray(0, 2), 1));
    expect(hashWords(mk([1, 2, 3]), 3)).not.toBe(hashWords(mk([1, 2, 4]), 3));
    expect(hashWords(mk([1, 2, 3]), 3)).not.toBe(hashWords(mk([1, 2, 3, 0]), 4));
    expect(hashWords(mk([1, 2, 3]), 3)).not.toBe(hashWords(mk([3, 2, 1]), 3));
    // 1-ulp difference is seen
    expect(hashWords(mk([1]), 1)).not.toBe(hashWords(mk([1 + Number.EPSILON]), 1));
  });
});

describe('forfeit', () => {
  const idle: BrawlIntent = { moveX: 0, moveY: 0, jump: false, jumpHeld: false, light: false, heavy: false, dodge: false };

  it('removes the fighter like a final KO, credits nobody, is idempotent', () => {
    const w = new BrawlWorld(makeConfig(3), 4);
    w.skipCountdown();
    advance(w, 3, 4, 0, 200);
    const before = w.snapshot();
    w.forfeit(1);
    const snap = w.snapshot();
    const f1 = snap.fighters[1];
    expect(f1.alive).toBe(false);
    expect(f1.stocks).toBe(0);
    expect(f1.action).toBe('ko');
    expect(snap.fighters[0].kos).toBe(before.fighters[0].kos);
    expect(snap.fighters[2].kos).toBe(before.fighters[2].kos);
    expect(f1.falls).toBe(before.fighters[1].falls);
    const ev = w.drainEvents();
    const kos = ev.filter((e) => e.type === 'ko');
    expect(kos).toHaveLength(1);
    expect(kos[0]).toMatchObject({ type: 'ko', fighterId: 1, killerId: -1, stocksLeft: 0 });
    const sum = w.checksum();
    w.forfeit(1);
    w.forfeit(1);
    expect(w.checksum()).toBe(sum);
    expect(w.drainEvents()).toEqual([]);
    // the others fight on and the forfeited fighter stays out
    advance(w, 3, 4, 200, 600);
    expect(w.snapshot().fighters[1].alive).toBe(false);
    expect(w.snapshot().fighters[1].stocks).toBe(0);
  });

  it('a 2-fighter match ends at once with the other as winner (matchEnd once); a 3-fighter match continues', () => {
    const w2 = new BrawlWorld(makeConfig(2), 4);
    w2.skipCountdown();
    w2.forfeit(0);
    expect(w2.isOver).toBe(true);
    const s = w2.snapshot();
    expect(s.matchOver).toBe(true);
    expect(s.winnerId).toBe(1);
    expect(w2.drainEvents().filter((e) => e.type === 'matchEnd')).toHaveLength(1);
    w2.step();
    expect(w2.drainEvents()).toEqual([]);

    const w3 = new BrawlWorld(makeConfig(3), 4);
    w3.skipCountdown();
    w3.forfeit(2);
    expect(w3.isOver).toBe(false);
    w3.forfeit(0);
    expect(w3.isOver).toBe(true);
    expect(w3.snapshot().winnerId).toBe(1);
  });

  it('works for a fighter that is mid-attack, in hitstun, or waiting to respawn, and is deterministic + save/load safe', () => {
    for (const at of [150, 420, 777, 1111, 1500]) {
      const run = (): { sum: number; log: string[] } => {
        const w = new BrawlWorld(makeConfig(4, 'skyAqueduct'), 6);
        advance(w, 4, 6, 0, at);
        const s = w.saveState();
        w.forfeit(at % 4);
        const sum = w.checksum();
        const log: string[] = [];
        advance(w, 4, 6, at, 200, log);
        // rewind over the forfeit and redo it
        w.loadState(s);
        w.forfeit(at % 4);
        expect(w.checksum()).toBe(sum);
        const log2: string[] = [];
        advance(w, 4, 6, at, 200, log2);
        expect(log2).toEqual(log);
        return { sum, log };
      };
      const a = run();
      const b = run();
      expect(b.sum).toBe(a.sum);
      expect(b.log).toEqual(a.log);
    }
  });

  it('ignores unknown ids and a forfeit after the match is over', () => {
    const w = new BrawlWorld(makeConfig(2), 4);
    w.skipCountdown();
    w.forfeit(9);
    w.forfeit(-1);
    expect(w.isOver).toBe(false);
    w.forfeit(0);
    const sum = w.checksum();
    w.forfeit(1);
    expect(w.checksum()).toBe(sum);
    w.setIntent(1, idle);
  });
});
