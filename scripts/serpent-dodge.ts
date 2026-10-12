/**
 * Sea-serpent dodge rates of the bots (v1.9 WP-O2): isolated trials on the real Ocean Dome (see serpentTrial.ts).
 *
 *   npx vite-node scripts/serpent-dodge.ts            (N=40 trials per animal and level, all four levels)
 *   N=100 LEVELS=3,4 npx vite-node scripts/serpent-dodge.ts
 *   TUNE='{"1":{"extraMs":250}}' npx vite-node scripts/serpent-dodge.ts     (what-if on the SERPENT_AI knobs)
 *
 * The rate printed is the share of trials in which the fighter took no serpent damage. The in-match rates (bots mid-fight, hemmed in
 * by others) are measured by `SERPENT_EVERY=20 ARENA=ocean npm run balance`.
 */
import { ANIMAL_IDS } from '../src/config/animals';
import { BOT_PROFILES } from '../src/config/botProfiles';
import { SERPENT_AI } from '../src/ai/SerpentSense';
import { trial } from './serpentTrial';
import type { AnimalId, Difficulty } from '../src/core/types';

const N = Number(process.env.N ?? 40);
const LEVELS = (process.env.LEVELS ?? '1,2,3,4').split(',').map((s) => Number(s.trim()) as Difficulty);

function main(): void {
  // TUNE='{"1":{"extraMs":250}}' overrides SERPENT_AI knobs for a quick what-if.
  if (process.env.TUNE !== undefined) {
    const t = JSON.parse(process.env.TUNE) as Record<string, Record<string, number | boolean>>;
    for (const k of Object.keys(t)) Object.assign(SERPENT_AI[Number(k) as Difficulty], t[k]);
  }
  console.log(`serpent dodge: ${N} isolated trials per animal and level (random point in the strip, random angle); survived = no serpent damage`);
  const rows: string[] = [];
  for (const level of LEVELS) {
    let ok = 0;
    let tot = 0;
    const per: string[] = [];
    let reactSum = 0;
    let reactN = 0;
    for (const animal of ANIMAL_IDS as readonly AnimalId[]) {
      let aOk = 0;
      for (let i = 0; i < N; i++) {
        const seed = 70000 + level * 1000 + i * 17 + (animal.charCodeAt(0) + animal.length) * 131;
        const r = trial(animal, level, seed);
        tot++;
        if (!r.hit) {
          ok++;
          aOk++;
        }
        if (r.reactedAt >= 0) {
          reactSum += r.reactedAt;
          reactN++;
        }
      }
      per.push(`${animal.slice(0, 4)} ${((100 * aOk) / N).toFixed(0)}`);
    }
    rows.push(
      `L${level} ${BOT_PROFILES[level].displayName.padEnd(8)} dodge ${((100 * ok) / tot).toFixed(1).padStart(5)} %  (${ok}/${tot})  mean reaction ${reactN > 0 ? ((1000 * reactSum) / reactN).toFixed(0) : '-'} ms | ${per.join('  ')}`,
    );
    console.log(rows[rows.length - 1]);
  }
}

main();
