/**
 * Sea-serpent dodge rates of the bots (v1.9 WP-O2; per lane since v1.10 WP-H3): isolated trials on the real Ocean Dome (see
 * serpentTrial.ts).
 *
 *   npx vite-node scripts/serpent-dodge.ts            (N=40 trials per animal and level, all four levels, both lanes)
 *   N=100 LEVELS=3,4 LANES=high npx vite-node scripts/serpent-dodge.ts
 *   TUNE='{"1":{"extraMs":250}}' npx vite-node scripts/serpent-dodge.ts     (what-if on the SERPENT_AI knobs)
 *
 * The rate printed is the share of trials in which the fighter took no serpent damage (a fall off a tower does not count as a hit:
 * `fell` is reported next to it; `dive` = the bot chose the fall on purpose). The LOW lane's trial puts the fighter at a random point
 * of a strip on low ground, the HIGH lane's on a tower top / the upper part of a tower ramp. The in-match rates (bots mid-fight, hemmed
 * in by others) are measured by `SERPENT_EVERY=20 ARENA=ocean npm run balance`.
 */
import { ANIMAL_IDS } from '../src/config/animals';
import { BOT_PROFILES } from '../src/config/botProfiles';
import { SERPENT_AI } from '../src/ai/SerpentSense';
import { trial } from './serpentTrial';
import type { AnimalId, Difficulty, SerpentTier } from '../src/core/types';

const N = Number(process.env.N ?? 40);
const LEVELS = (process.env.LEVELS ?? '1,2,3,4').split(',').map((s) => Number(s.trim()) as Difficulty);
const LANES = (process.env.LANES ?? 'low,high').split(',').map((s) => s.trim() as SerpentTier);

function main(): void {
  // TUNE='{"1":{"extraMs":250}}' overrides SERPENT_AI knobs for a quick what-if.
  if (process.env.TUNE !== undefined) {
    const t = JSON.parse(process.env.TUNE) as Record<string, Record<string, number | boolean>>;
    for (const k of Object.keys(t)) Object.assign(SERPENT_AI[Number(k) as Difficulty], t[k]);
  }
  console.log(`serpent dodge: ${N} isolated trials per animal, level and lane (random point in the strip, angle drawn like the sim's); survived = no serpent damage`);
  for (const tier of LANES) {
    for (const level of LEVELS) {
      let ok = 0;
      let tot = 0;
      let fell = 0;
      let dived = 0;
      const per: string[] = [];
      let reactSum = 0;
      let reactN = 0;
      for (const animal of ANIMAL_IDS as readonly AnimalId[]) {
        let aOk = 0;
        for (let i = 0; i < N; i++) {
          const seed = 70000 + level * 1000 + i * 17 + (animal.charCodeAt(0) + animal.length) * 131;
          const r = trial(animal, level, seed, tier);
          tot++;
          if (!r.hit) {
            ok++;
            aOk++;
          }
          if (r.fell) fell++;
          if (r.dived) dived++;
          if (r.reactedAt >= 0) {
            reactSum += r.reactedAt;
            reactN++;
          }
        }
        per.push(`${animal.slice(0, 4)} ${((100 * aOk) / N).toFixed(0)}`);
      }
      console.log(
        `${tier.toUpperCase().padEnd(4)} L${level} ${BOT_PROFILES[level].displayName.padEnd(8)} dodge ${((100 * ok) / tot).toFixed(1).padStart(5)} %  (${ok}/${tot})  fell ${((100 * fell) / tot).toFixed(1).padStart(4)} %  dive ${((100 * dived) / tot).toFixed(1).padStart(4)} %  mean reaction ${reactN > 0 ? ((1000 * reactSum) / reactN).toFixed(0) : '-'} ms | ${per.join('  ')}`,
      );
    }
  }
}

main();
