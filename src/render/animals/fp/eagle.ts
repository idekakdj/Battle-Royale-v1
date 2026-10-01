/**
 * Eagle first-person profile (v1.3 WP-Q, clear-view pass).
 * Joints: body (white neck ruff only), torso, head, wingLIn/wingLOut, wingRIn/wingROut, primL.0-4 / primR.0-4,
 * tailFan / tailL / tailR, legs.0-1 (talons; legs.0 = screen-right). Head, beak, ruff, torso and tail are ALL hidden (no kept
 * beak: a cut through the head leaves fragments, and the head / wings used to fill the view). Only the WING TIPS (pinned to the
 * far left / right edges in flight, their flap visible there) and the talons (lower corners) remain; a screen-space clear zone
 * (`clip`) guarantees nothing of the own rig is ever drawn in the centre of the screen.
 */

import type { FpProfile } from './types';
import { mirrorTip, mixTip, pin, attackCurve, edgeTip, type Tip } from './common';

const TALON_REST: Tip = edgeTip(0.7, -1.0, 0.9, 0.9, 0.05);
const TALON_WIND: Tip = edgeTip(0.95, -0.7, 0.9, 0.3, 0.4);
const TALON_HIT: Tip = edgeTip(0.1, -1.0, 1.1, 0.2, -0.4);

export const EAGLE_FP: FpProfile = {
  animal: 'eagle',
  eye: { forward: 0.2, up: 1.25, side: 0 },
  hide: ['head', 'body', 'torso', 'tailFan', 'tailL', 'tailR'],
  clip: { w: 0.5, h: 0.6 },
  nearPlane: 0.03,
  follow: 0.7,
  bob: 0.012,
  viewPitch: 1,
  pose(c) {
    const a = c.action;
    // Talon rakes: the striking foot comes up from below across the bottom of the view.
    if (a === 'attack1' || a === 'attack2') {
      const s = attackCurve(c.u);
      const rightStrikes = a === 'attack2';
      const wind = rightStrikes ? TALON_WIND : mirrorTip(TALON_WIND);
      const hit = rightStrikes ? TALON_HIT : mirrorTip(TALON_HIT);
      const rest = rightStrikes ? TALON_REST : mirrorTip(TALON_REST);
      const tip = s < 0 ? mixTip(rest, wind, -s / 0.45) : mixTip(rest, hit, s);
      pin(c, rightStrikes ? 'legs.0' : 'legs.1', 0.36, tip);
    }
    // Death From Above, impact + recovery (the proud landing flare): the chest-out pose swings the torso up in front of
    // the eye — in first person the body / torso pitch is mostly removed (the camera never pitches with it).
    if (a === 'ultimate' && (c.state.ultStage ?? 0) >= 2) {
      c.J('body').rx *= 0.2;
      c.J('torso').rx *= 0.2;
      c.J('head').rx *= 0.2;
      // The talons thrust forward in the flare: keep them small, at the lower corners.
      if (c.state.vel.y >= -6) {
        c.J('legs.0').s = 0.7;
        c.J('legs.1').s = 0.7;
        pin(c, 'legs.0', 0.25, edgeTip(0.72, -1.0, 0.9, 0.6, 0.2));
        pin(c, 'legs.1', 0.25, edgeTip(-0.72, -1.0, 0.9, 0.6, -0.2));
      }
    }
    // Death From Above, stoop: both talons thrust forward-down along the dive line (the folded body is the shared pose).
    if (a === 'ultimate' && c.state.vel.y < -6) {
      pin(c, 'legs.0', 0.36, edgeTip(0.2, -1.0, 0.9, 0.5, 0.05));
      pin(c, 'legs.1', 0.36, edgeTip(-0.2, -1.0, 0.9, 0.5, -0.05));
    }
    // Wing tips framing the view: in flight both wings are pinned to the far lower corners / edges (a viewmodel, so bank /
    // dive / roll never move them); climb flaps them, glide barely breathes, the fast stoop lets the shared folded pose take
    // over. On the ground the shared poses are left alone (the wings stay beside / behind the eye).
    const air = a === 'glide' || a === 'jump' || a === 'ultimate';
    if (air) {
      const vy = c.state.vel.y;
      const dive = vy < -6; // the stoop: the shared pose folds the wings, here they only keep a sliver at the very edges
      const climb = vy > 0.4;
      const flap = climb ? Math.sin(c.t * 10.5) * 0.1 : Math.sin(c.t * 1.3) * 0.03 + Math.sin(c.t * 3.3) * (c.state.pos.y > 3.4 ? 0.05 : 0);
      // The landing flare (recovery) cups the wings up: keep only small outer strips. The stoop shows no wing at all.
      const flare = a === 'ultimate' && (c.state.ultStage ?? 0) >= 2;
      const sc = dive ? 0.001 : flare ? 0.5 : 0.9;
      c.J('wingLIn').s = sc;
      c.J('wingRIn').s = sc;
      const x = dive ? 0.5 : flare ? 0.55 : 0.34;
      const y = dive ? -0.3 : flare ? -0.3 : -0.1;
      const out = dive ? 0.35 : flare ? 0.45 : 0.5;
      c.limb('wingLIn', { x, y: y - flap * 0.4, z: 0.2, down: 0.2 + flap, out, axis: '-x' });
      c.limb('wingRIn', { x: -x, y: y - flap * 0.4, z: 0.2, down: 0.2 + flap, out: -out, axis: '+x' });
    }
  },
};
