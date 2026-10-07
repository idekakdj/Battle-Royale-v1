/**
 * Local-id swap (WP-N3, plan §5). The Battle Royale `MatchController` assumes the local player is fighter 0. A networked
 * client sits in some other slot `s`, so the controller works on `swapIds(snapshot, 0, s)` / `swapEventIds(event, 0, s)`
 * (and sends nothing id-carrying back: intents have no ids). The swap is a transposition, hence its own inverse.
 *
 * It remaps EVERY id-carrying field and nothing else:
 *   snapshot  fighters[].id (and array position), grabTargetId, grabbedById, ultTargetId (when present),
 *             traps[].triggeredBy, projectiles[].ownerId, winnerId
 *   events    see {@link EVENT_ID_FIELDS} (attackerId/targetId/killerId/fighterId/ownerId/hitId/winnerId …)
 * `−1` (and any id other than a/b) is left alone. Pickup / crate / trap / projectile ids and `death.placement` are NOT fighter
 * ids and are untouched.
 */

import type { FighterState, GameEvent, GameEventOf, WorldSnapshot } from '../../core/types';
import type { BrResults } from './miscCodec';

type Type = GameEvent['type'];
type NumKeys<T> = { [P in keyof T]: T[P] extends number ? P : never }[keyof T];

/** a ↔ b on a single id value. */
export function swapId(id: number, a: number, b: number): number {
  return id === a ? b : id === b ? a : id;
}

/**
 * Fighter-id-carrying numeric fields of every event variant. A mapped type over the union: a new variant fails to compile
 * until it is listed (use `[]` for "no fighter ids"), and the field names are checked against the variant.
 */
export const EVENT_ID_FIELDS: { [K in Type]: ReadonlyArray<NumKeys<GameEventOf<K>>> } = {
  hit: ['attackerId', 'targetId'],
  blocked: ['attackerId', 'targetId'],
  guardBreak: ['targetId'],
  death: ['targetId', 'killerId'],
  ultimate: ['fighterId'],
  special: ['fighterId'],
  telegraph: ['fighterId'],
  pickup: ['fighterId'],
  comboFinisher: ['fighterId'],
  crateBreak: [],
  swingImpact: ['fighterId'],
  ultimateTarget: ['fighterId', 'targetId'],
  ultimateFizzle: ['fighterId'],
  ultimateStage: ['fighterId', 'targetId'],
  blink: ['fighterId'],
  projectileImpact: ['ownerId', 'hitId'],
  trapTriggered: ['fighterId'],
  trapDamage: ['targetId'],
  trapExpired: [],
  landingImpact: ['fighterId'],
  matchEnd: ['winnerId'],
  splash: ['fighterId'],
};

/**
 * Numeric event fields that are deliberately NOT fighter ids (ranks, other id spaces, measurements). Together with
 * {@link EVENT_ID_FIELDS} every numeric field of every variant must be accounted for — the test enforces it, so a new numeric
 * field forces a conscious "is this a fighter id?" decision.
 */
export const EVENT_NON_ID_NUMERIC_FIELDS: { [K in Type]: ReadonlyArray<NumKeys<GameEventOf<K>>> } = {
  hit: ['damage'],
  blocked: ['damage'],
  guardBreak: [],
  death: ['placement'],
  ultimate: [],
  special: [],
  telegraph: ['radius', 'yaw', 'arcDeg', 'windup'],
  pickup: [],
  comboFinisher: [],
  crateBreak: ['crateId'],
  swingImpact: ['yaw', 'range', 'arcDeg', 'step'],
  ultimateTarget: ['range', 'width', 'windup'],
  ultimateFizzle: [],
  ultimateStage: ['stage'],
  blink: [],
  projectileImpact: ['radius'],
  trapTriggered: ['trapId'],
  trapDamage: ['trapId', 'damage'],
  trapExpired: ['trapId'],
  landingImpact: ['radius', 'damage', 'height'],
  matchEnd: [],
  splash: ['strength'],
};

function cloneFighter(f: FighterState): FighterState {
  const c: FighterState = {
    ...f,
    pos: { ...f.pos },
    vel: { ...f.vel },
    buffs: f.buffs.map((b) => ({ ...b })),
  };
  return c;
}

/** A copy of `snap` with fighter ids `a` and `b` exchanged everywhere. Pure; `snap` is not modified. */
export function swapIds(snap: WorldSnapshot, a: number, b: number): WorldSnapshot {
  const n = snap.fighters.length;
  const fighters: FighterState[] = snap.fighters.map(cloneFighter);
  for (const f of fighters) {
    f.id = swapId(f.id, a, b);
    f.grabTargetId = swapId(f.grabTargetId, a, b);
    f.grabbedById = swapId(f.grabbedById, a, b);
    if (f.ultTargetId !== undefined) f.ultTargetId = swapId(f.ultTargetId, a, b);
  }
  // Keep "array index == fighter id" (the sim's invariant) by exchanging the two slots too.
  if (a !== b && a >= 0 && b >= 0 && a < n && b < n) {
    const t = fighters[a];
    fighters[a] = fighters[b];
    fighters[b] = t;
  }
  const out: WorldSnapshot = {
    time: snap.time,
    fighters,
    pickups: snap.pickups.map((p) => ({ ...p, pos: { ...p.pos } })),
    crates: snap.crates.map((c) => ({ ...c, pos: { ...c.pos } })),
    traps: snap.traps.map((t) => ({ ...t, pos: { ...t.pos }, triggeredBy: swapId(t.triggeredBy, a, b) })),
    bloodlustMult: snap.bloodlustMult,
    matchOver: snap.matchOver,
    winnerId: swapId(snap.winnerId, a, b),
  };
  if (snap.projectiles !== undefined) {
    out.projectiles = snap.projectiles.map((p) => ({ ...p, pos: { ...p.pos }, vel: { ...p.vel }, ownerId: swapId(p.ownerId, a, b) }));
  }
  return out;
}

/** A copy of `e` with fighter ids `a` and `b` exchanged. Pure. */
export function swapEventIds<E extends GameEvent>(e: E, a: number, b: number): E {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(e)) out[k] = v !== null && typeof v === 'object' ? { ...(v as object) } : v;
  for (const field of EVENT_ID_FIELDS[e.type] as readonly string[]) {
    out[field] = swapId(out[field] as number, a, b);
  }
  return out as unknown as E;
}

/** Exchange entries `a` and `b` of a per-fighter array (placements, stats …). Pure. */
export function swapList<T>(list: readonly T[], a: number, b: number): T[] {
  const out = list.slice();
  if (a !== b && a >= 0 && b >= 0 && a < out.length && b < out.length) {
    const t = out[a];
    out[a] = out[b];
    out[b] = t;
  }
  return out;
}

/** Same for the end-of-match results message. */
export function swapResults(r: BrResults, a: number, b: number): BrResults {
  return {
    winnerId: swapId(r.winnerId, a, b),
    matchTimeS: r.matchTimeS,
    fighters: swapList(r.fighters, a, b).map((f) => ({ ...f })),
  };
}
