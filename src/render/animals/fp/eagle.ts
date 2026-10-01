/**
 * Eagle first-person profile (v1.3 WP-Q).
 * Joints: body (white neck ruff only), torso, head, wingLIn/wingLOut, wingRIn/wingROut, primL.0-4 / primR.0-4,
 * tailFan / tailL / tailR, legs.0-1 (talons; legs.0 = screen-right). Head and ruff are hidden but the BEAK
 * (head triangles ahead of z = 0.34) stays at the bottom centre. Talons are pinned into view for the rakes;
 * wings are swept forward in flight and guard so the leading edges frame the sides of the view.
 */

import type { FpProfile } from './types';
import { mirrorTip, mixTip, pin, attackCurve, type Tip } from './common';

const TALON_REST: Tip = { x: 0.2, y: -0.7, z: 0.4, down: 0.9, out: 0.05 };
const TALON_WIND: Tip = { x: 0.45, y: -0.45, z: 0.5, down: 0.2, out: 0.4 };
const TALON_HIT: Tip = { x: -0.15, y: -0.35, z: 0.9, down: -0.15, out: -0.5 };

export const EAGLE_FP: FpProfile = {
  animal: 'eagle',
  eye: { forward: 0.2, up: 1.25, side: 0 },
  hide: ['head', 'body'],
  keepFront: { head: 0.34 },
  nearPlane: 0.03,
  follow: 0.7,
  bob: 0.012,
  viewPitch: 0.5,
  pose(c) {
    const a = c.action;
    // Talon rakes: the striking foot comes up from below across the view.
    if (a === 'attack1' || a === 'attack2') {
      const s = attackCurve(c.u);
      const rightStrikes = a === 'attack2';
      const wind = rightStrikes ? TALON_WIND : mirrorTip(TALON_WIND);
      const hit = rightStrikes ? TALON_HIT : mirrorTip(TALON_HIT);
      const rest = rightStrikes ? TALON_REST : mirrorTip(TALON_REST);
      const tip = s < 0 ? mixTip(rest, wind, -s / 0.45) : mixTip(rest, hit, s);
      pin(c, rightStrikes ? 'legs.0' : 'legs.1', 0.36, tip);
    }
    // Death From Above, impact + recovery (the proud landing flare): the chest-out pose swings the dark torso up in front of
    // the eye and fills the view — in first person the body / torso pitch is mostly removed (the camera never pitches with it).
    if (a === 'ultimate' && (c.state.ultStage ?? 0) >= 2) {
      c.J('body').rx *= 0.2;
      c.J('torso').rx *= 0.2;
      c.J('head').rx *= 0.2;
    }
    // Death From Above, stoop: both talons thrust forward-down along the dive line (the folded body is the shared pose).
    if (a === 'ultimate' && c.state.vel.y < -6) {
      pin(c, 'legs.0', 0.36, { x: 0.16, y: -0.5, z: 0.85, down: 0.5, out: 0.05 });
      pin(c, 'legs.1', 0.36, { x: -0.16, y: -0.5, z: 0.85, down: 0.5, out: -0.05 });
    }
    // Wings framing the view: in flight both wings are pinned to the lower corners of the view, leading edge
    // forward (a viewmodel, so bank / dive / roll never move them); climb flaps them, glide barely breathes,
    // the fast stoop lets the shared folded pose take over. On the ground the shared poses are left alone.
    const air = a === 'glide' || a === 'jump' || a === 'ultimate';
    if (air && c.state.vel.y > -6) {
      const vy = c.state.vel.y;
      const climb = vy > 0.4;
      const flap = climb ? Math.sin(c.t * 10.5) * 0.3 : Math.sin(c.t * 1.3) * 0.05 + Math.sin(c.t * 3.3) * (c.state.pos.y > 3.4 ? 0.12 : 0);
      c.limb('wingLIn', { x: 0.36, y: -0.4 - flap * 0.5, z: 0.25, down: 0.15 + flap, out: 0.45, axis: '-x' });
      c.limb('wingRIn', { x: -0.36, y: -0.4 - flap * 0.5, z: 0.25, down: 0.15 + flap, out: -0.45, axis: '+x' });
    }
  },
};
