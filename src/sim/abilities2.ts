/**
 * Compatibility barrel (v1.3). The ultimate code that used to live here was split
 * into per-animal modules: see `src/sim/ultimates/` — `common.ts` (shared scaffolding:
 * begin/telegraph/end, hitArea, aim helpers, blink, event helpers), `index.ts`
 * (registry + `startUlt`/`updateUlt`), `<animal>.ts` (one `UltimateImpl` each) and
 * `targeting.ts`. New code should import from `./ultimates/...` directly.
 */

export {
  aimX,
  aimZ,
  aimPointDist,
  beginAbility,
  emitCastEvents,
  endAbility,
  hitArea,
} from './ultimates/common';
export type { AreaCfg } from './ultimates/common';
export { startUlt, updateUlt } from './ultimates';
