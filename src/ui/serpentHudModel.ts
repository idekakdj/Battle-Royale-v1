/**
 * Sea-serpent warning HUD — pure model (v1.9 Ocean Dome, WP-O4; v1.10 two lanes, WP-H5). No DOM / three: the controller feeds the
 * snapshot's `serpent` (LOW lane) and `serpentHigh` (HIGH lane) blocks, the camera yaw and the local fighter; `SerpentHud.ts` paints
 * the returned view.
 *
 * v1.10: the Ocean Dome has TWO independent serpents (docs/OCEAN-HEIGHTS-PLAN.md): the LOW one hurts fighters standing over low
 * ground, the HIGH one fighters over high ground (the upper platforms and the top of their ramps). Each lane has its own banner,
 * rim chevron + line and status chip; both can run at once.
 *
 * What the player sees (arenas with `hazards.serpent` only; the model is inert elsewhere):
 *  - BANNER "SEA SERPENT! — LOW GROUND" / "SEA SERPENT! — HIGH GROUND" on that lane's `serpentWarning` event: ~1 s hold (pulsing),
 *    then a fade. Also shown to spectators (who see nothing else).
 *  - RIM MARKER per running lane (alive local player only): a chevron on the screen edge pointing toward where the strike line
 *    starts — the dome edge point at `angleDeg` — measured from the PLAYER's position and the camera yaw (so it keeps pointing at
 *    the edge point as the camera turns, in first and third person alike), plus a thin line running from the chevron toward the
 *    screen centre whose length grows as the player is closer to the strip (`lineFrac`; 0 when the strike cannot reach the player's
 *    band). The lane's own colour; a lane that cannot hurt the player's current band is drawn dimmed (`onBand: false`).
 *  - STATUS CHIP during the warning, under the lane's banner: `move` ("MOVE!") when the local player is inside that strip AND stands
 *    in the lane's band, `safe` ("SAFE") otherwise. Only the lanes relevant to the player's band show a chip (a player on the plateau
 *    is SAFE from a high strike, on a tower top SAFE from a low one); on the contour between the bands (a ramp near the split
 *    height) both lanes are relevant and both chips show, labelled. During the strike / hold / retreat only the small timer-less
 *    marker stays (`strike`, `after`).
 *
 * "Inside the strip" mirrors the sim's hit rule (SerpentSystem): the player's centre is within `stripHalfWidth + bodyRadius` of the
 * head's path — the segment from the dome edge to the centre — plus a {@link SERPENT_WARN_MARGIN} safety margin so MOVE! shows a
 * hair before it is strictly necessary, AND the player is at most `hazardHeight` above the LOCAL ground (a soaring eagle or anyone
 * standing > 3 m up is immune and shown as safe). The band is the sim's too: the GROUND height under the player against
 * `hazards.serpentSplitY`, widened by {@link SERPENT_BAND_MARGIN} so a step across the contour never flips MOVE! to SAFE a frame late.
 */

import { arenaGroundHeight, arenaHasHighSerpent, type ArenaDef } from '../config/arenas';
import { SERPENT } from '../config/serpent';
import { wrapAngle } from '../core/math';
import type { SerpentPhase, SerpentState, SerpentTier, WorldSnapshot } from '../core/types';

/** Extra metres around the real hit capsule within which the HUD already says MOVE!. */
export const SERPENT_WARN_MARGIN = 0.3;
/** The banner stays fully visible this long after the warning begins (ms), then fades over {@link BANNER_FADE_MS}. */
export const BANNER_HOLD_MS = 1000;
export const BANNER_FADE_MS = 500;
/** Beyond `reach + this` metres from the strip the rim line is at its minimum length (the "distance" ramp). */
export const SAFE_FADE_M = 8;
/** Within this many metres of the split height the player counts as standing in BOTH bands (both lanes are relevant to them). */
export const SERPENT_BAND_MARGIN = 0.4;

/** Both lanes, low first (also the DOM order). */
export const SERPENT_TIERS: readonly SerpentTier[] = ['low', 'high'];

/** Banner copy of a lane. */
export const SERPENT_BANNER_TEXT: Record<SerpentTier, string> = {
  low: 'SEA SERPENT! — LOW GROUND',
  high: 'SEA SERPENT! — HIGH GROUND',
};

/** Short lane labels (chips when two are shown at once). */
export const SERPENT_TIER_LABEL: Record<SerpentTier, string> = { low: 'LOW', high: 'HIGH' };

/** Unit direction (x, z) of the strike line from the dome centre toward the edge point (degrees, (cos θ, sin θ)). */
export function serpentDirection(angleDeg: number): { x: number; z: number } {
  const a = (angleDeg * Math.PI) / 180;
  return { x: Math.cos(a), z: Math.sin(a) };
}

/**
 * Screen angle (radians, clockwise from screen-up, 0 = straight ahead of the camera, in (−π, π]) toward the dome edge point where
 * the strike line starts, seen from the player at (`px`, `pz`). Same convention as the threat arrows (`CombatOverlay`): the world
 * direction's yaw is `atan2(dx, dz)` and camera yaw decreases when turning right, so the screen angle is the negated relative yaw.
 * A player standing on the edge point itself (no usable direction) is pointed along the strike direction instead.
 */
export function serpentMarkerAngle(angleDeg: number, camYaw: number, px: number, pz: number, wallRadius: number): number {
  const d = serpentDirection(angleDeg);
  let dx = d.x * wallRadius - px;
  let dz = d.z * wallRadius - pz;
  if (dx * dx + dz * dz < 1) {
    dx = d.x;
    dz = d.z;
  }
  const a = -wrapAngle(Math.atan2(dx, dz) - camYaw);
  return a === 0 ? 0 : a; // no negative zero
}

/** Distance (m) from (`px`, `pz`) to the head's path: the segment from the dome centre to the edge point at `angleDeg`. */
export function serpentStripDistance(angleDeg: number, px: number, pz: number, wallRadius: number): number {
  const d = serpentDirection(angleDeg);
  let s = px * d.x + pz * d.z; // distance along the strike direction
  s = s < 0 ? 0 : s > wallRadius ? wallRadius : s;
  const ex = px - d.x * s;
  const ez = pz - d.z * s;
  return Math.sqrt(ex * ex + ez * ez);
}

export interface SerpentThreat {
  /** Player centre → head path distance (m). */
  dist: number;
  /** `stripHalfWidth + bodyRadius + margin`: inside this the player must move. */
  reach: number;
  /** Altitude above the local ground (m). */
  altitude: number;
  /** Higher than the strike reaches: cannot be hit however close to the line. */
  immune: boolean;
  /** Within the (margin-padded) strip AND not immune. */
  inStrip: boolean;
}

/**
 * The local player's exposure to a strike along `angleDeg` on `arena` (the lane's band is NOT considered here, see
 * {@link serpentBandsAt}). `radius` = the fighter's body radius (the sim's hit rule is `headRadius + radius` from the head
 * path); `y` = its feet height (the sim's `pos.y`).
 */
export function serpentThreat(
  arena: ArenaDef,
  angleDeg: number,
  pos: { x: number; y: number; z: number },
  radius: number,
): SerpentThreat {
  const dist = serpentStripDistance(angleDeg, pos.x, pos.z, arena.wallRadius);
  const reach = SERPENT.stripHalfWidth + radius + SERPENT_WARN_MARGIN;
  const altitude = pos.y - arenaGroundHeight(arena, pos.x, pos.z);
  const immune = altitude > SERPENT.hazardHeight;
  return { dist, reach, altitude, immune, inStrip: !immune && dist <= reach };
}

/**
 * Which serpents can hurt a fighter standing at (`x`, `z`): the band of the GROUND height there (`high` iff ground >=
 * `hazards.serpentSplitY`, the sim's `arenaSerpentBand`), with a {@link SERPENT_BAND_MARGIN} metre overlap around the split so both
 * lanes count right at the contour. An arena without a split (the single v1.9 serpent) is `low` everywhere.
 */
export function serpentBandsAt(arena: ArenaDef, x: number, z: number): Record<SerpentTier, boolean> {
  const split = arena.hazards?.serpentSplitY;
  if (split === undefined) return { low: true, high: false };
  const g = arenaGroundHeight(arena, x, z);
  return { low: g < split + SERPENT_BAND_MARGIN, high: g >= split - SERPENT_BAND_MARGIN };
}

export type SerpentBanner = 'off' | 'hold' | 'fade';
export type SerpentStatus = 'off' | 'move' | 'safe' | 'strike' | 'after';

/** Everything the DOM layer needs for ONE lane for one frame. */
export interface SerpentLaneView {
  tier: SerpentTier;
  banner: SerpentBanner;
  /** The lane's snapshot block exists (an event of this lane runs). */
  active: boolean;
  /** The rim marker (+ line) is visible: the lane runs and the local player is alive. */
  marker: boolean;
  /** Screen angle of the marker, radians clockwise from up (meaningful when `marker`). */
  markerAngle: number;
  status: SerpentStatus;
  phase: SerpentPhase | null;
  /** 0..1: how deep into the danger the player is (1 = inside the strip); drives the rim line length. 0 off-band. */
  lineFrac: number;
  /** This lane can hurt the band the local player stands in (true when unknown, e.g. for a spectator). */
  onBand: boolean;
  /** Show the MOVE! / SAFE chip under this lane's banner (only during the warning, only for lanes relevant to the player). */
  chip: boolean;
}

/** Both lanes for one frame. `labelChips` = more than one chip is visible, so each says which lane it speaks of. */
export interface SerpentHudView {
  low: SerpentLaneView;
  high: SerpentLaneView;
  labelChips: boolean;
}

/** What the model needs to know about the local fighter this frame. */
export interface SerpentPlayerCtx {
  /** Camera yaw (radians). */
  camYaw: number;
  /** The local fighter (id 0) — null when dead / spectating / absent (then only the banners are shown). */
  player: { x: number; y: number; z: number; radius: number } | null;
}

/** The two snapshot blocks the model reads. */
export type SerpentBlocks = Pick<WorldSnapshot, 'serpent' | 'serpentHigh'>;

function offLane(tier: SerpentTier): SerpentLaneView {
  return {
    tier,
    banner: 'off',
    active: false,
    marker: false,
    markerAngle: 0,
    status: 'off',
    phase: null,
    lineFrac: 0,
    onBand: true,
    chip: false,
  };
}

const OFF_VIEW: SerpentHudView = Object.freeze({
  low: Object.freeze(offLane('low')),
  high: Object.freeze(offLane('high')),
  labelChips: false,
}) as SerpentHudView;

/** Stateful part: each lane's banner lifecycle (driven by the `serpentWarning` / `serpentEnd` events) + the per-frame view. */
export class SerpentHudModel {
  private readonly bannerStartMs: Record<SerpentTier, number> = { low: -1, high: -1 };
  private readonly hasHigh: boolean;

  /** `enabled` = the arena has the serpent hazard. Off arenas never show anything, whatever events or snapshots arrive. */
  constructor(
    private readonly arena: ArenaDef,
    readonly enabled: boolean = arena.hazards?.serpent === true,
  ) {
    this.hasHigh = arenaHasHighSerpent(arena);
  }

  /** A `serpentWarning` event arrived at wall-clock `nowMs` (`tier` absent on the event = low): (re)start that lane's banner. */
  onWarning(nowMs: number, tier: SerpentTier = 'low'): void {
    if (this.enabled && (tier === 'low' || this.hasHigh)) this.bannerStartMs[tier] = nowMs;
  }

  /**
   * A `serpentEnd` event (pass the event's `tier ?? 'low'`): that lane's banner goes away at once. Without a tier (the match ended
   * mid-event, or the HUD is unmounted) every lane is cleared.
   */
  onEnd(tier?: SerpentTier): void {
    if (tier === undefined) {
      this.bannerStartMs.low = -1;
      this.bannerStartMs.high = -1;
    } else {
      this.bannerStartMs[tier] = -1;
    }
  }

  bannerAt(nowMs: number, tier: SerpentTier = 'low'): SerpentBanner {
    const start = this.bannerStartMs[tier];
    if (!this.enabled || start < 0) return 'off';
    const age = nowMs - start;
    if (age < 0) return 'off';
    if (age < BANNER_HOLD_MS) return 'hold';
    if (age < BANNER_HOLD_MS + BANNER_FADE_MS) return 'fade';
    return 'off';
  }

  /** One lane's view, before the chip decision (`chip` is false here). */
  private lane(tier: SerpentTier, nowMs: number, state: SerpentState | undefined, ctx: SerpentPlayerCtx): SerpentLaneView {
    const banner = this.bannerAt(nowMs, tier);
    if (state === undefined || (tier === 'high' && !this.hasHigh)) {
      return { ...offLane(tier), banner };
    }
    const p = ctx.player;
    if (p === null) {
      return { ...offLane(tier), banner, active: true, phase: state.phase };
    }
    const th = serpentThreat(this.arena, state.angleDeg, p, p.radius);
    const onBand = serpentBandsAt(this.arena, p.x, p.z)[tier];
    let status: SerpentStatus;
    if (state.phase === 'warn') status = onBand && th.inStrip ? 'move' : 'safe';
    else if (state.phase === 'strike') status = onBand ? 'strike' : 'after';
    else status = 'after';
    const lineFrac = !onBand || th.immune ? 0 : th.inStrip ? 1 : Math.max(0, 1 - (th.dist - th.reach) / SAFE_FADE_M);
    return {
      tier,
      banner,
      active: true,
      marker: true,
      markerAngle: serpentMarkerAngle(state.angleDeg, ctx.camYaw, p.x, p.z, this.arena.wallRadius),
      status,
      phase: state.phase,
      lineFrac,
      onBand,
      chip: false,
    };
  }

  /** The view for this frame. `blocks` = the snapshot's `serpent` (low) / `serpentHigh` blocks (absent while no event of that lane runs). */
  frame(nowMs: number, blocks: SerpentBlocks, ctx: SerpentPlayerCtx): SerpentHudView {
    if (!this.enabled) return OFF_VIEW;
    const low = this.lane('low', nowMs, blocks.serpent, ctx);
    const high = this.lane('high', nowMs, blocks.serpentHigh, ctx);
    if (!low.active && !high.active && low.banner === 'off' && high.banner === 'off') return OFF_VIEW;
    // Chips: during the warning only; the lanes that can hurt the player's band, or (when none does — a lone lane of the other band)
    // every running lane, which then reads SAFE.
    const warn = (l: SerpentLaneView): boolean => l.marker && l.phase === 'warn';
    const anyRelevant = (warn(low) && low.onBand) || (warn(high) && high.onBand);
    low.chip = warn(low) && (low.onBand || !anyRelevant);
    high.chip = warn(high) && (high.onBand || !anyRelevant);
    return { low, high, labelChips: low.chip && high.chip };
  }
}

/** Kill-feed copy for a death: serpent / fall kills read like a sentence, `null` for anything else (trap / fighter). */
export function killCauseText(cause: 'trap' | 'serpent' | 'fall' | undefined): string | null {
  if (cause === 'serpent') return 'was eaten by the Sea Serpent';
  if (cause === 'fall') return 'fell from the heights';
  return null;
}

/** The chip text of a lane view (`''` = no chip): "MOVE!" / "SAFE", prefixed with the lane when two chips are shown. */
export function serpentChipText(v: SerpentLaneView, labelled: boolean): string {
  if (!v.chip) return '';
  const base = v.status === 'move' ? 'MOVE!' : v.status === 'safe' ? 'SAFE' : '';
  if (base === '') return '';
  return labelled ? `${SERPENT_TIER_LABEL[v.tier]} · ${base}` : base;
}
