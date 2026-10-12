/**
 * Sea-serpent warning HUD — pure model (v1.9 Ocean Dome, WP-O4). No DOM / three: the controller feeds the snapshot's
 * `serpent` block, the camera yaw and the local fighter; `SerpentHud.ts` paints the returned view.
 *
 * What the player sees (arenas with `hazards.serpent` only; the model is inert elsewhere):
 *  - BANNER "SEA SERPENT!" on the `serpentWarning` event: ~1 s hold (pulsing), then a fade. Also shown to spectators.
 *  - RIM MARKER (alive local player only): a chevron on the screen edge pointing toward where the strike line starts — the dome
 *    edge point at `angleDeg` — measured from the PLAYER's position and the camera yaw (so it keeps pointing at the edge point as
 *    the camera turns, in first and third person alike), plus a thin line running from the chevron toward the screen centre
 *    whose length grows as the player is closer to the strip (`lineFrac`).
 *  - STATUS during the warning: `move` ("MOVE!") when the local player is inside the strip, `safe` ("SAFE") when clear. During the
 *    strike / hold / retreat only the small timer-less marker stays (`strike`, `after`).
 *
 * "Inside the strip" mirrors the sim's hit rule (SerpentSystem): the player's centre is within `stripHalfWidth + bodyRadius` of the
 * head's path — the segment from the dome edge to the centre — plus a {@link SERPENT_WARN_MARGIN} safety margin so MOVE! shows a
 * hair before it is strictly necessary, AND the player is at most `hazardHeight` above the LOCAL ground (a soaring eagle or anyone
 * standing > 3 m up is immune and shown as safe).
 */

import { arenaGroundHeight, type ArenaDef } from '../config/arenas';
import { SERPENT } from '../config/serpent';
import { wrapAngle } from '../core/math';
import type { SerpentPhase, SerpentState } from '../core/types';

/** Extra metres around the real hit capsule within which the HUD already says MOVE!. */
export const SERPENT_WARN_MARGIN = 0.3;
/** The banner stays fully visible this long after the warning begins (ms), then fades over {@link BANNER_FADE_MS}. */
export const BANNER_HOLD_MS = 1000;
export const BANNER_FADE_MS = 500;
/** Beyond `reach + this` metres from the strip the rim line is at its minimum length (the "distance" ramp). */
export const SAFE_FADE_M = 8;

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
 * The local player's exposure to a strike along `angleDeg` on `arena`. `radius` = the fighter's body radius (the sim's hit rule is
 * `headRadius + radius` from the head path); `y` = its feet height (the sim's `pos.y`).
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

export type SerpentBanner = 'off' | 'hold' | 'fade';
export type SerpentStatus = 'off' | 'move' | 'safe' | 'strike' | 'after';

/** Everything the DOM layer needs for one frame. */
export interface SerpentHudView {
  banner: SerpentBanner;
  /** The rim marker (+ line) is visible: an event runs and the local player is alive. */
  marker: boolean;
  /** Screen angle of the marker, radians clockwise from up (meaningful when `marker`). */
  markerAngle: number;
  status: SerpentStatus;
  phase: SerpentPhase | null;
  /** 0..1: how deep into the danger the player is (1 = inside the strip); drives the rim line length. */
  lineFrac: number;
}

/** What the model needs to know about the local fighter this frame. */
export interface SerpentPlayerCtx {
  /** Camera yaw (radians). */
  camYaw: number;
  /** The local fighter (id 0) — null when dead / spectating / absent (then only the banner is shown). */
  player: { x: number; y: number; z: number; radius: number } | null;
}

const OFF_VIEW: SerpentHudView = Object.freeze({
  banner: 'off',
  marker: false,
  markerAngle: 0,
  status: 'off',
  phase: null,
  lineFrac: 0,
}) as SerpentHudView;

/** Stateful part: the banner's lifecycle (driven by the `serpentWarning` / `serpentEnd` events) + the per-frame view. */
export class SerpentHudModel {
  private bannerStartMs = -1;

  /** `enabled` = the arena has the serpent hazard. Off arenas never show anything, whatever events or snapshots arrive. */
  constructor(
    private readonly arena: ArenaDef,
    readonly enabled: boolean = arena.hazards?.serpent === true,
  ) {}

  /** The `serpentWarning` event arrived at wall-clock `nowMs`: (re)start the banner. */
  onWarning(nowMs: number): void {
    if (this.enabled) this.bannerStartMs = nowMs;
  }

  /** The `serpentEnd` event (also the abort when the match ends mid-event): everything goes away at once. */
  onEnd(): void {
    this.bannerStartMs = -1;
  }

  bannerAt(nowMs: number): SerpentBanner {
    if (!this.enabled || this.bannerStartMs < 0) return 'off';
    const age = nowMs - this.bannerStartMs;
    if (age < 0) return 'off';
    if (age < BANNER_HOLD_MS) return 'hold';
    if (age < BANNER_HOLD_MS + BANNER_FADE_MS) return 'fade';
    return 'off';
  }

  /** The view for this frame. `serpent` = `snapshot.serpent` (absent while no event runs). */
  frame(nowMs: number, serpent: SerpentState | undefined, ctx: SerpentPlayerCtx): SerpentHudView {
    if (!this.enabled) return OFF_VIEW;
    const banner = this.bannerAt(nowMs);
    if (serpent === undefined || ctx.player === null) {
      if (banner === 'off') return OFF_VIEW;
      return { banner, marker: false, markerAngle: 0, status: 'off', phase: serpent?.phase ?? null, lineFrac: 0 };
    }
    const th = serpentThreat(this.arena, serpent.angleDeg, ctx.player, ctx.player.radius);
    let status: SerpentStatus;
    if (serpent.phase === 'warn') status = th.inStrip ? 'move' : 'safe';
    else if (serpent.phase === 'strike') status = 'strike';
    else status = 'after';
    const lineFrac = th.immune ? 0 : th.inStrip ? 1 : Math.max(0, 1 - (th.dist - th.reach) / SAFE_FADE_M);
    return {
      banner,
      marker: true,
      markerAngle: serpentMarkerAngle(serpent.angleDeg, ctx.camYaw, ctx.player.x, ctx.player.z, this.arena.wallRadius),
      status,
      phase: serpent.phase,
      lineFrac,
    };
  }
}

/** Kill-feed copy for a death: `"was eaten by the Sea Serpent"` for a serpent kill, `null` for anything else (trap / fighter). */
export function killCauseText(cause: 'trap' | 'serpent' | undefined): string | null {
  return cause === 'serpent' ? 'was eaten by the Sea Serpent' : null;
}
