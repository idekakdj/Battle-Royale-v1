import { describe, it, expect } from 'vitest';
import { World } from '../../src/sim/World';
import { EventBus } from '../../src/core/EventBus';
import { ANIMAL_IDS } from '../../src/config/animals';
import type { AnimalId, FighterIntent, MatchConfig } from '../../src/core/types';

const DT = 1 / 60;

/**
 * Deterministic scripted intents: every fighter runs toward the arena centre,
 * attacks every ~0.4 s, blocks in bursts, and fires special/ultimate on a
 * per-fighter phase. Pure function of (fighterId, tick) — no randomness.
 */
function scriptedIntent(world: World, id: number, tick: number, out: FighterIntent): FighterIntent {
  const f = world.fighters[id].state;
  const toCenterX = -f.pos.x;
  const toCenterZ = -f.pos.z;
  const len = Math.hypot(toCenterX, toCenterZ) || 1;
  out.moveX = toCenterX / len;
  out.moveZ = toCenterZ / len;
  out.aimYaw = Math.atan2(toCenterX, toCenterZ);
  out.attack = (tick + id * 7) % 24 === 0;
  out.block = (tick + id * 11) % 90 < 12;
  out.special = (tick + id * 13) % 300 === 0;
  out.ultimate = (tick + id * 17) % 240 === 0;
  out.jump = (tick + id * 5) % 180 < 6;
  return out;
}

function runWorld(seed: number, steps: number): string {
  const cfg: MatchConfig = {
    roster: (ANIMAL_IDS as AnimalId[]).map((a, i) => ({ animal: a, isPlayer: i === 0 })),
    difficulty: 1,
  };
  const world = new World(cfg, seed, new EventBus());
  const intent: FighterIntent = {
    moveX: 0,
    moveZ: 0,
    aimYaw: 0,
    attack: false,
    block: false,
    special: false,
    ultimate: false,
    jump: false,
  };
  for (let t = 0; t < steps; t++) {
    for (let id = 0; id < world.fighters.length; id++) {
      world.setIntent(id, scriptedIntent(world, id, t, intent));
    }
    world.step(DT);
  }
  return JSON.stringify(world.snapshot());
}

describe('determinism (§5 / WP-B acceptance)', () => {
  it('two Worlds with the same seed + scripted intents match exactly after 3600 steps', () => {
    const a = runWorld(1337, 3600);
    const b = runWorld(1337, 3600);
    expect(a).toBe(b);
  });

  it('a different seed diverges (sanity check that the RNG is actually used)', () => {
    const a = runWorld(1337, 3600);
    const c = runWorld(7331, 3600);
    expect(a).not.toBe(c);
  });
});
