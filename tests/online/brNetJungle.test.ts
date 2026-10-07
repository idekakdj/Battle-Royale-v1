/**
 * v1.8 end-to-end: a Battle Royale host simulates the JUNGLE (real World + bots), a remote client walks into the pool, and the
 * client's rendered view carries the terrain flags and receives the `splash` events — through the real host / client sessions
 * over the loopback network (snapshot codec flags, event codec, de-duplication, interpolation).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { FighterIntent, GameEvent } from '../../src/core/types';
import { swapSample } from '../../src/online/br/BrNetClient';
import { JUNGLE_ARENA as J } from '../../src/config/arenas';
import { runSession, type Session } from './brNetHarness';
import { neutral } from './brTestUtil';

const POOL = J.terrain.find((z) => z.kind === 'water')!;
type Splash = Extract<GameEvent, { type: 'splash' }>;

/** The remote human wades back and forth through the pool: straight at the centre, then out the far side, again and again. */
function waderScript(_c: number, tick: number, truth: Session['truth'][number], slot: number): FighterIntent {
  const me = truth.fighters[slot];
  const out = neutral();
  if (!me.alive) return out;
  // 6 s toward the pool centre, 6 s away from it (v1.8 WP-J2: 4 s no longer reaches the water from the rim of the arena now that a
  // jump out of moss is a small hop, so the old script stopped just short of the pool)
  const phase = Math.floor(tick / 360) % 2;
  const dx = phase === 0 ? POOL.x - me.pos.x : me.pos.x - POOL.x;
  const dz = phase === 0 ? POOL.z - me.pos.z : me.pos.z - POOL.z;
  const l = Math.hypot(dx, dz) || 1;
  out.moveX = dx / l;
  out.moveZ = dz / l;
  out.aimYaw = Math.atan2(dx, dz);
  out.jump = tick % 97 === 0;
  return out;
}

let session: Session;
beforeAll(async () => {
  session = await runSession({ arena: 'jungle', seconds: 40, clients: 1, seed: 909, script: waderScript });
}, 120_000);

describe('BR online on the jungle', () => {
  it('the host simulated terrain: the remote fighter waded and splashed', () => {
    const mine = session.truthEvents.flat().filter((e): e is Splash => e.type === 'splash' && e.fighterId === 1);
    expect(mine.length).toBeGreaterThan(2);
    expect(mine.some((e) => e.entering)).toBe(true);
    expect(mine.some((e) => !e.entering)).toBe(true);
    expect(session.truth.some((s) => s.fighters[1].inWater === true)).toBe(true);
  });

  it('every splash the host emitted (except the last second) reaches the client once, intact', () => {
    const cutoff = session.truth.length - 90;
    const sent: Splash[] = [];
    session.truthEvents.forEach((evs, k) => {
      if (k < cutoff) for (const e of evs) if (e.type === 'splash') sent.push(e);
    });
    const got = session.released[0].map((r) => r.ev).filter((e): e is Splash => e.type === 'splash');
    expect(sent.length).toBeGreaterThan(2);
    expect(got.length).toBeGreaterThanOrEqual(sent.length);
    expect(got.length).toBeLessThanOrEqual(sent.length + 12); // the last second's worth may also have arrived
    sent.forEach((e, i) => {
      expect(got[i].fighterId).toBe(e.fighterId);
      expect(got[i].entering).toBe(e.entering);
      expect(Math.abs(got[i].strength - e.strength)).toBeLessThanOrEqual(0.5 / 255 + 1e-9);
      expect(Math.abs(got[i].pos.x - e.pos.x)).toBeLessThanOrEqual(0.0051);
      expect(Math.abs(got[i].pos.y - e.pos.y)).toBeLessThanOrEqual(0.0051);
    });
  });

  it('the client view carries the flags: wading frames agree with the host truth (except right at a shoreline flip)', () => {
    let wetFrames = 0;
    let agree = 0;
    let checked = 0;
    const truth = session.truth;
    for (const { sample } of session.frames[0]) {
      const v = sample.view.fighters[1];
      if (v === undefined) continue;
      // host truth at the snapshot's host time (view.time is host sim time)
      let k = Math.round((sample.view.time - truth[0].time) * 60);
      k = Math.max(0, Math.min(truth.length - 1, k));
      const t = truth[k].fighters[1];
      // skip the few ticks around a flip (the view shows the earlier snapshot's discrete fields)
      const near = [-8, -4, 4, 8].some((d) => truth[Math.max(0, Math.min(truth.length - 1, k + d))].fighters[1].inWater !== t.inWater);
      if (v.inWater === true) wetFrames++;
      if (near) continue;
      checked++;
      if ((v.inWater === true) === (t.inWater === true)) agree++;
    }
    expect(wetFrames).toBeGreaterThan(200);
    expect(checked).toBeGreaterThan(1000);
    expect(agree / checked).toBeGreaterThan(0.97);
  });

  it('the controller-facing sample (local player swapped to id 0) keeps the flags and remaps the splash ids', () => {
    let swappedFlag = false;
    let rawMine = 0;
    let swappedMine = 0;
    let rawHost = 0;
    let swappedHost = 0;
    for (const { sample } of session.frames[0]) {
      const m = swapSample(sample, 0, session.slots[0]);
      if (m.view.fighters[0].inWater === true) swappedFlag = true;
      for (const e of sample.events) if (e.type === 'splash') (e.fighterId === 1 ? rawMine++ : e.fighterId === 0 ? rawHost++ : 0);
      for (const e of m.events) if (e.type === 'splash') (e.fighterId === 0 ? swappedMine++ : e.fighterId === 1 ? swappedHost++ : 0);
    }
    expect(swappedFlag).toBe(true);
    expect(rawMine).toBeGreaterThan(2);
    expect(swappedMine).toBe(rawMine); // slot 1 became fighter 0 ...
    expect(swappedHost).toBe(rawHost); // ... and slot 0 became fighter 1
  });

  it('the colosseum session on the same harness never carries terrain flags or splash events', async () => {
    const col = await runSession({ seconds: 12, clients: 1, seed: 909, script: waderScript });
    expect(col.truth.every((s) => s.fighters.every((f) => f.inWater === undefined && f.onMoss === undefined))).toBe(true);
    expect(col.truthEvents.flat().some((e) => e.type === 'splash')).toBe(false);
    expect(col.frames[0].every((f) => f.sample.view.fighters.every((x) => x.inWater === undefined && x.onMoss === undefined))).toBe(true);
  }, 60_000);
});
