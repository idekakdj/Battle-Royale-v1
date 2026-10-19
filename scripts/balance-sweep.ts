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
 *   TRAPS=0 N=60 npm run balance             (v1.2: no arena traps — the baseline)
 *   COMPARE=1 N=60 npm run balance           (v1.2: same seeds without and with traps + placement deltas)
 *   ARENA=jungle N=30 npm run balance        (v1.8: play on the Jungle Clearing; default colosseum, output unchanged)
 *   ARENA=ocean N=60 npm run balance         (v1.9: the Ocean Dome; adds the serpent readout: events, exposure, dodge rate, deaths)
 *   SERPENT_EVERY=20 ARENA=ocean N=40 npm run balance   (v1.9: force a serpent event every 20 s of live match time instead of the real 10 %/min;
 *                                            SERPENT_CHANCE=1 per roll by default, SERPENT_FIRST=10 first roll at 10 s; off by default)
 *
 * v1.2 trap readout per level: trap triggers / damage per match, average trap
 * damage per fighter per match, trap share of ALL damage (fighter damage incl.
 * bleed/grab/thorns + trap damage), trap deaths per match and their share of
 * deaths; per animal, `trapT/m` = trap damage taken per match. Eagle soar
 * readout: landing slams per match and average slam damage (base, pre-block).
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
import { ARENA_IDS } from '../src/core/types';
import { getArena, arenaSerpentBand } from '../src/config/arenas';
import { SERPENT } from '../src/config/serpent';
import { SERPENT_AI, stripDistance } from '../src/ai/SerpentSense';
import { NAV_AI } from '../src/ai/Navigator';
import type { AnimalId, ArenaId, Difficulty, MatchConfig } from '../src/core/types';

const DT = 1 / 60;
const N = Number(process.env.N ?? 30);
const LEVELS = (process.env.LEVELS ?? '1,2,3,4')
  .split(',')
  .map((s) => Number(s.trim()) as Difficulty);
/** FROM=201 N=400 re-runs only matches 201..400 of the FFA sweep (e.g. to trace one timeout without replaying the first 200). */
const FROM = Number(process.env.FROM ?? 1);
const SHUFFLE = (process.env.SEATS ?? 'shuffle') !== 'fixed';
const DUEL = process.env.DUEL === '1';
const MAX_SIM_S = Number(process.env.MAX_S ?? 300);
/** TRACE=1 prints the survivors of every timed-out match (stall hunting). */
const TRACE = process.env.TRACE === '1';
/** TRACE_FALLS=1 prints every fall nobody pushed or cast (where the fighter left the ground, what it was steering). */
const TRACE_FALLS = process.env.TRACE_FALLS === '1';
/** Ground at or above this height (m) is the upper tier of an elevated arena (the Ocean's tower tops; `hazards.serpentSplitY`). */
const UPPER_Y = 4.5;
/** TRACE_STALLS=1 prints every fighter that reaches a 300-frame stall (seed, animal, where, what it wanted). */
const TRACE_STALLS = process.env.TRACE_STALLS === '1';
/** TRAPS=0 disables arena traps (the v1.2 no-trap baseline). */
const TRAPS_ON = process.env.TRAPS !== '0';
/** COMPARE=1 runs every level twice (no traps, then traps) on the same seeds. */
const COMPARE = process.env.COMPARE === '1';
/** v1.8 ARENA=colosseum|jungle: which arena the matches are played in (default colosseum). */
const ARENA: ArenaId = ((): ArenaId => {
  const v = process.env.ARENA ?? 'colosseum';
  if (!(ARENA_IDS as readonly string[]).includes(v)) throw new Error(`ARENA must be one of ${ARENA_IDS.join('|')} (got "${v}")`);
  return v as ArenaId;
})();

/** True when the chosen arena has terrain zones (the jungle): the sweep adds the water / moss readout. */
const ARENA_HAS_TERRAIN = getArena(ARENA).terrain.length > 0;

/** v1.9 SERPENT_EVERY=s forces a sea-serpent roll every s seconds (chance SERPENT_CHANCE, default 1; first roll at SERPENT_FIRST, default s). 0 = the real rules. */
const SERPENT_EVERY = Number(process.env.SERPENT_EVERY ?? 0);
const SERPENT_CHANCE = Number(process.env.SERPENT_CHANCE ?? 1);
const SERPENT_FIRST = Number(process.env.SERPENT_FIRST ?? SERPENT_EVERY);
/** v1.9 stall readout (worst run of frames a moving-intent fighter stayed put): always on for elevated arenas, STALLS=1 elsewhere (the colosseum's output stays unchanged by default). */
const STALLS = process.env.STALLS === '1' || getArena((process.env.ARENA ?? 'colosseum') as ArenaId).heightfield !== undefined;

/** What-if tuning of the v1.9 bot knobs, e.g. NAV_TUNE='{"2":{"levelBias":0}}' SERPENT_TUNE='{"1":{"missChance":0.4}}' (dev only; unset = the shipped numbers). */
for (const [env, table] of [['NAV_TUNE', NAV_AI], ['SERPENT_TUNE', SERPENT_AI]] as const) {
  const raw = process.env[env];
  if (raw === undefined) continue;
  const t = JSON.parse(raw) as Record<string, Record<string, number | boolean>>;
  for (const k of Object.keys(t)) Object.assign((table as Record<number, object>)[Number(k)], t[k]);
}

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
  /** v1.2: trap damage TAKEN. */
  trapTaken: number;
  /** v1.8 (terrain arenas only): seconds alive in the water / on moss, over the pool without being in it (hop-chaining), damage dealt from the water. */
  waterT: number;
  mossT: number;
  hopT: number;
  dmgFromWater: number;
  /** Damage taken (hit events, after block) while the VICTIM stood in the water. */
  dmgTakenInWater: number;
}

function blank(): PerAnimal {
  return { wins: 0, place: 0, ults: 0, specials: 0, dmg: 0, dmgBasic: 0, dmgSpecial: 0, dmgUlt: 0, dmgTotal: 0, kills: 0, survive: 0, ready: 0, held: 0, trapTaken: 0, waterT: 0, mossT: 0, hopT: 0, dmgFromWater: 0, dmgTakenInWater: 0 };
}

/** v1.2 per-level trap / soar totals (ended matches only). */
interface LevelExtras {
  trapTriggers: number;
  trapDmg: number;
  /** All HP removed: Σ fighter damageDealt (incl. bleed/grab/thorns) + trap damage. */
  allDmg: number;
  trapDeaths: number;
  deaths: number;
  slams: number;
  slamDmg: number;
  /** v1.9 sea serpent: events, fighters standing in the telegraphed strip when it appeared, hits on them, hits on others (walked in), deaths it caused. */
  serpEvents: number;
  serpExposed: number;
  serpHitExposed: number;
  serpHitOther: number;
  serpDeaths: number;
  /** v1.10 per lane (index 0 = low, 1 = high): events, exposed (in the strip AND in the lane's band when it appeared), hits on the exposed, hits on others. */
  laneEvents: [number, number];
  laneExposed: [number, number];
  laneHitExposed: [number, number];
  laneHitOther: [number, number];
  /** v1.10 fall damage: falls, deaths by a fall, HP lost to falls, falls the bot chose (serpent dive) vs not, falls per level of the drop (m, summed). */
  /** v1.10 upper tier (ground >= 4.5 m: the towers): seconds fighters spent up there, seconds alive, pickups taken on an upper pad, pickups in all. */
  upperT: number;
  aliveT: number;
  upperPickups: number;
  pickups: number;
  falls: number;
  fallDeaths: number;
  fallHp: number;
  fallsDeliberate: number;
  fallDrop: number;
  /** v1.10 falls by what the faller was doing in the last second: an ability that moves it, a shove / stun / grab, or just walking. */
  fallByAbility: number;
  fallByShove: number;
  fallByWalk: number;
  /** ... and falls with another fighter within 0.6 m of the faller's last footing (shoved by the soft push-out of a melee). */
  fallByJostle: number;
  /** v1.9 stall hunt: the longest run of frames one fighter tried to move (|intent| > 0.5, run/idle) and stayed within 0.75 m, and how many runs reached 300 frames (5 s). */
  worstStall: number;
  stalls300: number;
}

function blankExtras(): LevelExtras {
  return { trapTriggers: 0, trapDmg: 0, allDmg: 0, trapDeaths: 0, deaths: 0, slams: 0, slamDmg: 0, serpEvents: 0, serpExposed: 0, serpHitExposed: 0, serpHitOther: 0, serpDeaths: 0, laneEvents: [0, 0], laneExposed: [0, 0], laneHitExposed: [0, 0], laneHitOther: [0, 0], upperT: 0, aliveT: 0, upperPickups: 0, pickups: 0, falls: 0, fallDeaths: 0, fallHp: 0, fallsDeliberate: 0, fallDrop: 0, fallByAbility: 0, fallByShove: 0, fallByJostle: 0, fallByWalk: 0, worstStall: 0, stalls300: 0 };
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

function play(
  seed: number,
  lvl: Difficulty,
  animals: readonly AnimalId[],
  stats: PerAnimal[] | null,
  traps: boolean = TRAPS_ON,
  extras: LevelExtras | null = null,
): Outcome {
  const cfg: MatchConfig = { roster: animals.map((a) => ({ animal: a, isPlayer: false })), difficulty: lvl, arena: ARENA };
  const bus = new EventBus();
  const world = new World(cfg, seed, bus, {
    traps,
    ...(SERPENT_EVERY > 0 ? { serpent: { intervalS: SERPENT_EVERY, chance: SERPENT_CHANCE, firstAtS: SERPENT_FIRST } } : {}),
  });
  const mx = blankExtras();
  const bots = new BotManager(bus, lvl, seed, world.arena);
  let ended = false;
  let winner = -1;
  const deathTime = new Array<number>(animals.length).fill(-1);
  const place = new Array<number>(animals.length).fill(-1);

  const credit = (attackerId: number, damage: number): void => {
    if (stats === null || attackerId < 0) return;
    const s = stats[IDX.get(animals[attackerId]) as number];
    const f = world.fighters[attackerId];
    s.dmg += damage;
    if (f.inWater) s.dmgFromWater += damage;
    if (f.ability === null) s.dmgBasic += damage;
    else if (f.ability.kind === 'special') s.dmgSpecial += damage;
    else s.dmgUlt += damage;
  };
  bus.on('hit', (e) => {
    credit(e.attackerId, e.damage);
    if (stats !== null && e.targetId >= 0 && world.fighters[e.targetId].inWater) stats[IDX.get(animals[e.targetId]) as number].dmgTakenInWater += e.damage;
  });
  bus.on('blocked', (e) => credit(e.attackerId, e.damage));
  bus.on('ultimate', (e) => {
    if (stats !== null) stats[IDX.get(animals[e.fighterId]) as number].ults++;
  });
  bus.on('special', (e) => {
    if (stats !== null) stats[IDX.get(animals[e.fighterId]) as number].specials++;
  });
  bus.on('pickup', (e) => {
    mx.pickups++;
    if (e.pos.y >= UPPER_Y) mx.upperPickups++;
  });
  bus.on('trapTriggered', () => {
    mx.trapTriggers++;
  });
  bus.on('trapDamage', (e) => {
    mx.trapDmg += e.damage;
    if (stats !== null) stats[IDX.get(animals[e.targetId]) as number].trapTaken += e.damage;
  });
  bus.on('landingImpact', (e) => {
    mx.slams++;
    mx.slamDmg += e.damage;
  });
  // v1.9 serpent exposure: who stands in the strip when the warning appears? (v1.10: per lane; exposed = in the strip AND in the lane's band)
  const exposed = [new Array<boolean>(animals.length).fill(false), new Array<boolean>(animals.length).fill(false)];
  bus.on('serpentWarning', (e) => {
    const lane = e.tier === 'high' ? 1 : 0;
    mx.serpEvents++;
    mx.laneEvents[lane]++;
    exposed[lane].fill(false);
    const rad = (e.angleDeg * Math.PI) / 180;
    for (let i = 0; i < animals.length; i++) {
      const f = world.fighters[i];
      if (!f.state.alive) continue;
      const d = stripDistance(f.state.pos.x, f.state.pos.z, Math.cos(rad), Math.sin(rad), world.arena.wallRadius);
      if (d < SERPENT.headRadius + f.def.radius && arenaSerpentBand(world.arena, f.state.pos.x, f.state.pos.z) === (lane === 1 ? 'high' : 'low')) {
        exposed[lane][i] = true;
        mx.serpExposed++;
        mx.laneExposed[lane]++;
      }
    }
  });
  bus.on('serpentHit', (e) => {
    const lane = e.tier === 'high' ? 1 : 0;
    if (exposed[lane][e.fighterId]) {
      mx.serpHitExposed++;
      mx.laneHitExposed[lane]++;
    } else {
      mx.serpHitOther++;
      mx.laneHitOther[lane]++;
    }
  });
  // v1.10 fall damage: was the fall on purpose (the bot was diving off the platform within the last 1.5 s)?
  const lastDive = new Array<number>(animals.length).fill(-99);
  const lastGround = animals.map(() => ({ x: 0, z: 0, y: 0, ix: 0, iz: 0, near: 99 }));
  const lastAbility = new Array<number>(animals.length).fill(-99);
  const lastShove = new Array<number>(animals.length).fill(-99);
  bus.on('fall', (e) => {
    mx.falls++;
    if (world.time - lastDive[e.fighterId] > 1.5) {
      if (world.time - lastAbility[e.fighterId] <= 1.0) mx.fallByAbility++;
      else if (world.time - lastShove[e.fighterId] <= 1.0) mx.fallByShove++;
      else if (lastGround[e.fighterId].near < 0.6) mx.fallByJostle++;
      else {
        mx.fallByWalk++;
        if (TRACE_FALLS) {
          const lg = lastGround[e.fighterId];
          console.log(
            `  WALKED-FALL seed=${seed} L${lvl} t=${world.time.toFixed(1)} ${world.fighters[e.fighterId].def.id} left (${lg.x.toFixed(1)}, ${lg.z.toFixed(1)}) y ${lg.y.toFixed(1)} intent (${lg.ix.toFixed(2)}, ${lg.iz.toFixed(2)}) landed (${e.pos.x.toFixed(1)}, ${e.pos.z.toFixed(1)}) nearest foe gap ${lg.near.toFixed(1)} drop ${e.drop.toFixed(1)}`,
          );
        }
      }
    }
    mx.fallHp += e.damage;
    mx.fallDrop += e.drop;
    if (world.time - lastDive[e.fighterId] <= 1.5) mx.fallsDeliberate++;
  });
  bus.on('death', (e) => {
    mx.deaths++;
    if (e.killerId === -1) {
      if (e.cause === 'serpent') mx.serpDeaths++;
      else if (e.cause === 'fall') mx.fallDeaths++;
      else mx.trapDeaths++;
    }
    place[e.targetId] = e.placement;
    deathTime[e.targetId] = world.time;
    if (stats !== null && e.killerId >= 0 && e.killerId !== e.targetId) stats[IDX.get(animals[e.killerId]) as number].kills++;
  });
  bus.on('matchEnd', (e) => {
    ended = true;
    winner = e.winnerId;
  });

  const maxTicks = Math.ceil((MAX_SIM_S + 3.5) / DT);
  const hasTerrain = world.arena.terrain.length > 0;
  const pool = world.arena.terrain.find((z) => z.kind === 'water');
  const poolX = pool?.x ?? 0;
  const poolZ = pool?.z ?? 0;
  const poolR = pool?.radius ?? 0;
  const wasFull = new Array<boolean>(animals.length).fill(false);
  const stallX = new Float64Array(animals.length);
  const stallZ = new Float64Array(animals.length);
  const stallN = new Int32Array(animals.length);
  for (let id = 0; id < animals.length; id++) {
    stallX[id] = world.fighters[id].state.pos.x;
    stallZ[id] = world.fighters[id].state.pos.z;
  }
  for (let tick = 0; tick < maxTicks && !ended; tick++) {
    bots.update(world.snapshot(), DT);
    for (let id = 0; id < animals.length; id++) {
      world.setIntent(id, bots.getIntent(id));
      if (bots.isDiving(id)) lastDive[id] = world.time;
    }
    world.step(DT);
    for (let id = 0; id < animals.length; id++) {
      const wf = world.fighters[id];
      const act = wf.state.action;
      if (!wf.state.airborne) {
        const lg = lastGround[id];
        lg.x = wf.state.pos.x;
        lg.z = wf.state.pos.z;
        lg.y = wf.state.pos.y;
        lg.ix = wf.intent.moveX;
        lg.iz = wf.intent.moveZ;
        lg.near = 99;
        for (let o = 0; o < animals.length; o++) {
          if (o === id || !world.fighters[o].state.alive) continue;
          const gap = Math.hypot(world.fighters[o].state.pos.x - wf.state.pos.x, world.fighters[o].state.pos.z - wf.state.pos.z) - wf.def.radius - world.fighters[o].def.radius;
          if (gap < lg.near) lg.near = gap;
        }
      }
      if (act === 'special' || act === 'ultimate' || wf.ability !== null) lastAbility[id] = world.time;
      if (wf.knockTimer > 0 || act === 'stagger' || act === 'knockdown' || act === 'grabbed' || act === 'feared') lastShove[id] = world.time;
    }
    if (world.time > 0 && world.arena.hazards?.serpentSplitY !== undefined) {
      for (let id = 0; id < animals.length; id++) {
        const sy = world.fighters[id].state;
        if (!sy.alive) continue;
        mx.aliveT += DT;
        if (sy.pos.y >= UPPER_Y) mx.upperT += DT;
      }
    }
    if (STALLS && world.time > 0) {
      for (let id = 0; id < animals.length; id++) {
        const wf = world.fighters[id];
        const st0 = wf.state;
        if (!st0.alive) continue;
        const wants = Math.hypot(wf.intent.moveX, wf.intent.moveZ) > 0.5 && (st0.action === 'run' || st0.action === 'idle');
        if (!wants || Math.hypot(st0.pos.x - stallX[id], st0.pos.z - stallZ[id]) > 0.75) {
          stallX[id] = st0.pos.x;
          stallZ[id] = st0.pos.z;
          stallN[id] = 0;
        } else {
          stallN[id]++;
          if (stallN[id] > mx.worstStall) mx.worstStall = stallN[id];
          if (stallN[id] === 300) {
            mx.stalls300++;
            if (TRACE_STALLS) {
              console.log(
                `  STALL seed=${seed} L${lvl} t=${world.time.toFixed(1)} ${wf.def.id} at (${st0.pos.x.toFixed(1)}, ${st0.pos.z.toFixed(1)}) y ${st0.pos.y.toFixed(1)} action ${st0.action} intent (${wf.intent.moveX.toFixed(2)}, ${wf.intent.moveZ.toFixed(2)}) hp ${st0.hp.toFixed(0)}`,
              );
            }
          }
        }
      }
    }
    if (stats !== null) {
      for (let id = 0; id < animals.length; id++) {
        const st = world.fighters[id].state;
        const full = st.alive && st.ultCharge >= 100;
        const s = stats[IDX.get(animals[id]) as number];
        if (hasTerrain && st.alive) {
          const wf = world.fighters[id];
          if (wf.inWater) s.waterT += DT;
          if (wf.onMoss) s.mossT += DT;
          if (!wf.inWater && poolR > 0 && Math.hypot(st.pos.x - poolX, st.pos.z - poolZ) < poolR) s.hopT += DT;
        }
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
  if (ended && extras !== null) {
    let dealt = 0;
    for (let i = 0; i < animals.length; i++) dealt += world.fighters[i].state.damageDealt;
    mx.allDmg = dealt + mx.trapDmg;
    extras.trapTriggers += mx.trapTriggers;
    extras.trapDmg += mx.trapDmg;
    extras.allDmg += mx.allDmg;
    extras.trapDeaths += mx.trapDeaths;
    extras.deaths += mx.deaths;
    extras.slams += mx.slams;
    extras.slamDmg += mx.slamDmg;
    extras.serpEvents += mx.serpEvents;
    extras.serpExposed += mx.serpExposed;
    extras.serpHitExposed += mx.serpHitExposed;
    extras.serpHitOther += mx.serpHitOther;
    extras.serpDeaths += mx.serpDeaths;
    for (let k = 0; k < 2; k++) {
      extras.laneEvents[k] += mx.laneEvents[k];
      extras.laneExposed[k] += mx.laneExposed[k];
      extras.laneHitExposed[k] += mx.laneHitExposed[k];
      extras.laneHitOther[k] += mx.laneHitOther[k];
    }
    extras.upperT += mx.upperT;
    extras.aliveT += mx.aliveT;
    extras.upperPickups += mx.upperPickups;
    extras.pickups += mx.pickups;
    extras.falls += mx.falls;
    extras.fallDeaths += mx.fallDeaths;
    extras.fallHp += mx.fallHp;
    extras.fallsDeliberate += mx.fallsDeliberate;
    extras.fallDrop += mx.fallDrop;
    extras.fallByAbility += mx.fallByAbility;
    extras.fallByShove += mx.fallByShove;
    extras.fallByJostle += mx.fallByJostle;
    extras.fallByWalk += mx.fallByWalk;
  }
  if (extras !== null) {
    extras.worstStall = Math.max(extras.worstStall, mx.worstStall);
    extras.stalls300 += mx.stalls300;
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

/** One-decimal percentage (the terrain readout needs finer cells than `pct`). */
function pct1(n: number, d: number): string {
  return `${((100 * n) / Math.max(1e-9, d)).toFixed(1).padStart(5)}%`;
}

function runFfa(lvl: Difficulty, traps: boolean = TRAPS_ON): PerAnimal[] {
  const stats = A.map(() => blank());
  const ex = blankExtras();
  let timeSum = 0;
  let ended = 0;
  let timeouts = 0;
  let bloodlust = 0;
  const t0 = Date.now();
  for (let s = FROM; s <= N; s++) {
    const seed = 1000 * lvl + s;
    const r = play(seed, lvl, seatOrder(seed), stats, traps, ex);
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
    `\n=== L${lvl}  matches=${N} ended=${ended} timeouts=${timeouts} avgTime=${(timeSum / e).toFixed(0)}s  bloodlust=${pct(bloodlust, e)}  seats=${SHUFFLE ? 'shuffle' : 'fixed'}  traps=${traps ? 'on' : 'off'}${ARENA === 'colosseum' ? '' : `  arena=${ARENA}`}  (${secs}s wall)`,
  );
  console.log('animal     wins  win%  place | rdy/m ult/m held spc/m  dmg/m kill/m  life | basic spec  ult  (hit-event share) | trapT/m');
  const rows = A.map((a, i) => ({ a, s: stats[i] }));
  rows.sort((x, y) => x.s.place - y.s.place);
  for (const { a, s } of rows) {
    const d = Math.max(1, s.dmg);
    console.log(
      `${a.padEnd(10)} ${String(s.wins).padStart(4)} ${pct(s.wins, e)}  ${(s.place / e).toFixed(2)} | ` +
        `${(s.ready / e).toFixed(2).padStart(5)} ${(s.ults / e).toFixed(2).padStart(5)} ${(s.held / Math.max(1, s.ready)).toFixed(0).padStart(4)} ${(s.specials / e).toFixed(1).padStart(5)} ${(s.dmgTotal / e).toFixed(0).padStart(6)} ` +
        `${(s.kills / e).toFixed(2).padStart(6)} ${(s.survive / e).toFixed(0).padStart(5)} | ` +
        `${pct(s.dmgBasic, d)} ${pct(s.dmgSpecial, d)} ${pct(s.dmgUlt, d)}                    | ${(s.trapTaken / e).toFixed(0).padStart(6)}`,
    );
  }
  const totalUlts = stats.reduce((acc, s) => acc + s.ults, 0);
  const totalSpc = stats.reduce((acc, s) => acc + s.specials, 0);
  console.log(`avg ults/fighter/match ${(totalUlts / e / A.length).toFixed(2)}  specials/fighter/match ${(totalSpc / e / A.length).toFixed(1)}`);
  if (ARENA_HAS_TERRAIN) {
    console.log('terrain (share of life; hop = over the pool but not in it):  animal      water%  moss%  hop%   dmg-from-water%  pool-exchange (dealt/taken in water)');
    for (const { a, s } of rows) {
      const life = Math.max(1, s.survive);
      console.log(
        `                                                  ${a.padEnd(10)} ${pct1(s.waterT, life)} ${pct1(s.mossT, life)} ${pct1(s.hopT, life)}  ${pct1(s.dmgFromWater, Math.max(1, s.dmg))}      ${(s.dmgFromWater / Math.max(1, s.dmgTakenInWater)).toFixed(2)}`,
      );
    }
  }
  console.log(
    `traps: triggers/match ${(ex.trapTriggers / e).toFixed(1)}  trapDmg/match ${(ex.trapDmg / e).toFixed(0)}  ` +
      `trapDmg/fighter/match ${(ex.trapDmg / e / A.length).toFixed(1)}  share of all damage ${((100 * ex.trapDmg) / Math.max(1, ex.allDmg)).toFixed(1)}%  ` +
      `trap deaths/match ${(ex.trapDeaths / e).toFixed(2)} (${((100 * ex.trapDeaths) / Math.max(1, ex.deaths)).toFixed(1)}% of deaths)`,
  );
  if (getArena(ARENA).hazards?.serpent === true) {
    const dodged = ex.serpExposed - ex.serpHitExposed;
    console.log(
      `serpent${SERPENT_EVERY > 0 ? ` (forced every ${SERPENT_EVERY}s, chance ${SERPENT_CHANCE})` : ' (real rules)'}: events/match ${(ex.serpEvents / e).toFixed(2)}  ` +
        `exposed/event ${(ex.serpExposed / Math.max(1, ex.serpEvents)).toFixed(2)}  dodge ${ex.serpExposed > 0 ? ((100 * dodged) / ex.serpExposed).toFixed(0) : '-'}% ` +
        `(hit ${ex.serpHitExposed}/${ex.serpExposed} exposed, ${ex.serpHitOther} walked in)  deaths/match ${(ex.serpDeaths / e).toFixed(2)} (${((100 * ex.serpDeaths) / Math.max(1, ex.deaths)).toFixed(1)}% of deaths)`,
    );
  }
  if (getArena(ARENA).hazards?.serpentSplitY !== undefined) {
    for (const [k, name] of [[0, 'low '], [1, 'high']] as const) {
      const exp = ex.laneExposed[k];
      console.log(
        `  ${name} lane: events/match ${(ex.laneEvents[k] / e).toFixed(2)}  exposed/event ${(exp / Math.max(1, ex.laneEvents[k])).toFixed(2)}  dodge ${exp > 0 ? ((100 * (exp - ex.laneHitExposed[k])) / exp).toFixed(0) : '-'}% ` +
          `(hit ${ex.laneHitExposed[k]}/${exp} exposed, ${ex.laneHitOther[k]} walked in)`,
      );
    }
  }
  if (getArena(ARENA).hazards?.fallDamage !== undefined) {
    const fd = getArena(ARENA).hazards?.fallDamage;
    console.log(
      `falls (>= ${fd?.minDrop} m, ${fd?.damage} dmg): per match ${(ex.falls / e).toFixed(2)}  HP lost ${(ex.fallHp / e).toFixed(0)}/match (${((100 * ex.fallHp) / Math.max(1, ex.allDmg)).toFixed(1)}% of all damage)  ` +
        `deaths by a fall ${ex.fallDeaths} (${((100 * ex.fallDeaths) / Math.max(1, ex.deaths)).toFixed(1)}% of deaths)  deliberate ${ex.fallsDeliberate} / accidental ${ex.falls - ex.fallsDeliberate} (ability ${ex.fallByAbility}, shove/stun/grab ${ex.fallByShove}, jostled in a melee ${ex.fallByJostle}, walked alone ${ex.fallByWalk})  mean drop ${(ex.fallDrop / Math.max(1, ex.falls)).toFixed(1)} m`,
    );
  }
  if (getArena(ARENA).hazards?.serpentSplitY !== undefined) {
    console.log(
      `upper tier (ground >= ${UPPER_Y} m): ${((100 * ex.upperT) / Math.max(1, ex.aliveT)).toFixed(1)}% of fighter-time up there  pickups/match ${(ex.pickups / e).toFixed(1)}, on a tower pad ${(ex.upperPickups / e).toFixed(2)}/match (${((100 * ex.upperPickups) / Math.max(1, ex.pickups)).toFixed(0)}%)`,
    );
  }
  if (STALLS) console.log(`stalls: worst run ${ex.worstStall} frames, runs >= 300 frames: ${ex.stalls300} (over ${ended} matches)`);
  console.log(
    `eagle soar: landing slams/match ${(ex.slams / e).toFixed(2)}  avg slam base dmg ${(ex.slamDmg / Math.max(1, ex.slams)).toFixed(1)}`,
  );
  return stats;
}

/** v1.2: same seeds without and with traps; prints per-animal placement / win deltas. */
function runCompare(lvl: Difficulty): void {
  const off = runFfa(lvl, false);
  const on = runFfa(lvl, true);
  console.log(`\n--- L${lvl} traps on − off (same seeds): Δwin% / Δplace  (place: + = worse)`);
  let worst = 0;
  for (let i = 0; i < A.length; i++) {
    const dWin = (100 * (on[i].wins - off[i].wins)) / N;
    const dPlace = (on[i].place - off[i].place) / N;
    if (Math.abs(dPlace) > Math.abs(worst)) worst = dPlace;
    console.log(`${A[i].padEnd(10)} ${dWin >= 0 ? '+' : ''}${dWin.toFixed(1).padStart(5)}%  ${dPlace >= 0 ? '+' : ''}${dPlace.toFixed(2)}`);
  }
  console.log(`largest |Δplace| ${Math.abs(worst).toFixed(2)}`);
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
  console.log(`\n=== DUELS L${lvl}  N=${N} per pair  timeouts=${timeouts}${ARENA === 'colosseum' ? '' : `  arena=${ARENA}`}   (row win% vs column)`);
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
  else if (COMPARE) runCompare(lvl);
  else runFfa(lvl);
}
