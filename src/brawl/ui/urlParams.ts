/**
 * Champions League URL shortcut: `?brawl=1&animal=lion&stage=skyAqueduct&bots=3&level=3&stocks=3[&time=5]`.
 * Returns the setup to boot straight into a match, or `null` when `brawl=1` is absent. Every field is validated
 * (bad values fall back to `base`, the stored / default setup).
 */

import { parseBrawlSetup, type BrawlSetupChoice } from './setup';

export function parseBrawlParams(params: URLSearchParams, base: BrawlSetupChoice): BrawlSetupChoice | null {
  if (params.get('brawl') !== '1') return null;
  const num = (k: string): number | undefined => {
    const v = params.get(k);
    if (v === null || v.trim() === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const merged: Record<string, unknown> = { ...base };
  const animal = params.get('animal');
  if (animal !== null) merged.animal = animal;
  const stage = params.get('stage');
  if (stage !== null) merged.stage = stage;
  const bots = num('bots');
  if (bots !== undefined) merged.opponents = bots;
  const level = num('level');
  if (level !== undefined) merged.difficulty = level;
  const stocks = num('stocks');
  if (stocks !== undefined) merged.stocks = stocks;
  const time = num('time');
  if (time !== undefined) merged.timeMin = time;
  return parseBrawlSetup(JSON.stringify(merged), base.animal);
}
