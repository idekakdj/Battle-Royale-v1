/**
 * Per-tick determinism fingerprint of full all-bot matches (v1.8 WP-J2 identity proof).
 *
 *   npx vite-node scripts/identity-hash.ts            (colosseum, the default; prints one hash line per match)
 *   ARENA=jungle SEEDS=3 npx vite-node scripts/identity-hash.ts
 *
 * Every tick it folds JSON.stringify(world.snapshot()) and the bots' intents into an FNV-1a chain, so ANY change of a
 * sim or bot decision at ANY tick changes the match hash. Run before and after a change that must not alter the
 * colosseum and diff the outputs (they must be byte-identical).
 */
import { World } from '../src/sim/World';
import { EventBus } from '../src/core/EventBus';
import { BotManager } from '../src/ai/BotManager';
import { ANIMAL_IDS } from '../src/config/animals';
import { mulberry32 } from '../src/core/math';
import { ARENA_IDS } from '../src/core/types';
import type { AnimalId, ArenaId, Difficulty, MatchConfig } from '../src/core/types';

const DT = 1 / 60;
const SEEDS = Number(process.env.SEEDS ?? 3);
const LEVELS = (process.env.LEVELS ?? '1,2,3,4').split(',').map((s) => Number(s.trim()) as Difficulty);
const MAX_S = Number(process.env.MAX_S ?? 300);
const ARENA: ArenaId = ((): ArenaId => {
  const v = process.env.ARENA ?? 'colosseum';
  if (!(ARENA_IDS as readonly string[]).includes(v)) throw new Error(`ARENA must be one of ${ARENA_IDS.join('|')}`);
  return v as ArenaId;
})();

function shuffled(seed: number, animals: readonly AnimalId[]): AnimalId[] {
  const order = [...animals];
  const rng = mulberry32(seed ^ 0x9e3779b9);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

function fold(h: number, str: string): number {
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

function play(seed: number, lvl: Difficulty, animals: readonly AnimalId[]): { hash: number; ticks: number; ended: boolean } {
  const cfg: MatchConfig = { roster: animals.map((a) => ({ animal: a, isPlayer: false })), difficulty: lvl, arena: ARENA };
  const bus = new EventBus();
  const world = new World(cfg, seed, bus, { traps: true });
  const bots = new BotManager(bus, lvl, seed, world.arena);
  let ended = false;
  bus.on('matchEnd', () => {
    ended = true;
  });
  let h = 2166136261 >>> 0;
  const maxTicks = Math.ceil((MAX_S + 3.5) / DT);
  let tick = 0;
  for (; tick < maxTicks && !ended; tick++) {
    const snap = world.snapshot();
    bots.update(snap, DT);
    for (let id = 0; id < animals.length; id++) world.setIntent(id, bots.getIntent(id));
    world.step(DT);
    h = fold(h, JSON.stringify(world.snapshot()));
    for (let id = 0; id < animals.length; id++) {
      const it = bots.getIntent(id);
      h = fold(h, `${it.moveX.toFixed(6)},${it.moveZ.toFixed(6)},${it.aimYaw.toFixed(6)},${+it.attack}${+it.block}${+it.special}${+it.ultimate}${+it.jump}`);
    }
  }
  return { hash: h, ticks: tick, ended };
}

const all = ANIMAL_IDS as readonly AnimalId[];
let chain = 2166136261 >>> 0;
for (const lvl of LEVELS) {
  for (let s = 1; s <= SEEDS; s++) {
    const seed = 1000 * lvl + s;
    const r = play(seed, lvl, shuffled(seed, all));
    chain = fold(chain, String(r.hash));
    console.log(`L${lvl} seed ${seed}: ticks=${r.ticks} ended=${r.ended} hash=${r.hash.toString(16)}`);
  }
}
console.log(`ARENA=${ARENA} chain=${chain.toString(16)}`);
