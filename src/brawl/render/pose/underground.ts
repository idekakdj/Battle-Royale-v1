/**
 * v1.6 burrow visibility (WP-B2): is a fighter's rig hidden because it is underground?
 *
 * The sim publishes `BrawlFighterState.underground` per snapshot (true while `moveFrame` is inside the move's `burrow` window
 * `[from, to)`, evaluated at the INTEGER frame). The view renders at the continuous time `moveFrame − (1 − alpha)` between `prev`
 * and `cur`, so the flag has to be interpolated the same way or the rig flashes for a frame at both boundaries:
 *
 *  - the interval `[prev, cur)` belongs to `prev`'s state (the dig-in is still visible until the window opens exactly at `alpha = 1`,
 *    the surfacing only shows at `alpha = 1` of the first non-underground snapshot);
 *  - the rule is pure (no stored state), so a rollback, a restart or a teleport can never leave the rig hidden: with no `prev`, a
 *    discontinuity (a different move / a jump in position / a dead `prev`) it simply follows `cur`.
 */

import type { BrawlFighterState } from '../../types';

/** Positions further apart than this between `prev` and `cur` are a teleport (respawn, rollback), not movement. */
const TELEPORT_SQ = 9;

export function rigHiddenUnderground(cur: BrawlFighterState, prev: BrawlFighterState | null, alpha: number): boolean {
  const c = cur.underground === true;
  if (prev === null) return c;
  const p = prev.underground === true;
  if (!c && !p) return false;
  if (!cur.alive || !prev.alive) return c;
  const dx = cur.pos.x - prev.pos.x;
  const dy = cur.pos.y - prev.pos.y;
  if (dx * dx + dy * dy > TELEPORT_SQ) return c;
  // The two snapshots must be consecutive frames of the same move (otherwise `prev` says nothing about the interval).
  const cont =
    cur.action === 'attack' &&
    prev.action === 'attack' &&
    cur.moveId === prev.moveId &&
    cur.moveAir === prev.moveAir &&
    cur.moveChain === prev.moveChain &&
    cur.moveFrame >= prev.moveFrame &&
    cur.moveFrame - prev.moveFrame <= 2;
  if (!cont) return c;
  return alpha >= 1 ? c : p;
}
