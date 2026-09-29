/**
 * Headless balance sweep: runs N all-bot matches per difficulty (10 animals, one
 * bot each) and prints, per animal, win rate / average placement plus the
 * economy readout (ults + specials cast per match, damage dealt, kills, share of
 * damage from basics / specials / ults) and match timing.
 *
 *   npm run balance                          (N=30, all four difficulties)
 *   N=60 LEVELS=3,4 npm run balance
 *   SEATS=fixed N=30 npm run balance         (v1.0 method: animal i always spawns in seat i)
 *   DUEL=1 N=10 LEVELS=4 npm run balance     (1v1 round-robin win matrix)
 *
 * SEATS defaults to `shuffle`: every match deals the 10 animals into the 10
 * spawn seats with a seeded permutation, so no animal is stuck with the same
 * neighbours for the whole sweep (in v1.0's fixed seating the giraffe always
 * spawned between python and mole). The sim is deterministic per seed, so the
 * same N gives the same table until a rule or number changes.
 */
import { World } from '../src/sim/World';
import { EventBus } from '../src/core/EventBus';
import { BotManager } from '../src/ai/BotManager';
import { ANIMAL_IDS } from '../src/config/animals';
import { mulberry32 } from '../src/core/math';
import type { AnimalId, Difficulty, MatchConfig } from '../src/core/types';

const DT = 1 / 60;
const N = Number(process.env.N ?? 30);
const LEVELS = (process.env.LEVELS ?? '1,2,3,4')
  .split(',')
  .map((s) => Number(s.trim()) as Difficulty);
const SHUFFLE = (process.env.SEATS ?? 'shuffle') !== 'fixed';
const DUEL = process.env.DUEL === '1';
const MAX_SIM_S = Number(process.env.MAX_S ?? 300);
/** TRACE=1 prints the survivors of every timed-out match (stall hunting). */
const TRACE = process.env.TRACE === '1';

const A = ANIMAL_IDS as readonly AnimalId[];
const IDX = new Map<AnimalId, number>(A.map((a, i) => [a, i]));

interface PerAnimal {
  wins: number;
  place: number;
  ults: number;
  specials: number;
  dmg: number;
  dmgBasic: number;
  dmgSpecial: number;
  dmgUlt: number;
  /** HP actually removed (includes bleed, grab ticks and thorns). */
  dmgTotal: number;
  kills: number;
  survive: number;
  /** Times the fighter's ult charge reached full. */
  ready: number;
  /** Seconds spent holding a full, uncast charge. */
  held: number;
}

function blank(): PerAnimal {
  return { wins: 0, place: 0, ults: 0, specials: 0, dmg: 0, dmgBasic: 0, dmgSpecial: 0, dmgUlt: 0, dmgTotal: 0, kills: 0, survive: 0, ready: 0, held: 0 };
}

interface Outcome {
  ended: boolean;
  timeS: number;
  winnerAnimal: AnimalId | null;
}

/** Seeded Fisher–Yates permutation of the roster. */
function seatOrder(seed: number): AnimalId[] {
  const order = [...A];
  if (!SHUFFLE) return order;
  const rng = mulberry32(seed ^ 0x9e3779b9);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = order[i];
    order[i] = order[j];
    order[j] = t;
  }
  return order;
}

function play(seed: number, lvl: Difficulty, animals: readonly AnimalId[], stats: PerAnimal[] | null): Outcome {
  const cfg: MatchConfig = { roster: animals.map((a) => ({ animal: a, isPlayer: false })), difficulty: lvl };
  const bus = new EventBus();
  const world = new World(cfg, seed, bus);
  const bots = new BotManager(bus, lvl, seed);
  let ended = false;
  let winner = -1;
  const deathTime = new Array<number>(animals.length).fill(-1);
  const place = new Array<number>(animals.length).fill(-1);

  const credit = (attackerId: number, damage: number): void => {
    if (stats === null || attackerId < 0) return;
    const s = stats[IDX.get(animals[attackerId]) as number];
    const f = world.fighters[attackerId];
    s.dmg += damage;
    if (f.ability === null) s.dmgBasic += damage;
    else if (f.ability.kind === 'special') s.dmgSpecial += damage;
    else s.dmgUlt += damage;
  };
  bus.on('hit', (e) => credit(e.attackerId, e.damage));
  bus.on('blocked', (e) => credit(e.attackerId, e.damage));
  bus.on('ultimate', (e) => {
    if (stats !== null) stats[IDX.get(animals[e.fighterId]) as number].ults++;
  });
  bus.on('special', (e) => {
    if (stats !== null) stats[IDX.get(animals[e.fighterId]) as number].specials++;
  });
  bus.on('death', (e) => {
    place[e.targetId] = e.placement;
    deathTime[e.targetId] = world.time;
    if (stats !== null && e.killerId >= 0 && e.killerId !== e.targetId) stats[IDX.get(animals[e.killerId]) as number].kills++;
  });
  bus.on('matchEnd', (e) => {
    ended = true;
    winner = e.winnerId;
  });

  const maxTicks = Math.ceil((MAX_SIM_S + 3.5) / DT);
  const wasFull = new Array<boolean>(animals.length).fill(false);
  for (let tick = 0; tick < maxTicks && !ended; tick++) {
    bots.update(world.snapshot(), DT);
    for (let id = 0; id < animals.length; id++) world.setIntent(id, bots.getIntent(id));
    world.step(DT);
    if (stats !== null) {
      for (let id = 0; id < animals.length; id++) {
        const st = world.fighters[id].state;
        const full = st.alive && st.ultCharge >= 100;
        const s = stats[IDX.get(animals[id]) as number];
        if (full && !wasFull[id]) s.ready++;
        if (full) s.held += DT;
        wasFull[id] = full;
      }
    }
  }
  const timeS = world.time;
  if (!ended && TRACE) {
    const alive = world.fighters
      .filter((f) => f.state.alive)
      .map(
        (f) =>
          `${f.def.id}(hp ${f.state.hp.toFixed(0)} pos ${f.state.pos.x.toFixed(1)},${f.state.pos.z.toFixed(1)} ${f.state.action} dmg ${f.state.damageDealt.toFixed(0)})`,
      );
    console.log(`  TIMEOUT seed=${seed} L${lvl}: ${alive.join('  ')}`);
  }
  if (ended && stats !== null) {
    for (let i = 0; i < animals.length; i++) {
      const s = stats[IDX.get(animals[i]) as number];
      s.dmgTotal += world.fighters[i].state.damageDealt;
      s.place += i === winner ? 1 : place[i];
      s.survive += deathTime[i] >= 0 ? deathTime[i] : timeS;
      if (i === winner) s.wins++;
    }
  }
  return { ended, timeS, winnerAnimal: ended && winner >= 0 ? animals[winner] : null };
}

function pct(n: number, d: number): string {
  return `${((100 * n) / Math.max(1, d)).toFixed(0).padStart(3)}%`;
}

function runFfa(lvl: Difficulty): void {
  const stats = A.map(() => blank());
  let timeSum = 0;
  let ended = 0;
  let timeouts = 0;
  let bloodlust = 0;
  const t0 = Date.now();
  for (let s = 1; s <= N; s++) {
    const seed = 1000 * lvl + s;
    const r = play(seed, lvl, seatOrder(seed), stats);
    if (!r.ended) {
      timeouts++;
      continue;
    }
    ended++;
    timeSum += r.timeS;
    if (r.timeS >= 120) bloodlust++;
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  const e = Math.max(1, ended);
  console.log(
    `\n=== L${lvl}  matches=${N} ended=${ended} timeouts=${timeouts} avgTime=${(timeSum / e).toFixed(0)}s  bloodlust=${pct(bloodlust, e)}  seats=${SHUFFLE ? 'shuffle' : 'fixed'}  (${secs}s wall)`,
  );
  console.log('animal     wins  win%  place | rdy/m ult/m held spc/m  dmg/m kill/m  life | basic spec  ult  (hit-event share)');
  const rows = A.map((a, i) => ({ a, s: stats[i] }));
  rows.sort((x, y) => x.s.place - y.s.place);
  for (const { a, s } of rows) {
    const d = Math.max(1, s.dmg);
    console.log(
      `${a.padEnd(10)} ${String(s.wins).padStart(4)} ${pct(s.wins, e)}  ${(s.place / e).toFixed(2)} | ` +
        `${(s.ready / e).toFixed(2).padStart(5)} ${(s.ults / e).toFixed(2).padStart(5)} ${(s.held / Math.max(1, s.ready)).toFixed(0).padStart(4)} ${(s.specials / e).toFixed(1).padStart(5)} ${(s.dmgTotal / e).toFixed(0).padStart(6)} ` +
        `${(s.kills / e).toFixed(2).padStart(6)} ${(s.survive / e).toFixed(0).padStart(5)} | ` +
        `${pct(s.dmgBasic, d)} ${pct(s.dmgSpecial, d)} ${pct(s.dmgUlt, d)}`,
    );
  }
  const totalUlts = stats.reduce((acc, s) => acc + s.ults, 0);
  const totalSpc = stats.reduce((acc, s) => acc + s.specials, 0);
  console.log(`avg ults/fighter/match ${(totalUlts / e / A.length).toFixed(2)}  specials/fighter/match ${(totalSpc / e / A.length).toFixed(1)}`);
}

function runDuels(lvl: Difficulty): void {
  // wins[i][j] = matches animal i won against animal j (N per ordered seat pair).
  const wins = A.map(() => A.map(() => 0));
  const games = A.map(() => A.map(() => 0));
  let timeouts = 0;
  for (let i = 0; i < A.length; i++) {
    for (let j = i + 1; j < A.length; j++) {
      for (let s = 1; s <= N; s++) {
        const seed = 100000 * lvl + 1000 * i + 37 * j + s;
        const pair: AnimalId[] = s % 2 === 0 ? [A[i], A[j]] : [A[j], A[i]];
        const r = play(seed, lvl, pair, null);
        if (!r.ended || r.winnerAnimal === null) {
          timeouts++;
          continue;
        }
        games[i][j]++;
        games[j][i]++;
        if (r.winnerAnimal === A[i]) wins[i][j]++;
        else wins[j][i]++;
      }
    }
  }
  console.log(`\n=== DUELS L${lvl}  N=${N} per pair  timeouts=${timeouts}   (row win% vs column)`);
  console.log('           ' + A.map((a) => a.slice(0, 5).padStart(6)).join('') + '   total');
  for (let i = 0; i < A.length; i++) {
    let w = 0;
    let g = 0;
    const cells = A.map((_, j) => {
      if (i === j) return '     -';
      w += wins[i][j];
      g += games[i][j];
      return `${((100 * wins[i][j]) / Math.max(1, games[i][j])).toFixed(0)}`.padStart(6);
    });
    console.log(`${A[i].padEnd(10)} ${cells.join('')}   ${pct(w, g)}`);
  }
}

for (const lvl of LEVELS) {
  if (DUEL) runDuels(lvl);
  else runFfa(lvl);
}
