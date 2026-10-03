/**
 * Champions League balance harness (plan §9). Headless, deterministic, no DOM:
 *
 *   npm run brawl:balance                      (duels, both stages, level 4, N=40 games per ordered pairing)
 *   N=20 STAGE=brokenColosseum npm run brawl:balance
 *   LEVEL=3 npm run brawl:balance              (both fighters are level-3 bots)
 *   MODE=ffa N=30 npm run brawl:balance        (4-fighter free-for-all, seeded rosters, rotating seats)
 *   LEVELS=1,2,3,4 M=2 npm run brawl:balance   (level-vs-level matrix: the lower level plays animal A, the higher B)
 *   TRACE=1 npm run brawl:balance              (one game, move/hit/KO log; ANIMALS=lion,eagle picks the pair)
 *
 * Env: N (games per ordered pairing, default 40), STAGE (brokenColosseum | skyAqueduct | both, default both),
 *      LEVEL (default 4), MODE (duel | ffa), LEVELS (comma list, compare mode), M (games per animal pair in compare
 *      mode, default 2), STOCKS (3), TIME (seconds, default 300), SEED (base seed, default 1),
 *      ANIMALS (comma list, restricts the roster), WORKERS (parallel processes, default min(cores − 2, 10); 1 = in-process),
 *      PROFILE=1 (time split sim / bots).
 *
 * Every pairing is played with both seat orders alternated; all seeds derive from SEED, so identical settings give
 * identical tables until a rule, a number or a bot changes. Last line: PASS / FAIL against the plan's acceptance bands.
 */

import { spawn } from 'node:child_process';
import { cpus } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { BrawlWorld } from '../src/brawl/sim/BrawlWorld';
import { BrawlBot } from '../src/brawl/ai/BrawlBot';
import { MOVE_IDS } from '../src/brawl/types';
import type { BrawlDifficulty, BrawlMatchConfig, BrawlSnapshot, MoveId, StageId } from '../src/brawl/types';
import { ANIMAL_IDS } from '../src/config/animals';
import type { AnimalId } from '../src/core/types';
import { mulberry32 } from '../src/core/math';

// ── settings ─────────────────────────────────────────────────────────────────

const env = process.env;
const N = Number(env.N ?? 40);
const M = Number(env.M ?? 2);
const LEVEL = Math.max(1, Math.min(4, Number(env.LEVEL ?? 4))) as BrawlDifficulty;
const MODE = (env.MODE ?? 'duel') === 'ffa' ? 'ffa' : 'duel';
const STOCKS = Number(env.STOCKS ?? 3);
const TIME_S = Number(env.TIME ?? 300);
const SEED = Number(env.SEED ?? 1);
const TRACE = env.TRACE === '1';
const PROFILE = env.PROFILE === '1';
const STAGES: StageId[] =
  (env.STAGE ?? 'both') === 'both' ? ['brokenColosseum', 'skyAqueduct'] : [(env.STAGE ?? 'brokenColosseum') as StageId];
const ALL = ANIMAL_IDS as readonly AnimalId[];
const ANIMALS: AnimalId[] = env.ANIMALS ? (env.ANIMALS.split(',').map((s) => s.trim()) as AnimalId[]) : [...ALL];
const LEVEL_LIST: BrawlDifficulty[] | null = env.LEVELS ? ((env.LEVELS.split(',').map((s) => Number(s.trim())).sort((a, b) => a - b)) as BrawlDifficulty[]) : null;
const WORKER_ID = env.BRAWL_WORKER !== undefined ? Number(env.BRAWL_WORKER) : -1;
const WORKER_N = Number(env.BRAWL_WORKERS ?? 1);

interface Job {
  stage: StageId;
  animals: AnimalId[];
  levels: BrawlDifficulty[];
  seed: number;
  /** Counter tag(s) the result is attributed to (matrix cells, level pairs). */
  tag: string;
}

type Counters = Record<string, number>;

function bump(c: Counters, k: string, v = 1): void {
  c[k] = (c[k] ?? 0) + v;
}

// ── jobs ─────────────────────────────────────────────────────────────────────

function hashSeed(...n: number[]): number {
  let h = SEED >>> 0;
  for (const v of n) h = (Math.imul(h ^ (v + 0x9e3779b9), 0x85ebca6b) + 0x27d4eb2f) >>> 0;
  return h >>> 0;
}

function buildJobs(): Job[] {
  const jobs: Job[] = [];
  const stageIdx = (s: StageId): number => (s === 'brokenColosseum' ? 0 : 1);
  if (LEVEL_LIST && LEVEL_LIST.length > 1) {
    for (const stage of STAGES) {
      for (let i = 0; i < LEVEL_LIST.length; i++) {
        for (let j = i; j < LEVEL_LIST.length; j++) {
          const la = LEVEL_LIST[i];
          const lb = LEVEL_LIST[j];
          for (let ai = 0; ai < ANIMALS.length; ai++) {
            for (let bi = 0; bi < ANIMALS.length; bi++) {
              if (ai === bi) continue;
              for (let g = 0; g < M; g++) {
                const seat = g % 2;
                const A = ANIMALS[ai];
                const B = ANIMALS[bi];
                jobs.push({
                  stage,
                  animals: seat === 0 ? [A, B] : [B, A],
                  levels: seat === 0 ? [la, lb] : [lb, la],
                  seed: hashSeed(stageIdx(stage), ai, bi, g, la * 10 + lb),
                  tag: `lv:${la}:${lb}`,
                });
              }
            }
          }
        }
      }
    }
    return jobs;
  }
  if (MODE === 'ffa') {
    const total = N * ANIMALS.length;
    for (const stage of STAGES) {
      for (let g = 0; g < total; g++) {
        const rng = mulberry32(hashSeed(stageIdx(stage), g, 77));
        const pool = [...ANIMALS];
        const roster: AnimalId[] = [];
        for (let k = 0; k < Math.min(4, pool.length); k++) roster.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
        jobs.push({
          stage,
          animals: roster,
          levels: roster.map(() => LEVEL),
          seed: hashSeed(stageIdx(stage), g, 5),
          tag: 'ffa',
        });
      }
    }
    return jobs;
  }
  for (const stage of STAGES) {
    for (let ai = 0; ai < ANIMALS.length; ai++) {
      for (let bi = 0; bi < ANIMALS.length; bi++) {
        if (ai === bi) continue;
        for (let g = 0; g < N; g++) {
          const A = ANIMALS[ai];
          const B = ANIMALS[bi];
          const seat = g % 2;
          jobs.push({
            stage,
            animals: seat === 0 ? [A, B] : [B, A],
            levels: [LEVEL, LEVEL],
            seed: hashSeed(stageIdx(stage), ai, bi, g),
            tag: 'duel',
          });
        }
      }
    }
  }
  return jobs;
}

// ── one match ────────────────────────────────────────────────────────────────

let simMs = 0;
let botMs = 0;

function playMatch(job: Job, c: Counters, trace: boolean): void {
  const cfg: BrawlMatchConfig = {
    stage: job.stage,
    roster: job.animals.map((animal) => ({ animal, isPlayer: false })),
    difficulty: 4,
    stocks: STOCKS,
    timeLimitS: TIME_S,
  };
  const n = job.animals.length;
  const w = new BrawlWorld(cfg, job.seed);
  w.skipCountdown();
  const bots = job.animals.map((_, i) => new BrawlBot(i, job.levels[i], (job.seed + i * 7919) >>> 0));
  const maxFrames = Math.round(TIME_S * 60) + 400;
  let snap: BrawlSnapshot = w.snapshot();
  const lastPct = new Array<number>(n).fill(0);
  const modeLog: string[][] = job.animals.map(() => []);
  let timeout = false;
  while (!snap.matchOver && snap.frame < maxFrames) {
    const t0 = PROFILE ? performance.now() : 0;
    for (let i = 0; i < n; i++) w.setIntent(i, bots[i].update(snap));
    const t1 = PROFILE ? performance.now() : 0;
    w.step();
    if (PROFILE) {
      botMs += t1 - t0;
      simMs += performance.now() - t1;
    }
    for (let i = 0; i < n; i++) lastPct[i] = snap.fighters[i].percent;
    if (trace) for (let i = 0; i < n; i++) modeLog[i].push(bots[i].mode);
    snap = w.snapshot();
    for (const e of w.drainEvents()) {
      if (e.type === 'moveStart') {
        if (e.chain === 0) bump(c, `ms:${job.animals[e.fighterId]}:${e.moveId}`);
      } else if (e.type === 'hit') {
        const a = job.animals[e.attackerId];
        bump(c, `m:${a}:${e.moveId}`, e.damage);
        bump(c, `mh:${a}:${e.moveId}`);
        bump(c, `dmg:${a}`, e.damage);
        if (trace) {
          console.log(
            `  [${(snap.time).toFixed(2)}s] ${job.animals[e.attackerId]}#${e.attackerId} ${e.moveId}${e.sweetspot ? '*' : ''} -> ${job.animals[e.targetId]}#${e.targetId}  +${e.damage.toFixed(1)} = ${e.percentAfter.toFixed(0)}%  kb ${e.kbSpeed.toFixed(0)} @${e.angle.toFixed(0)}`,
          );
        }
      } else if (e.type === 'ko') {
        const v = job.animals[e.fighterId];
        const self = e.killerId < 0;
        bump(c, 'ko');
        bump(c, 'koPct', lastPct[e.fighterId]);
        bump(c, `lost:${v}`);
        bump(c, `koPct:${v}`, lastPct[e.fighterId]);
        bump(c, `koN:${v}`);
        if (self) {
          bump(c, 'sd');
          bump(c, `sd:${v}`);
        } else bump(c, `kos:${job.animals[e.killerId]}`);
        bump(c, `side:${e.side}`);
        if (trace) {
          const last = modeLog[e.fighterId].slice(-90);
          const recent = [...new Set(last)].join('>');
          console.log(
            `  [${snap.time.toFixed(2)}s] KO ${v}#${e.fighterId} at ${lastPct[e.fighterId].toFixed(0)}% via ${e.side} (${self ? 'SELF-DESTRUCT' : 'by ' + job.animals[e.killerId]}) stocks left ${e.stocksLeft}  modes: ${recent}`,
          );
        }
      } else if (e.type === 'ledgeGrab') {
        bump(c, 'ledge');
      } else if (e.type === 'dodge') {
        bump(c, `dodge:${job.animals[e.fighterId]}`);
      }
    }
  }
  if (snap.timeLeft !== null && snap.timeLeft <= 0 && snap.matchOver) timeout = true;
  if (!snap.matchOver) timeout = true;
  bump(c, 'g');
  bump(c, 'frames', snap.frame - 180);
  if (timeout) bump(c, 'timeout');
  for (let i = 0; i < n; i++) {
    const a = job.animals[i];
    bump(c, `g:${a}`);
    bump(c, `frames:${a}`, snap.frame - 180);
    bump(c, `stocksLeft:${a}`, snap.fighters[i].stocks);
    bump(c, `damageTaken:${a}`, 0);
    if (snap.winnerId === i) bump(c, `w:${a}`);
    else if (snap.winnerId < 0) bump(c, `d:${a}`);
  }
  // result attribution
  if (job.tag === 'duel') {
    const [i0, i1] = [0, 1];
    for (const [x, y] of [
      [i0, i1],
      [i1, i0],
    ]) {
      const a = job.animals[x];
      const b = job.animals[y];
      bump(c, `mx:${a}:${b}:g`);
      if (snap.winnerId === x) bump(c, `mx:${a}:${b}:w`);
      else if (snap.winnerId < 0) bump(c, `mx:${a}:${b}:d`);
    }
  } else if (job.tag.startsWith('lv:')) {
    const [, la, lb] = job.tag.split(':');
    // the first level named plays the lower-index seat in `levels`; credit by level, not seat
    for (let i = 0; i < n; i++) {
      const l = job.levels[i];
      if (la === lb) continue;
      const key = `${l}`;
      bump(c, `lvg:${la}:${lb}:${key}`);
      if (snap.winnerId === i) bump(c, `lvw:${la}:${lb}:${key}`);
    }
    bump(c, `lvn:${la}:${lb}`);
    if (la === lb) {
      for (let i = 0; i < n; i++) {
        if (snap.winnerId === i) bump(c, `lvself:${la}:w`);
      }
    }
    if (snap.winnerId < 0) bump(c, `lvdraw:${la}:${lb}`);
  }
}

// ── running (in-process or fanned out) ───────────────────────────────────────

function runJobs(jobs: Job[], c: Counters): void {
  for (let i = 0; i < jobs.length; i++) {
    if (WORKER_ID >= 0 && i % WORKER_N !== WORKER_ID) continue;
    playMatch(jobs[i], c, false);
  }
}

function merge(into: Counters, from: Counters): void {
  for (const [k, v] of Object.entries(from)) into[k] = (into[k] ?? 0) + v;
}

async function runParallel(workers: number): Promise<Counters> {
  const here = dirname(fileURLToPath(import.meta.url));
  const bin = resolve(here, '../node_modules/vite-node/vite-node.mjs');
  const script = resolve(here, 'brawl-balance.ts');
  const total: Counters = {};
  await Promise.all(
    Array.from({ length: workers }, (_, k) =>
      new Promise<void>((done, fail) => {
        const child = spawn(process.execPath, [bin, script], {
          env: { ...process.env, BRAWL_WORKER: String(k), BRAWL_WORKERS: String(workers) },
          stdio: ['ignore', 'pipe', 'inherit'],
        });
        let buf = '';
        child.stdout.on('data', (d: Buffer) => {
          buf += d.toString('utf8');
        });
        child.on('error', fail);
        child.on('close', (code: number | null) => {
          const m = /@@RESULT@@(.*)/.exec(buf);
          if (code !== 0 || !m) {
            fail(new Error(`worker ${k} failed (code ${code})\n${buf.slice(-2000)}`));
            return;
          }
          merge(total, JSON.parse(m[1]) as Counters);
          done();
        });
      }),
    ),
  );
  return total;
}

// ── reporting ────────────────────────────────────────────────────────────────

const pct = (a: number, b: number): number => (b > 0 ? (100 * a) / b : 0);
const f1 = (v: number): string => v.toFixed(1);
const pad = (s: string | number, n: number): string => String(s).padStart(n);
const padR = (s: string, n: number): string => s.padEnd(n);

interface Verdict {
  name: string;
  ok: boolean;
  detail: string;
}

function report(c: Counters): Verdict[] {
  const verdicts: Verdict[] = [];
  const games = c['g'] ?? 0;
  const lvList = LEVEL_LIST && LEVEL_LIST.length > 1 ? LEVEL_LIST : null;
  const title = lvList
    ? `LEVELS ${lvList.join(',')} duels (M=${M})`
    : MODE === 'ffa'
      ? `FFA 4-fighter, level ${LEVEL}`
      : `duels, level ${LEVEL}, N=${N} per ordered pairing`;
  console.log(`\nChampions League balance — ${title}; stages: ${STAGES.join(', ')}; stocks ${STOCKS}; ${games} games\n`);

  if (!lvList) {
    // per animal table
    console.log(
      `${padR('animal', 10)}${pad('games', 7)}${pad('win%', 7)}${pad('draw%', 7)}${pad('KOs/g', 7)}${pad('KO@%', 7)}${pad('SD%', 6)}${pad('stk lost', 9)}${pad('secs', 7)}${pad('dmg/g', 8)}`,
    );
    const winRates: Record<string, number> = {};
    for (const a of ANIMALS) {
      const g = c[`g:${a}`] ?? 0;
      const w = c[`w:${a}`] ?? 0;
      const d = c[`d:${a}`] ?? 0;
      const lost = c[`lost:${a}`] ?? 0;
      winRates[a] = pct(w, g);
      console.log(
        `${padR(a, 10)}${pad(g, 7)}${pad(f1(pct(w, g)), 7)}${pad(f1(pct(d, g)), 7)}${pad(f1((c[`kos:${a}`] ?? 0) / Math.max(1, g)), 7)}${pad(
          f1((c[`koPct:${a}`] ?? 0) / Math.max(1, c[`koN:${a}`] ?? 0)),
          7,
        )}${pad(f1(pct(c[`sd:${a}`] ?? 0, lost)), 6)}${pad(f1(lost / Math.max(1, g)), 9)}${pad(f1((c[`frames:${a}`] ?? 0) / Math.max(1, g) / 60), 7)}${pad(
          f1((c[`dmg:${a}`] ?? 0) / Math.max(1, g)),
          8,
        )}`,
      );
    }
    const ko = c['ko'] ?? 0;
    const meanKoPct = (c['koPct'] ?? 0) / Math.max(1, ko);
    const sdShare = pct(c['sd'] ?? 0, ko);
    const secs = (c['frames'] ?? 0) / Math.max(1, games) / 60;
    const toRate = pct(c['timeout'] ?? 0, games);
    console.log(
      `\noverall: KOs/match ${f1(ko / Math.max(1, games))}  mean KO percent ${f1(meanKoPct)}  self-destruct ${f1(sdShare)} % of stocks  avg match ${f1(secs)} s  timeouts ${f1(toRate)} %  ledge grabs/match ${f1((c['ledge'] ?? 0) / Math.max(1, games))}`,
    );
    console.log(
      `blast sides: left ${c['side:left'] ?? 0}  right ${c['side:right'] ?? 0}  top ${c['side:top'] ?? 0}  bottom ${c['side:bottom'] ?? 0}`,
    );

    // matrix (duel mode)
    if (MODE === 'duel') {
      console.log('\nmatchup matrix: row animal win % against column animal');
      console.log(padR('', 10) + ANIMALS.map((a) => pad(a.slice(0, 5), 6)).join(''));
      let worst = 100;
      let worstPair = '';
      for (const a of ANIMALS) {
        let line = padR(a, 10);
        for (const b of ANIMALS) {
          if (a === b) {
            line += pad('--', 6);
            continue;
          }
          const g = c[`mx:${a}:${b}:g`] ?? 0;
          const v = pct(c[`mx:${a}:${b}:w`] ?? 0, g);
          if (g > 0 && v < worst) {
            worst = v;
            worstPair = `${a} vs ${b}`;
          }
          line += pad(g > 0 ? v.toFixed(0) : '-', 6);
        }
        console.log(line);
      }
      verdicts.push({ name: 'worst matchup >= 30 %', ok: worst >= 30, detail: `${f1(worst)} % (${worstPair})` });
    }

    // move usage
    console.log('\nmove usage per animal: share of its damage / uses per game (u) / connects per use (h, % - multi-hit moves can exceed 100):');
    const warnings: string[] = [];
    for (const a of ANIMALS) {
      const tot = c[`dmg:${a}`] ?? 0;
      if (tot <= 0) continue;
      const shares = MOVE_IDS.map((m) => ({
        m,
        s: pct(c[`m:${a}:${m}`] ?? 0, tot),
        hit: pct(c[`mh:${a}:${m}`] ?? 0, c[`ms:${a}:${m}`] ?? 0),
        uses: (c[`ms:${a}:${m}`] ?? 0) / Math.max(1, c[`g:${a}`] ?? 1),
      }));
      console.log(
        `  ${padR(a, 10)}${shares.map((x) => `${x.m.replace('light', 'L').replace('heavy', 'H')} ${pad(x.s.toFixed(0), 2)}%/${pad(x.uses.toFixed(0), 2)}u/${pad(x.hit.toFixed(0), 3)}h`).join('  ')}`,
      );
      for (const x of shares) if (x.s > 45) warnings.push(`${a}.${x.m} ${x.s.toFixed(0)} %`);
    }
    console.log(warnings.length ? `  DOMINANT-MOVE WARNING (> 45 %): ${warnings.join(', ')}` : '  no dominant move (> 45 % of damage)');
    // dodge usage
    // acceptance
    if (MODE === 'duel' && LEVEL === 4) {
      const out = ANIMALS.filter((a) => winRates[a] < 42 || winRates[a] > 58);
      verdicts.push({
        name: 'win rate 42-58 % per animal',
        ok: out.length === 0,
        detail: out.length ? out.map((a) => `${a} ${f1(winRates[a])}`).join(', ') : 'all in band',
      });
    }
    if (MODE === 'ffa') {
      const out = ANIMALS.filter((a) => winRates[a] < 18 || winRates[a] > 32);
      verdicts.push({
        name: 'FFA win rate 18-32 % per animal',
        ok: out.length === 0,
        detail: out.length ? out.map((a) => `${a} ${f1(winRates[a])}`).join(', ') : 'all in band',
      });
    }
    verdicts.push({ name: 'mean KO percent 80-150', ok: meanKoPct >= 80 && meanKoPct <= 150, detail: f1(meanKoPct) });
    verdicts.push({ name: 'timeouts < 5 %', ok: toRate < 5, detail: `${f1(toRate)} %` });
    verdicts.push({ name: 'match length 70-220 s', ok: secs >= 70 && secs <= 220, detail: `${f1(secs)} s` });
    verdicts.push({ name: 'self-destructs < 15 % of stocks', ok: sdShare < 15, detail: `${f1(sdShare)} %` });
  } else {
    console.log('level matrix: win % of the ROW level against the COLUMN level (all animal pairings, seats alternated)');
    console.log(padR('', 8) + lvList.map((l) => pad(`L${l}`, 8)).join(''));
    for (const la of lvList) {
      let line = padR(`L${la}`, 8);
      for (const lb of lvList) {
        let v = 50;
        if (la === lb) {
          line += pad('50.0', 8);
          continue;
        }
        const lo = Math.min(la, lb);
        const hi = Math.max(la, lb);
        const key = `${lo}:${hi}`;
        const g = c[`lvn:${key}`] ?? 0;
        const wLo = c[`lvw:${key}:${lo}`] ?? 0;
        const wHi = c[`lvw:${key}:${hi}`] ?? 0;
        v = la === lo ? pct(wLo, g) : pct(wHi, g);
        line += pad(f1(v), 8);
      }
      console.log(line);
    }
    const hiWins = (lo: number, hi: number): number => {
      const g = c[`lvn:${lo}:${hi}`] ?? 0;
      return pct(c[`lvw:${lo}:${hi}:${hi}`] ?? 0, g);
    };
    const need: [number, number, number][] = [
      [1, 4, 90],
      [2, 4, 75],
      [3, 4, 55],
    ];
    for (const [lo, hi, min] of need) {
      if (!lvList.includes(lo as BrawlDifficulty) || !lvList.includes(hi as BrawlDifficulty)) continue;
      const v = hiWins(lo, hi);
      verdicts.push({ name: `L${hi} beats L${lo} >= ${min} %`, ok: v >= min, detail: `${f1(v)} %` });
    }
    const secs = (c['frames'] ?? 0) / Math.max(1, games) / 60;
    console.log(`\navg match ${f1(secs)} s, self-destruct ${f1(pct(c['sd'] ?? 0, c['ko'] ?? 0))} % of stocks, timeouts ${f1(pct(c['timeout'] ?? 0, games))} %`);
  }
  return verdicts;
}

// ── trace ────────────────────────────────────────────────────────────────────

function traceOne(): void {
  const A = ANIMALS[0];
  const B = ANIMALS[1] ?? ANIMALS[0];
  const stage = STAGES[0];
  const lv = LEVEL_LIST ?? [LEVEL, LEVEL];
  const job: Job = { stage, animals: [A, B], levels: [lv[0], lv[1] ?? lv[0]], seed: hashSeed(1, 2, 3), tag: 'trace' };
  console.log(`TRACE ${A} (L${job.levels[0]}) vs ${B} (L${job.levels[1]}) on ${stage}, seed ${job.seed}`);
  const c: Counters = {};
  playMatch(job, c, true);
  console.log(`result: game frames ${c['frames']}  KOs ${c['ko'] ?? 0}  self-destructs ${c['sd'] ?? 0}  timeout ${c['timeout'] ?? 0}`);
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (TRACE) {
    traceOne();
    return;
  }
  const jobs = buildJobs();
  const c: Counters = {};
  if (WORKER_ID >= 0) {
    runJobs(jobs, c);
    process.stdout.write(`@@RESULT@@${JSON.stringify(c)}\n`);
    return;
  }
  const want = env.WORKERS !== undefined ? Number(env.WORKERS) : Math.min(Math.max(1, cpus().length - 2), 10);
  const t0 = Date.now();
  let total: Counters;
  if (want > 1 && jobs.length >= 40) {
    console.log(`running ${jobs.length} games on ${want} workers...`);
    total = await runParallel(want);
  } else {
    console.log(`running ${jobs.length} games in-process...`);
    runJobs(jobs, c);
    total = c;
  }
  const verdicts = report(total);
  console.log(`\n${((Date.now() - t0) / 1000).toFixed(1)} s wall, ${jobs.length} games`);
  if (PROFILE) console.log(`profile (this process): sim ${simMs.toFixed(0)} ms, bots ${botMs.toFixed(0)} ms`);
  console.log('\nacceptance bands:');
  for (const v of verdicts) console.log(`  ${v.ok ? 'ok  ' : 'FAIL'} ${padR(v.name, 36)} ${v.detail}`);
  const bad = verdicts.filter((v) => !v.ok);
  console.log(bad.length === 0 ? '\nRESULT: PASS' : `\nRESULT: FAIL (${bad.length}: ${bad.map((b) => b.name).join('; ')})`);
}

void main();
