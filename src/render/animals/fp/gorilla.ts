/**
 * Gorilla first-person profile (v1.3 WP-Q).
 * Joints: body, head, armL / armR (armL = the animal's right = screen-right), foreL / foreR (elbows),
 * legL / legR, legs.0-3 (= armL, armR, legL, legR). Head hidden; the arms are pinned as a viewmodel:
 * knuckle stride on run, wide hooks (attack1/2), overhead double-fist slam (attack3 / leap), crossed guard.
 */

import type { FpProfile } from './types';
import { type Tip, edgeTip, mirrorTip, mixTip, pawPose, pin, ramp, smooth01 } from './common';

/**
 * Boulder Hurl viewmodel (ultimate only; the normal look is approved and unchanged). The body pose from `poseUltimate` swings
 * the big arms right in front of the lens (chest beats, squat, hoist), so during the ultimate both arms are pinned as small
 * fists at the screen edges, keyed off the same keyframes (`actionT` of the windup: beats 0.13 / 0.31, rip 0.44–0.66, heave
 * 0.66–0.86, cock-back to 0.93, throw 0.93–1.0): high and wide on the beats, low at the ground for the rip, up the sides for the
 * hoist, whipped forward-down at the throw. The held slab itself is not drawn in first person (`hideProps`).
 */
const U_REST: Tip = edgeTip(0.9, -0.92, 0.95, 0.2, 0.1);
const U_HIGH: Tip = edgeTip(1.0, 0.3, 0.9, -0.5, 0.25);
const U_CHEST: Tip = edgeTip(0.86, -0.6, 0.9, 0.0, 0.15);
const U_GROUND: Tip = edgeTip(0.72, -0.98, 1.1, 0.4, 0.05);
const U_OVER: Tip = edgeTip(0.95, 0.5, 0.85, -0.9, 0.2);
const U_THROW: Tip = edgeTip(0.75, -0.95, 1.2, 0.3, -0.05);

function ultFistTip(t: number, windup: boolean): Tip {
  if (!windup) return U_REST;
  let tip = mixTip(U_REST, U_HIGH, smooth01(ramp(t, 0, 0.12)));
  for (const b of [0.13, 0.31]) {
    const k = Math.max(0, 1 - Math.abs(t - b) / 0.045);
    tip = mixTip(tip, U_CHEST, k);
  }
  tip = mixTip(tip, U_GROUND, smooth01(ramp(t, 0.36, 0.46)));
  tip = mixTip(tip, U_OVER, smooth01(ramp(t, 0.66, 0.86)));
  tip = mixTip(tip, U_THROW, smooth01(ramp(t, 0.93, 1.0)));
  return tip;
}

export const GORILLA_FP: FpProfile = {
  animal: 'gorilla',
  eye: { forward: 0.5, up: 1.48, side: 0 },
  hide: ['head'],
  hideProps: ['boulder-slab'], // the held slab fills the view while it is torn out / hoisted
  ultClip: { w: 0.5, h: 0.6 },
  ultViewLock: true,
  nearPlane: 0.06,
  follow: 0.55,
  bob: 0.03,
  pose(c) {
    pawPose(c, {
      len: 1.2,
      right: 'armL',
      left: 'armR',
      first: 'left',
      rest: { x: 0.52, y: -0.72, z: 0.8, down: 0.1, out: 0.08 },
      runReach: 0.3,
      runLift: 0.22,
      swipeWind: { x: 0.95, y: -0.15, z: 0.55, down: -0.4, out: 0.6, roll: 0.3 },
      swipeHit: { x: -0.35, y: -0.3, z: 1.3, down: -0.2, out: -0.6 },
      lunge: { x: 0.3, y: -0.8, z: 1.35, down: 0.5, out: -0.05 },
      wind3: { x: 0.6, y: 0.3, z: 0.6, down: -1.0, out: 0.1 },
      guard: { x: -0.05, y: -0.1, z: 1.0, down: -0.15, out: 0.35 },
    });
    if (c.action === 'ultimate') {
      const r = ultFistTip(c.state.actionT, c.state.ultPhase === 'windup');
      c.J('armL').s = 0.55;
      c.J('armR').s = 0.55;
      pin(c, 'armL', 1.2 * 0.55, r);
      pin(c, 'armR', 1.2 * 0.55, mirrorTip(r));
    }
    // Elbows stay slightly bent.
    c.J('foreL').rx = -0.1;
    c.J('foreR').rx = -0.1;
  },
};
