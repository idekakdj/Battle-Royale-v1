/** Mole — tiny trickster. Smallest hurtbox, fast digging claws, burrow that buries; drill recovery; low kill power. */

import type { MovesetDef } from '../../types';
import { A, air, body, cs, hb, linkTo, moveset, mot, mv } from '../helpers';

const stats = cs({
  weight: 82,
  walkSpeed: 4.85,
  runSpeed: 9.1,
  airSpeed: 7,
  airAccel: 31.9,
  jumpVel: 14.5,
  airJumpVel: 12.5,
  maxJumps: 2,
  gravityMult: 0.95,
  fallSpeed: 17,
  fastFallSpeed: 25,
  width: 0.68,
  height: 0.68,
});

// lightN — Claw Dig (3 quick)
const n1 = body(
  'Claw Dig',
  'swipe',
  A('Right digging claw scoops forward', { limb: 'claw', side: 'R', reach: 0.95, height: 0.4, arc: 60 }),
  [4, 2, 8],
  [hb.circle(0.65, 0.4, 0.3, 4, 5, 4, 62, { stun: 3.7 })],
  { cancels: linkTo(6, 14, false), turn: true },
);
const n2 = body(
  'Claw Dig 2',
  'backhand',
  A('Left digging claw scoops back', { limb: 'claw', side: 'L', reach: 0.95, height: 0.4, arc: 60 }),
  [4, 2, 8],
  [hb.circle(0.65, 0.4, 0.3, 4, 5, 4, 62, { stun: 3.7 })],
  { cancels: linkTo(6, 14, true) },
);
const n3 = body(
  'Claw Dig 3',
  'rake',
  A('Both claws dig down through the target', { limb: 'claw', side: 'both', reach: 1.05, height: 0.4, arc: 80 }),
  [5, 2, 10],
  [hb.circle(0.7, 0.4, 0.33, 4, 7, 9, 50, { path: [[0, 0, 0.15], [2, 0.1, -0.25]] })],
);

const lightS = body(
  'Dirt Fling',
  'swipe',
  A('Both paws fling a short cone of dirt into the target\'s face', { limb: 'claw', side: 'both', reach: 1.1, height: 0.4 }),
  [6, 3, 13],
  [hb.rect(0.65, 0.4, 0.9, 0.7, 8, 5, 6, 30, { fx: 'flinch' })],
);
const lightD = body(
  'Low Dig',
  'rake',
  A('Claws scrape low along the ground and kick up the ankles', { limb: 'claw', side: 'both', reach: 1.05, height: 0.15, arc: 50 }),
  [5, 3, 11],
  [hb.rect(0.65, 0.15, 0.8, 0.35, 7, 5, 6, 68)],
);
const lightU = body(
  'Earth Pop',
  'uppercut',
  A('Claws scoop upward in a small uppercut, popping the target up', { limb: 'claw', side: 'both', reach: 0.9, height: 1.3, arc: 100 }),
  [6, 3, 12],
  [hb.circle(0.6, 0.6, 0.4, 8, 6, 8, 88, { path: [[0, 0, 0], [3, -0.2, 0.7]] })],
);

const heavyN = body(
  'Drill Spin',
  'spinAttack',
  A('Spins like a drill on the spot, claws buzzing around the body; the last turn flings victims', { limb: 'claw', side: 'both', reach: 0.9, height: 0.4, spin: 3 }),
  [12, 6, 22],
  [
    hb.rect(0, 0.4, 1.8, 0.8, 3, 3, 0, 40, { win: [0, 4], multi: 2, group: 1 }),
    hb.rect(0, 0.4, 1.8, 0.8, 7, 10.8, 23, 55, { win: [4, 6], group: 2 }),
  ],
);
const heavyS = body(
  'Tunnel Lunge',
  'charge',
  A('Tucks into a drill and rockets forward like a boring machine', { limb: 'claw', side: 'front', reach: 1.2, height: 0.4, travel: 1.4 }),
  [14, 4, 25],
  [hb.circle(0.8, 0.4, 0.4, 14, 11, 24, 40, { hitlag: 2 })],
  { motion: [mot(12, 22, { vx: 8.5 })] },
);
const heavyD = body(
  'Burrow Strike',
  'burrow',
  A('Dives into the ground out of sight, then erupts upward in front, burying the target; in the air it is a drill-down', { limb: 'claw', side: 'front', reach: 1.45, height: 0.2, depth: 0.6 }),
  [13, 4, 25],
  [hb.circle(0.9, 0.2, 0.55, 12, 6, 10, 90, { fx: 'bury', stun: 1.5 })],
);
const heavyU = body(
  'Drill Ascent',
  'leapUp',
  A('Spins into a vertical drill and bores up through the air', { limb: 'claw', side: 'up', reach: 0.5, height: 1.4, rise: 6.0, spin: 4 }),
  [8, 16, 24],
  [
    hb.rect(0.25, 0.7, 0.9, 1.0, 2, 3, 0, 85, { win: [0, 12], multi: 4, group: 1 }),
    hb.circle(0.3, 1.0, 0.5, 4, 9.5, 17, 85, { win: [12, 16], group: 2 }),
  ],
  { motion: [mot(6, 22, { vx: 2.5, vy: 16.9 })] },
);

export const mole: MovesetDef = moveset('mole', 'Tiny trickster: hard to hit, quick digging combos, a burrow that buries and a drilling recovery.', stats, [
  mv('lightN', n1, air(n1, { lag: 6 }), [n2, n3]),
  mv('lightS', lightS, air(lightS, { lag: 7 })),
  mv('lightD', lightD, air(lightD, { lag: 6 })),
  mv('lightU', lightU, air(lightU, { lag: 6 })),
  mv('heavyN', heavyN, air(heavyN, { lag: 15 })),
  mv('heavyS', heavyS, air(heavyS, { lag: 18 })),
  mv(
    'heavyD',
    heavyD,
    air(heavyD, {
      lag: 18,
      name: 'Drill Down',
      hits: [hb.circle(0.25, -0.15, 0.45, 12, 10, 20, 285)],
      anim: A('Points the claws down and drills straight down through the air', { limb: 'claw', side: 'down', reach: 0.3, height: -0.2, pitch: -90 }),
    }),
  ),
  mv('heavyU', heavyU, air(heavyU, { lag: 14 })),
]);
