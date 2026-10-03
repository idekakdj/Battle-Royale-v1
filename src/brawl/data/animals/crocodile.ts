/** Crocodile — low trapper. Long and low, bites hard from the floor; huge risky lunge, pulling roll, poor recovery. */

import type { MovesetDef } from '../../types';
import { A, air, body, cs, hb, linkTo, moveset, mot, mv } from '../helpers';

const stats = cs({
  weight: 132,
  walkSpeed: 4.1,
  runSpeed: 8.0,
  airSpeed: 5.5,
  airAccel: 24.2,
  jumpVel: 12.5,
  airJumpVel: 11.5,
  maxJumps: 2,
  gravityMult: 1.15,
  fallSpeed: 21,
  fastFallSpeed: 28,
  width: 1.7,
  height: 0.9,
});

// lightN — Snap-Snap (2 bites)
const n1 = body(
  'Snap',
  'bite',
  A('Quick head thrust, jaws snapping shut', { limb: 'jaw', side: 'front', reach: 2.1, height: 0.55 }),
  [7, 3, 11],
  [hb.circle(1.6, 0.55, 0.5, 5, 6, 5, 62, { stun: 3.3 })],
  { cancels: linkTo(10, 21, false), turn: true },
);
const n2 = body(
  'Snap Again',
  'bite',
  A('Second snap, head dipping slightly lower and further', { limb: 'jaw', side: 'front', reach: 2.2, height: 0.5 }),
  [6, 3, 13],
  [hb.circle(1.7, 0.55, 0.5, 5, 8, 10, 45)],
);

const lightS = body(
  'Tail Flick',
  'tailWhip',
  A('Tail flicks out behind the body, then whips round to the front', { limb: 'tail', side: 'both', reach: 2.5, height: 0.5, arc: 200 }),
  [9, 4, 17],
  [
    hb.rect(-1.7, 0.5, 1.6, 0.6, 9, 6, 9, 145, { win: [0, 2], group: 1, stun: 2 }),
    hb.rect(1.7, 0.5, 1.6, 0.6, 9, 6, 9, 35, { win: [2, 4], group: 1, stun: 2 }),
  ],
);
const lightD = body(
  'Low Snap',
  'bite',
  A('Head sweeps low along the ground and snaps up at the ankles', { limb: 'jaw', side: 'front', reach: 2.2, height: 0.25 }),
  [7, 3, 14],
  [hb.rect(1.6, 0.25, 1.2, 0.5, 7, 5, 7, 70, { stun: 2.5 })],
);
const lightU = body(
  'Head Toss',
  'uppercut',
  A('Snout dips, then the jaw flips up and tosses the target', { limb: 'jaw', side: 'front', reach: 1.9, height: 1.5, arc: 80 }),
  [8, 4, 15],
  [hb.circle(1.4, 0.75, 0.55, 7, 6, 9, 88, { stun: 2, path: [[0, 0, -0.1], [4, -0.3, 0.9]] })],
);

const heavyN = body(
  'Death Roll',
  'spinAttack',
  A('Whole body barrel-rolls on the spot; the jaws and tail drag victims in, then fling them', { limb: 'body', side: 'both', reach: 1.7, height: 0.6, spin: 2 }),
  [16, 6, 26],
  [
    hb.rect(0, 0.5, 3.4, 0.9, 3, 6, 0, 0, { win: [0, 5], multi: 2, fx: 'pull', group: 1 }),
    hb.rect(0.3, 0.5, 3.4, 0.9, 7, 12, 24, 60, { win: [5, 6], group: 2 }),
  ],
);
const heavyS = body(
  'Lunge Bite',
  'lunge',
  A('Coils, then lunges the entire body forward with the jaws wide open', { limb: 'jaw', side: 'front', reach: 2.4, height: 0.55, travel: 1.5 }),
  [19, 4, 33],
  [hb.rect(1.6, 0.55, 1.6, 0.8, 19, 12, 26, 35, { hitlag: 3, sweet: [2.3, 0.6, 0.55, 1.15, 1.1] })],
  { motion: [mot(17, 27, { vx: 9 })] },
);
const heavyD = body(
  'Tail Slam',
  'tailWhip',
  A('Tail arcs over the back and slams down in front of the head', { limb: 'tail', side: 'front', reach: 2.4, height: 0.45, arc: 150 }),
  [13, 4, 27],
  [hb.circle(1.7, 0.45, 0.7, 12, 10, 20, 70, { path: [[0, -0.5, 0.6], [4, 0.4, -0.2]] })],
);
const heavyU = body(
  'Rising Snap',
  'leapUp',
  A('Short upward lunge, jaws snapping at the top', { limb: 'jaw', side: 'front', reach: 2.2, height: 2.4, rise: 3.2 }),
  [10, 10, 28],
  [hb.circle(1.3, 0.8, 0.6, 8, 9.5, 17, 80, { path: [[0, 0, 0], [8, 0.3, 1.0]] })],
  { motion: [mot(8, 18, { vx: 3.8, vy: 13.8 })] },
);

export const crocodile: MovesetDef = moveset('crocodile', 'Low trapper: long reach along the floor, a crushing lunge, and a death roll that drags victims in.', stats, [
  mv('lightN', n1, air(n1, { lag: 8 }), [n2]),
  mv('lightS', lightS, air(lightS, { lag: 9 })),
  mv('lightD', lightD, air(lightD, { lag: 8 })),
  mv('lightU', lightU, air(lightU, { lag: 9 })),
  mv('heavyN', heavyN, air(heavyN, { lag: 20 })),
  mv('heavyS', heavyS, air(heavyS, { lag: 24 })),
  mv(
    'heavyD',
    heavyD,
    air(heavyD, {
      lag: 22,
      name: 'Tail Slam (spike)',
      hits: [hb.circle(1.5, -0.2, 0.7, 14, 10, 20, 270, { fx: 'spike' })],
      anim: A('Flips the tail over the body and slams it down in front, below the croc', { limb: 'tail', side: 'front', reach: 1.5, height: -0.3 }),
    }),
  ),
  mv('heavyU', heavyU, air(heavyU, { lag: 16 })),
]);
