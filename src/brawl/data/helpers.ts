/**
 * Champions League — small builders that keep the per-animal move files readable.
 *
 * Conventions (binding for every file in `src/brawl/data/animals`):
 *  - Hitbox coordinates are fighter-local metres: origin = feet centre, +x forward, +y up.
 *  - A hitbox is authored with `win: [a, b)` = offsets INSIDE the move's active window
 *    (default: the whole window); the builder turns that into move-relative `from`/`to`.
 *  - `path` keyframes are authored as `[frameInsideWindow, dx, dy]` OFFSETS from the box's
 *    (x, y), which is the position on the box's first active frame; the builder converts the
 *    frame to MOVE-RELATIVE frames (same clock as `from`/`to`) and always starts at (0, 0).
 *    Between keys the offset is linearly interpolated; before/after it clamps.
 *  - `anim` is free-form for the animation layer. Keys used everywhere: `look` (one-line
 *    description), `limb` (the striking part: paw, forelimb, hindleg, jaw, head, horn, tail, neck, body,
 *    wing, beak, talon, claw), `reach` (m from the feet centre to the striking tip at peak),
 *    `height` (m above the feet at peak), `side` (L | R | both | front | back | up | down), plus move
 *    specific numbers (arc = swing degrees, travel = metres moved, spin = turns, rise = metres climbed).
 */

import type {
  ArchetypeId,
  CharacterStats,
  HitboxDef,
  MoveBody,
  MoveData,
  MoveId,
  MoveMotion,
  MovesetDef,
} from '../types';
import { MOVE_IDS } from '../types';
import type { AnimalId } from '../../core/types';

export type Anim = Record<string, number | string>;
export type Effect = NonNullable<HitboxDef['effect']>;
/** `[frame inside the hitbox window, dx, dy]`. */
export type PathKey = [number, number, number];
/** `[x, y, radius, damageMult, kbMult]`. */
export type SweetSpec = [number, number, number, number, number];

export interface HbOpts {
  /** `[a, b)` offsets inside the active window. Default: the whole window. */
  win?: [number, number];
  hitlag?: number;
  /** hitstunScale. */
  stun?: number;
  sweet?: SweetSpec;
  path?: PathKey[];
  /** multiHitInterval. */
  multi?: number;
  fx?: Effect;
  group?: number;
}

export interface HbSpec {
  shape: 'circle' | 'rect';
  x: number;
  y: number;
  r: number;
  w: number;
  h: number;
  damage: number;
  baseKb: number;
  kbGrowth: number;
  angle: number;
  opts: HbOpts;
}

export const hb = {
  circle(x: number, y: number, r: number, damage: number, baseKb: number, kbGrowth: number, angle: number, opts: HbOpts = {}): HbSpec {
    return { shape: 'circle', x, y, r, w: 0, h: 0, damage, baseKb, kbGrowth, angle, opts };
  },
  rect(x: number, y: number, w: number, h: number, damage: number, baseKb: number, kbGrowth: number, angle: number, opts: HbOpts = {}): HbSpec {
    return { shape: 'rect', x, y, r: 0, w, h, damage, baseKb, kbGrowth, angle, opts };
  },
};

export function A(look: string, o: Anim = {}): Anim {
  return { look, ...o };
}

/** Motion shorthand: `set: true` by default (velocity is set each frame of the window). */
export function mot(from: number, to: number, o: { vx?: number; vy?: number; g?: number; add?: boolean } = {}): MoveMotion {
  const m: MoveMotion = { from, to, set: !o.add };
  if (o.vx !== undefined) m.vx = o.vx;
  if (o.vy !== undefined) m.vy = o.vy;
  if (o.g !== undefined) m.gravity = o.g;
  return m;
}

export interface BodyExtra {
  motion?: MoveMotion[];
  armor?: MoveBody['armor'];
  invuln?: MoveBody['invuln'];
  cancels?: MoveBody['cancels'];
  turn?: boolean;
}

function resolveHit(s: HbSpec, startup: number, active: number): HitboxDef {
  const [a, b] = s.opts.win ?? [0, active];
  const from = startup + a;
  const to = startup + b;
  const h: HitboxDef = {
    shape: s.shape,
    x: s.x,
    y: s.y,
    r: s.r,
    w: s.w,
    h: s.h,
    from,
    to,
    damage: s.damage,
    baseKb: s.baseKb,
    kbGrowth: s.kbGrowth,
    angle: s.angle,
  };
  const o = s.opts;
  if (o.hitlag !== undefined) h.hitlag = o.hitlag;
  if (o.stun !== undefined) h.hitstunScale = o.stun;
  if (o.sweet) h.sweet = { x: o.sweet[0], y: o.sweet[1], r: o.sweet[2], damageMult: o.sweet[3], kbMult: o.sweet[4] };
  if (o.path) {
    const keys = o.path.map(([f, x, y]) => ({ frame: from + f, x, y }));
    if (keys.length === 0 || keys[0].frame > from) keys.unshift({ frame: from, x: 0, y: 0 });
    h.path = keys;
  }
  if (o.multi !== undefined) h.multiHitInterval = o.multi;
  if (o.fx !== undefined) h.effect = o.fx;
  if (o.group !== undefined) h.group = o.group;
  return h;
}

export function resolveHits(specs: HbSpec[], startup: number, active: number): HitboxDef[] {
  return specs.map((s) => resolveHit(s, startup, active));
}

/** Build one move body. `t` = [startup, active, recovery] in frames. */
export function body(name: string, archetype: ArchetypeId, anim: Anim, t: [number, number, number], hits: HbSpec[], x: BodyExtra = {}): MoveBody {
  const [startup, active, recovery] = t;
  const b: MoveBody = { name, archetype, anim, startup, active, recovery, hitboxes: resolveHits(hits, startup, active) };
  if (x.motion) b.motion = x.motion;
  if (x.armor) b.armor = x.armor;
  if (x.invuln) b.invuln = x.invuln;
  if (x.cancels) b.cancels = x.cancels;
  if (x.turn) b.turnOnStart = true;
  return b;
}

/** Light-neutral string link: press Light inside [from, to) to continue (`onHitOnly` = later links). */
export function linkTo(from: number, to: number, onHitOnly: boolean): NonNullable<MoveBody['cancels']> {
  return [{ into: ['lightN'], from, to, onHitOnly }];
}

export interface AirOpts {
  /** Landing lag (frames) when landing before the move ends. */
  lag: number;
  /** Auto-cancel window [from, to). Default: the last 8 frames of the aerial. */
  ac?: [number, number];
  name?: string;
  arch?: ArchetypeId;
  anim?: Anim;
  /** Override [startup, active, recovery]. */
  t?: [number, number, number];
  hits?: HbSpec[];
  motion?: MoveMotion[];
  armor?: MoveBody['armor'];
  invuln?: MoveBody['invuln'];
}

/** Air form: partial overrides of `ground` (always carries `landingLag` + `autoCancel`). */
export function air(g: MoveBody, o: AirOpts): Partial<MoveBody> {
  const [su, act, rec] = o.t ?? [g.startup, g.active, g.recovery];
  const total = su + act + rec;
  const p: Partial<MoveBody> = {
    landingLag: o.lag,
    autoCancel: o.ac ? { from: o.ac[0], to: o.ac[1] } : { from: Math.max(su + act + 1, total - 8), to: total },
    // chained link windows are ground-only
    cancels: [],
  };
  if (o.name !== undefined) p.name = o.name;
  if (o.arch !== undefined) p.archetype = o.arch;
  if (o.anim !== undefined) p.anim = o.anim;
  if (o.t) {
    p.startup = su;
    p.active = act;
    p.recovery = rec;
  }
  if (o.hits) p.hitboxes = resolveHits(o.hits, su, act);
  else if (o.t) {
    // timings changed but hit boxes kept: re-base their windows onto the new startup/active
    p.hitboxes = g.hitboxes.map((h) => ({
      ...h,
      from: su + (h.from - g.startup),
      to: Math.min(su + act, su + (h.to - g.startup)),
      ...(h.path ? { path: h.path.map((k) => ({ ...k, frame: k.frame + (su - g.startup) })) } : {}),
    }));
  }
  if (o.motion) p.motion = o.motion;
  if (o.armor) p.armor = o.armor;
  if (o.invuln) p.invuln = o.invuln;
  return p;
}

export function mv(id: MoveId, ground: MoveBody, airForm: Partial<MoveBody> | null, chain?: MoveBody[]): MoveData {
  const m: MoveData = { id, ground, air: airForm };
  if (chain && chain.length) m.chain = chain;
  return m;
}

export function moveset(animal: AnimalId, tagline: string, stats: CharacterStats, list: MoveData[]): MovesetDef {
  const moves = {} as Record<MoveId, MoveData>;
  for (const m of list) moves[m.id] = m;
  for (const id of MOVE_IDS) {
    if (!moves[id]) throw new Error(`moveset ${animal}: missing move ${id}`);
  }
  return { animal, tagline, stats, moves };
}

/** Stats builder: named fields, dodge frames derived from weight class (14 invuln for all). */
export function cs(s: Omit<CharacterStats, 'dodgeInvuln' | 'dodgeFrames'> & { dodgeFrames?: number }): CharacterStats {
  const dodgeFrames = s.dodgeFrames ?? (s.weight >= 110 ? 28 : s.weight <= 85 ? 24 : 26);
  const { dodgeFrames: _ignored, ...rest } = s;
  void _ignored;
  return { ...rest, dodgeInvuln: 14, dodgeFrames };
}
