import { describe, expect, it } from 'vitest';
import { moveInfo, probeHit } from '../../src/brawl/ai/moveInfo';
import { BrawlBot } from '../../src/brawl/ai';
import { BrawlWorld } from '../../src/brawl/sim/BrawlWorld';
import { MOVESETS } from '../../src/brawl/data';

/**
 * v1.6: the bots' move knowledge (moveInfo / probeHit) understands the mole's ground Burrow Strike: the 3.3 m tunnel, the underground
 * (invulnerable) window, the upward eruption, the platform-edge clip; and a bot treats an underground opponent as untouchable.
 */

describe('bots know the burrow', () => {
  const info = moveInfo('mole', 'heavyD', false);
  const mole = MOVESETS.mole.stats;

  it('moveInfo: tunnel travel, underground / invulnerable window, upward launcher, edge-stopping', () => {
    expect(info.burrow).toEqual({ from: 6, to: 24 });
    expect(info.invuln).toEqual({ from: 6, to: 24 });
    expect(info.stopsAtEdge).toBe(true);
    expect(info.travelX).toBeCloseTo(3.3, 1); // no slide after surfacing: the sim stops the mole dead
    expect(info.first).toBe(24);
    expect(info.main.angle).toBeGreaterThanOrEqual(80);
    expect(info.main.angle).toBeLessThanOrEqual(100);
    // the air form is the plain drill-down
    const air = moveInfo('mole', 'heavyD', true);
    expect(air.burrow).toBeNull();
    expect(air.invuln).toBeNull();
    expect(air.stopsAtEdge).toBe(false);
    expect(air.travelX).toBeLessThan(0.5);
  });

  it('probeHit: the eruption lands ~3.3 m ahead; at a platform end it is clipped to the room left', () => {
    // target feet 3.5 m ahead: inside the eruption circle (centre 3.3 + 0.5 forward, radius 0.95)
    expect(probeHit(info, 3.5, 0, mole.width, mole.height).frame).toBe(24);
    // a target right in front of the mole is NOT hit (the mole has already tunnelled past it)
    expect(probeHit(info, 0.4, 0, mole.width, mole.height).frame).toBe(-1);
    // only 1.0 m of platform in front of the mole: the eruption is where the mole stops, so a target 3.5 m ahead is out of reach...
    expect(probeHit(info, 3.5, 0, mole.width, mole.height, 0, 0, 0, 0, 1.0).frame).toBe(-1);
    // ...and one 1.4 m ahead (just beyond the edge, 0.4 m past it) is within the clipped eruption
    expect(probeHit(info, 1.4, 0, mole.width, mole.height, 0, 0, 0, 0, 1.0).frame).toBe(24);
    // other moves ignore `room`
    const lunge = moveInfo('mole', 'heavyS', false);
    expect(lunge.stopsAtEdge).toBe(false);
    expect(probeHit(lunge, 1.5, 0, mole.width, mole.height, 0, 0, 0, 0, 0.1).frame).toBe(probeHit(lunge, 1.5, 0, mole.width, mole.height).frame);
  });

  it('a bot never swings at an opponent that is underground (it is untouchable until the eruption)', () => {
    const w = new BrawlWorld({ stage: 'brokenColosseum', roster: [{ animal: 'lion', isPlayer: false }, { animal: 'mole', isPlayer: false }], difficulty: 4, stocks: 3, timeLimitS: 0 }, 9);
    w.skipCountdown();
    w.debugPlace(0, -3, 0);
    w.debugPlace(1, -1.4, 0);
    for (let i = 0; i < 2; i++) w.step();
    w.debugSetFacing(1, -1);
    const bot = new BrawlBot(0, 4, 77);
    // the mole starts its burrow; every frame the lion bot decides on the snapshot
    w.setIntent(1, { moveX: 0, moveY: -1, jump: false, jumpHeld: false, light: false, heavy: true, dodge: false });
    w.step();
    w.setIntent(1, { moveX: 0, moveY: 0, jump: false, jumpHeld: false, light: false, heavy: false, dodge: false });
    let swingsWhileUnderground = 0;
    for (let f = 0; f < 40; f++) {
      const snap = w.snapshot();
      const m = snap.fighters[1];
      const intent = bot.update(snap);
      w.setIntent(0, intent);
      w.step();
      const l = w.snapshot().fighters[0];
      if (m.underground && m.moveFrame >= 8 && m.moveFrame < 20 && l.action === 'attack' && l.moveFrame <= 1) swingsWhileUnderground++;
    }
    // (a bot decides with a few frames of reaction delay, so a stray swing at the very first underground frames is tolerated)
    expect(swingsWhileUnderground).toBeLessThanOrEqual(2);
  });
});
