/** Giraffe — tall zoner. The neck reaches high and far (up to 3.5 m) with tip sweetspots; weak against low targets. Good recovery. */

import type { MovesetDef } from '../../types';
import { A, air, body, cs, hb, linkTo, moveset, mot, mv } from '../helpers';

const stats = cs({
  weight: 100,
  walkSpeed: 3.95,
  runSpeed: 7.2,
  airSpeed: 6.6,
  airAccel: 29.7,
  jumpVel: 14.0,
  airJumpVel: 12.5,
  maxJumps: 2,
  gravityMult: 1.0,
  fallSpeed: 18.5,
  fastFallSpeed: 26,
  width: 1.0,
  height: 2.3,
});

// lightN — Neck Jab (2 hits, long poke)
const n1 = body(
  'Neck Jab',
  'tether',
  A('Neck stretches forward in a quick head poke at head height', { limb: 'neck', side: 'front', reach: 2.4, height: 1.5 }),
  [6, 3, 12],
  [hb.rect(1.6, 1.4, 1.4, 0.7, 5, 6, 5, 62, { stun: 3.3, path: [[0, 0, 0.15], [3, 0, -0.3]] })],
  { cancels: linkTo(9, 21, false), turn: true },
);
const n2 = body(
  'Neck Jab 2',
  'tether',
  A('A second poke with the neck fully stretched and the head dipping', { limb: 'neck', side: 'front', reach: 2.5, height: 1.3 }),
  [6, 3, 13],
  [hb.rect(1.7, 1.3, 1.4, 0.7, 5, 8, 10, 45)],
);

const lightS = body(
  'Long Kick',
  'kick',
  A('Front leg lashes out in a long kick at hip height', { limb: 'forelimb', side: 'R', reach: 2.0, height: 1.0, arc: 70 }),
  [8, 3, 16],
  [hb.rect(1.35, 1.0, 1.3, 0.5, 8, 6, 9, 35)],
);
const lightD = body(
  'Hoof Stomp',
  'stomp',
  A('Lifts a front hoof and stamps it down low in front', { limb: 'forelimb', side: 'R', reach: 1.4, height: 0.2 }),
  [7, 3, 14],
  [hb.rect(0.9, 0.2, 1.0, 0.5, 6, 5, 7, 65)],
);
const lightU = body(
  'Neck Lift',
  'neckSwing',
  A('The neck whips upward in a vertical arc, head rising to 3.4 m', { limb: 'neck', side: 'up', reach: 1.5, height: 3.4, arc: 100 }),
  [8, 4, 16],
  [hb.circle(1.0, 1.9, 0.5, 8, 6, 9, 88, { path: [[0, 0, 0], [4, -0.5, 1.0]] })],
);

const heavyN = body(
  'Neck Spin',
  'neckSwing',
  A('Neck lowers level and spins a full circle around the body; the head tip is the sweetspot', { limb: 'neck', side: 'both', reach: 3.0, height: 1.5, spin: 1 }),
  [14, 6, 30],
  [
    hb.rect(1.6, 1.4, 2.8, 0.9, 11, 10.8, 21, 45, { win: [0, 3], group: 1, sweet: [2.8, 1.2, 0.5, 1.25, 1.15] }),
    hb.rect(-1.6, 1.4, 2.8, 0.9, 11, 10.8, 21, 135, { win: [3, 6], group: 1, sweet: [-2.8, 1.2, 0.5, 1.25, 1.15] }),
  ],
);
const heavyS = body(
  'Skull Hammer',
  'neckSwing',
  A('Neck rears back overhead, then slams the skull down like a hammer on the target in front', { limb: 'neck', side: 'front', reach: 3.4, height: 1.2, arc: 160 }),
  [19, 4, 33],
  [hb.rect(2.1, 1.2, 2.6, 1.3, 16, 11, 26, 38, { hitlag: 3, sweet: [3.2, 1.0, 0.55, 1.15, 1.1] })],
);
const heavyD = body(
  'Axe Kick',
  'kick',
  A('Raises a front leg straight up and chops the hoof down in a heel drop', { limb: 'forelimb', side: 'R', reach: 1.8, height: 0.8, arc: 120 }),
  [14, 4, 26],
  [hb.rect(1.2, 0.8, 1.2, 1.2, 12, 10, 20, 70)],
);
const heavyU = body(
  'Neck Stretch',
  'tether',
  A('The neck shoots straight up to full stretch with the whole body rising, ending in a headbutt', { limb: 'head', side: 'up', reach: 1.3, height: 3.8, rise: 5.4 }),
  [8, 12, 26],
  [hb.circle(0.8, 1.3, 0.6, 9, 9.5, 17, 85, { path: [[0, 0, 0], [10, 0.2, 2.0]] })],
  { motion: [mot(8, 20, { vx: 1.9, vy: 18.8 })] },
);

export const giraffe: MovesetDef = moveset('giraffe', 'Tall zoner: huge neck reach with tip sweetspots and vertical control, but struggles against low targets.', stats, [
  mv('lightN', n1, air(n1, { lag: 7 }), [n2]),
  mv('lightS', lightS, air(lightS, { lag: 8 })),
  mv('lightD', lightD, air(lightD, { lag: 8 })),
  mv('lightU', lightU, air(lightU, { lag: 9 })),
  mv('heavyN', heavyN, air(heavyN, { lag: 20 })),
  mv('heavyS', heavyS, air(heavyS, { lag: 24 })),
  mv(
    'heavyD',
    heavyD,
    air(heavyD, {
      lag: 22,
      name: 'Axe Kick (spike)',
      hits: [hb.rect(0.8, 0.0, 0.9, 1.4, 13, 10, 20, 270, { fx: 'spike' })],
      anim: A('Kicks a front leg straight down below the body in an axe kick', { limb: 'forelimb', side: 'down', reach: 1.2, height: -0.5 }),
    }),
  ),
  mv('heavyU', heavyU, air(heavyU, { lag: 16 })),
]);
