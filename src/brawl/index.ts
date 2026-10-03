/**
 * Champions League (platform-fighter mode) — public surface for the shell (`src/main.ts` loads this lazily:
 * `await import('./brawl')`, so the Battle Royale boot never pays for it). The stylesheet is imported eagerly
 * by `src/ui/index.ts` (`styles/brawl.css`).
 */

export { BrawlSetup, type BrawlSetupOptions } from './ui/BrawlSetup';
export { BrawlResults, buildResultsData, type BrawlResultsData, type BrawlResultsOptions, type BrawlFighterResult } from './ui/BrawlResults';
export { BrawlMatchController, type BrawlMatchControllerOptions } from './BrawlMatchController';
export { BrawlInput } from './ui/BrawlInput';
export { BrawlHud } from './ui/BrawlHud';
export { BrawlPause } from './ui/BrawlPause';
export { BrawlSession } from './ui/BrawlSession';
export {
  buildMatchConfig,
  buildRoster,
  defaultBrawlSetup,
  parseBrawlSetup,
  type BrawlSetupChoice,
  type BrawlOpponents,
  type BrawlStocks,
  type BrawlTimeMin,
} from './ui/setup';
export { BrawlAudio } from './audio/BrawlAudio';
