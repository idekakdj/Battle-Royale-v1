/** Python — long-reach controller. Fangs and tail poke from far away, a pulling constrict that stuns, slow strong lunge; mid recovery. */

import type { MovesetDef } from '../../types';
import { A, air, body, cs, hb, linkTo, moveset, mot, mv } from '../helpers';

const stats = cs({
  weight: 97,
  walkSpeed: 4.05,
  runSpeed: 7.3,
  airSpeed: 6.4,
  airAccel: 28.6,
  jumpVel: 13.5,
  airJumpVel: 12.5,
  maxJumps: 2,
  gravityMult: 0.9,
  fallSpeed: 16,
  fastFallSpeed: 24,
  width: 1.5,
  height: 1.0,
});

// lightN — Fang Strike (2 hits, long poke)
const n1 = body(
  'Fang Strike',
  'bite',
  A('Head snaps forward on a stretched neck for a quick fang strike', { limb: 'head', side: 'front', reach: 2.3, height: 0.6 }),
  [6, 3, 12],
  [hb.rect(1.6, 0.6, 1.4, 0.55, 5, 6, 5, 62, { stun: 3.3 })],
  { cancels: linkTo(9, 21, false), turn: true },
);
const n2 = body(
  'Fang Strike 2',
  'bite',
  A('A second, longer strike with the neck fully extended', { limb: 'head', side: 'front', reach: 2.4, height: 0.6 }),
  [6, 3, 13],
  [hb.rect(1.7, 0.6, 1.4, 0.55, 5, 8, 10, 45)],
);

const lightS = body(
  'Tail Lash',
  'tailWhip',
  A('The tail whips out long and flat across the front, reaching about three metres', { limb: 'tail', side: 'front', reach: 3.1, height: 0.5, arc: 80 }),
  [9, 3, 16],
  [hb.rect(1.6, 0.5, 2.2, 0.5, 8, 8, 10, 30, { path: [[0, -0.4, 0.2], [3, 0.4, -0.2]] })],
);
const lightD = body(
  'Ground Sweep',
  'tailWhip',
  A('Tail sweeps low along the floor and trips the target', { limb: 'tail', side: 'front', reach: 2.7, height: 0.15, arc: 70 }),
  [7, 3, 14],
  [hb.rect(1.6, 0.15, 2.2, 0.3, 7, 5, 6, 20)],
);
const lightU = body(
  'Rising Coil',
  'uppercut',
  A('The front of the body arcs up in a coil, head rising overhead', { limb: 'body', side: 'up', reach: 1.5, height: 1.9, arc: 90 }),
  [8, 3, 15],
  [hb.circle(0.7, 1.1, 0.6, 7, 6, 9, 88, { path: [[0, 0, -0.2], [3, 0.2, 0.9]] })],
);

const heavyN = body(
  'Constrict',
  'spinAttack',
  A('Coils into a tight spiral around the spot; the body squeezes in a pulsing wrap, then bursts open', { limb: 'body', side: 'both', reach: 1.5, height: 0.6, spin: 1 }),
  [14, 6, 30],
  [
    hb.rect(0, 0.5, 3.0, 1.0, 2, 5, 0, 0, { win: [0, 5], multi: 2, fx: 'pull', group: 1 }),
    hb.rect(0, 0.5, 2.6, 1.0, 7, 6, 18, 50, { win: [5, 6], fx: 'stun', stun: 2, group: 2 }),
  ],
);
const heavyS = body(
  'Venom Lunge',
  'lunge',
  A('Slowly coils back, then lunges the whole front body forward with fangs bared', { limb: 'head', side: 'front', reach: 2.5, height: 0.6, travel: 1.5 }),
  [19, 4, 34],
  [hb.rect(1.8, 0.6, 1.4, 0.8, 19, 12, 25, 40, { hitlag: 3, sweet: [2.55, 0.6, 0.5, 1.1, 1.1] })],
  { motion: [mot(17, 27, { vx: 9 })] },
);
const heavyD = body(
  'Coil Drop',
  'bellyFlop',
  A('Rears up and drops the heavy coil of the body on the target below', { limb: 'body', side: 'down', reach: 1.6, height: 0.5 }),
  [13, 4, 27],
  [hb.rect(0.8, 0.45, 1.6, 0.9, 12, 10, 20, 75)],
);
const heavyU = body(
  'Spring Coil',
  'leapUp',
  A('Compresses into a tight coil, then springs up and forward like a released spring', { limb: 'body', side: 'both', reach: 1.5, height: 2.0, rise: 3.5 }),
  [10, 14, 26],
  [hb.circle(0.9, 0.9, 0.7, 9, 9.5, 17, 70, { path: [[0, 0, 0], [12, 0.4, 0.9]] })],
  { motion: [mot(8, 22, { vx: 5.6, vy: 13.1 })] },
);

export const python: MovesetDef = moveset('python', 'Long-reach controller: pokes and whips from afar, pulls you in and stuns you, with a slow but strong lunge.', stats, [
  mv('lightN', n1, air(n1, { lag: 7 }), [n2]),
  mv('lightS', lightS, air(lightS, { lag: 9 })),
  mv('lightD', lightD, air(lightD, { lag: 8 })),
  mv('lightU', lightU, air(lightU, { lag: 8 })),
  mv('heavyN', heavyN, air(heavyN, { lag: 20 })),
  mv('heavyS', heavyS, air(heavyS, { lag: 24 })),
  mv(
    'heavyD',
    heavyD,
    air(heavyD, {
      lag: 22,
      name: 'Coil Drop (air)',
      hits: [hb.rect(0.5, 0.0, 1.4, 1.2, 14, 10, 20, 285)],
      anim: A('Folds the body into a ball and falls on the target', { limb: 'body', side: 'down', reach: 1.2, height: -0.2 }),
    }),
  ),
  mv('heavyU', heavyU, air(heavyU, { lag: 16 })),
]);
